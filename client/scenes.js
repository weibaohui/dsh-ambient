'use strict'

/**
 * dsh-ambient — 音频格式常量（host 与 client 共享）
 *
 * 场景完全由目录驱动：libraryRoot 下每个子文件夹就是一个场景（文件夹名即
 * 场景名），有什么算什么——没有内置预制清单、没有别名匹配、没有程序化兜底。
 * 本文件只保留音频扩展名与 MIME 表，供宿主扫描与流式使用。
 */

/** 支持的音频扩展名（小写，含点）。 */
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba', '.webm']

/** MIME 表（流式响应 Content-Type）。 */
const MIME_OF = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  '.weba': 'audio/webm', '.webm': 'audio/webm',
}

if (typeof module !== 'undefined' && module.exports) module.exports = { AUDIO_EXTS, MIME_OF }
