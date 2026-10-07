'use strict'

/**
 * dsh-ambient — Client half
 *
 * 两件 UI：
 *
 *   1. 设置页（settings.section，React）：场景选择、音量、播放模式、定时关、
 *      音频根目录 + 即时扫描预览、文件夹命名规则说明、
 *      每场景轨列表、播放控制、状态。
 *   2. 迷你播放器（右下角浮窗，纯 DOM）：播放/暂停 + 场景下拉 + 音量，
 *      不进设置页也能控。
 *
 * 一个 store 持 {config, library, playerState, scanState}，player.onState 触发
 * notify，两个 UI 都订阅。player 单例在 apply() 创建，跨 UI 共享、随设置页
 * 卸载仍存活。
 *
 * 声源：音频文件/直链（场景纯目录驱动，libraryRoot 下有什么文件夹就有什么场景）。
 * 浏览器 autoplay 策略：播放需用户手势（点播放 / 切场景触发）。
 *
 * player.js / noise.js / scenes.js 由构建脚本内联进本文件所在工厂作用域。
 */

const LOCALE_NS = 'settings.dshAmbient'
const API = '/dsh-ambient/api'

// 后台 AI 下载：指令文本在 src/index.js 的 DOWNLOAD_AGENT_PROMPT（host 侧发给 agent），客户端只 POST/轮询任务状态。

