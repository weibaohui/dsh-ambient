'use strict'

/**
 * dsh-ambient — Host half
 *
 * 把「所在地音频文件夹」翻译成场景氛围音库：
 *
 *   1. 配置持久化：GET/POST /dsh-ambient/api/config，归一后落
 *      storageDomain（域 dsh_ambient），多窗口共享；存储不可用降级内存。
 *   2. 文件夹扫描：config.libraryRoot 指向用户本地音频根目录，结构是
 *      <root>/<场景文件夹>/*.mp3|.wav|.ogg…。子目录名按 client/scenes.js
 *      的别名表（中英文）归到场景 id；未命中别名的目录忽略。扫描结果
 *      合并策展 Wikimedia CC 直链清单，经 GET /dsh-ambient/api/library
 *      返回给客户端：每个场景列出 tracks（file 走宿主流式，url 直接放）。
 *   3. 音频流式：GET /dsh-ambient/api/audio?scene=X&track=N，宿主查库找到
 *      文件绝对路径，校验落在 libraryRoot 内（防穿越），用 Range 头
 *      分块流式（支持 <audio> 拖动进度条）。客户端从不接触绝对路径。
 *   4. 即时扫描：POST /dsh-ambient/api/scan {root} → 扫描一个根目录，
 *      返回发现的库预览（保存前先看），同时把 root 写进 config 触发重扫。
 *
 * 路由信任栅栏沿用 dsh-flow / dsh-matrix 同款：connection.requestRejection
 * 的 Host/Origin 检查 + 浏览器认证。除可选的 dsh-plugin-kit 外零 npm 运行时依赖。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const url = require('node:url')

/**
 * 默认音频库位置：~/.dsh/dsh-ambient/library。用户未显式设 libraryRoot 且此目录
 * 存在时自动采用——配合下载脚本把高质量录音放到这里，开箱即用、无需手动配置。
 */
const DEFAULT_LIBRARY_ROOT = path.join(os.homedir(), '.dsh', 'dsh-ambient', 'library')

const { AUDIO_EXTS, MIME_OF } = require('../client/scenes.js')

const DEFAULT_CONFIG = {
  v: 4,                    // 配置 schema 版本（v4：跨场景 + 收藏）
  crossScene: false,        // true 时播放池=全库所有场景的轨；false=仅当前场景
  favoritesOnly: false,     // true 时播放池=收藏的轨（跨场景）
  favorites: [],            // 收藏列表：['场景id/文件名', …]
  enabled: false,           // 默认关——音频需用户手势启动（浏览器 autoplay 策略）
  scene: 'rain',            // 当前场景 id
  volume: 0.6,              // 0..1 主音量
  playMode: 'sequential',   // sequential 顺序循环 | shuffle 随机 | single-loop 单曲循环 | interval 间歇(20min放5min停)
  sleepHours: 0,            // 0..8 定时关：播放 N 小时后自动停（0=关）；与 sleepAtTime 二选一
  sleepAtTime: '',          // 'HH:MM'（24h）定时关：到指定时刻停（空=关）；设了优先于 sleepHours
  libraryRoot: null,        // 用户音频根目录绝对路径；null 表示未设置
}

/** 播放模式合法值（与客户端 player.js 同源）。 */
const PLAY_MODES = ['sequential', 'shuffle', 'single-loop', 'interval']

const CONFIG_KEY = 'config'
const MAX_BODY_BYTES = 16 * 1024
const SCAN_DEPTH_MAX = 4
const SCAN_FILES_MAX = 2000   // 单场景文件数上限，防 runaway

/** 数值钳制工具。 */
function clamp(v, lo, hi, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, v))
}

