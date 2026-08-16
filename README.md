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
- 📊 **Rich completion stats** — every toast carries the session title, turn number, elapsed time, tool-call count, and model name.
- 🚨 **Immediate error alerts** — a separate toast fires the moment `agent/error` is emitted, with the error message; the completion toast then reports the outcome (`任务结束（有错误）`) and switches to the IM sound.
- 🖱️ **Click-through** — clicking the toast (or its **打开 DSH** button) opens the DSH web UI in your default browser via protocol activation.
- 🌳 **Root-agent filter** — subagents and workflow children are filtered out via the `agents` service, so background delegation doesn't spam you.
- 🔔 **Native Windows toast** — real notification-center entry with sound, not a console popup.
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
│    └─ status === 'idle' ?            │            │  │ <会话标题>              │ │
│       └─ root agent only             │            │  │ 任务已完成 · 第3轮      │ │
│       + stats (turn/tools/           │            │  │ · 耗时2分35秒          │ │
│         duration/model)              │            │  │ · 工具调用12次          │ │
│            │                         │            │  │ [打开 DSH] ──click─▶ 浏览器│ │
│            ▼                         │            │  └────────────────────────┘ │
│                                      │            │            ▲                │
│  subprocess.spawn(                   │            │            │ Show($toast)   │
│    powershell.exe                    │  interop   │            │                │
│    -EncodedCommand <UTF-16LE b64>    │───────────▶│  powershell.exe             │
│  )                                   │            │  WinRT ToastNotification   │
└──────────────────────────────────────┘            └─────────────────────────────┘
```

1. DSH emits `agent/status` with `{ agent, status }` on every `idle ⇄ running` transition. `idle` = the task is done. The `running` edge opens a per-agent stats window (start time, tool-call snapshot).
2. The plugin keeps only transitions from **root agents** (`agents.roots()`), so subagent/workflow completions stay quiet. While the task runs it gathers stats from DSH events: `tools/result` (per-agent tool-call count), `agent/turn-stopping` (turn number), and `agent/error` (outcome + immediate error toast).
3. A PowerShell script is built that loads the WinRT `Windows.UI.Notifications` types, wraps the session title (from the `sessionTitle` service) and the stats line (XML-escaped) in a `ToastGeneric` toast XML with a protocol-activation `launch`/button pointing at the DSH web UI, then calls `Show()`.
4. The script is encoded as **base64 of UTF-16LE** (what `-EncodedCommand` expects — note the builtin `btoa` is UTF-8, so the plugin ships a tiny byte-level base64 encoder) and spawned via DSH's `subprocess` service: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ...`.
5. WSL interop translates the call onto Windows; the toast lands in the notification center with the default (or IM, for errors) sound.

## Requirements

| Component | Requirement |
| --- | --- |
| Harness | DeepSeek Harness (DSH) with dynamic-plugin support (`cordis_define` / plugin panel) |
| OS | WSL2 with interop enabled (the default; check `echo $WSL_INTEROP`) |
| Windows | Windows 10 / 11 — anything with the toast notification center |
| Windows installs | **none** (uses Windows PowerShell 5.1 + WinRT) |

## Installation

Two ways to install: a **dynamic plugin** for the current process (Options A/B), or a **persistent mount** in an agent preset that survives DSH restarts (Option C, recommended).

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

### Option C — Persistent host mount via profile patch layer (survives restart, recommended)

[`win-task-notify.mjs`](win-task-notify.mjs) is the same plugin as a proper ESM module for composition rows. Mount it through your **profile's user patch layer** — no agent preset involved, one host-level instance for the whole process, loaded automatically on every boot:

1. Copy the file into your profile directory:

   ```
   ${DSH_HOME:-~/.dsh}/profiles/<profile>/plugins/win-task-notify.mjs
   ```

2. Append one insert block to the profile's `cordis.patch.yml` (relative row names resolve against the profile directory):

   ```yaml
   # 宿主级插件：消费 subprocess/agents/sessionTitle，不发布服务 → 无需 isolate realm
   - insert:
       - id: plugin-win-task-notify
         name: ./plugins/win-task-notify.mjs
   ```

3. Validate the composed tree offline, then restart DSH:

   ```bash
   dsh --profile <profile> --dump-config   # the row must appear at the root
   ```

   The profile patch layer is also hot-reloaded on long-lived surfaces, so a restart may not even be needed.

*Alternative:* mount the same file inside an agent preset (`${DSH_HOME}/.agent-presets/<preset-id>/plugins/` + a row in its `agent.cordis.yml`) — one instance per session. To change what a shipped preset does, copy the preset first (never edit the shipped install) and edit the copy.

Note: dynamic plugins (Options A/B) live only in the current process; after a DSH restart they are gone, while the profile patch row loads again automatically.

## Verification

The quickest check is to simply finish a task — the toast fires at the end of the turn that activates it. To test the notification channel independently of DSH:

```bash
chmod +x scripts/test-toast.sh
./scripts/test-toast.sh "DSH 通知测试" "来自 WSL 的测试通知"
```

If a toast appears, the channel works and DSH will notify you on every task completion.

### Automated tests

The event logic of both variants (`host.js` and `win-task-notify.mjs`) is covered by a dependency-free Node test suite that mocks the DSH services:

```bash
npm test            # node --test test/plugin.test.mjs
npm run check       # syntax check for both JS files + the shell script
```

## Behavior notes