const ZH = {
  nav: '场景氛围音',
  intro: '场景氛围音播放器——场景完全由「音频根目录」下的文件夹决定，有什么文件夹就有什么场景，有什么音频就播什么。点下方「🤖 执行下载」让 AI 从 Wikimedia Commons 按 CC0/PD/CC BY 许可分门别类下载到对应文件夹，或自己放音频文件进去。',
  enabled: '启用氛围音',
  enabledHint: '勾选后开始播放当前场景（需点播放或切场景触发，浏览器要求用户手势）。',
  scene: '场景',
  sceneHint: '当前场景——由音频根目录下的文件夹决定，有什么算什么。',
  volume: '音量',
  volumeHint: '主音量（0–100%）。',
  playMode: '播放模式',
  playModeHint: '顺序=按文件名循环；随机=多轨随机；单曲循环=当前轨无限；间歇=放20分钟停5分钟循环。',
  modeSequential: '顺序循环',
  modeShuffle: '随机',
  modeSingleLoop: '单曲循环',
  modeInterval: '间歇（20放5停）',
  crossScene: '跨场景播放',
  crossSceneHint: '勾选后上一首/下一首与循环在全库所有场景间进行；不勾仅在上面选中的场景内。',
  favoritesOnly: '只播收藏',
  favoritesOnlyHint: '勾选后播放池=收藏的轨（跨场景）。先用心形按钮收藏几首。',
  favAdd: '♥ 收藏当前曲目',
  favRemove: '♥ 取消收藏',
  favEmptyHint: '收藏池为空——先播放几首并用心形按钮收藏。',
  sleep: '定时关',
  sleepHint: '播放 N 小时后停，或到指定时刻停（如 23:30）。适合睡前听。',
  sleepOff: '关',
  sleep30m: '30 分钟',
  sleep1h: '1 小时',
  sleep2h: '2 小时',
  sleep4h: '4 小时',
  sleep8h: '8 小时',
  sleepAt: '到指定时刻',
  sleepAtHint: '24 小时制 HH:MM，到点即停（今天已过则明天此时）',
  libraryRoot: '音频根目录',
  libraryRootHint: '本地音频根目录绝对路径。下面按场景名建子文件夹放音频，自动识别。不上传，宿主侧流式读取。',
  libraryRootEmpty: '未设置',
  libraryScan: '扫描',
  libraryScanning: '扫描中…',
  libraryScanResult: '发现 {n} 个场景的音频',
  libraryScanNone: '未发现任何场景音频（检查子文件夹名是否命中场景别名）',
  libraryScanError: '扫描失败：{msg}',
  libraryRules: '文件夹命名规则',
  libraryApply: '应用为根目录',
  libraryRulesBody: '在「音频根目录」下按场景名建子文件夹，每个子文件夹里放该场景的音频文件（.mp3 / .wav / .ogg / .m4a / .flac / .aac / .opus 等）。插件自动识别子文件夹名并归到对应场景。\n\n示例：\n  /你的/声音/根目录/\n    ├── 雨/            （或 rain/）\n    │   ├── 01-小雨.mp3\n    │   └── 02-大雨.mp3\n    ├── 海浪/          （或 ocean/ waves/ 海滩/）\n    │   └── 海浪.mp3\n    ├── 森林/          （或 forest/）\n    ├── 市场/          （或 market/）\n    └── 地铁/          （或 subway/）\n\n支持的文件夹名（中英文均可，不区分大小写）：\n雨/rain · 海浪/ocean/sea/beach/海 · 森林/forest/woods · 风/wind · 篝火/fire/fireplace/campfire · 夜晚/night/crickets/虫鸣 · 溪流/stream/brook · 雷/thunder · 山林/mountain · 沙漠/desert · 鸟鸣/birds · 公园/park · 田野/field/farm/乡村 · 市场/market/bazaar/集市 · 闹市/street/city/traffic/街道 · 地铁/subway/metro · 轮船/ship/boat · 咖啡馆/cafe/coffee · 白噪音/white · 粉噪音/pink · 棕噪音/brown\n\n未命中的子文件夹会成为自定义场景（用文件夹名作场景名）——任意文件夹都自动成场景。音频不会上传，宿主侧直接流式读取播放。',
  downloadTitle: 'AI 下载音频',
  downloadHint: '点击在后台执行：AI 搜 Wikimedia Commons → 跳过已有 → 下载到对应场景文件夹 → 更新 INDEX.md，完成自动刷新库。插件不分发音频。',
  downloadRun: '🤖 执行下载',
  downloadRunStarting: '正在启动后台下载任务…',
  downloadRunning: '后台下载中（AI 搜源 → 下载 → 建文件夹 → 更新索引），完成后自动刷新库…',
  downloadRunDone: 'AI 下载完成 ✓ 库已刷新，新场景可直接播放',
  downloadRunFail: '后台下载失败：{msg}',
  downloadAlready: '已有下载任务在跑，显示其进度',
  tracks: '场景轨列表',
  tracksNone: '此场景文件夹里没有音频文件——放几个进去，或换一个有文件的场景。',
  trackFile: '本地',
  trackUrl: '直链',
  play: '播放',
  pause: '暂停',
  prev: '上一首',
  next: '下一首',
  status: '状态',
  statusPlaying: '播放中',
  statusPaused: '已暂停',
  statusNoTrack: '此场景无可用声源',
  loading: '正在加载…',
  saved: '已保存 ✓',
}
const EN = {
  nav: 'Ambient Sounds',
  intro: 'Scene ambient player — scenes come purely from folders under the audio root: whatever folders exist are the scenes. Click the AI download button to have an agent fetch CC0/PD/CC BY recordings from Wikimedia Commons into the matching folders, or drop your own audio in.',
  enabled: 'Enable ambient',
  enabledHint: 'Starts playing the current scene (click Play or switch scene to trigger — browsers require a gesture).',
  scene: 'Scene',
  sceneHint: 'Scenes are determined by the folders under your audio root — whatever exists.',
  volume: 'Volume',
  volumeHint: 'Master volume (0–100%).',
  playMode: 'Play mode',
  playModeHint: 'Sequential=filename order loop; Shuffle=random; Single-loop=current track forever; Interval=20min on 5min off.',
  modeSequential: 'Sequential',
  modeShuffle: 'Shuffle',
  modeSingleLoop: 'Single loop',
  modeInterval: 'Interval (20on/5off)',
  crossScene: 'Cross-scene',
  crossSceneHint: 'On: prev/next and looping span all scenes in the library; off: within the selected scene only.',
  favoritesOnly: 'Favorites only',
  favoritesOnlyHint: 'Play pool = favorited tracks (across scenes). Favorite a few with the heart button first.',
  favAdd: '♥ Favorite current track',
  favRemove: '♥ Unfavorite',
  sleep: 'Sleep timer',
  sleepHint: 'Stop after N hours, or at a clock time (e.g. 23:30). Good for falling asleep.',
  sleepOff: 'Off',
  sleep30m: '30 min',
  sleep1h: '1 hour',
  sleep2h: '2 hours',
  sleep4h: '4 hours',
  sleep8h: '8 hours',
  sleepAt: 'At clock time',
  sleepAtHint: '24h HH:MM; stops at that time (tomorrow if already passed today)',
  libraryRoot: 'Audio root',
  libraryRootHint: 'Absolute path to your local audio root. Create per-scene subfolders inside; auto-detected. Nothing uploaded — host streams from disk.',
  libraryRootEmpty: 'not set',
  libraryScan: 'Scan',
  libraryScanning: 'Scanning…',
  libraryScanResult: 'Found audio for {n} scene(s)',
  libraryScanNone: 'No scene audio found (check subfolder names match aliases)',
  libraryScanError: 'Scan failed: {msg}',
  libraryRules: 'Folder naming rules',
  libraryApply: 'Apply as root',
  libraryRulesBody: 'Inside the audio root, create one subfolder per scene and put that scene\'s audio files inside (.mp3 / .wav / .ogg / .m4a / .flac / .aac / .opus). Subfolder names are matched to scenes automatically.\n\nExample:\n  /your/sounds/root/\n    ├── rain/\n    │   ├── 01-light.mp3\n    │   └── 02-heavy.mp3\n    ├── ocean/\n    │   └── waves.mp3\n    ├── forest/\n    ├── market/\n    └── subway/\n\nRecognized folder names (case-insensitive, EN/ZH):\nrain/雨 · ocean/sea/beach/海浪 · forest/woods/森林 · wind/风 · fire/fireplace/campfire/篝火 · night/crickets/夜晚 · stream/brook/溪流 · thunder/雷 · mountain/山林 · desert/沙漠 · birds/鸟鸣 · park/公园 · field/farm/乡村 · market/bazaar/市场 · street/city/闹市 · subway/metro/地铁 · ship/boat/轮船 · cafe/coffee/咖啡馆 · white/白噪音 · pink/粉噪音 · brown/棕噪音\n\nUnmatched folders become custom scenes (folder name = scene name) — any folder auto-becomes a scene. Files are NOT uploaded — the host streams them from disk.',
  downloadTitle: 'AI download',
  downloadHint: 'Click to run in background: AI searches Wikimedia Commons → skips already-downloaded → downloads per scene → updates INDEX.md; library auto-refreshes when done. Plugin ships no audio.',
  downloadRun: '🤖 Run download',
  downloadRunStarting: 'Starting background download…',
  downloadRunning: 'Downloading in background (AI searches → downloads → organizes → updates index); library refreshes when done…',
  downloadRunDone: 'AI download finished ✓ library refreshed',
  downloadRunFail: 'Background download failed: {msg}',
  downloadAlready: 'A download job is already running; showing its progress',
  tracks: 'Scene tracks',
  tracksNone: 'No audio files in this scene folder — drop some in, or pick another scene.',
  trackFile: 'file',
  trackUrl: 'url',
  play: 'Play',
  pause: 'Pause',
  prev: 'Prev',
  next: 'Next',
  status: 'Status',
  statusPlaying: 'Playing',
  statusPaused: 'Paused',
  statusNoTrack: 'No source for this scene',
  loading: 'Loading…',
  saved: 'Saved ✓',
}
const LOCALE_DICT = { zh: ZH, en: EN }