/** 配置校验：宽松合并，坏字段回退默认值。 */
function normalizeConfig(raw) {
  const out = Object.assign({}, DEFAULT_CONFIG)
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.scene === 'string' && raw.scene.trim() !== '') out.scene = raw.scene  // 场景纯目录驱动，运行时按库回退
  out.volume = clamp(raw.volume, 0, 1, out.volume)
  // playMode：v1 旧 shuffle 字段迁移（shuffle=true → 'shuffle'）
  if (typeof raw.playMode === 'string' && PLAY_MODES.includes(raw.playMode)) out.playMode = raw.playMode
  else if (raw.shuffle === true) out.playMode = 'shuffle'
  if (typeof raw.crossScene === 'boolean') out.crossScene = raw.crossScene
  if (typeof raw.favoritesOnly === 'boolean') out.favoritesOnly = raw.favoritesOnly
  // favorites：字符串数组（'场景id/文件名'），去重封顶
  if (Array.isArray(raw.favorites)) {
    const seen = new Set()
    out.favorites = raw.favorites.filter((x) => typeof x === 'string' && x.includes('/') && !seen.has(x) && seen.add(x)).slice(0, 500)
  }
  out.sleepHours = clamp(raw.sleepHours, 0, 8, out.sleepHours)
  // sleepAtTime：HH:MM 24h 格式校验，坏值清空
  if (typeof raw.sleepAtTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.sleepAtTime)) out.sleepAtTime = raw.sleepAtTime
  else if (raw.sleepAtTime === '' || raw.sleepAtTime === null) out.sleepAtTime = ''
  if (typeof raw.libraryRoot === 'string' && raw.libraryRoot.trim() !== '') {
    out.libraryRoot = path.resolve(raw.libraryRoot)
  } else if (raw.libraryRoot === null || raw.libraryRoot === '') {
    out.libraryRoot = null
  }
  return out
}

/**
 * 递归收集一个目录下的音频文件（按扩展名）。深度封顶防 runaway。
 * 返回 [{name, path, size, ext}]。纯 fs 调用，离线测试用 mock fs。
 */
function collectAudio(dir, depth, acc) {
  if (depth > SCAN_DEPTH_MAX) return
  if (acc.length > SCAN_FILES_MAX) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch { return }   // 无权限/不存在 → 跳过
  for (const e of entries) {
    if (acc.length > SCAN_FILES_MAX) return
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      collectAudio(full, depth + 1, acc)
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (AUDIO_EXTS.includes(ext)) {
        let size = 0
        try { size = fs.statSync(full).size } catch {}
        acc.push({ name: e.name, path: full, size, ext })
      }
    }
  }
}

/** 把任意目录名规范成自定义场景 id：小写 + 非字母数字 CJK 转连字符。 */
function customSceneIdOf(folderName) {
  const norm = String(folderName || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '')
  return norm ? 'custom-' + norm : 'custom'
}

/**
 * 扫描库根目录，返回 { files: {sceneId:[track]}, scenes:[{id,label,icon,custom}] }。
 * 场景完全由目录驱动：root 下每个子文件夹就是一个场景——文件夹名即场景名，
 * 有什么算什么（没有预制清单、没有别名匹配）。子文件夹递归收音频，
 * 按文件名排序（01-xxx 命名可控顺序）。
 */
function scanLibrary(root) {
  const files = {}
  const scenes = []
  if (!root || typeof root !== 'string') return { files, scenes }
  let rootEntries
  try { rootEntries = fs.readdirSync(root, { withFileTypes: true }) }
  catch { return { files, scenes } }   // root 不存在/无权限 → 空库
  for (const e of rootEntries) {
    if (!e.isDirectory()) continue
    const id = customSceneIdOf(e.name)
    if (!files[id]) { files[id] = []; scenes.push({ id, label: e.name, icon: '📁', custom: true }) }
    const acc = []
    collectAudio(path.join(root, e.name), 0, acc)
    acc.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    files[id] = acc
  }
  // 空文件夹（没有音频文件）不成场景
  const scenesWithFiles = scenes.filter((s) => files[s.id].length > 0)
  return { files, scenes: scenesWithFiles }
}

/**
 * 把扫描结果折成客户端 library 响应。场景顺序 = 目录序（readdir 顺序，
 * 同一目录布局稳定）。每场景 tracks：file → {name,source:'file',index,size,ext}。
 */
function buildLibraryResponse(scanResult, config) {
  const { scenes } = scanResult || { scenes: [] }
  const items = scenes.map((s) => {
    const sceneFiles = (scanResult.files && scanResult.files[s.id]) || []
    const tracks = sceneFiles.map((f, i) => ({ name: f.name, source: 'file', index: i, size: f.size, ext: f.ext }))
    return { id: s.id, label: s.label, labelEn: s.label, icon: s.icon || '📁', custom: true, tracks }
  })
  return { scenes: items, libraryRoot: config.libraryRoot }
}

