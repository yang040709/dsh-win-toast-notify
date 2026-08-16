/**
 * win-task-notify — 任务完成时弹 Windows 原生 Toast（WSL → PowerShell WinRT）。
 *
 * 静态持久化插件（宿主级组合行，随 DSH 重启自动生效）。
 * Host-only：消费宿主服务 `subprocess`、`agents`、`sessionTitle`，不发布任何服务，
 * 因此无需 isolate realm（同 `tool-bash` 的先例）。
 *
 * v1.3.0：
 * - 修复：标题/正文里的单引号不再破坏 PowerShell 单引号字符串（'' 转义）
 * - 修复：剥离 XML 1.0 非法控制字符，避免 LoadXml 解析失败
 * - 修复：powershell.exe 卡住时 15 秒后中止，不泄漏托管子进程
 * - 修复：agent 销毁时清理状态；任务未完成任何轮次时不再沿用上一轮轮次号
 * - v1.1.0 功能：完成通知（会话标题 + 第 N 轮 + 耗时 + 工具调用次数 + 模型名），
 *   agent/error 即时错误通知（每 agent 30 秒去重），结束通知标注"任务结束（有错误）"并换 IM 音，
 *   点击通知或"打开 DSH"按钮 → 浏览器打开 DSH（protocol 激活）
 *
 * 安装（推荐：profile 补丁层，宿主级，随 DSH 重启自动生效，不依赖预设）：
 *   1. 把本文件复制到你的 profile 目录：
 *      ${DSH_HOME:-~/.dsh}/profiles/<profile>/plugins/win-task-notify.mjs
 *   2. 在该 profile 的 cordis.patch.yml 中追加：
 *        - insert:
 *            - id: plugin-win-task-notify
 *              name: ./plugins/win-task-notify.mjs
 *   3. 用 `dsh --profile <profile> --dump-config` 校验组合树，然后重启 DSH
 *      （profile 补丁层在长驻进程上支持热重载）。
 *
 * 备选：agent preset 挂载（每个会话一份实例）——把本文件放进
 *   ${DSH_HOME}/.agent-presets/<preset-id>/plugins/ 并在该 preset 的
 *   agent.cordis.yml 末尾加一行同 name 的行。
 *
 * 模块级 1 秒去重：同一进程内多个会话挂载本 preset 时，同一 agent 连续 idle 事件不会重复弹窗。
 */

const lastNotified = new Map() // agentId -> epoch ms

