'use strict'

/**
 * dsh-ambient — 播放控制器
 *
 * 声源：音频文件（HTML5 Audio 元素，本地文件走宿主流式
 * /dsh-ambient/api/audio?scene=<场景id>&track=<文件下标>）。
 *
 * 曲池（pool）抽象——实际参与播放/切轨的曲目列表，按配置决定：
 *   favoritesOnly → 收藏的轨（'场景id/文件名' 键匹配 config.favorites）
 *   crossScene    → 全库所有场景的轨
 *   默认           → 当前选中场景的轨
 * 空池回退：收藏/跨场景池为空时自动回退全库（poolFallback=true），控制永不变死。
 *
 * 播放模式（playMode，与 src/index.js PLAY_MODES 同源）：
 *   sequential 顺序循环 | shuffle 随机 | single-loop 单曲循环 | interval 间歇(20放5停)
 *
 * 智能音量（淡入淡出）：起播/切歌/恢复 → 从 0 缓缓淡入 FADE_IN_MS；
 * 暂停/定时关/切场景/间歇停 → 缓缓淡出后停。音量主体保持用户设定恒定，
 * 只有边界渐变——避免切歌瞬间炸耳。手动调节音量即时生效。
 *
 * 定时关：sleepMs（N 小时后）或 sleepAtTime（HH:MM 到点），0/空=关。
 * 浏览器 autoplay 策略：play() 需用户手势。
 */

const PLAYER_API = '/dsh-ambient/api'
const PLAY_MODES = ['sequential', 'shuffle', 'single-loop', 'interval']

const FADE_IN_MS = 3000        // 起播/切歌淡入（3 秒，明显可感知）
const FADE_OUT_MS = 2500       // 暂停/切出淡出（2.5 秒）
const FADE_SWITCH_MS = 1200    // 手动切歌交叉淡化（1.2 秒）
const FADE_SCENE_MS = 1200     // 切场景淡出
const FADE_INTERVAL_MS = 3500  // 间歇模式进出缓变
const FADE_SLEEP_MS = 4000     // 定时关长淡出
const INTERVAL_ON_MS = 20 * 60 * 1000
const INTERVAL_OFF_MS = 5 * 60 * 1000

/**
 * 曲池构建：收藏 > 跨场景 > 当前场景。纯函数（离线测试直接断言）。
 */
function buildPool(scene, library, cfg) {
  cfg = cfg || {}
  const scenes = (library && library.scenes) || []
  const all = []
  for (const s of scenes) {
    for (const t of (s.tracks || [])) {
      if (!t || t.source !== 'file') continue
      all.push({ sceneId: s.id, sceneLabel: s.label, name: t.name, fileIndex: t.index, key: s.id + '/' + t.name })
    }
  }
  if (cfg.favoritesOnly) {
    const favs = new Set(cfg.favorites || [])
    return all.filter((t) => favs.has(t.key))
  }
  if (cfg.crossScene) return all
  const cur = scene ? scenes.find((s) => s.id === scene.id) : null
  if (!cur) return all
  return all.filter((t) => t.sceneId === cur.id)
}

