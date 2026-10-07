/**
 * Build `client/bundle.js` from client/player.js + client/index.js
 * (+ dsh-plugin-kit client source).
 *
 * 静态安装产物遵循 client-modules bundle 协议：
 * `window.__ModuleLoader__.load({ id, factory })` 注册一个惰性 CommonJS
 * 工厂，factory 接收的 require 解析框架模块（react 是平台模块；其余内联）。
 * 2 个 helper 模块按依赖顺序内联进 factory 作用域（player → index），glue
 * 代码以裸名引用 createAmbientPlayer / PluginKit —— dsh-matrix 同款内联方案。
 *
 * 从每个 helper 源剥掉 node-only 外壳：`'use strict'` prologue 与
 * `module.exports` 守卫行（否则会在 index.js 设置 module.exports 前覆盖掉）。
 *
 * Run: `npm run build:client`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const helper = (name) => readFileSync(join(here, '..', 'client', name), 'utf8')
  .replace(/^'use strict'\s*/, '')
  .replace(/^if \(typeof module !== 'undefined' && module\.exports\) module\.exports = .+$/gm, '')
  .trim()

const kitClient = readFileSync(createRequire(import.meta.url).resolve('@weibaohui/dsh-plugin-kit/client/source.js'), 'utf8').replace(/^'use strict'\s*/, '').trim()
const player = helper('player.js')
const source = readFileSync(join(here, '..', 'client', 'index.js'), 'utf8').trim()

const banner = `/* Generated from client/{player,index}.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
`

const footer = `
    return module.exports
  }
})
`

const indent = (code) => code
  .split('\n')
  .map((line) => (line.length === 0 ? line : '    ' + line))
  .join('\n')

const body = [kitClient, player, source].map(indent).join('\n\n')
writeFileSync(join(here, '..', 'client', 'bundle.js'), banner + body + footer)
console.log(`built client/bundle.js (${Buffer.byteLength(banner + body + footer, 'utf8')} bytes)`)