/** 取场景显示名（按语言）。 */
function sceneName(scene, lang) {
  if (!scene) return '—'
  return lang === 'en' ? (scene.labelEn || scene.label) : scene.label
}

// ── 设置页（React）──────────────────────────────────────────────────────

function AmbientPanel({ t, lang, store, player }) {
  const h = React.createElement
  const [, setN] = React.useState(0)
  const [runHint, setRunHint] = React.useState('')
  // 后台 AI 下载：POST 起任务 → 轮询状态 → 完成/失败自动刷新库
  const pollDownload = (job, depth) => {
    if (!job || depth > 600) { setRunHint(t('downloadRunFail', { msg: '轮询超时' })); return }
    if (job.status === 'running') {
      const tail = String(job.output || '').trim().split('\n').filter(Boolean).slice(-1)[0] || ''
      setRunHint(t('downloadRunning') + (tail ? '　' + tail.slice(0, 120) : ''))
      setTimeout(async () => {
        try {
          const r = await fetch(API + '/ai-download', { cache: 'no-store' })
          const data = await r.json()
          pollDownload(data.job, depth + 1)
        } catch { setTimeout(() => pollDownload(job, depth + 1), 3000) }
      }, 2500)
    } else if (job.status === 'done') {
      setRunHint(t('downloadRunDone'))
      store.loadLibrary()
    } else {
      setRunHint(t('downloadRunFail', { msg: (String(job.output || '').trim().split('\n').slice(-1)[0] || '未知错误').slice(0, 160) }))
      store.loadLibrary()
    }
  }
  const runDownload = async () => {
    setRunHint(t('downloadRunStarting'))
    try {
      const r = await fetch(API + '/ai-download', { method: 'POST' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const data = await r.json()
      if (data.already) setRunHint(t('downloadAlready'))
      pollDownload(data.job, 0)
    } catch (e) {
      setRunHint(t('downloadRunFail', { msg: (e && e.message) || e }))
    }
  }
  React.useEffect(() => store.subscribe(() => setN((x) => x + 1)), [store])

  const { config, library, playerState: sc, scanState } = store
  if (!config) return h('p', { style: { opacity: 0.7 } }, t('loading'))

  const row = { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.15))' }
  const label = { flex: 1, fontSize: '13px' }
  const hint = { display: 'block', opacity: 0.6, fontSize: '12px', marginTop: '2px' }
  const num = { fontSize: '12px', minWidth: '44px', textAlign: 'right' }
  const btn = { fontSize: '12px', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer' }
  const pre = { fontSize: '11px', lineHeight: 1.6, whiteSpace: 'pre-wrap', opacity: 0.75, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))', padding: '10px 12px', borderRadius: '8px', marginTop: '6px', fontFamily: 'var(--dsw-font-family, monospace)' }

  const scenes = (library && library.scenes) || []
  const sceneObj = scenes.find((s) => s.id === config.scene) || null
  const sceneTracks = sceneObj ? sceneObj.tracks : []

  const save = (next) => store.saveConfig(next)
  const onPickScene = (id) => {
    const next = Object.assign({}, config, { scene: id, enabled: true })
    save(next)
    const so = scenes.find((x) => x.id === id)
    if (so) { player.setScene(so, { config: next, library }); if (next.enabled) player.play() }
  }
  const onVolume = (v) => { player.setVolume(v); save(Object.assign({}, config, { volume: v })) }
  const onPlayPause = () => { if (sc && sc.playing) player.pause(); else player.play() }
  const toggleFavorite = () => {
    let key = sc && sc.trackKey
    if (!key) {
      // 无当前轨：收藏当前场景第一首（或全库第一首），♥ 按下必有反应
      const so = (library.scenes || []).find((x) => x.id === config.scene) || (library.scenes || [])[0]
      const file = so && (so.tracks || []).find((t2) => t2 && t2.source === 'file')
      key = file ? so.id + '/' + file.name : null
    }
    if (!key) return
    const favs = new Set(config.favorites || [])
    if (favs.has(key)) favs.delete(key)
    else favs.add(key)
    save(Object.assign({}, config, { favorites: [...favs] }))
    player.setPoolOptions(Object.assign({}, config, { favorites: [...favs] }), library)
  }

  const doScan = () => {
    const input = document.getElementById('dsh-ambient-root-input')
    const root = input ? input.value.trim() : ''
    if (!root) return
    store.scan(root)
  }

  return h('div', { style: { maxWidth: '600px' } },
    h('p', { style: { opacity: 0.75, fontSize: '13px', lineHeight: 1.6 } }, t('intro')),

    h('div', { style: row },
      h('span', { style: label }, t('enabled'), h('span', { style: hint }, t('enabledHint'))),
      h('input', { type: 'checkbox', checked: !!config.enabled, onChange: (e) => { const n = Object.assign({}, config, { enabled: e.target.checked }); save(n); if (e.target.checked) player.play(); else player.pause() } })),

    h('div', { style: row },
      h('span', { style: label }, t('scene'), h('span', { style: hint }, t('sceneHint'))),
      h('select', { value: config.scene || 'rain', style: { fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' }, onChange: (e) => onPickScene(e.target.value) },
        scenes.map((s) => h('option', { key: s.id, value: s.id }, s.icon + ' ' + sceneName(s, lang))))),

    h('div', { style: row },
      h('span', { style: label }, t('volume'), h('span', { style: hint }, t('volumeHint'))),
      h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: config.volume, onChange: (e) => onVolume(Number(e.target.value)) }),
      h('code', { style: num }, Math.round((config.volume || 0) * 100) + '%')),

    h('div', { style: row },
      h('span', { style: label }, t('playMode'), h('span', { style: hint }, t('playModeHint'))),
      h('select', {
        value: config.playMode || 'sequential',
        style: { fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
        onChange: (e) => { player.setPlayMode(e.target.value); save(Object.assign({}, config, { playMode: e.target.value })) },
      },
        [['modeSequential', 'sequential'], ['modeShuffle', 'shuffle'], ['modeSingleLoop', 'single-loop'], ['modeInterval', 'interval']].map(([k, v]) => h('option', { key: v, value: v }, t(k))))),

    h('div', { style: row },
      h('span', { style: label }, t('crossScene'), h('span', { style: hint }, t('crossSceneHint'))),
      h('input', { type: 'checkbox', checked: !!config.crossScene, onChange: (e) => { const n = Object.assign({}, config, { crossScene: e.target.checked }); save(n); player.setPoolOptions(n, library) } })),
    h('div', { style: Object.assign({}, row, { flexWrap: 'wrap' }) },
      h('span', { style: label }, t('favoritesOnly'), h('span', { style: hint }, t('favoritesOnlyHint'))),
      h('input', { type: 'checkbox', checked: !!config.favoritesOnly, onChange: (e) => { const n = Object.assign({}, config, { favoritesOnly: e.target.checked }); save(n); player.setPoolOptions(n, library) } })),
    config.favoritesOnly && (config.favorites || []).length === 0 && h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-warning, #d19a66)', margin: '-4px 0 4px' } }, '⚠ ' + t('favEmptyHint')),
    h('div', { style: Object.assign({}, row, { flexWrap: 'wrap' }) },
      h('span', { style: label }, t('sleep'), h('span', { style: hint }, t('sleepHint'))),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('select', {
          value: config.sleepAtTime ? 'at' : String(config.sleepHours ?? 0),
          style: { fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
          onChange: (e) => {
            const v = e.target.value
            if (v === 'at') { player.setSleepAtTime(config.sleepAtTime || '23:30'); save(Object.assign({}, config, { sleepAtTime: config.sleepAtTime || '23:30', sleepHours: 0 })) }
            else { const hv = Number(v); player.setSleepMs(hv * 3600 * 1000); save(Object.assign({}, config, { sleepHours: hv, sleepAtTime: '' })) }
          },
        },
          [['sleepOff', 0], ['sleep30m', 0.5], ['sleep1h', 1], ['sleep2h', 2], ['sleep4h', 4], ['sleep8h', 8]].map(([k, v]) => h('option', { key: String(v), value: String(v) }, t(k))).concat([h('option', { key: 'at', value: 'at' }, t('sleepAt'))])),
        config.sleepAtTime ? h('input', {
          type: 'time',
          value: config.sleepAtTime,
          title: t('sleepAtHint'),
          style: { fontSize: '12px', padding: '4px 6px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
          onChange: (e) => { player.setSleepAtTime(e.target.value); save(Object.assign({}, config, { sleepAtTime: e.target.value, sleepHours: 0 })) },
        }) : null)),
    h('div', { style: Object.assign({}, row, { flexDirection: 'column', alignItems: 'stretch' }) },
      h('span', { style: label }, t('libraryRoot'), h('span', { style: hint }, t('libraryRootHint'))),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
        h('input', { type: 'text', id: 'dsh-ambient-root-input', defaultValue: config.libraryRoot || '', placeholder: '/path/to/your/sounds', style: { flex: 1, fontSize: '13px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', fontFamily: 'var(--dsw-font-family, monospace)' } }),
        h('button', { type: 'button', style: btn, onClick: doScan }, scanState._busy ? t('libraryScanning') : t('libraryScan'))),
      h('p', { style: { fontSize: '12px', opacity: 0.75, marginTop: '6px' } }, config.libraryRoot ? '📁 ' + config.libraryRoot : t('libraryRootEmpty')),
      scanState._resultN > 0 && h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-success, #5cd6a8)' } }, t('libraryScanResult', { n: scanState._resultN })),
      scanState._result === false && scanState._resultN === 0 && h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-warning, #d19a66)' } }, t('libraryScanNone')),
      scanState._error && h('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #e06c75)' } }, t('libraryScanError', { msg: scanState._error })),
      h('details', { style: { marginTop: '8px' } },
        h('summary', { style: { fontSize: '12px', cursor: 'pointer', opacity: 0.8 } }, t('libraryRules')),
        h('pre', { style: pre }, t('libraryRulesBody')))),

    // AI 下载音频：单按钮，点击开新对话执行（不显示提示词文本，对齐 dsh-kb「问 AI」设计）
    h('div', { style: row },
      h('span', { style: label }, '🤖 ' + t('downloadTitle'), h('span', { style: hint }, t('downloadHint'))),
      h('button', { type: 'button', style: btn, title: t('downloadHint'), onClick: runDownload }, t('downloadRun'))),
    runHint && h('p', { style: { fontSize: '12px', opacity: 0.75, padding: '0 0 4px', color: 'var(--dsw-alias-label-success, #5cd6a8)' } }, runHint),

    h('h4', { style: { margin: '18px 0 4px', fontSize: '13px' } }, t('tracks')),
    sceneTracks.length === 0
      ? h('p', { style: { fontSize: '12px', opacity: 0.6 } }, t('tracksNone'))
      : h('div', null,
        sceneTracks.map((tr, i) => h('div', { key: i, style: { fontSize: '12px', padding: '3px 0', opacity: 0.8 } }, '· [' + t(tr.source === 'file' ? 'trackFile' : 'trackUrl') + '] ' + tr.name + (tr.license ? ' (' + tr.license + ')' : '')))),

    h('div', { style: Object.assign({}, row, { borderBottom: 'none' }) },
      h('span', { style: label }, t('status'), h('span', { style: hint }, (sc && sc.playing ? '🟢 ' + t('statusPlaying') : sc && sc.mode === 'none' ? '⚫ ' + t('statusNoTrack') : '⚫ ' + t('statusPaused')) + (sc && sc.trackName ? ' · ' + (sc.trackScene ? sc.trackScene + ' / ' : '') + sc.trackName : '') + (sc && sc.poolLen ? '（池 ' + sc.poolLen + '）' : ''))),
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('button', { type: 'button', style: Object.assign({}, btn, sc && sc.isFavorite ? { color: 'var(--dsw-alias-label-warning, #d19a66)' } : null), title: sc && sc.isFavorite ? t('favRemove') : t('favAdd'), onClick: toggleFavorite }, '♥'),
        h('button', { type: 'button', style: btn, onClick: () => player.prevTrack() }, t('prev')),
        h('button', { type: 'button', style: btn, onClick: onPlayPause }, sc && sc.playing ? t('pause') : t('play')),
        h('button', { type: 'button', style: btn, onClick: () => player.nextTrack() }, t('next')))))
}