/** 路径安全：解析后必须落在 libraryRoot 内（防 ../../etc/passwd 穿越）。 */
function isPathSafe(filePath, root) {
  if (!root || typeof root !== 'string') return false
  const resolved = path.resolve(filePath)
  const rootResolved = path.resolve(root)
  // 确保是 root 的子路径（同目录也允许：root 自身的文件，但本插件要求按场景子目录）
  const rel = path.relative(rootResolved, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  return true
}

/** 解析 Range 头，返回 {start, end} 或 null（整文件）。
 *  支持 bytes=start-end / bytes=start- / bytes=-N（后缀 N 字节，即末尾 N 字节）。 */
function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null
  const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return null   // 'bytes=-' 非法
  let start, end
  if (hasStart) {
    start = parseInt(m[1], 10)
    end = hasEnd ? parseInt(m[2], 10) : totalSize - 1
  } else {
    // 后缀范围 bytes=-N → 末尾 N 字节
    const n = parseInt(m[2], 10)
    start = totalSize - n
    end = totalSize - 1
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  if (start < 0 || end >= totalSize || start > end) return null
  return { start, end }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── 后台 AI 下载（照 dsh-sync 的 apiproxy 主会话模式）─────────────────────
// 下载要 bash（curl 二进制音频），agents.create 子 agent 精简无 bash——走
// apiproxy 创建主对话级 session（standard preset + dsh-base 全工具，含 bash）。
// 0.1.2-rc.1 wire：BrowserAuth cookie 由宿主 connection 服务铸造（GET
// authenticatedUrl 303 → dsh-auth-* cookie）；RPC 斜杠端点 + {args:{request}}
// 包裹；0.1.1 回退点号 + 平铺 payload。
const APIPROXY_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
let connectionSvcRef = null
let authedUrlCache = null
let cookieCache = null

async function mintCookie() {
  if (!authedUrlCache && connectionSvcRef && typeof connectionSvcRef.authenticatedUrl === 'function') {
    try { authedUrlCache = connectionSvcRef.authenticatedUrl(APIPROXY_BASE) } catch { authedUrlCache = null }
  }
  if (!authedUrlCache) return null
  let setCookies = []
  try {
    const r = await fetch(authedUrlCache, { redirect: 'manual' })
    setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  } catch { return null }
  for (const sc of setCookies) {
    const pair = String(sc).split(';')[0]
    if (pair && pair.includes('=')) { cookieCache = pair; return cookieCache }
  }
  return null
}

async function apiproxyCall(methodSlash, request, cookie) {
  const rpcId = 'dsamb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const r = await fetch(`${APIPROXY_BASE}/api/${methodSlash}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId, method: methodSlash, payload: { args: { request } } }),
  })
  if (r.status === 401) return { unauthorized: true }
  if (r.status === 404) return { notFound: true }
  const j = await r.json().catch(() => ({}))
  return { res: j.result, raw: JSON.stringify(j).slice(0, 200) }
}

// 0.1.1-rc.2 回退：点号端点 + 平铺 payload、无认证
async function apiproxyLegacy(dotted, request) {
  const rpcId = 'dsamb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const r = await fetch(`${APIPROXY_BASE}/api/${dotted}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: dotted, payload: request }),
  })
  const j = await r.json().catch(() => ({}))
  return j.result
}

async function apiproxy(methodSlash, request) {
  let out = await apiproxyCall(methodSlash, request, cookieCache)
  if (out.unauthorized) out = await apiproxyCall(methodSlash, request, await mintCookie())
  if (out.unauthorized) throw new Error(`apiproxy ${methodSlash}: dsh web 认证失败（无法铸造 BrowserAuth cookie）`)
  if (out.notFound) {
    const res = await apiproxyLegacy(methodSlash.replace('/', '.'), request)
    if (!res || !res.ok) throw new Error(`apiproxy ${methodSlash} 失败: ` + JSON.stringify(res || out.raw).slice(0, 200))
    return res.value
  }
  const res = out.res
  if (!res || !res.ok) throw new Error(`apiproxy ${methodSlash} 失败: ` + JSON.stringify((res && res.error) || out.raw || {}).slice(0, 200))
  return res.value
}

