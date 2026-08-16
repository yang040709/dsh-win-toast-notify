import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PS_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

// The dynamic-plugin variant is a plain function body: `return { apply(ctx) {...} }`.
const loadHostPlugin = () => new Function(readFileSync(path.join(ROOT, 'host.js'), 'utf8'))()
// The persistent-mount variant is a proper ESM module.
const { default: persistentPlugin } = await import(pathToFileURL(path.join(ROOT, 'win-task-notify.mjs')).href)

let agentSeq = 0
const makeAgent = (overrides = {}) => ({
  id: `agent-${Date.now()}-${agentSeq++}`,
  session: { id: `session-${Date.now()}-${agentSeq}` },
  options: { model: 'deepseek-chat' },
  ...overrides,
})

function makeHarness(options = {}) {
  const state = {
    roots: options.roots ?? [],
    titleFor: options.titleFor ?? (() => ({ title: '测试会话' })),
  }
  const listeners = new Map()
  const spawns = []
  const subprocess = {
    resolveExecutable(command) {
      if (options.resolveError) return Promise.reject(options.resolveError)
      return Promise.resolve(options.psPath ?? PS_PATH)
    },
    spawn(spec) {
      spawns.push(spec)
      if (options.spawnError) throw options.spawnError
      return {
        done: options.done ? options.done(spec) : Promise.resolve({ exitCode: 0, signal: null }),
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'subprocess') return subprocess
      if (name === 'agents') return { roots: () => state.roots }
      if (name === 'sessionTitle') return { get: (session) => state.titleFor(session) }
      return undefined
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => true
    },
  }
  return {
    ctx,
    spawns,
    subprocess,
    setRoots(roots) { state.roots = roots },
    setTitle(titleFor) { state.titleFor = titleFor },
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args) },
    listenerCount(name) { return listeners.get(name)?.length ?? 0 },
  }
}

const apply = (plugin, harness) => plugin.apply(harness.ctx)