// ── 迷你播放器（纯 DOM，右下角浮窗）─────────────────────────────────────

// 单色 SVG 图标（Material 风格 24x24，fill=currentColor 跟随按钮 color，无 emoji 渲染差异）
const MINI_ICONS = {
  grip: 'M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18v-2H3v2z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  heart: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z',
  heartFill: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  note: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  volFull: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  volLow: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z',
  volMute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  minus: 'M19 13H5v-2h14v2z',
}
const svgIcon = (name, size) => '<svg viewBox="0 0 24 24" width="' + (size || 14) + '" height="' + (size || 14) + '" fill="currentColor" aria-hidden="true"><path d="' + (MINI_ICONS[name] || '') + '"/></svg>'

function mountMiniPlayer({ t, lang, store, player }) {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147482400;display:flex;flex-direction:column;align-items:stretch;color:#e6e8ec;font-family:var(--dsw-font-family,system-ui,sans-serif);touch-action:none'
  document.body.appendChild(host)
  // 信息行：与控制条同宽紧贴成一张卡；文字超宽自动来回滚动（跑马灯）
  const infoLine = document.createElement('div')
  infoLine.style.cssText = 'display:none;overflow:hidden;white-space:nowrap;font-size:11px;color:#c8cdd8;background:rgba(20,22,28,.72);padding:5px 12px 3px;border:1px solid rgba(127,127,127,.22);border-bottom:none;border-radius:10px 10px 0 0;text-align:left'
  const infoText = document.createElement('span')
  infoText.style.cssText = 'display:inline-block;white-space:nowrap;padding-right:16px'
  infoLine.appendChild(infoText)
  host.appendChild(infoLine)
  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(20,22,28,.82);border:1px solid rgba(127,127,127,.22);border-top:none;border-radius:0 0 10px 10px;backdrop-filter:blur(6px);font-size:12px;touch-action:none'
  host.appendChild(bar)

  const MINI_KEY = 'dsh-ambient-mini'
  const loadMiniState = () => { try { return JSON.parse(localStorage.getItem(MINI_KEY) || 'null') || {} } catch { return {} } }
  const saveMiniState = () => {
    try { localStorage.setItem(MINI_KEY, JSON.stringify({ left: parseInt(host.style.left, 10) || 0, top: parseInt(host.style.top, 10) || 0, collapsed: collapsed })) } catch {}
  }

  // 恢复拖动位置（无存档保持默认右下角）
  const saved = loadMiniState()
  let collapsed = !!saved.collapsed
  if (typeof saved.left === 'number' && typeof saved.top === 'number') {
    host.style.right = 'auto'; host.style.bottom = 'auto'
    host.style.left = saved.left + 'px'; host.style.top = saved.top + 'px'
  }

  // ── 拖动：把手（展开态）或圆球（收缩态）pointer capture，拖完落盘 ──
  let dragState = null
  const startDrag = (e) => {
    const rect = host.getBoundingClientRect()
    dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false, sx: e.clientX, sy: e.clientY }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    document.body.style.userSelect = 'none'
  }
  const moveDrag = (e) => {
    if (!dragState) return
    if (Math.abs(e.clientX - dragState.sx) + Math.abs(e.clientY - dragState.sy) > 4) dragState.moved = true
    const w = host.offsetWidth, h = host.offsetHeight
    const x = Math.max(4, Math.min(e.clientX - dragState.dx, window.innerWidth - w - 4))
    const y = Math.max(4, Math.min(e.clientY - dragState.dy, window.innerHeight - h - 4))
    host.style.left = x + 'px'; host.style.top = y + 'px'
    host.style.right = 'auto'; host.style.bottom = 'auto'
  }
  const endDrag = () => {
    if (!dragState) return
    dragState = null
    document.body.style.userSelect = ''
    saveMiniState()
  }

  const grip = document.createElement('span')
  grip.innerHTML = svgIcon('grip', 14)
  grip.title = '拖动'
  grip.style.cssText = 'cursor:grab;color:#8a92a4;user-select:none;display:flex;line-height:1;touch-action:none'
  grip.addEventListener('pointerdown', startDrag)
  grip.addEventListener('pointermove', moveDrag)
  grip.addEventListener('pointerup', (e) => { endDrag() })

  // ── 控件 ──
  const playBtn = document.createElement('button')
  playBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;padding:0 4px;display:flex;align-items:center'
  const prevBtn = document.createElement('button')
  prevBtn.innerHTML = svgIcon('prev', 14)
  prevBtn.title = t('prev')
  prevBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;padding:0 2px;display:flex;align-items:center'
  const nextBtn = document.createElement('button')
  nextBtn.innerHTML = svgIcon('next', 14)
  nextBtn.title = t('next')
  nextBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;padding:0 2px;display:flex;align-items:center'
  const shufBtn = document.createElement('button')
  shufBtn.innerHTML = svgIcon('shuffle', 13)
  shufBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;padding:0 2px;display:flex;align-items:center'
  const favBtn = document.createElement('button')
  favBtn.innerHTML = svgIcon('heart', 13)
  favBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;padding:0 2px;display:flex;align-items:center'
  // 场景：图标 + 弹出列表（点图标弹出全场景，点条目切换；不回显在播放条上）
  const sceneWrap = document.createElement('div')
  sceneWrap.style.cssText = 'position:relative;display:flex;align-items:center'
  const sceneBtn = document.createElement('button')
  sceneBtn.innerHTML = svgIcon('note', 13)
  sceneBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;padding:0 2px;display:flex;align-items:center'
  const scenePop = document.createElement('div')
  scenePop.style.cssText = 'position:absolute;bottom:26px;right:0;transform:translateX(30%);padding:4px;background:rgba(20,22,28,.92);border:1px solid rgba(127,127,127,.25);border-radius:8px;display:none;z-index:1;max-height:280px;overflow:auto;min-width:130px'
  sceneWrap.appendChild(scenePop); sceneWrap.appendChild(sceneBtn)
  const closeScenePop = () => { scenePop.style.display = 'none'; sceneBtn.dataset.open = '' }
  const toggleScenePop = () => {
    const open = scenePop.style.display !== 'none'
    scenePop.style.display = open ? 'none' : 'block'
    sceneBtn.dataset.open = open ? '' : '1'
    if (!open) renderSceneList()
  }
  sceneBtn.addEventListener('click', (e) => { e.stopPropagation(); closeVolPop(); toggleScenePop() })
  document.addEventListener('click', (e) => { if (sceneBtn.dataset.open && !sceneWrap.contains(e.target)) closeScenePop() })
  // 音量：喇叭图标 + 竖向滑块弹出面板（点图标弹出，比横条省宽）
  const volWrap = document.createElement('div')
  volWrap.style.cssText = 'position:relative;display:flex;align-items:center'
  const volSlider = document.createElement('input')
  volSlider.type = 'range'; volSlider.min = 0; volSlider.max = 1; volSlider.step = 0.01
  volSlider.style.cssText = 'writing-mode:vertical-lr;direction:rtl;width:22px;height:76px;accent-color:#4a7dff;cursor:pointer'
  const volPop = document.createElement('div')
  volPop.style.cssText = 'position:absolute;bottom:26px;left:50%;transform:translateX(-50%);padding:8px 4px;background:rgba(20,22,28,.92);border:1px solid rgba(127,127,127,.25);border-radius:8px;display:none;z-index:1'
  volPop.appendChild(volSlider)
  const volBtn = document.createElement('button')
  volBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;padding:0 2px;display:flex;align-items:center'
  volWrap.appendChild(volPop); volWrap.appendChild(volBtn)
  const collapseBtn = document.createElement('button')
  collapseBtn.innerHTML = svgIcon('minus', 13)
  collapseBtn.title = '收起'
  collapseBtn.style.cssText = 'background:transparent;border:none;color:#8a92a4;cursor:pointer;padding:0 2px;display:flex;align-items:center'
  bar.appendChild(grip); bar.appendChild(prevBtn); bar.appendChild(playBtn); bar.appendChild(nextBtn); bar.appendChild(shufBtn); bar.appendChild(favBtn); bar.appendChild(sceneWrap); bar.appendChild(volWrap); bar.appendChild(collapseBtn)
  // 收起弹出面板（点外部 / 再点图标）
  const closeVolPop = () => { volPop.style.display = 'none'; volBtn.dataset.open = '' }
  const toggleVolPop = () => {
    const open = volPop.style.display !== 'none'
    volPop.style.display = open ? 'none' : 'block'
    volBtn.dataset.open = open ? '' : '1'
    if (!open) volSlider.value = store.config.volume || 0   // 打开时同步当前音量
  }
  volBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleVolPop() })
  document.addEventListener('click', (e) => { if (volBtn.dataset.open && !volWrap.contains(e.target)) closeVolPop() })

  playBtn.addEventListener('click', () => { if (store.playerState.playing) player.pause(); else player.play() })
  prevBtn.addEventListener('click', () => player.prevTrack())
  nextBtn.addEventListener('click', () => player.nextTrack())
  shufBtn.addEventListener('click', () => {
    const cur = (store.playerState && store.playerState.playMode) || (store.config && store.config.playMode) || 'sequential'
    const mode = cur === 'shuffle' ? 'sequential' : 'shuffle'
    player.setPlayMode(mode)
    store.saveConfig(Object.assign({}, store.config, { playMode: mode }))
  })
  favBtn.addEventListener('click', () => {
    const st = store.playerState
    let key = st && st.trackKey
    if (!key) {
      // 无当前轨（如只播收藏+空收藏）：收藏当前场景第一首，再不行全库第一首——按下必有反应
      const scenes = (store.library && store.library.scenes) || []
      const so = scenes.find((x) => x.id === ((st && st.sceneId) || (store.config && store.config.scene))) || scenes[0]
      const file = so && (so.tracks || []).find((t2) => t2 && t2.source === 'file')
      key = file ? so.id + '/' + file.name : null
    }
    if (!key) return
    const favs = new Set(store.config.favorites || [])
    if (favs.has(key)) favs.delete(key)
    else favs.add(key)
    const next = Object.assign({}, store.config, { favorites: [...favs] })
    store.saveConfig(next)
    player.setPoolOptions(next, store.library)
  })
  const pickScene = (so) => {
    if (!so) return
    const next = Object.assign({}, store.config, { scene: so.id, enabled: true })
    store.saveConfig(next)
    player.setScene(so, { config: next, library: store.library })
    player.play()
    closeScenePop()
  }
  volSlider.addEventListener('input', () => {
    // 先捕获值再 setVolume——setVolume→emit→render 会同步把滑块重置回 store.config.volume，
    // 之后再读 slider.value 拿到的是旧值（真机抓过：音量永远存不上）
    const v = Number(volSlider.value)
    player.setVolume(v)
    store.saveConfig(Object.assign({}, store.config, { volume: v }))
  })

  // ── 收缩态：缩成一个小圆球（♪），双职能：拖动 + 点击展开 ──
  const ball = document.createElement('button')
  ball.innerHTML = svgIcon('note', 16)
  ball.style.cssText = 'width:38px;height:38px;border-radius:50%;border:1px solid rgba(127,127,127,.3);background:rgba(20,22,28,.85);color:#e6e8ec;cursor:grab;display:none;align-items:center;justify-content:center;touch-action:none'
  ball.title = '展开迷你播放器（拖动可移位置）'
  host.appendChild(ball)
  ball.addEventListener('pointerdown', startDrag)
  ball.addEventListener('pointermove', moveDrag)
  ball.addEventListener('pointerup', (e) => {
    const wasDrag = dragState && dragState.moved
    endDrag()
    if (!wasDrag) { collapsed = false; render(); saveMiniState() }   // 未移动 → 视为点击展开
  })

  collapseBtn.addEventListener('click', () => { collapsed = true; render(); saveMiniState() })

  const volIcon = (v) => {
    if (v <= 0) return svgIcon('volMute', 14)
    if (v < 0.5) return svgIcon('volLow', 14)
    return svgIcon('volFull', 14)
  }
  /** 构建场景弹出列表（点图标展开时调用 + 状态变化时刷新高亮）。 */
  const renderSceneList = () => {
    const scenes = (store.library && store.library.scenes) || []
    const curId = (store.playerState && store.playerState.sceneId) || (store.config && store.config.scene) || ''
    const rows = [...scenePop.querySelectorAll('[data-sid]')]
    if (rows.length !== scenes.length) {
      scenePop.innerHTML = ''
      for (const x of scenes) {
        const row = document.createElement('div')
        row.dataset.sid = x.id
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;font-size:12px'
        row.innerHTML = '<span>' + (x.icon || '📁') + '</span><span></span>'
        row.lastChild.textContent = sceneName(x, lang)
        row.addEventListener('click', () => pickScene(x))
        scenePop.appendChild(row)
      }
    }
    for (const row of scenePop.querySelectorAll('[data-sid]')) {
      const on = row.dataset.sid === curId
      row.style.background = on ? 'rgba(74,125,255,.35)' : 'transparent'
    }
  }

  const render = () => {
    const { config, library, playerState: sc } = store
    if (!config || !config.enabled) { host.style.display = 'none'; return }
    host.style.display = 'flex'
    volBtn.innerHTML = volIcon(config.volume || 0)
    if (volBtn.dataset.open && Math.abs((Number(volSlider.value) || 0) - (config.volume || 0)) > 0.001) volSlider.value = config.volume || 0
    // 展开控件 vs 收缩圆球
    for (const el of [grip, prevBtn, playBtn, nextBtn, shufBtn, favBtn, sceneWrap, volWrap, collapseBtn]) el.style.display = collapsed ? 'none' : ''
    infoLine.style.display = collapsed || !sc.trackName ? 'none' : 'block'
    if (collapsed) { closeVolPop(); closeScenePop() }
    ball.style.display = collapsed ? 'block' : 'none'
    if (collapsed) {
      host.style.padding = '4px'
      ball.innerHTML = svgIcon('note', 16)
      ball.style.color = sc && sc.playing ? '#2ecc71' : '#e6e8ec'
      ball.title = sc && sc.playing ? '正在播放 · 点击展开' : '已暂停 · 点击展开'
      return
    }
    host.style.padding = '8px 12px'
    playBtn.innerHTML = svgIcon(sc && sc.playing ? 'pause' : 'play', 15)
    playBtn.title = sc && sc.playing ? t('pause') : t('play')
    prevBtn.title = t('prev'); nextBtn.title = t('next')
    const pm = (sc && sc.playMode) || (config && config.playMode) || 'sequential'
    shufBtn.title = pm === 'shuffle' ? t('shuffle') + ' ✓（点击切回顺序）' : t('shuffle')
    shufBtn.style.color = pm === 'shuffle' ? '#2ecc71' : '#e6e8ec'
    const favNow = sc && sc.isFavorite
    favBtn.innerHTML = svgIcon(favNow ? 'heartFill' : 'heart', 13)
    favBtn.title = favNow ? t('favRemove') : t('favAdd')
    favBtn.style.color = favNow ? '#d19a66' : '#e6e8ec'
    // 场景图标 = 当前场景的 icon
    const scenes = (library && library.scenes) || []
    const curId = sc ? sc.sceneId : (config.scene || '')
    const so = scenes.find((x) => x.id === curId)
    sceneBtn.title = so ? t('scene') + ': ' + sceneName(so, lang) : t('scene')
    renderSceneList()
    volSlider.value = config.volume || 0
    // 信息行：当前播放场景+文件（任意按钮点击后立即更新）；超宽来回滚动
    if (sc && sc.trackName) {
      infoLine.style.display = 'block'
      bar.style.borderRadius = '0 0 10px 10px'
      const text = (sc.playing ? '▶ ' : '⏸ ') + sceneName(so, lang) + ' · ' + sc.trackName + (sc.poolFallback ? ' · ⚠ 收藏池空，播放全部' : '')
      if (infoText.dataset.t !== text) {
        infoText.dataset.t = text
        infoText.textContent = text
        infoText.getAnimations().forEach((a) => a.cancel())
        const overflow = infoText.scrollWidth - infoLine.clientWidth
        if (overflow > 4) {
          infoText.animate(
            [{ transform: 'translateX(0)' }, { transform: 'translateX(-' + overflow + 'px)' }, { transform: 'translateX(0)' }],
            { duration: Math.max(5000, overflow * 80), iterations: Infinity, easing: 'ease-in-out' }
          )
        }
      }
    } else {
      infoLine.style.display = 'none'
      bar.style.borderRadius = '10px'
    }
  }
  store.subscribe(render)
  render()

  return { dispose: () => host.remove(), __debug: () => ({ collapsed, hostLeft: host.style.left, hostTop: host.style.top, sceneBtnIcon: sceneBtn.textContent, scenePopRows: scenePop.querySelectorAll('[data-sid]').length }) }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────