/** 后台 AI 下载任务的超时与输出上限。 */
const DOWNLOAD_RUN_TIMEOUT_MS = 30 * 60 * 1000   // 30 分钟（搜索限流退避 + 多文件下载 + 收尾清单）
const DOWNLOAD_OUTPUT_CAP = 16 * 1024

/** 无人值守下载指令（发给后台 agent；含 INDEX.md 跳过检查 + 署名要求）。 */
const DOWNLOAD_AGENT_PROMPT = `为 dsh-ambient 插件下载高质量氛围音到本地库。无人值守执行：直接开始，不要向用户提问；完成后输出已下载文件清单。

目标目录：~/.dsh/dsh-ambient/library/
（已存在的文件跳过；每下载一个文件就更新该目录的 INDEX.md 与 ATTRIBUTION.txt）

先读 INDEX.md（若存在）：已在表里的来源 URL 跳过、不重复下载。

按场景建子文件夹，每个文件夹放该场景的音频文件（.mp3/.wav/.ogg/.m4a/.flac）。文件夹名中英文均可、不区分大小写；未命中内置场景别名的文件夹会成为自定义场景。已有场景（不必重复，除非补第 2/3 个文件）：雨/rain、海浪/ocean、森林/forest、风/wind、篝火/fire、夜晚/night、溪流/stream、雷/thunder、鸟鸣/birds、公园/park、市场/market、闹市/street、地铁/subway、咖啡馆/cafe、瀑布（自定义）。

优先补充缺失场景：山林/mountain、沙漠/desert、轮船/ship/boat、田野/field/farm/meadow、白噪音/white-noise、粉噪音/pink-noise、棕噪音/brown-noise（若无真实录音可用 ffmpeg/sox 合成白/粉/棕噪音 ogg，没有则跳过）。

已知结论（2026-10 两轮穷举实测）：山林/沙漠/轮船/田野在 Wikimedia Commons 无合适录音（关键词/分类/录音师用户全试过）——这些场景每个搜索预算不超过 2 分钟，搜不到就跳过该文件夹。把搜索预算留给已有场景的高质量补充（第 2/3 个文件）。

音频来源：Wikimedia Commons API（免 key）：
  curl -A "dsh-ambient/0.1" "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=<场景英文>+sound+filetype:audio&gsrnamespace=6&prop=imageinfo&iiprop=url|size|extmetadata&format=json&gsrlimit=8"
imageinfo[].url 即直链。下载带 User-Agent。每个场景选 1-3 个高质量文件（优先 wav/flac）。许可优先级：Public Domain / CC0 > CC BY 4.0 > CC BY-SA。

每下载一个文件，往 INDEX.md 的表格追加一行（| 文件 | 场景目录 | 来源页 URL | 直链 | 许可 | 作者 | 大小 | 下载日期 |），并往 ATTRIBUTION.txt 追加署名。

不要上传任何文件，只下载到本地这个目录。`

/**
 * 后台跑下载（apiproxy 主会话 + 事件泵 + turn/end 收尾）。
 * 形状照 dsh-sync runAgentViaApiproxy：session/create → session/prompt(queue)
 * → ctx.sessions.get 泵 300ms → turn/end 或超时 → job.status。
 */