function createAmbientPlayer() {
  const audio = typeof Audio !== 'undefined' ? new Audio() : null
  if (audio) { audio.preload = 'auto'; audio.crossOrigin = 'anonymous' }

  let currentScene = null
  let library = null
  let poolCfg = {}
  let pool = []
  let poolIdx = 0
  let volume = 0.6
  let playMode = 'sequential'
  let sleepMs = 0
  let sleepAtTime = ''
  let playing = false
  let onState = null

  let sleepTimer = null
  let intervalTimer = null
  let intervalOn = true
  let poolFallback = false

  // ── 淡入淡出引擎（音量主体恒定，边界渐变）──
  let fadeVol = 0          // 0..1 当前淡入系数
  let fadeTimer = null
  const applyVol = () => { if (audio) audio.volume = Math.min(1, Math.max(0, volume * fadeVol)) }
  const stopFade = () => { if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null } }
  const fadeTo = (target, ms, done) => {
    stopFade()
    const from = fadeVol
    if (ms <= 0 || Math.abs(from - target) < 0.01) { fadeVol = target; applyVol(); if (done) done(); return }
    const t0 = Date.now()
    fadeTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - t0) / ms)
      fadeVol = from + (target - from) * t
      applyVol()
      if (t >= 1) { stopFade(); if (done) done() }
    }, 40)
    if (typeof fadeTimer.unref === 'function') fadeTimer.unref()
  }

  const emit = () => { if (typeof onState === 'function') { try { onState(state()) } catch {} } }
  const current = () => pool[poolIdx] || null
  const state = () => {
    const p = current()
    const favs = new Set(poolCfg.favorites || [])
    return {
      sceneId: currentScene ? currentScene.id : null,
      mode: pool.length > 0 ? 'file' : 'none',
      poolLen: pool.length, poolIdx, poolFallback,
      volume, playMode, sleepMs, sleepAtTime, playing,
      trackName: p ? p.name : null,
      trackScene: p ? p.sceneLabel : null,
      trackKey: p ? p.key : null,
      isFavorite: p ? favs.has(p.key) : false,
      intervalOn: playMode === 'interval' ? intervalOn : null,
    }
  }

  const silenceAudio = () => {
    if (audio) {
      try { audio.pause() } catch {}
      audio.removeAttribute('src')
      try { audio.load() } catch {}
    }
  }
  const clearTimers = () => {
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
  }
  const silence = () => { clearTimers(); stopFade(); fadeVol = 0; silenceAudio() }

  const computeLoop = () => (playMode === 'single-loop' || playMode === 'interval') || pool.length === 1

  /** 播一条：音量从 0 淡入到设定值。 */
  const playEntry = (p) => {
    if (!audio || !p) return
    audio.src = PLAYER_API + '/audio?scene=' + encodeURIComponent(p.sceneId) + '&track=' + p.fileIndex
    audio.loop = computeLoop()
    fadeVol = 0; applyVol()
    audio.play().catch(() => { /* autoplay 被拦：等用户手势 */ })
    fadeTo(1, FADE_IN_MS)
  }

  const startInterval = () => {
    stopInterval()
    intervalOn = true
    const tick = () => {
      if (!playing) return
      if (intervalOn) {
        intervalOn = false
        fadeTo(0, FADE_INTERVAL_MS, () => { silenceAudio(); emit() })
        intervalTimer = setTimeout(tick, INTERVAL_OFF_MS)
      } else {
        intervalOn = true
        resumePlayback()
        intervalTimer = setTimeout(tick, INTERVAL_ON_MS)
      }
    }
    intervalTimer = setTimeout(tick, INTERVAL_ON_MS)
  }
  const stopInterval = () => { if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null } }

  const startSleep = () => {
    if (sleepTimer) clearTimeout(sleepTimer)
    const ms = sleepAtTime ? msUntilNext(sleepAtTime) : (sleepMs > 0 ? sleepMs : 0)
    if (ms > 0) sleepTimer = setTimeout(() => { fadeTo(0, FADE_SLEEP_MS, () => { playing = false; silenceAudio(); emit() }) }, ms)
  }

  const resumePlayback = () => { playEntry(current()) }

  if (audio) {
    audio.addEventListener('ended', () => {
      if (playMode === 'single-loop' || playMode === 'interval') return  // loop=true 不触发，兜底
      nextTrack()   // 自然播完：下一首自带淡入
    })
  }

  const nextIdx = (cur, n) => {
    if (n <= 1) return 0
    if (playMode === 'shuffle') { let r = cur; while (r === cur) r = Math.floor(Math.random() * n); return r }
    return (cur + 1) % n
  }

  /** 带快速淡出的切轨（手动 ⏮⏭）。 */
  const switchTrack = (idx) => {
    poolIdx = idx
    const doPlay = () => { playEntry(current()); emit() }
    if (audio && !audio.paused && audio.src) fadeTo(0, FADE_SWITCH_MS, doPlay)
    else doPlay()
  }

  const nextTrack = () => { if (pool.length === 0) return; switchTrack(nextIdx(poolIdx, pool.length)) }
  const prevTrack = () => { if (pool.length === 0) return; switchTrack((poolIdx - 1 + pool.length) % pool.length) }

  const initPoolIdx = () => {
    if (pool.length === 0) return 0
    if (playMode === 'shuffle') return Math.floor(Math.random() * pool.length)
    if (currentScene) {
      const i = pool.findIndex((p) => p.sceneId === currentScene.id)
      if (i >= 0) return i
    }
    return 0
  }

  /** 构建池；收藏/跨场景池为空时回退全库（保证播放控制永远可用）。 */
  const applyPool = (keepKey) => {
    pool = buildPool(currentScene, library, poolCfg)
    if (pool.length === 0 && (poolCfg.favoritesOnly || poolCfg.crossScene)) {
      pool = buildPool(currentScene, library, {})
      poolFallback = true
    } else {
      poolFallback = false
    }
    const keepIdx = keepKey ? pool.findIndex((p) => p.key === keepKey) : -1
    if (keepIdx >= 0) poolIdx = keepIdx
    else poolIdx = initPoolIdx()
  }

  const setScene = (scene, opts) => {
    opts = opts || {}
    currentScene = scene
    library = opts.library || library
    poolCfg = {
      favoritesOnly: opts.config ? !!opts.config.favoritesOnly : false,
      crossScene: opts.config ? !!opts.config.crossScene : false,
      favorites: opts.config ? (opts.config.favorites || []) : [],
    }
    const doSwitch = () => {
      applyPool()
      if (playing && pool.length > 0) { resumePlayback(); if (playMode === 'interval') startInterval() }
      emit()
    }
    // 旧声源在放 → 短淡出再切；新轨再淡入
    if (audio && !audio.paused && audio.src) fadeTo(0, FADE_SCENE_MS, () => { silenceAudio(); doSwitch() })
    else { silenceAudio(); doSwitch() }
  }

  /** 曲池选项变化（跨场景/收藏/只播收藏）→ 重建池；当前轨仍在池内则无缝续播。 */
  const setPoolOptions = (cfg, lib) => {
    poolCfg = {
      favoritesOnly: cfg ? !!cfg.favoritesOnly : false,
      crossScene: cfg ? !!cfg.crossScene : false,
      favorites: cfg ? (cfg.favorites || []) : [],
    }
    library = lib || library
    const keep = current()
    applyPool(keep ? keep.key : null)
    if (playing) {
      if (pool.length > 0) { applyVol(); if (playMode === 'interval') startInterval() }
      else silenceAudio()
    }
    emit()
  }

  const play = () => {
    playing = true
    if (pool.length > 0) {
      if (audio && audio.src && audio.paused) {
        // 暂停恢复：原位置淡入
        audio.play().catch(() => {})
        fadeTo(1, FADE_IN_MS)
      } else {
        resumePlayback()   // 全新起播（playEntry 自带淡入）
      }
      if (playMode === 'interval') startInterval()
      if (sleepMs > 0 || sleepAtTime) startSleep()
    }
    emit()
  }
  const pause = () => {
    playing = false
    clearTimers()
    const done = () => { if (audio) { try { audio.pause() } catch {} } emit() }
    if (audio && !audio.paused) fadeTo(0, FADE_OUT_MS, done)
    else { applyVol(); done() }
  }

  const setVolume = (v) => {
    volume = Math.min(1, Math.max(0, v || 0))
    if (!fadeTimer) applyVol()   // 淡入淡出进行中则由 tick 应用新音量
    emit()
  }

  const setPlayMode = (m) => {
    if (!PLAY_MODES.includes(m)) m = 'sequential'
    if (m === playMode) return
    playMode = m
    if (audio) audio.loop = computeLoop()
    if (playMode !== 'interval') { stopInterval(); if (playing) fadeTo(1, 300) }   // 退出间歇：确保声音回来
    else if (playing) startInterval()
    if (sleepMs > 0 || sleepAtTime) startSleep()
    emit()
  }

  const setSleepMs = (ms) => {
    sleepMs = Math.max(0, Number(ms) || 0)
    sleepAtTime = ''
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null }
    if (playing && sleepMs > 0) startSleep()
    emit()
  }
  const setSleepAtTime = (hhmm) => {
    sleepAtTime = typeof hhmm === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm) ? hhmm : ''
    if (sleepAtTime) sleepMs = 0
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null }
    if (playing && sleepAtTime) startSleep()
    emit()
  }

  /** 计算到下一个 HH:MM 时刻的毫秒数（今天未到用今天，已过用明天）。 */
  function msUntilNext(hhmm) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm || '')
    if (!m) return 0
    const now = new Date()
    const target = new Date(now)
    target.setHours(+m[1], +m[2], 0, 0)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return target.getTime() - now.getTime()
  }

  const dispose = () => { silence(); if (audio) { try { audio.pause() } catch {} } }

  return { setScene, setPoolOptions, play, pause, setVolume, setPlayMode, setSleepMs, setSleepAtTime, nextTrack, prevTrack, dispose, state,
    __debug: () => ({ pool: pool.map((p) => p.key), poolIdx, playMode, sleepMs, sleepAtTime, playing, poolCfg, poolFallback, volume, fadeVol }),
    get onState() { return onState }, set onState(fn) { onState = fn } }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createAmbientPlayer, buildPool, PLAY_MODES, FADE_IN_MS, FADE_OUT_MS, INTERVAL_ON_MS, INTERVAL_OFF_MS }