export default {
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    const agents = ctx.get('agents')
    const sessionTitle = ctx.get('sessionTitle')
    if (subprocess === undefined) return

    // 若你的 DSH Web UI 监听其它端口，请修改这里。
    const DSH_URL = 'http://127.0.0.1:3080'
    let psPath = null

    // 每个根 agent 的任务统计：id -> { startedAt, toolsStart, errored }
    const perAgent = new Map()
    const toolCounts = new Map() // id -> 生命周期累计工具调用次数
    const lastTurn = new Map() // id -> 最近完成的轮次号
    const lastErrorToast = new Map() // id -> 上次错误通知时间戳

    // --- 工具函数 -----------------------------------------------------------
    function now() {
      try { return Date.now() } catch (err) { return 0 }
    }

    function fmtDuration(ms) {
      if (!ms || ms < 0) return ''
      const s = Math.round(ms / 1000)
      if (s < 60) return s + ' 秒'
      const m = Math.floor(s / 60)
      return m + ' 分 ' + (s % 60) + ' 秒'
    }

    function truncate(str, max) {
      const s = String(str)
      return s.length > max ? s.slice(0, max) + '…' : s
    }

    function titleOf(agent) {
      try {
        if (sessionTitle === undefined || agent === undefined) return ''
        const snap = sessionTitle.get(agent.session)
        if (snap && typeof snap.title === 'string') return truncate(snap.title, 40)
      } catch (err) {
        // 标题获取失败时回退
      }
      return ''
    }

    function isRoot(agent) {
      if (agents === undefined || agent === undefined) return true
      try { return agents.roots().includes(agent) } catch (err) { return true }
    }

    function bytesToBase64(bytes) {
      const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      let out = ''
      for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0
        out += map[a >> 2] + map[((a & 3) << 4) | (b >> 4)]
        out += i + 1 < bytes.length ? map[((b & 15) << 2) | (c >> 6)] : '='
        out += i + 2 < bytes.length ? map[c & 63] : '='
      }
      return out
    }

    // PowerShell -EncodedCommand 要求 UTF-16LE 字节的 base64。
    function utf16leBytes(str) {
      const bytes = []
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i)
        bytes.push(code & 0xff, (code >> 8) & 0xff)
      }
      return bytes
    }

    function xmlEscape(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    // XML 1.0 不允许大多数 C0 控制字符和孤立代理项，XmlDocument.LoadXml 会抛错；
    // 这里替换掉它们，避免一个畸形标题/错误信息让整条通知失效。
    function xmlSafe(value) {
      let out = ''
      for (const ch of String(value)) {
        const cp = ch.codePointAt(0)
        if (cp === 0x9 || cp === 0xa || cp === 0xd ||
            (cp >= 0x20 && cp <= 0xd7ff) ||
            (cp >= 0xe000 && cp <= 0xfffd) ||
            (cp >= 0x10000 && cp <= 0x10ffff)) {
          out += ch
        } else {
          out += '\ufffd'
        }
      }
      return out
    }

    // Toast XML 嵌在 PowerShell 的单引号字符串里：单引号必须翻倍（''），
    // 否则 "It's done" 会提前结束字符串导致 PowerShell 解析失败。
    function psSingleQuoted(value) {
      return String(value).replace(/'/g, "''")
    }

    function toastText(value) {
      return psSingleQuoted(xmlEscape(xmlSafe(value)))
    }

    // ToastGeneric 模板：加粗标题 + 正文，点击跳转 DSH，附带操作按钮。
    function buildScript(title, body, sound) {
      const launch = toastText(DSH_URL)
      return [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
        "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
        '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
        "$xml.LoadXml('<toast activationType=\"protocol\" launch=\"" + launch + "\"><visual><binding template=\"ToastGeneric\"><text id=\"1\">" + toastText(title) + "</text><text id=\"2\">" + toastText(body) + "</text></binding></visual><audio src=\"" + sound + "\"/><actions><action content=\"打开 DSH\" activationType=\"protocol\" arguments=\"" + launch + "\"/></actions></toast>')",
        '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
      ].join('\n')
    }

    function fireToast(title, body, kind) {
      if (psPath === null) return
      const sound = kind === 'error' ? 'ms-winsoundevent:Notification.IM' : 'ms-winsoundevent:Notification.Default'
      const b64 = bytesToBase64(utf16leBytes(buildScript(title, body, sound)))
      // powershell.exe 卡住时不能让托管子进程永久泄漏：15 秒后中止，
      // 由 subprocess 服务按 graceMs 升级终止整个进程树。
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const handle = subprocess.spawn({
          argv: [psPath, '-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
          cwd: '/',
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 1024 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 15000,
          signal: controller.signal,
        })
        handle.done
          .catch((err) => {
            console.error('[win-task-notify] toast process failed:', err)
          })
          .finally(() => {
            clearTimeout(timer)
          })
      } catch (err) {
        clearTimeout(timer)
        console.error('[win-task-notify] spawn failed:', err)
      }
    }

    // 模块级 1 秒去重（同一进程内多个会话挂载本 preset 时防重复弹窗）。
    function dedup(agent) {
      const t = now()
      if (t === 0) return true
      let key = 'unknown'
      try { key = String(agent && agent.id) } catch (err) { /* ignore */ }
      const last = lastNotified.get(key)
      if (typeof last === 'number' && t - last < 1000) return false
      lastNotified.set(key, t)
      if (lastNotified.size > 64) {
        for (const k of Array.from(lastNotified.keys())) {
          const v = lastNotified.get(k)
          if (typeof v === 'number' && t - v > 1000) lastNotified.delete(k)
        }
      }
      return true
    }

    // --- 特性探测：WSL 互操作下的 powershell.exe（非 WSL 环境静默禁用）------
    subprocess.resolveExecutable('powershell.exe')
      .then((path) => {
        psPath = path
        console.log('[win-task-notify] powershell.exe resolved to', path)
      })
      .catch((err) => {
        console.error('[win-task-notify] powershell.exe unavailable, notifications disabled:', err)
      })

    // --- 数据采集 ------------------------------------------------------------

    // 按 agent 统计工具调用次数（exec.agent 由 agent loop 设置）。
    ctx.on('tools/result', (exec) => {
      const agent = exec && exec.agent
      if (agent === undefined) return
      const id = String(agent.id)
      toolCounts.set(id, (toolCounts.get(id) || 0) + 1)
    })

    // 记录每个 agent 最近完成的轮次号。
    ctx.on('agent/turn-stopping', (payload) => {
      const agent = payload && payload.agent
      if (agent === undefined) return
      if (typeof payload.turn === 'number') lastTurn.set(String(agent.id), payload.turn)
    })

    // agent 从注册表移除时清掉该 agent 的全部内存状态。
    ctx.on('agent/disposed', (payload) => {
      const agent = payload && payload.agent
      if (agent === undefined) return
      const id = String(agent.id)
      perAgent.delete(id)
      toolCounts.delete(id)
      lastTurn.delete(id)
      lastErrorToast.delete(id)
      lastNotified.delete(id)
    })

    // 根 agent 出错时即时通知（每 agent 30 秒去重）。
    ctx.on('agent/error', (payload) => {
      const agent = payload && payload.agent
      if (!isRoot(agent)) return
      const id = String(agent.id)
      const st = perAgent.get(id)
      if (st !== undefined) st.errored = true
      const t = now()
      const last = lastErrorToast.get(id) || 0
      if (t > 0 && t - last < 30000) return
      lastErrorToast.set(id, t)
      let msg = '未知错误'
      try {
        const e = payload.error
        if (e && typeof e === 'object' && typeof e.message === 'string') msg = String(e.message)
        else if (e !== undefined && e !== null) msg = String(e)
      } catch (err) {
        // 保留默认文案
      }
      const prefix = typeof payload.turn === 'number' ? '第 ' + payload.turn + ' 轮 · ' : ''
      fireToast('DeepSeek Harness · 任务出错', prefix + truncate(msg, 120), 'error')
    })

    // --- 任务完成触发 --------------------------------------------------------

    // agent/status 在 idle ⇄ running 切换时触发；`idle` 表示无剩余调度，即任务结束。
    ctx.on('agent/status', (payload) => {
      const agent = payload && payload.agent
      if (!isRoot(agent)) return
      const id = String(agent.id)
      const status = payload.status

      if (status === 'running') {
        perAgent.set(id, {
          startedAt: now(),
          toolsStart: toolCounts.get(id) || 0,
          turnStart: lastTurn.get(id),
          errored: false,
        })
        return
      }
      if (status !== 'idle') return

      const st = perAgent.get(id)
      if (st === undefined) return
      perAgent.delete(id)
      if (!dedup(agent)) return

      const title = titleOf(agent) || 'DeepSeek Harness'
      const outcome = st.errored ? '任务结束（有错误）' : '任务已完成'
      const parts = [outcome]
      // 只报告本次运行期间真正完成的轮次；运行在 turn-stopping 之前就失败时，
      // 不要沿用上一轮的旧轮次号。
      const turn = lastTurn.get(id)
      if (typeof turn === 'number' && turn !== st.turnStart) parts.push('第 ' + turn + ' 轮')
      if (st.startedAt > 0) {
        const dur = fmtDuration(now() - st.startedAt)
        if (dur) parts.push('耗时 ' + dur)
      }
      parts.push('工具调用 ' + ((toolCounts.get(id) || 0) - st.toolsStart) + ' 次')
      try {
        const model = agent.options && agent.options.model
        if (typeof model === 'string' && model) parts.push(model)
      } catch (err) {
        // 模型名为可选字段
      }
      fireToast(title, parts.join(' · '), st.errored ? 'error' : 'ok')
    })
  },
}
