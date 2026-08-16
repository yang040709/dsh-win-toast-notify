/**
 * dsh-win-toast-notify — DeepSeek Harness (DSH) dynamic Cordis plugin (Host half)
 *
 * Sends rich native Windows toast notifications when an agent task completes.
 * Designed for DSH running under WSL2: the Host process spawns powershell.exe
 * through WSL interop, and a PowerShell WinRT snippet shows the toast.
 * Zero dependencies on the Windows side.
 *
 * Features:
 * - Completion toast: session title, turn number, elapsed time, tool-call count,
 *   model name; click (or the 打开 DSH button) opens the DSH web UI.
 * - Immediate error toast on agent/error (30 s dedup per agent).
 * - Root-agent filter: subagents and workflow children stay quiet.
 * - v1.3.0: XML/PowerShell escaping (apostrophes, special and illegal XML
 *   characters), 15 s spawn timeout, per-agent state cleanup on agent/disposed,
 *   and turn numbers only reported for turns that actually completed this run.
 * - v1.3.1: declares inject dependencies (subprocess/agents/sessionTitle) so the
 *   plugin waits for those services instead of silently giving up on cold boot.
 *
 * USAGE in DSH:
 *   Paste the body of the exported function below as the `code.host` value of
 *   the `cordis_define` tool (or the dynamic-plugin panel), then activate the
 *   returned packageId with `cordis_run`.
 */
return {
  inject: ['subprocess', 'agents', 'sessionTitle'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    const agents = ctx.get('agents')
    const sessionTitle = ctx.get('sessionTitle')
    if (subprocess === undefined) return

    // Edit if your DSH web UI listens on another port.
    const DSH_URL = 'http://127.0.0.1:3080'
    let psPath = null

    // Per-root-agent task stats: id -> { startedAt, toolsStart, errored }
    const perAgent = new Map()
    const toolCounts = new Map() // id -> lifetime tool-call count
    const lastTurn = new Map() // id -> last completed turn number
    const lastErrorToast = new Map() // id -> timestamp of last error toast

    // --- small helpers -----------------------------------------------------
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
        // fall through
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

    // PowerShell -EncodedCommand expects base64 of UTF-16LE bytes.
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

    // XML 1.0 does not allow most C0 control characters or lone surrogates;
    // PowerShell's XmlDocument.LoadXml throws on them. Replace them instead
    // of letting one malformed title/error message disable the notification.
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

    // The toast XML is embedded in a PowerShell SINGLE-quoted string, so a
    // literal apostrophe must be doubled (''); otherwise "It's done" ends the
    // string early and PowerShell fails to parse the script.
    function psSingleQuoted(value) {
      return String(value).replace(/'/g, "''")
    }

    function toastText(value) {
      return psSingleQuoted(xmlEscape(xmlSafe(value)))
    }

    // ToastGeneric template: bold title + body, click-through to DSH, action button.
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
      // A stuck powershell.exe must not leak a managed child forever: abort
      // the spawn after 15 s and let the subprocess service terminate it.
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

    // --- feature detection: powershell.exe via WSL interop -----------------

    subprocess.resolveExecutable('powershell.exe')
      .then((path) => {
        psPath = path
        console.log('[win-task-notify] powershell.exe resolved to', path)
      })
      .catch((err) => {
        console.error('[win-task-notify] powershell.exe unavailable, notifications disabled:', err)
      })

    // --- instrumentation ---------------------------------------------------

    // Count tool calls per agent (exec.agent is set by the agent loop).
    ctx.on('tools/result', (exec) => {
      const agent = exec && exec.agent
      if (agent === undefined) return
      const id = String(agent.id)
      toolCounts.set(id, (toolCounts.get(id) || 0) + 1)
    })

    // Remember the last completed turn number per agent.
    ctx.on('agent/turn-stopping', (payload) => {
      const agent = payload && payload.agent
      if (agent === undefined) return
      if (typeof payload.turn === 'number') lastTurn.set(String(agent.id), payload.turn)
    })

    // Drop per-agent state when the agent is removed from the registry.
    ctx.on('agent/disposed', (payload) => {
      const agent = payload && payload.agent
      if (agent === undefined) return
      const id = String(agent.id)
      perAgent.delete(id)
      toolCounts.delete(id)
      lastTurn.delete(id)
      lastErrorToast.delete(id)
    })

    // Immediate error notification for root agents (30s dedup per agent).
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
        // keep default
      }
      const prefix = typeof payload.turn === 'number' ? '第 ' + payload.turn + ' 轮 · ' : ''
      fireToast('DeepSeek Harness · 任务出错', prefix + truncate(msg, 120), 'error')
    })

    // --- task completion trigger ------------------------------------------

    // agent/status fires on every idle <-> running transition. `idle` means
    // no driver remains scheduled or active, i.e. the task has finished.
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

      const title = titleOf(agent) || 'DeepSeek Harness'
      const outcome = st.errored ? '任务结束（有错误）' : '任务已完成'
      const parts = [outcome]
      // Only report a turn that actually completed during THIS run; if the
      // run failed before agent/turn-stopping, don't reuse the previous run.
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
        // model optional
      }
      fireToast(title, parts.join(' · '), st.errored ? 'error' : 'ok')
    })
  },
}