// Decode the -EncodedCommand argument back into the PowerShell script, and
// prove the plugin's hand-rolled base64/UTF-16LE encoder round-trips.
function decodeScript(spawn) {
  assert.equal(spawn.argv.length, 5)
  assert.deepEqual(spawn.argv.slice(0, 4), [PS_PATH, '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  const b64 = spawn.argv[4]
  const bytes = Buffer.from(b64, 'base64')
  const script = bytes.toString('utf16le')
  assert.equal(Buffer.from(script, 'utf16le').toString('base64'), b64)
  return script
}

// The toast XML is the last argument of $xml.LoadXml('...').
function extractXml(script) {
  const start = script.indexOf("LoadXml('")
  const end = script.lastIndexOf("')\n$toast")
  assert.notEqual(start, -1, 'script should contain LoadXml')
  assert.notEqual(end, -1, 'script should close the LoadXml call before $toast')
  const raw = script.slice(start + "LoadXml('".length, end)
  // PowerShell single-quote doubling is removed before the string reaches XML.
  return raw.replace(/''/g, "'")
}

function unescapeXml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function xmlText(xml, id) {
  const match = xml.match(new RegExp(`<text id="${id}">([\\s\\S]*?)</text>`))
  assert.ok(match, `text id=${id} should exist in ${xml}`)
  return unescapeXml(match[1])
}

function assertWellFormedXml(xml) {
  const probe = spawnSync('python3', [
    '-c',
    'import sys, xml.etree.ElementTree as ET; ET.fromstring(sys.stdin.buffer.read())',
  ], { input: xml, encoding: 'utf8' })
  if (probe.error?.code === 'ENOENT') return // python3 optional for the test run
  assert.equal(probe.status, 0, `XML must be well-formed: ${probe.stderr || probe.stdout}`)
}

async function tick() { await new Promise((resolve) => setImmediate(resolve)) }

for (const [name, plugin] of [['host.js', loadHostPlugin()], ['win-task-notify.mjs', persistentPlugin]]) {
  test(`${name}: applies without required services and stays silent`, () => {
    const ctx = { get: () => undefined, on: () => () => true }
    assert.doesNotThrow(() => plugin.apply(ctx))
  })

  test(`${name}: resolves powershell.exe and sends one completion toast for the root agent`, async () => {
    const root = makeAgent({ options: { model: 'deepseek-chat' } })
    const child = makeAgent({ id: `child-${root.id}` })
    const harness = makeHarness({ roots: [root] })
    apply(plugin, harness)
    await tick()

    const realNow = Date.now
    let clock = 1_700_000_000_000
    Date.now = () => clock
    try {
      harness.emit('agent/status', { agent: root, status: 'running' })
      // DSH order: tools run and turns stop while the agent is running.
      harness.emit('tools/result', { agent: root })
      harness.emit('tools/result', { agent: root })
      harness.emit('tools/result', { agent: child })
      harness.emit('agent/turn-stopping', { agent: root, turn: 3 })
      clock += 5_000
      harness.emit('agent/status', { agent: child, status: 'running' })
      harness.emit('agent/status', { agent: child, status: 'idle' })
      harness.emit('agent/status', { agent: root, status: 'idle' })

      assert.equal(harness.spawns.length, 1)
      const script = decodeScript(harness.spawns[0])
      const xml = extractXml(script)
      assertWellFormedXml(xml)
      assert.equal(xmlText(xml, 1), '测试会话')
      const body = xmlText(xml, 2)
      assert.match(body, /^任务已完成 · 第 3 轮 · 耗时 5 秒 · 工具调用 2 次 · deepseek-chat$/)
      assert.match(xml, /<audio src="ms-winsoundevent:Notification.Default"\/>/)
      assert.match(xml, /launch="http:\/\/127\.0\.0\.1:3080"/)
      assert.match(xml, /arguments="http:\/\/127\.0\.0\.1:3080"/)
      assert.equal(harness.spawns[0].stdio.stdin, 'ignore')
      assert.equal(harness.spawns[0].signal instanceof AbortSignal, true)
      assert.equal(harness.spawns[0].signal.aborted, false)
    } finally {
      Date.now = realNow
    }
  })

  test(`${name}: XML/PowerShell escaping survives quotes, ampersands, emoji and control chars`, async () => {
    const root = makeAgent()
    const harness = makeHarness({ roots: [root] })
    harness.setTitle(() => ({ title: "It's <Fast> & \"Furious\" 😀\u0001" }))
    apply(plugin, harness)
    await tick()

    harness.emit('agent/status', { agent: root, status: 'running' })
    harness.emit('agent/status', { agent: root, status: 'idle' })

    assert.equal(harness.spawns.length, 1)
    const script = decodeScript(harness.spawns[0])
    // The PowerShell source itself must contain a doubled apostrophe.
    assert.match(script, /<text id="1">It''s /)
    const xml = extractXml(script)
    assertWellFormedXml(xml)
    assert.equal(xmlText(xml, 1), "It's <Fast> & \"Furious\" 😀\uFFFD")
  })

  test(`${name}: idle without a matching running edge does not toast`, async () => {
    const root = makeAgent()
    const harness = makeHarness({ roots: [root] })
    apply(plugin, harness)
    await tick()

    harness.emit('agent/status', { agent: root, status: 'idle' })
    assert.equal(harness.spawns.length, 0)
  })

  test(`${name}: subagent transitions are filtered out`, async () => {
    const root = makeAgent()
    const child = makeAgent()
    const harness = makeHarness({ roots: [root] })
    apply(plugin, harness)
    await tick()

    harness.emit('agent/status', { agent: child, status: 'running' })
    harness.emit('agent/status', { agent: child, status: 'idle' })
    assert.equal(harness.spawns.length, 0)
  })

  test(`${name}: error toast is immediate, deduplicated for 30s and marks the completion`, async () => {
    const root = makeAgent()
    const harness = makeHarness({ roots: [root] })
    apply(plugin, harness)
    await tick()
    const realNow = Date.now
    let clock = 1_700_000_000_000
    Date.now = () => clock

    try {
      harness.emit('agent/status', { agent: root, status: 'running' })
      harness.emit('agent/error', { agent: root, turn: 2, error: new Error("boom 'bad' & gone") })
      assert.equal(harness.spawns.length, 1)
      const first = decodeScript(harness.spawns[0])
      let xml = extractXml(first)
      assertWellFormedXml(xml)
      assert.equal(xmlText(xml, 1), 'DeepSeek Harness · 任务出错')
      assert.equal(xmlText(xml, 2), "第 2 轮 · boom 'bad' & gone")
      assert.match(xml, /<audio src="ms-winsoundevent:Notification.IM"\/>/)

      harness.emit('agent/error', { agent: root, turn: 2, error: new Error('duplicate') })
      assert.equal(harness.spawns.length, 1)

      clock += 31_000
      harness.emit('agent/error', { agent: root, turn: 2, error: new Error('later') })
      assert.equal(harness.spawns.length, 2)

      harness.emit('agent/status', { agent: root, status: 'idle' })
      assert.equal(harness.spawns.length, 3)
      xml = extractXml(decodeScript(harness.spawns[2]))
      assert.match(xmlText(xml, 2), /^任务结束（有错误）/u)
      assert.match(xml, /<audio src="ms-winsoundevent:Notification.IM"\/>/)
    } finally {
      Date.now = realNow
    }
  })

  test(`${name}: does not reuse the previous run's turn number when the new run never finished a turn`, async () => {
    const root = makeAgent()
    const harness = makeHarness({ roots: [root] })
    apply(plugin, harness)
    await tick()

    const realNow = Date.now
    let clock = 1_700_000_000_000
    Date.now = () => clock
    try {
      harness.emit('agent/status', { agent: root, status: 'running' })
      harness.emit('agent/turn-stopping', { agent: root, turn: 4 })
      harness.emit('agent/status', { agent: root, status: 'idle' })
      assert.match(xmlText(extractXml(decodeScript(harness.spawns[0])), 2), /第 4 轮/)

      // Move past the persistent variant's 1 s module-level dedup window.
      clock += 2_000
      harness.emit('agent/status', { agent: root, status: 'running' })
      harness.emit('agent/status', { agent: root, status: 'idle' })
      assert.doesNotMatch(xmlText(extractXml(decodeScript(harness.spawns[1])), 2), /第 4 轮/)
    } finally {
      Date.now = realNow
    }
  })

  test(`${name}: agent disposal drops its state and a spawn failure is contained`, async () => {
    const root = makeAgent()
    const harness = makeHarness({ roots: [root], spawnError: new Error('spawn boom') })
    const errors = []
    const original = console.error
    console.error = (...args) => errors.push(args)
    apply(plugin, harness)
    await tick()

    try {
      harness.emit('agent/status', { agent: root, status: 'running' })
      harness.emit('agent/disposed', { agent: root })
      assert.doesNotThrow(() => harness.emit('agent/status', { agent: root, status: 'idle' }))
      assert.equal(harness.spawns.length, 0)
    } finally {
      console.error = original
    }
  })

  test(`${name}: stays silent when powershell.exe cannot be resolved`, async () => {
    const root = makeAgent()
    const harness = makeHarness({ roots: [root], resolveError: new Error('no interop') })
    apply(plugin, harness)
    await tick()

    harness.emit('agent/status', { agent: root, status: 'running' })
    harness.emit('agent/status', { agent: root, status: 'idle' })
    assert.equal(harness.spawns.length, 0)
  })
}

test('host.js and win-task-notify.mjs generate identical toast scripts', async () => {
  const root = makeAgent()
  const a = makeHarness({ roots: [root] })
  const b = makeHarness({ roots: [root] })
  a.setTitle(() => ({ title: "It's <一致> & \"测试\"" }))
  b.setTitle(() => ({ title: "It's <一致> & \"测试\"" }))
  apply(loadHostPlugin(), a)
  apply(persistentPlugin, b)
  await tick()

  for (const harness of [a, b]) {
    harness.emit('agent/status', { agent: root, status: 'running' })
    harness.emit('agent/status', { agent: root, status: 'idle' })
  }
  assert.equal(decodeScript(a.spawns[0]), decodeScript(b.spawns[0]))
})

test('persistent variant deduplicates duplicate idle events across mounted instances', async () => {
  const root = makeAgent()
  const a = makeHarness({ roots: [root] })
  const b = makeHarness({ roots: [root] })
  apply(persistentPlugin, a)
  apply(persistentPlugin, b)
  await tick()

  for (const harness of [a, b]) {
    harness.emit('agent/status', { agent: root, status: 'running' })
  }
  for (const harness of [a, b]) {
    harness.emit('agent/status', { agent: root, status: 'idle' })
  }
  assert.equal(a.spawns.length + b.spawns.length, 1)
})