async function runDownloadViaApiproxy({ prompt, dir, job, sessions, logger }) {
  try {
    const created = await apiproxy('session/create', { cwd: dir })
    const sessionId = created && created.sessionId
    if (!sessionId) throw new Error('session/create 未返回 sessionId')
    job.sessionId = sessionId
    await apiproxy('session/prompt', {
      requestId: 'dsamb-' + randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    })
    let session
    try { session = sessions.get(sessionId) } catch (e) { throw new Error('ctx.sessions.get 失败: ' + (e && e.message)) }
    const seen = new Set()
    const liveLine = (text) => { job.output = (job.output + text).slice(-DOWNLOAD_OUTPUT_CAP) }
    let finished = false
    const pump = () => {
      let evs = []
      try {
        if (session && typeof session.snapshotEvents === 'function') evs = session.snapshotEvents() || []
        else if (session && Array.isArray(session.events)) evs = session.events
      } catch { evs = [] }
      if (!Array.isArray(evs)) evs = []
      for (const ev of evs) {
        const seq = ev.seq
        if (seq != null && seen.has(seq)) continue
        if (seq != null) seen.add(seq)
        const d = ev.data || ev
        const ty = ev.type
        if (ty === 'assistant/chunk' && d.chunk && d.chunk.type === 'text' && d.chunk.text) liveLine(d.chunk.text)
        else if (ty === 'tool/call') {
          const args = d.arguments || d.input || {}
          const cmd = (args && typeof args === 'object' ? (args.command || JSON.stringify(args)) : String(args))
          liveLine('\n[tool] ' + (d.name || '?') + ' ' + String(cmd).slice(0, 200) + '\n')
        } else if (ty === 'tool/result') {
          let rc = ''
          const msg = d.message || d
          const outer = (msg && Array.isArray(msg.content)) ? msg.content : (Array.isArray(d.content) ? d.content : [])
          for (const it of outer) {
            const inner = it && it.content
            if (Array.isArray(inner)) { for (const x of inner) { if (x && x.text) rc += x.text } }
            else if (typeof inner === 'string') rc += inner
          }
          if (rc) liveLine('-> ' + rc.slice(0, 240) + '\n')
        } else if (ty === 'turn/end') finished = true
      }
    }
    const timer = setInterval(pump, 300)
    if (typeof timer.unref === 'function') timer.unref()
    const deadline = Date.now() + DOWNLOAD_RUN_TIMEOUT_MS
    await new Promise((resolve) => {
      const wait = setInterval(() => { if (finished || Date.now() > deadline) { clearInterval(wait); resolve() } }, 500)
      if (typeof wait.unref === 'function') wait.unref()
    })
    clearInterval(timer); pump()
    job.status = finished ? 'done' : 'error'
    job.code = finished ? 0 : 1
    if (!finished) job.output += '\n[超时未完成]'
    job.finishedAt = new Date().toISOString()
  } finally {
    if (typeof job.onFinish === 'function') { try { job.onFinish() } catch {} }
  }
  return job
}

/** 起 download job（单并发由调用方保证）；立即返回 job（后台跑）。 */
function startDownloadJob({ prompt, dir, jobs, logger, sessions, onFinish }) {
  const id = 'dl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const job = { id, status: 'running', startedAt: new Date().toISOString(), dir, output: '', code: null, onFinish }
  jobs.set(id, job)
  if (!sessions || typeof sessions.get !== 'function') {
    job.status = 'error'
    job.output = 'sessions 服务不可用（动态 ctx.inject 失败）'
    job.finishedAt = new Date().toISOString()
    if (typeof onFinish === 'function') { try { onFinish() } catch {} }
    return job
  }
  runDownloadViaApiproxy({ prompt, dir, job, sessions, logger })
    .catch(e => { job.status = 'error'; job.output = (job.output + '\n' + String(e && e.message)).slice(-DOWNLOAD_OUTPUT_CAP); job.finishedAt = new Date().toISOString() })
  return job
}

/** 序列化 job 给客户端（output 截尾，不暴露绝对路径细节）。 */
function serializeDownloadJob(job) {
  if (!job) return null
  return {
    id: job.id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
    code: job.code, sessionId: job.sessionId,
    output: String(job.output || '').slice(-1500),
  }
}