- **Completion toast**: title = the session's auto-generated title (fallback `DeepSeek Harness`); body = `任务已完成 · 第 N 轮 · 耗时 X 分 Y 秒 · 工具调用 N 次 · <model>` — each segment appears only when known.
- **Error toast**: a separate alert fires immediately on `agent/error` (deduplicated to one per agent per 30 s). If the task ends in error, the completion toast says `任务结束（有错误）` and uses the IM sound instead of the default.
- **Click-through**: both the toast body and its **打开 DSH** button open `http://127.0.0.1:3080` via protocol activation — edit `DSH_URL` in `host.js` if your DSH web UI listens on another port.
- **Sender identity**: toasts are attributed to *Windows PowerShell* (the PowerShell 5.1 AUMID). To rebrand, register a dedicated AUMID (e.g. via a Start-menu shortcut) and replace `$appId` in the script.
- **One per goal round**: each autonomous goal continuation round also ends in `idle`, so you get one toast per round (with that round's own stats) — intentional, but easy to throttle if you prefer.
- **Robust text handling**: titles/error messages are XML-escaped, invalid XML 1.0 control characters are replaced, and apostrophes are doubled for the PowerShell single-quoted string — so `It's done`, `<tags>` and `&`-signs all toast correctly.
- **No stuck child processes**: each `powershell.exe` spawn is aborted after 15 s, so a hung WSL interop call cannot leak a managed child forever. Per-agent state is cleaned up on `agent/disposed`.
- **Turn accuracy**: the completion toast only reports a turn number that actually completed during that run; a run that failed before `agent/turn-stopping` no longer reuses the previous run's number.
- **Process-local lifetime**: like every dynamic plugin, it lives in the current DSH process. After a restart, activate it again — or mount it permanently in your agent preset composition.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No toast, but script exits 0 | Windows notification settings: allow *Windows PowerShell* to show notifications; also check Focus Assist / Do Not Disturb |
| `powershell.exe: not found` | WSL interop disabled (`WSL_INTEROP` empty) or `/mnt/c` not mounted — fix via `/etc/wsl.conf` (`interop=true`) |
| Plugin logs "unavailable" | You are not on WSL2; this plugin targets WSL2 → Windows specifically |
| Test script (or a raw `powershell.exe` call) hangs | WSL interop can keep waiting on an inherited stdin — use the current `scripts/test-toast.sh` (it redirects `</dev/null`), or call powershell with stdin closed |
| Toast worked after hot-reload but not after a DSH restart | v1.3.1 fix: the plugin now declares `inject` for `subprocess`/`agents`/`sessionTitle`, so it waits for those services on cold boot instead of applying too early and staying silent |
| Toast shows wrong encoding | Ensure the script goes through the UTF-16LE base64 path; don't replace it with plain UTF-8 `btoa` |

## License

[MIT](LICENSE) © 2026 yang040709

---

# 中文说明

## 这是什么

一个 **DeepSeek Harness (DSH) 动态 Cordis 插件**：每次 agent 任务完成后，在你的 Windows 桌面弹出原生 Toast 通知。专为 **WSL2 下运行 DSH** 的场景设计。

## 特性

- 监听 DSH 的 `agent/status` 事件，`idle`（任务结束、驱动静默）时触发通知，每轮任务恰好一次
- **丰富统计**：每条完成通知包含会话标题、轮次、耗时、工具调用次数、模型名
- **错误即时通知**：`agent/error` 触发时立刻弹独立通知（含错误信息，30 秒去重），任务结束时正文显示"任务结束（有错误）"并改用 IM 提示音
- **点击跳转**：点击通知本体或"打开 DSH"按钮，直接浏览器打开 DSH 页面（protocol 激活）
- 通过 `agents.roots()` 过滤子代理/工作流子任务，后台委托不会刷屏
- 原生 Windows Toast（进通知中心、带提示音），Windows 侧**零依赖**：只用自带的 PowerShell 5.1 + WinRT
- 自动探测 `powershell.exe`，非 WSL 环境静默降级
- 仅 Host 端，激活无需浏览器审批

## 工作原理

DSH（WSL2 内）监听 `agent/status` → 根 agent 进入 `idle` → 构造 PowerShell WinRT 脚本 → 编码为 UTF-16LE base64（`-EncodedCommand` 要求的格式）→ 通过 `subprocess` 服务 spawn `powershell.exe` → WSL 互操作转发到 Windows → Toast 弹出。

## 安装（DSH 内）

两种方式：**动态插件**（仅当前进程有效）或 **profile 补丁层持久化挂载**（宿主级，随 DSH 重启自动生效，不依赖预设，推荐）。

1. 打开 DSH 的动态插件面板（或使用 `cordis_define` 工具）
2. 新建插件（id 前缀如 `winntf`），把 [`host.js`](host.js) 中注释块之后的函数体粘贴到 **Host** 代码框（Client 留空）
3. 激活即可；本轮任务结束时你就会收到第一条通知

**持久化挂载（profile 补丁层，重启后依然自动生效）**：

1. 把 [`win-task-notify.mjs`](win-task-notify.mjs) 复制到你的 profile 目录：

   ```
   ${DSH_HOME:-~/.dsh}/profiles/<profile>/plugins/win-task-notify.mjs
   ```

2. 在该 profile 的 `cordis.patch.yml` 中追加（相对路径相对 profile 目录解析）：

   ```yaml
   # 宿主级插件：消费 subprocess/agents/sessionTitle，不发布服务 → 无需 isolate realm
   - insert:
       - id: plugin-win-task-notify
         name: ./plugins/win-task-notify.mjs
   ```

3. 用 `dsh --profile <profile> --dump-config` 校验组合树（该行必须出现在根级），然后重启 DSH（profile 补丁层在长驻进程上支持热重载，可能无需重启）。

*备选*：agent preset 挂载（每个会话一份实例）——同文件放进 `${DSH_HOME}/.agent-presets/<preset-id>/plugins/` 并在该 preset 的 `agent.cordis.yml` 末尾加同名行；修改内置 preset 前请先复制副本再改副本。

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
