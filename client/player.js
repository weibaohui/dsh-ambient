'use strict'

/**
 * dsh-ambient — 播放控制器
 *
 * 声源：音频文件（HTML5 Audio 元素，本地文件走宿主流式
 * /dsh-ambient/api/audio?scene=<场景id>&track=<文件下标>）。
 *
 * 曲池（pool）抽象——实际参与播放/切轨的曲目列表，按配置决定：
 *   favoritesOnly → 收藏的轨（跨场景；'场景id/文件名' 键匹配 config.favorites）
 *   crossScene    → 全库所有场景的轨
 *   默认           → 当前选中场景的轨
 * 池条目 { sceneId, sceneLabel, name, fileIndex, key }；key = '场景id/文件名'
 * （收藏键，文件名稳定即键稳定）。
 *
 * 播放模式（playMode，与 src/index.js PLAY_MODES 同源）：
 *   sequential 顺序循环 | shuffle 随机 | single-loop 单曲循环 | interval 间歇(20放5停)
 * 定时关：sleepMs（N 小时后）或 sleepAtTime（HH:MM 到点），0/空=关。
 * 音量统一 audio.volume。浏览器 autoplay 策略：play() 需用户手势。
 */

const PLAYER_API = '/dsh-ambient/api'
const PLAY_MODES = ['sequential', 'shuffle', 'single-loop', 'interval']

const INTERVAL_ON_MS = 20 * 60 * 1000
const INTERVAL_OFF_MS = 5 * 60 * 1000

/**
 * 曲池构建：收藏 > 跨场景 > 当前场景。纯函数（离线测试直接断言）。
 * @param {{id:string}|null} scene 当前选中场景（library.scenes 之一）
 * @param {{scenes:Array}} library 库响应（每场景 {id,label,tracks:[{name,source,index}]}）
 * @param {{favoritesOnly?:boolean, crossScene?:boolean, favorites?:string[]}} cfg
 * @returns Array<{sceneId,sceneLabel,name,fileIndex,key}>
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
  let poolCfg = {}          // { favoritesOnly, crossScene, favorites }
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

  const emit = () => { if (typeof onState === 'function') { try { onState(state()) } catch {} } }
  const current = () => pool[poolIdx] || null
  const state = () => {
    const p = current()
    const favs = new Set(poolCfg.favorites || [])
    return {
      sceneId: currentScene ? currentScene.id : null,
      mode: pool.length > 0 ? 'file' : 'none',
      poolLen: pool.length, poolIdx,
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
    if (intervalTimer) { clearTimeout(intervalTimer); intervalTimer = null }
  }
  const silence = () => { clearTimers(); silenceAudio() }

  const playEntry = (p) => {
    if (!audio || !p) return
    audio.src = PLAYER_API + '/audio?scene=' + encodeURIComponent(p.sceneId) + '&track=' + p.fileIndex
    audio.volume = volume
    audio.loop = computeLoop()
    audio.play().catch(() => { /* autoplay 被拦：等用户手势 */ })
  }

  const computeLoop = () => (playMode === 'single-loop' || playMode === 'interval') || pool.length === 1

  const startInterval = () => {
    stopInterval()
    intervalOn = true
    const tick = () => {
      if (!playing) return
      if (intervalOn) { intervalOn = false; silenceAudio(); emit(); intervalTimer = setTimeout(tick, INTERVAL_OFF_MS) }
      else { intervalOn = true; resumePlayback(); emit(); intervalTimer = setTimeout(tick, INTERVAL_ON_MS) }
    }
    intervalTimer = setTimeout(tick, INTERVAL_ON_MS)
  }
  const stopInterval = () => { if (intervalTimer) { clearTimeout(intervalTimer); intervalTimer = null } }

  const startSleep = () => {
    if (sleepTimer) clearTimeout(sleepTimer)
    const ms = sleepAtTime ? msUntilNext(sleepAtTime) : (sleepMs > 0 ? sleepMs : 0)
    if (ms > 0) sleepTimer = setTimeout(() => { playing = false; silence(); emit() }, ms)
  }

  const resumePlayback = () => { playEntry(current()) }

  if (audio) {
    audio.addEventListener('ended', () => {
      if (playMode === 'single-loop' || playMode === 'interval') return  // loop=true 不触发，兜底
      nextTrack()
    })
  }

  const nextIdx = (cur, n) => {
    if (n <= 1) return 0
    if (playMode === 'shuffle') { let r = cur; while (r === cur) r = Math.floor(Math.random() * n); return r }
    return (cur + 1) % n
  }

  const nextTrack = () => {
    if (pool.length === 0) return
    poolIdx = nextIdx(poolIdx, pool.length)
    playEntry(current()); emit()
  }
  const prevTrack = () => {
    if (pool.length === 0) return
    poolIdx = (poolIdx - 1 + pool.length) % pool.length
    playEntry(current()); emit()
  }

  const initPoolIdx = () => {
    if (pool.length === 0) return 0
    if (playMode === 'shuffle') return Math.floor(Math.random() * pool.length)
    if (currentScene) {
      const i = pool.findIndex((p) => p.sceneId === currentScene.id)
      if (i >= 0) return i
    }
    return 0
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
    silence()
    pool = buildPool(scene, library, poolCfg)
    poolIdx = initPoolIdx()
    if (playing && pool.length > 0) { resumePlayback(); if (playMode === 'interval') startInterval() }
    emit()
  }

  /** 曲池选项变化（跨场景/收藏/只播收藏）→ 重建池，尽量保住当前轨无缝续播。 */
  const setPoolOptions = (cfg, lib) => {
    poolCfg = {
      favoritesOnly: cfg ? !!cfg.favoritesOnly : false,
      crossScene: cfg ? !!cfg.crossScene : false,
      favorites: cfg ? (cfg.favorites || []) : [],
    }
    library = lib || library
    const keep = current()
    pool = buildPool(currentScene, library, poolCfg)
    const keepIdx = keep ? pool.findIndex((p) => p.key === keep.key) : -1
    if (keepIdx >= 0) {
      poolIdx = keepIdx
      if (playing) playEntry(current())
    } else {
      poolIdx = initPoolIdx()
      if (playing) {
        if (pool.length > 0) { resumePlayback(); if (playMode === 'interval') startInterval() }
        else silenceAudio()
      }
    }
    emit()
  }

  const play = () => {
    playing = true
    if (pool.length > 0) resumePlayback()
    if (playMode === 'interval') startInterval()
    if (sleepMs > 0 || sleepAtTime) startSleep()
    emit()
  }
  const pause = () => { playing = false; silence(); emit() }

  const setVolume = (v) => { volume = Math.min(1, Math.max(0, v || 0)); if (audio) audio.volume = volume; emit() }

  const setPlayMode = (m) => {
    if (!PLAY_MODES.includes(m)) m = 'sequential'
    if (m === playMode) return
    const wasPlaying = playing
    silence()
    playMode = m
    if (wasPlaying) { resumePlayback(); if (playMode === 'interval') startInterval(); if (sleepMs > 0 || sleepAtTime) startSleep() }
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
    get onState() { return onState }, set onState(fn) { onState = fn } }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createAmbientPlayer, buildPool, PLAY_MODES, INTERVAL_ON_MS, INTERVAL_OFF_MS }
