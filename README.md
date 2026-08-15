# dsh-win-toast-notify

**A dynamic Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): pop a native Windows toast notification every time an agent task completes — built for DSH running under WSL2.**

[![DSH: dynamic Cordis plugin](https://img.shields.io/badge/DSH-dynamic_Cordis_plugin-4D6BFE)](https://github.com/deepseek-ai)
[![Platform: WSL2 → Windows](https://img.shields.io/badge/platform-WSL2_%E2%86%92_Windows-0078D4)](#)
[![Zero Windows-side deps](https://img.shields.io/badge/windows_deps-none-2ea44f)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

> DSH 动态 Cordis 插件：每次 agent 任务完成后，在 Windows 上弹出原生 Toast 通知。专为 WSL2 下的 DeepSeek Harness 设计，Windows 侧零依赖。

---

## Features

- 🎯 **Fires exactly once per completed task** — listens to DSH's `agent/status` event and notifies on `idle` (no driver remains scheduled or active).
- 🌳 **Root-agent filter** — subagents and workflow children are filtered out via the `agents` service, so background delegation doesn't spam you.
- 🔔 **Native Windows toast** — real notification-center entry with default notification sound, not a console popup.
- 🪶 **Zero Windows-side dependencies** — no BurntToast, no SnoreToast, no extra install: `powershell.exe` + WinRT, invoked through WSL interop.
- 🛡️ **Graceful on non-WSL** — feature-detects `powershell.exe` at startup; outside WSL the plugin simply stays silent.
- 🧩 **Host-only** — no Client half, no browser approval needed to activate.

## How it works

```
 DeepSeek Harness (WSL2, Node.js)                    Windows
┌──────────────────────────────────────┐            ┌─────────────────────────────┐
│  Dynamic Host plugin                 │            │  通知中心 (Action Center)     │
│                                      │            │                             │
│  ctx.on('agent/status')              │            │  ┌────────────────────────┐ │
│    └─ status === 'idle' ?            │            │  │ DeepSeek Harness       │ │
│       └─ root agent only             │            │  │ 任务已完成 [a1b2c3d4]   │ │
│            │                         │            │  └────────────────────────┘ │
│            ▼                         │            │            ▲                │
│  subprocess.spawn(                   │            │            │ Show($toast)   │
│    powershell.exe                    │  interop   │            │                │
│    -EncodedCommand <UTF-16LE b64>    │───────────▶│  powershell.exe             │
│  )                                   │            │  WinRT ToastNotification   │
└──────────────────────────────────────┘            └─────────────────────────────┘
```

1. DSH emits `agent/status` with `{ agent, status }` on every `idle ⇄ running` transition. `idle` = the task is done.
2. The plugin keeps only transitions from **root agents** (`agents.roots()`), so subagent/workflow completions stay quiet.
3. A PowerShell script is built that loads the WinRT `Windows.UI.Notifications` types, wraps title/body (XML-escaped) in a `ToastText02` toast XML and calls `Show()`.
4. The script is encoded as **base64 of UTF-16LE** (what `-EncodedCommand` expects — note the builtin `btoa` is UTF-8, so the plugin ships a tiny byte-level base64 encoder) and spawned via DSH's `subprocess` service: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ...`.
5. WSL interop translates the call onto Windows; the toast lands in the notification center with the default sound.

## Requirements

| Component | Requirement |
| --- | --- |
| Harness | DeepSeek Harness (DSH) with dynamic-plugin support (`cordis_define` / plugin panel) |
| OS | WSL2 with interop enabled (the default; check `echo $WSL_INTEROP`) |
| Windows | Windows 10 / 11 — anything with the toast notification center |
| Windows installs | **none** (uses Windows PowerShell 5.1 + WinRT) |

## Installation

This plugin is a **dynamic Cordis plugin** for a running DSH process. Paste [`host.js`](host.js) as the Host code and activate it.

### Option A — Web GUI

1. In your DSH session, open the **dynamic plugin** panel (Cordis plugins).
2. Create a new plugin with any 3–6 letter id prefix (e.g. `winntf`).
3. Paste the *body* of `host.js` (everything after the comment block, starting at `return {`) into the **Host** code field. Leave Client empty.
4. Activate the package.

### Option B — cordis_define tool

```
cordis_define:
  plugin:  { kind: "new", idPrefix: "winntf" }
  name:    win-task-notify
  code:    { host: <content of host.js after the comments> }
→ then cordis_run with the returned pluginId + packageId
```

The plugin is **Host-only**, so it activates without any Client approval step. On startup it logs which `powershell.exe` it resolved:

```
[win-task-notify] powershell.exe resolved to /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
```

## Verification

The quickest check is to simply finish a task — the toast fires at the end of the turn that activates it. To test the notification channel independently of DSH:

```bash
chmod +x scripts/test-toast.sh
./scripts/test-toast.sh "DSH 通知测试" "来自 WSL 的测试通知"
```

If a toast appears, the channel works and DSH will notify you on every task completion.

## Behavior notes

- **Notification text**: title `DeepSeek Harness`, body `任务已完成 [first 8 chars of session id]`.
- **Sender identity**: toasts are attributed to *Windows PowerShell* (the PowerShell 5.1 AUMID). To rebrand, register a dedicated AUMID (e.g. via a Start-menu shortcut) and replace `$appId` in the script.
- **One per goal round**: each autonomous goal continuation round also ends in `idle`, so you get one toast per round — intentional, but easy to throttle if you prefer.
- **Process-local lifetime**: like every dynamic plugin, it lives in the current DSH process. After a restart, activate it again — or mount it permanently in your agent preset composition.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No toast, but script exits 0 | Windows notification settings: allow *Windows PowerShell* to show notifications; also check Focus Assist / Do Not Disturb |
| `powershell.exe: not found` | WSL interop disabled (`WSL_INTEROP` empty) or `/mnt/c` not mounted — fix via `/etc/wsl.conf` (`interop=true`) |
| Plugin logs "unavailable" | You are not on WSL2; this plugin targets WSL2 → Windows specifically |
| Toast shows wrong encoding | Ensure the script goes through the UTF-16LE base64 path; don't replace it with plain UTF-8 `btoa` |

## License

[MIT](LICENSE) © 2026 yang040709

---

# 中文说明

## 这是什么

一个 **DeepSeek Harness (DSH) 动态 Cordis 插件**：每次 agent 任务完成后，在你的 Windows 桌面弹出原生 Toast 通知。专为 **WSL2 下运行 DSH** 的场景设计。

## 特性

- 监听 DSH 的 `agent/status` 事件，`idle`（任务结束、驱动静默）时触发通知，每轮任务恰好一次
- 通过 `agents.roots()` 过滤子代理/工作流子任务，后台委托不会刷屏
- 原生 Windows Toast（进通知中心、带默认提示音），Windows 侧**零依赖**：只用自带的 PowerShell 5.1 + WinRT
- 自动探测 `powershell.exe`，非 WSL 环境静默降级
- 仅 Host 端，激活无需浏览器审批

## 工作原理

DSH（WSL2 内）监听 `agent/status` → 根 agent 进入 `idle` → 构造 PowerShell WinRT 脚本 → 编码为 UTF-16LE base64（`-EncodedCommand` 要求的格式）→ 通过 `subprocess` 服务 spawn `powershell.exe` → WSL 互操作转发到 Windows → Toast 弹出。

## 安装（DSH 内）

1. 打开 DSH 的动态插件面板（或使用 `cordis_define` 工具）
2. 新建插件（id 前缀如 `winntf`），把 [`host.js`](host.js) 中注释块之后的函数体粘贴到 **Host** 代码框（Client 留空）
3. 激活即可；本轮任务结束时你就会收到第一条通知

## 验证

```bash
chmod +x scripts/test-toast.sh
./scripts/test-toast.sh "DSH 通知测试" "来自 WSL 的测试通知"
```

## 注意事项

- 通知来源显示为 "Windows PowerShell"；想改名需注册专用 AUMID
- 目标续跑（goal round）每轮结束也会各弹一次
- 动态插件只在当前 DSH 进程内生效，重启后需重新激活；如需永久挂载，可把它写进 agent preset 的 composition

## 许可证

[MIT](LICENSE)