module.exports = {
  name: '@weibaohui/dsh-ambient',
  inject: ['slots', 'locale'],

  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const locale = ctx.get('locale')
    const lang = (locale && typeof locale.locale === 'string' ? locale.locale : 'zh').startsWith('en') ? 'en' : 'zh'
    const tRaw = locale && typeof locale.bind === 'function' ? locale.bind(LOCALE_NS) : null
    const t = (key, vars) => {
      let out = (tRaw && tRaw(key)) || ZH[key] || key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    }
    if (locale && typeof locale.register === 'function') {
      ctx.effect(() => locale.register(LOCALE_NS, LOCALE_DICT))
    }

    // ── dsh 会话导航服务（「执行下载」开新对话填 prompt；缺席退回剪贴板）──
    if (typeof ctx.inject === 'function') {
      try { ctx.inject(['uiWorkspace'], (scope) => { uiWorkspaceSvc = scope && (scope.uiWorkspace || scope) }) } catch {}
      try { ctx.inject(['sessions'], (scope) => { sessionsSvc = scope && (scope.sessions || scope) }) } catch {}
    }

    // ── 播放器 + store ─────────────────────────────────────────────────
    const player = createAmbientPlayer()
    const store = {
      config: null, library: null, playerState: { sceneId: null, mode: 'none', playing: false, poolLen: 0, poolIdx: 0, volume: 0.6, playMode: 'sequential', sleepMs: 0, sleepAtTime: '', trackName: null, trackScene: null, trackKey: null, isFavorite: false, intervalOn: null },
      scanState: { _busy: false, _result: null, _resultN: 0, _error: '' },
      listeners: new Set(),
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
      notify() { for (const fn of this.listeners) { try { fn() } catch {} } },
      saveConfig(next) {
        this.config = next
        this.notify()
        fetch(API + '/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
          .then((r) => r.ok ? r.json() : Promise.reject(new Error('bad status')))
          .then((c) => { this.config = c; this.notify(); return this.loadLibrary() })
          .catch(() => this.loadConfig())
      },
      loadConfig() {
        return fetch(API + '/config', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((c) => {
          if (!c) return
          this.config = c
          player.setVolume(c.volume)
          player.setPlayMode(c.playMode || (c.shuffle ? 'shuffle' : 'sequential'))
          if (c.sleepAtTime) player.setSleepAtTime(c.sleepAtTime)
          else player.setSleepMs((c.sleepHours || 0) * 3600 * 1000)
          if (this.library) {
            const scenes = this.library.scenes || []
            let so = scenes.find((x) => x.id === c.scene)
            if (!so && scenes.length > 0) {
              // 场景纯目录驱动：config.scene 可能指向已删文件夹 → 回退第一个场景并写回
              so = scenes[0]
              c.scene = so.id
              this.saveConfig(Object.assign({}, this.config, { scene: so.id }))
            }
            if (so) player.setScene(so, { config: c, library: this.library })
          }
          this.notify()
        }).catch(() => {})
      },
      loadLibrary() {
        return fetch(API + '/library', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((l) => {
          this.library = l
          if (this.config) {
            const scenes = (l && l.scenes) || []
            let so = scenes.find((x) => x.id === this.config.scene)
            if (!so && scenes.length > 0) {
              // 库重扫后 config.scene 可能指向已删文件夹 → 回退第一个场景
              so = scenes[0]
              this.config.scene = so.id
            }
            if (so) player.setScene(so, { config: this.config, library: l })
          }
          this.notify()
        }).catch(() => {})
      },
      scan(root) {
        this.scanState = { _busy: true, _result: null, _resultN: 0, _error: '' }
        this.notify()
        fetch(API + '/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) })
          .then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
          .then((data) => {
            const n = (data.scenes || []).filter((s) => s.tracks.some((tr) => tr.source === 'file')).length
            this.scanState = { _busy: false, _result: data, _resultN: n, _error: '' }
            // 扫描成功即采用为根目录
            this.saveConfig(Object.assign({}, this.config, { libraryRoot: root }))
          })
          .catch((e) => { this.scanState = { _busy: false, _result: false, _resultN: 0, _error: (e && e.message) || 'failed' }; this.notify() })
      },
    }
    player.onState = (s) => { store.playerState = s; store.notify() }
    // 调试探针（真机诊断用）
    window.__dshAmbient = {
      state: () => store.playerState,
      poolDebug: () => player.__debug(),
      miniDebug: () => mini.__debug(),
    }
    ctx.effect(() => () => { try { delete window.__dshAmbient } catch {} }, 'dsh-ambient: debug api')

    store.loadConfig()
    store.loadLibrary()

    // ── 迷你播放器 ─────────────────────────────────────────────────────
    const mini = mountMiniPlayer({ t, lang, store, player })
    ctx.effect(() => () => { mini.dispose(); player.dispose() }, 'dsh-ambient: mini-player + player')

    // ── 设置页 ─────────────────────────────────────────────────────────
    slots.inject('settings.section', () => slots.register(
      {
        name: 'settings.section',
        id: '@weibaohui/dsh-ambient',
        order: 35,
        label: () => t('nav'),
        locale: LOCALE_NS,
      },
      () => React.createElement(AmbientPanel, { t, lang, store, player })
    ))
  },
}
