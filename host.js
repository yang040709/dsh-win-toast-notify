/**
 * dsh-win-toast-notify — DeepSeek Harness (DSH) dynamic Cordis plugin (Host half)
 *
 * Sends a native Windows toast notification every time an agent task completes.
 * Designed for DSH running under WSL2: the Host process spawns powershell.exe
 * through WSL interop, and a PowerShell WinRT snippet shows the toast.
 * Zero dependencies on the Windows side.
 *
 * USAGE in DSH:
 *   Paste the body of the exported function below as the `code.host` value of
 *   the `cordis_define` tool (or the dynamic-plugin panel), then activate the
 *   returned packageId with `cordis_run`.
 */
return {
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    const agents = ctx.get('agents')
    if (subprocess === undefined) return

    let psPath = null

    // --- helpers -----------------------------------------------------------

    // Byte-level base64 encoder (builtin btoa is UTF-8 only; we need raw bytes).
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

    // Toast XML (ToastText02: bold title + body) plus default notification sound.
    function buildScript(title, body) {
      return [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
        "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
        '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
        "$xml.LoadXml('<toast><visual><binding template=\"ToastText02\"><text id=\"1\">" + xmlEscape(title) + "</text><text id=\"2\">" + xmlEscape(body) + "</text></binding></visual><audio src=\"ms-winsoundevent:Notification.Default\"/></toast>')",
        '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
      ].join('\n')
    }

    function fireToast(title, body) {
      if (psPath === null) return
      const b64 = bytesToBase64(utf16leBytes(buildScript(title, body)))
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
        })
        handle.done.catch((err) => {
          console.error('[win-task-notify] toast process failed:', err)
        })
      } catch (err) {
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

    // --- task completion trigger ------------------------------------------

    // agent/status fires on every idle <-> running transition. `idle` means
    // no driver remains scheduled or active, i.e. the task has finished.
    ctx.on('agent/status', (payload) => {
      const status = payload && payload.status
      if (status !== 'idle') return
      const agent = payload && payload.agent
      // Only notify for root agents (user sessions), not subagents/workflow children.
      if (agents !== undefined && agent !== undefined) {
        try {
          if (!agents.roots().includes(agent)) return
        } catch (err) {
          // fall through and notify anyway
        }
      }
      let tag = ''
      try {
        const id = agent && agent.id
        if (typeof id === 'string') tag = ' [' + id.slice(0, 8) + ']'
      } catch (err) {
        tag = ''
      }
      fireToast('DeepSeek Harness', '任务已完成' + tag)
    })
  },
}
