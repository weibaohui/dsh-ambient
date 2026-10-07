/**
 * dsh-ambient 离线测试：宿主配置归一化、纯目录场景扫描、路径安全、
 * Range 解析、库响应构建、后台 AI 下载任务（mock fetch 驱动 wire 形态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const Host = require('../src/index.js')
const Player = require('../client/player.js')

const { normalizeConfig, DEFAULT_CONFIG, PLAY_MODES, isPathSafe, parseRange, scanLibrary, buildLibraryResponse, customSceneIdOf, DOWNLOAD_AGENT_PROMPT } = Host.__internals
const { buildPool } = Player

// ── 配置归一化 ────────────────────────────────────────────────────────

test('默认配置即合法配置', () => {
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig('junk'), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG)
})

test('v3 配置不再有 procedural/useCurated 字段', () => {
  assert.equal(DEFAULT_CONFIG.procedural, undefined)
  assert.equal(DEFAULT_CONFIG.useCurated, undefined)
  assert.equal(normalizeConfig({ procedural: true }).procedural, undefined, '旧字段被忽略')
  assert.equal(normalizeConfig({ useCurated: true }).useCurated, undefined)
})

test('volume 钳制 0..1，坏值回退默认', () => {
  assert.equal(normalizeConfig({ volume: 2 }).volume, 1)
  assert.equal(normalizeConfig({ volume: -1 }).volume, 0)
  assert.equal(normalizeConfig({ volume: 0.5 }).volume, 0.5)
  assert.equal(normalizeConfig({ volume: 'loud' }).volume, DEFAULT_CONFIG.volume)
})

test('scene 接受任意非空字符串（纯目录驱动，运行时按库回退）', () => {
  assert.equal(normalizeConfig({ scene: 'rain' }).scene, 'rain')
  assert.equal(normalizeConfig({ scene: 'custom-我家后院' }).scene, 'custom-我家后院')
  assert.equal(normalizeConfig({ scene: 'weird-not-exist' }).scene, 'weird-not-exist', '不再按预制清单校验')
  assert.equal(normalizeConfig({ scene: '' }).scene, DEFAULT_CONFIG.scene, '空串回退默认')
  assert.equal(normalizeConfig({ scene: 123 }).scene, DEFAULT_CONFIG.scene)
})

test('playMode 合法值 + 旧 shuffle 字段迁移', () => {
  assert.equal(normalizeConfig({ playMode: 'shuffle' }).playMode, 'shuffle')
  assert.equal(normalizeConfig({ playMode: 'single-loop' }).playMode, 'single-loop')
  assert.equal(normalizeConfig({ playMode: 'interval' }).playMode, 'interval')
  assert.equal(normalizeConfig({ playMode: 'sequential' }).playMode, 'sequential')
  assert.equal(normalizeConfig({ playMode: 'weird' }).playMode, DEFAULT_CONFIG.playMode, '非法值回退默认')
  assert.equal(normalizeConfig({ shuffle: true }).playMode, 'shuffle', '旧 shuffle=true 迁移')
  assert.equal(normalizeConfig({ shuffle: false }).playMode, 'sequential', '旧 shuffle=false 走默认')
})

test('sleepHours 钳制 0..8', () => {
  assert.equal(normalizeConfig({ sleepHours: 2 }).sleepHours, 2)
  assert.equal(normalizeConfig({ sleepHours: 99 }).sleepHours, 8, '封顶 8')
  assert.equal(normalizeConfig({ sleepHours: -1 }).sleepHours, 0, '底 0')
  assert.equal(normalizeConfig({ sleepHours: 'x' }).sleepHours, DEFAULT_CONFIG.sleepHours)
})

test('sleepAtTime HH:MM 校验', () => {
  assert.equal(normalizeConfig({ sleepAtTime: '23:30' }).sleepAtTime, '23:30')
  assert.equal(normalizeConfig({ sleepAtTime: '00:00' }).sleepAtTime, '00:00')
  assert.equal(normalizeConfig({ sleepAtTime: '' }).sleepAtTime, '', '空=关')
  assert.equal(normalizeConfig({ sleepAtTime: '24:00' }).sleepAtTime, '', '24:00 非法')
  assert.equal(normalizeConfig({ sleepAtTime: '23:60' }).sleepAtTime, '', '60 分非法')
  assert.equal(normalizeConfig({ sleepAtTime: 'abc' }).sleepAtTime, '', '乱串清空')
})

test('libraryRoot 字符串解析为绝对路径，空值/null 清零', () => {
  assert.equal(normalizeConfig({ libraryRoot: '/tmp/sounds' }).libraryRoot, path.resolve('/tmp/sounds'))
  assert.equal(normalizeConfig({ libraryRoot: '' }).libraryRoot, null)
  assert.equal(normalizeConfig({ libraryRoot: null }).libraryRoot, null)
  assert.equal(normalizeConfig({ libraryRoot: 123 }).libraryRoot, null)
})

// ── 纯目录场景扫描 ────────────────────────────────────────────────────

test('scanLibrary：每个子文件夹就是一个场景，有什么算什么', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-amb-scan-'))
  mkdirSync(path.join(tmp, '雨'), { recursive: true })
  mkdirSync(path.join(tmp, 'my-office'), { recursive: true })
  mkdirSync(path.join(tmp, 'empty-folder'), { recursive: true })
  writeFileSync(path.join(tmp, '雨', '01-小雨.mp3'), Buffer.alloc(50))
  writeFileSync(path.join(tmp, '雨', '02-大雨.mp3'), Buffer.alloc(50))
  writeFileSync(path.join(tmp, 'my-office', 'hum.ogg'), Buffer.alloc(50))
  writeFileSync(path.join(tmp, 'not-audio.txt'), Buffer.alloc(10))
  const r = scanLibrary(tmp)
  assert.equal(r.scenes.length, 2, '空文件夹不成场景')
  const yu = r.scenes.find((s) => s.label === '雨')
  assert.ok(yu, '中文文件夹名即场景名')
  assert.equal(yu.id, 'custom-雨')
  assert.equal(yu.custom, true)
  assert.equal(r.files['custom-雨'].length, 2, '文件按序')
  const office = r.scenes.find((s) => s.label === 'my-office')
  assert.ok(office, '英文文件夹名即场景名')
  assert.equal(r.files['custom-my-office'].length, 1)
  rmSync(tmp, { recursive: true, force: true })
})

test('scanLibrary：不存在目录 → 空库', () => {
  const r = scanLibrary('/nonexistent-path-xyz')
  assert.equal(r.scenes.length, 0)
  assert.deepEqual(r.files, {})
})

test('customSceneIdOf 规范化', () => {
  assert.equal(customSceneIdOf('我家后院'), 'custom-我家后院')
  assert.equal(customSceneIdOf('My Office!'), 'custom-my-office')
  assert.equal(customSceneIdOf('  Cozy Room  '), 'custom-cozy-room')
})

test('buildLibraryResponse：场景顺序 = 目录序，无预制/无策展', () => {
  const scan = {
    files: {
      'custom-雨': [{ name: '01.mp3', path: '/x/01.mp3', size: 10, ext: '.mp3' }],
      'custom-cafe': [],
    },
    scenes: [
      { id: 'custom-雨', label: '雨', icon: '📁', custom: true },
      { id: 'custom-cafe', label: 'cafe', icon: '📁', custom: true },
    ],
  }
  const lib = buildLibraryResponse(scan, {})
  assert.ok(Array.isArray(lib.scenes))
  assert.equal(lib.scenes.length, 2)
  const yu = lib.scenes.find((s) => s.id === 'custom-雨')
  assert.equal(yu.tracks.length, 1)
  assert.equal(yu.tracks[0].source, 'file')
  const cafe = lib.scenes.find((s) => s.id === 'custom-cafe')
  assert.equal(cafe.tracks.length, 0, '无文件场景 tracks 空')
  assert.equal(lib.procedural, undefined, '响应不再带程序化字段')
})

// ── 路径安全 + Range ──────────────────────────────────────────────────

test('isPathSafe 拒绝穿越与越界', () => {
  const root = path.resolve('/tmp/sounds')
  assert.equal(isPathSafe(path.join(root, 'rain', 'a.mp3'), root), true)
  assert.equal(isPathSafe(path.join(root, '../../etc/passwd'), root), false)
  assert.equal(isPathSafe('/etc/passwd', root), false)
  assert.equal(isPathSafe('/tmp/sounds', null), false, '无 root 拒绝')
})

test('parseRange 标准与边界', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 }, '后缀范围 = 末尾 100 字节')
  assert.equal(parseRange(null, 1000), null)
  assert.equal(parseRange('bytes=900-2000', 1000), null, '越界拒绝')
  assert.equal(parseRange('bytes=200-100', 1000), null, 'start>end 拒绝')
  assert.equal(parseRange('garbage', 1000), null)
})

// ── 播放器轨筛选 ──────────────────────────────────────────────────────

test('buildPool：收藏 > 跨场景 > 当前场景', () => {
  const library = { scenes: [
    { id: 's1', label: 'S1', tracks: [
      { name: 'a.mp3', source: 'file', index: 0 },
      { name: 'b.mp3', source: 'file', index: 1 },
    ] },
    { id: 's2', label: 'S2', tracks: [
      { name: 'c.mp3', source: 'file', index: 0 },
      { name: 'd.mp3', source: 'file', index: 1 },
    ] },
  ] }
  const s1 = { id: 's1' }
  // 默认：当前场景
  assert.equal(buildPool(s1, library, {}).length, 2)
  assert.ok(buildPool(s1, library, {}).every((t) => t.sceneId === 's1'))
  // 跨场景：全库
  assert.equal(buildPool(s1, library, { crossScene: true }).length, 4)
  // 只播收藏：键匹配（跨场景）
  const favs = { favoritesOnly: true, favorites: ['s1/b.mp3', 's2/c.mp3'] }
  const pool = buildPool(s1, library, favs)
  assert.equal(pool.length, 2)
  assert.deepEqual(pool.map((t) => t.key), ['s1/b.mp3', 's2/c.mp3'])
  // 收藏空 → 空池
  assert.equal(buildPool(s1, library, { favoritesOnly: true, favorites: [] }).length, 0)
  // 非 file 轨不进池
  const lib2 = { scenes: [{ id: 'x', tracks: [ { name: 'u', source: 'url', url: 'http://x', index: 0 }, { name: 'f.mp3', source: 'file', index: 1 } ] }] }
  assert.equal(buildPool({ id: 'x' }, lib2, { crossScene: true }).length, 1)
})

// ── 后台 AI 下载（mock fetch 驱动 wire 形态）──────────────────────────

test('后台 AI 下载：apiproxy 建会话 + 事件泵 + done（mock fetch 驱动 wire 形态）', async () => {
  const { startDownloadJob, serializeDownloadJob, DOWNLOAD_AGENT_PROMPT } = Host.__internals
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts && opts.body ? JSON.parse(opts.body).method : '' })
    const body = JSON.parse(opts.body)
    if (body.method === 'session/create') {
      return { status: 200, json: async () => ({ result: { ok: true, value: { sessionId: 'test-sess-1' } } }) }
    }
    return { status: 200, json: async () => ({ result: { ok: true, value: {} } }) }
  }
  try {
    const events = [
      { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'text', text: '开始搜索场景…' } } },
      { seq: 2, type: 'tool/call', data: { name: 'bash', arguments: { command: 'curl -A dsh-ambient "https://commons.wikimedia.org/..."' } } },
      { seq: 3, type: 'tool/result', data: { message: { content: [{ content: [{ type: 'text', text: 'ok' }] }] } } },
      { seq: 4, type: 'turn/end', data: { reason: 'completed' } },
    ]
    const sessionsSvc = { get: (id) => ({ snapshotEvents: () => events }) }
    const jobs = new Map()
    const job = startDownloadJob({ prompt: DOWNLOAD_AGENT_PROMPT, dir: '/tmp', jobs, logger: { info() {}, warn() {} }, sessions: sessionsSvc })
    assert.ok(job.id, 'job 有 id')
    assert.equal(job.status, 'running', '启动即 running')
    await new Promise((r) => setTimeout(r, 3000))
    const s = serializeDownloadJob(job)
    assert.equal(s.status, 'done', 'turn/end 后 done')
    assert.equal(s.code, 0)
    assert.ok(s.output.includes('开始搜索'), '输出含 assistant 文本')
    assert.ok(s.output.includes('[tool] bash'), '输出含工具调用行')
    assert.ok(s.sessionId === 'test-sess-1', 'sessionId 透出')
    assert.ok(calls.some((c) => c.url.includes('/api/session/create')), '调用 session/create')
    assert.ok(calls.some((c) => c.url.includes('/api/session/prompt')), '调用 session/prompt')
    assert.ok(DOWNLOAD_AGENT_PROMPT.includes('无人值守'), 'prompt 无人值守声明')
    assert.ok(DOWNLOAD_AGENT_PROMPT.includes('INDEX.md'), 'prompt 含索引要求')
    assert.ok(!DOWNLOAD_AGENT_PROMPT.includes('程序化'), 'prompt 不再提程序化')
  } finally {
    globalThis.fetch = realFetch
  }
})