module.exports = {
  name: 'dsh-ambient',
  inject: ['webServer', 'connection', 'storageDomain'],

  // 供离线测试断言；Cordis 忽略多余导出属性。
  __internals: {
    normalizeConfig, DEFAULT_CONFIG, PLAY_MODES,
    isPathSafe, parseRange, scanLibrary, buildLibraryResponse, customSceneIdOf,
    apiproxy, apiproxyCall, apiproxyLegacy, mintCookie, startDownloadJob, serializeDownloadJob, runDownloadViaApiproxy, DOWNLOAD_AGENT_PROMPT,
  },

  apply(ctx) {
    // ── 配置持久化 ───────────────────────────────────────────────────────
    const domainPromise = ctx.storageDomain.open({
      name: 'dsh_ambient',
      version: 1,
      invalidRecords: 'backup-and-skip',
      // valueSchema 缺失会让存量记录打不开整个域（dsh-matrix/fireworks 同款事故）
      tables: { config: { valueSchema: { parse: (v) => v } } },
    })
    let configTable = null
    let config = DEFAULT_CONFIG
    domainPromise.then((domain) => {
      configTable = domain.table('config')
      const stored = configTable.get(CONFIG_KEY)
      if (stored && typeof stored === 'object') config = normalizeConfig(stored)
      // 自动检测默认库：未显式设 libraryRoot 且 ~/.dsh/dsh-ambient/library 存在时采用
      if (!config.libraryRoot) {
        try {
          if (fs.existsSync(DEFAULT_LIBRARY_ROOT) && fs.statSync(DEFAULT_LIBRARY_ROOT).isDirectory()) {
            config.libraryRoot = DEFAULT_LIBRARY_ROOT
          }
        } catch { /* 默认库不存在则保持 null */ }
      }
    }).catch(() => { /* 存储不可用时用内存默认配置 */ })
    ctx.effect(() => () => {
      domainPromise.then((domain) => domain.close()).catch(() => {})
    }, 'dsh-ambient: storage close')

    // ── 库扫描（内存态，root 变化时重扫）────────────────────────────────
    let scanResult = { files: {}, customScenes: [] }
    const rescan = () => {
      const root = config && config.libraryRoot
      if (!root) { scanResult = { files: {}, customScenes: [] }; return }
      try { scanResult = scanLibrary(root) }
      catch { scanResult = { files: {}, customScenes: [] } }   // 扫描失败不拖垮宿主
    }
    domainPromise.then(() => rescan()).catch(() => {})
    ctx.effect(() => () => {}, 'dsh-ambient: library holder')

    // ── 后台 AI 下载：sessions（读事件流）+ connection（铸 cookie）服务接线 ──
    let sessionsSvcRef = null
    if (ctx.inject && typeof ctx.inject === 'function') {
      try { ctx.inject(['sessions'], (svcs) => { sessionsSvcRef = svcs && svcs.sessions }) } catch {}
      try { ctx.inject(['connection'], (svcs) => { connectionSvcRef = svcs && svcs.connection }) } catch {}
    }
    if (ctx.connection && typeof ctx.connection.authenticatedUrl === 'function') connectionSvcRef = ctx.connection
    const downloadJobs = new Map()

    // ── HTTP 路由 ──────────────────────────────────────────────────────────
    ctx.effect(() => {
      const disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-ambient/api',
        handler: async (req, res) => {
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection)
            res.end()
            return
          }
          try {
            const u = new URL(req.url || '/', 'http://dsh.local')
            const apiPath = u.pathname.replace(/\/+$/, '')
            const sendJson = (status, payload) => {
              res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(payload))
            }

            // GET /dsh-ambient/api/config → 当前配置
            if (req.method === 'GET' && apiPath.endsWith('/dsh-ambient/api/config')) {
              sendJson(200, config)
              return
            }

            // POST /dsh-ambient/api/config → 保存配置
            if (req.method === 'POST' && apiPath.endsWith('/dsh-ambient/api/config')) {
              const body = await readBody(req, MAX_BODY_BYTES)
              let parsed
              try { parsed = JSON.parse(body) } catch { sendJson(400, { error: 'bad json' }); return }
              const prevRoot = config && config.libraryRoot
              config = normalizeConfig(parsed)
              try { await domainPromise; if (configTable) await configTable.put(CONFIG_KEY, config) } catch { /* 降级内存 */ }
              if (config.libraryRoot !== prevRoot) rescan()
              sendJson(200, config)
              return
            }

            // GET /dsh-ambient/api/library → 场景库（纯目录驱动，有什么算什么）
            if (req.method === 'GET' && apiPath.endsWith('/dsh-ambient/api/library')) {
              sendJson(200, buildLibraryResponse(scanResult, config))
              return
            }

            // POST /dsh-ambient/api/scan {root} → 扫描根目录预览（不落盘）
            if (req.method === 'POST' && apiPath.endsWith('/dsh-ambient/api/scan')) {
              const body = await readBody(req, MAX_BODY_BYTES)
              let parsed = {}
              try { parsed = JSON.parse(body || '{}') } catch { sendJson(400, { error: 'bad json' }); return }
              const root = typeof parsed.root === 'string' ? path.resolve(parsed.root) : ''
              if (root === '') { sendJson(400, { error: 'root required' }); return }
              let scanPreview
              try { scanPreview = scanLibrary(root) }
              catch (e) { sendJson(500, { error: (e && e.message) || 'scan failed' }); return }
              const preview = buildLibraryResponse(scanPreview, Object.assign({}, config, { libraryRoot: root }))
              // 附每个场景文件数，方便 UI 提示
              sendJson(200, preview)
              return
            }

            // POST /dsh-ambient/api/ai-download → 后台起 AI 下载任务（单并发；完成自动重扫）
            if (req.method === 'POST' && apiPath.endsWith('/dsh-ambient/api/ai-download')) {
              const running = [...downloadJobs.values()].find((j) => j.status === 'running')
              if (running) { sendJson(200, { job: serializeDownloadJob(running), already: true }); return }
              if (!sessionsSvcRef || typeof sessionsSvcRef.get !== 'function') {
                sendJson(503, { error: 'sessions 服务不可用，无法后台执行 AI 下载' })
                return
              }
              const job = startDownloadJob({
                prompt: DOWNLOAD_AGENT_PROMPT,
                dir: os.homedir(),
                jobs: downloadJobs,
                logger: ctx.logger,
                sessions: sessionsSvcRef,
                onFinish: () => { try { rescan() } catch {} },   // 下载完成自动重扫库
              })
              ctx.logger.info && ctx.logger.info(`dsh-ambient: AI 下载任务已启动 ${job.id}`)
              sendJson(200, { job: serializeDownloadJob(job) })
              return
            }

            // GET /dsh-ambient/api/ai-download → 最近一次下载任务状态
            if (req.method === 'GET' && apiPath.endsWith('/dsh-ambient/api/ai-download')) {
              const jobs = [...downloadJobs.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
              sendJson(200, { job: serializeDownloadJob(jobs[0] || null) })
              return
            }

            // GET /dsh-ambient/api/audio?scene=X&track=N → 流式音频文件（Range 支持）
            if (req.method === 'GET' && apiPath.endsWith('/dsh-ambient/api/audio')) {
              const sceneId = u.searchParams.get('scene')
              const trackIdx = parseInt(u.searchParams.get('track') || '0', 10)
              const sceneTracks = scanResult.files[sceneId]
              if (!sceneTracks || !Array.isArray(sceneTracks) || trackIdx < 0 || trackIdx >= sceneTracks.length) {
                sendJson(404, { error: 'track not found' })
                return
              }
              const track = sceneTracks[trackIdx]
              if (!track || typeof track.path !== 'string') {
                sendJson(404, { error: 'track not found' })
                return
              }
              // 路径安全：必须落在 libraryRoot 内
              if (!isPathSafe(track.path, config.libraryRoot)) {
                sendJson(403, { error: 'path outside library root' })
                return
              }
              let stat
              try { stat = fs.statSync(track.path) }
              catch { sendJson(404, { error: 'file not on disk' }); return }
              const totalSize = stat.size
              const mime = MIME_OF[track.ext] || 'application/octet-stream'
              const range = parseRange(req.headers.range, totalSize)
              if (range) {
                const chunkSize = range.end - range.start + 1
                res.writeHead(206, {
                  'Content-Type': mime,
                  'Content-Length': String(chunkSize),
                  'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
                  'Accept-Ranges': 'bytes',
                  'Cache-Control': 'no-store',
                })
                const stream = fs.createReadStream(track.path, { start: range.start, end: range.end })
                stream.on('error', () => { try { res.end() } catch {} })
                stream.pipe(res)
                return
              }
              // 整文件
              res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': String(totalSize),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
              })
              const stream = fs.createReadStream(track.path)
              stream.on('error', () => { try { res.end() } catch {} })
              stream.pipe(res)
              return
            }

            sendJson(404, { error: `no route for ${req.method} ${apiPath}` })
          } catch (e) {
            try {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: (e && e.message) || 'internal error' }))
            } catch { /* res 可能已部分写出 */ }
          }
        },
      })
      return () => {
        try { if (typeof disposeRoute === 'function') disposeRoute() } catch {}
      }
    }, 'dsh-ambient: api')
  },
}
