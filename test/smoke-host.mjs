// 宿主流式路由集成冒烟：真临时音频文件 + mock ctx，验证
// GET /api/audio 返回 200 + 正确 MIME + 流式字节；带 Range 头返回 206 +
// Content-Range + 部分字节；不存在的 track 返回 404；信任栅栏拒绝时返回栅栏码。
// 以及 POST /api/config 设 libraryRoot 触发重扫后 GET /api/library 返回纯目录场景。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const Host = require('../src/index.js')

/** mock ctx：effect 同步执行回调，捕获 webServer.register 的 handler。 */
function mockCtx(opts = {}) {
  const cleanups = []
  return {
    storageDomain: { open: () => Promise.resolve({ table: () => ({ get: () => null, put: async (k, v) => { opts.onPut && opts.onPut(v) } }), close: async () => {} }) },
    connection: { requestRejection: () => opts.rejection },
    webServer: { register: (spec) => { opts.onRegister && opts.onRegister(spec); return () => {} } },
    effect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
    on: () => () => {},
  }
}

function mockReq(method, url, headers = {}, body) {
  const req = new EventEmitter()
  req.method = method; req.url = url; req.headers = headers
  if (body !== undefined) queueMicrotask(() => { req.emit('data', Buffer.from(body)); req.emit('end') })
  else queueMicrotask(() => req.emit('end'))
  return req
}

function mockRes() {
  const res = new EventEmitter()
  res._status = null; res._headers = null; res._body = Buffer.alloc(0)
  res.writeHead = (status, headers) => { res._status = status; res._headers = headers || {} }
  res.end = (data) => { if (data) res._body = Buffer.concat([res._body, Buffer.isBuffer(data) ? data : Buffer.from(String(data))]); res.emit('finish') }
  res.write = (chunk) => { res._body = Buffer.concat([res._body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); return true }
  return res
}

const waitFor = (res) => new Promise((r) => { res.once('finish', r); setTimeout(r, 1200) })

/** 造一个临时库：root/rain/test.mp3，2048 字节递增。 */
function makeTmpLibrary() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-ambient-'))
  mkdirSync(join(tmp, 'rain'), { recursive: true })
  const payload = Buffer.from(new Array(2048).fill(0).map((_, i) => i % 256))
  writeFileSync(join(tmp, 'rain', 'test.mp3'), payload)
  return { tmp, payload }
}

/** 启动插件并返回捕获的 handler + 设置 libraryRoot 触发重扫。 */
async function boot(opts = {}) {
  let handler = null
  let savedConfig = null
  const ctx = mockCtx({
    rejection: opts.rejection,
    onRegister: (spec) => { handler = spec.handler },
    onPut: (v) => { savedConfig = v },
  })
  Host.apply(ctx)
  await new Promise((r) => setTimeout(r, 30))
  if (opts.libraryRoot) {
    const req = mockReq('POST', '/dsh-ambient/api/config', {}, JSON.stringify({ libraryRoot: opts.libraryRoot, enabled: true }))
    const res = mockRes()
    await handler(req, res)
    await waitFor(res)
    await new Promise((r) => setTimeout(r, 30))   // 等 rescan
  }
  return { handler, savedConfig }
}

test('audio：整文件 200 + MIME + 流式字节', async () => {
  const { tmp, payload } = makeTmpLibrary()
  const { handler } = await boot({ libraryRoot: tmp })
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-ambient/api/audio?scene=custom-rain&track=0'), res)
  await waitFor(res)
  assert.equal(res._status, 200)
  assert.equal(res._headers['Content-Type'], 'audio/mpeg')
  assert.equal(res._headers['Accept-Ranges'], 'bytes')
  assert.equal(res._headers['Content-Length'], '2048')
  assert.equal(res._body.length, 2048)
  assert.deepEqual(res._body, payload)
  rmSync(tmp, { recursive: true, force: true })
})

test('audio：Range 请求 206 + Content-Range + 部分字节', async () => {
  const { tmp } = makeTmpLibrary()
  const { handler } = await boot({ libraryRoot: tmp })
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-ambient/api/audio?scene=custom-rain&track=0', { range: 'bytes=0-99' }), res)
  await waitFor(res)
  assert.equal(res._status, 206)
  assert.equal(res._headers['Content-Type'], 'audio/mpeg')
  assert.equal(res._headers['Content-Range'], 'bytes 0-99/2048')
  assert.equal(res._headers['Content-Length'], '100')
  assert.equal(res._body.length, 100)
  rmSync(tmp, { recursive: true, force: true })
})

test('audio：不存在的 track 返回 404', async () => {
  const { handler } = await boot()
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-ambient/api/audio?scene=no-such-scene&track=0'), res)
  await waitFor(res)
  assert.equal(res._status, 404)
})

test('audio：信任栅栏拒绝时返回 401', async () => {
  const { handler } = await boot({ rejection: 401 })
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-ambient/api/audio?scene=custom-rain&track=0'), res)
  assert.equal(res._status, 401)
})

test('library：扫描到的文件（纯目录）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-ambient-'))
  mkdirSync(join(tmp, 'cafe'), { recursive: true })
  writeFileSync(join(tmp, 'cafe', 'my-cafe.mp3'), Buffer.alloc(100))
  const { handler } = await boot({ libraryRoot: tmp })
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-ambient/api/library'), res)
  await waitFor(res)
  assert.equal(res._status, 200)
  const lib = JSON.parse(res._body.toString())
  const cafe = lib.scenes.find((s) => s.id === 'custom-cafe')
  assert.equal(cafe.tracks.length, 1, 'cafe 只有本地文件（无策展直链）')
  assert.equal(cafe.tracks[0].source, 'file')
  assert.equal(cafe.tracks[0].name, 'my-cafe.mp3')
  rmSync(tmp, { recursive: true, force: true })
})
