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
    if (!sc || !sc.trackKey) return
    const favs = new Set(config.favorites || [])
    if (favs.has(sc.trackKey)) favs.delete(sc.trackKey)
    else favs.add(sc.trackKey)
    const next = Object.assign({}, config, { favorites: [...favs] })
    save(next)
    player.setPoolOptions(next, library)
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
    h('div', { style: row },
      h('span', { style: label }, t('favoritesOnly'), h('span', { style: hint }, t('favoritesOnlyHint'))),
      h('input', { type: 'checkbox', checked: !!config.favoritesOnly, onChange: (e) => { const n = Object.assign({}, config, { favoritesOnly: e.target.checked }); save(n); player.setPoolOptions(n, library) } })),
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

function mountMiniPlayer({ t, lang, store, player }) {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147482400;display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(20,22,28,.82);color:#e6e8ec;border:1px solid rgba(127,127,127,.22);border-radius:10px;backdrop-filter:blur(6px);font-size:12px;font-family:var(--dsw-font-family,system-ui,sans-serif);touch-action:none'
  document.body.appendChild(host)

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
  grip.textContent = '⠿'
  grip.title = '拖动'
  grip.style.cssText = 'cursor:grab;color:#8a92a4;user-select:none;font-size:13px;line-height:1;touch-action:none'
  grip.addEventListener('pointerdown', startDrag)
  grip.addEventListener('pointermove', moveDrag)
  grip.addEventListener('pointerup', (e) => { endDrag() })

  // ── 控件 ──
  const playBtn = document.createElement('button')
  playBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;font-size:14px;padding:0 4px'
  const favBtn = document.createElement('button')
  favBtn.style.cssText = 'background:transparent;border:none;color:#e6e8ec;cursor:pointer;font-size:13px;padding:0 2px'
  const sceneSel = document.createElement('select')
  sceneSel.style.cssText = 'font-size:11px;padding:2px 4px;border-radius:5px;border:1px solid rgba(127,127,127,.3);background:transparent;color:#e6e8ec;max-width:140px'
  const nameSpan = document.createElement('span')
  nameSpan.style.cssText = 'opacity:0.7;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  const volSlider = document.createElement('input')
  volSlider.type = 'range'; volSlider.min = 0; volSlider.max = 1; volSlider.step = 0.01
  volSlider.style.cssText = 'width:64px'
  const collapseBtn = document.createElement('button')
  collapseBtn.textContent = '—'
  collapseBtn.title = '收起'
  collapseBtn.style.cssText = 'background:transparent;border:none;color:#8a92a4;cursor:pointer;font-size:13px;padding:0 2px;line-height:1'
  host.appendChild(grip); host.appendChild(playBtn); host.appendChild(favBtn); host.appendChild(sceneSel); host.appendChild(nameSpan); host.appendChild(volSlider); host.appendChild(collapseBtn)

  playBtn.addEventListener('click', () => { if (store.playerState.playing) player.pause(); else player.play() })
  favBtn.addEventListener('click', () => {
    const st = store.playerState
    if (!st || !st.trackKey) return
    const favs = new Set(store.config.favorites || [])
    if (favs.has(st.trackKey)) favs.delete(st.trackKey)
    else favs.add(st.trackKey)
    const next = Object.assign({}, store.config, { favorites: [...favs] })
    store.saveConfig(next)
    player.setPoolOptions(next, store.library)
  })
  sceneSel.addEventListener('change', () => {
    const id = sceneSel.value
    const so = (store.library && store.library.scenes) ? store.library.scenes.find((s) => s.id === id) : null
    if (so) {
      const next = Object.assign({}, store.config, { scene: id, enabled: true })
      store.saveConfig(next)
      player.setScene(so, { config: next, library: store.library })
      player.play()
    }
  })
  volSlider.addEventListener('input', () => {
    // 先捕获值再 setVolume——setVolume→emit→render 会同步把滑块重置回 store.config.volume，
    // 之后再读 slider.value 拿到的是旧值（真机抓过：音量永远存不上）
    const v = Number(volSlider.value)
    player.setVolume(v)
    store.saveConfig(Object.assign({}, store.config, { volume: v }))
  })

  // ── 收缩态：缩成一个小圆球（♪），双职能：拖动 + 点击展开 ──
  const ball = document.createElement('button')
  ball.style.cssText = 'width:38px;height:38px;border-radius:50%;border:1px solid rgba(127,127,127,.3);background:rgba(20,22,28,.85);color:#e6e8ec;cursor:grab;font-size:16px;line-height:1;display:none;touch-action:none'
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

  const render = () => {
    const { config, library, playerState: sc } = store
    if (!config || !config.enabled) { host.style.display = 'none'; return }
    host.style.display = 'flex'
    // 展开控件 vs 收缩圆球
    for (const el of [grip, playBtn, favBtn, sceneSel, nameSpan, volSlider, collapseBtn]) el.style.display = collapsed ? 'none' : ''
    ball.style.display = collapsed ? 'block' : 'none'
    if (collapsed) {
      host.style.padding = '4px'
      ball.textContent = sc && sc.playing ? '♫' : '♪'
      ball.style.color = sc && sc.playing ? '#2ecc71' : '#e6e8ec'
      ball.title = sc && sc.playing ? '正在播放 · 点击展开' : '已暂停 · 点击展开'
      return
    }
    host.style.padding = '8px 12px'
    playBtn.textContent = sc && sc.playing ? '⏸' : '▶'
    playBtn.title = sc && sc.playing ? t('pause') : t('play')
    // 场景下拉
    const scenes = (library && library.scenes) || []
    if (sceneSel.options.length !== scenes.length) {
      sceneSel.innerHTML = ''
      for (const s of scenes) {
        const o = document.createElement('option'); o.value = s.id; o.textContent = s.icon + ' ' + sceneName(s, lang); sceneSel.appendChild(o)
      }
    }
    sceneSel.value = sc ? sc.sceneId : (config.scene || 'rain')
    const so = scenes.find((s) => s.id === (sc ? sc.sceneId : config.scene))
    nameSpan.textContent = (sc && sc.playing ? '▶ ' : '⏸ ') + sceneName(so, lang)
    volSlider.value = config.volume || 0
  }
  store.subscribe(render)
  render()

  return { dispose: () => host.remove() }
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
