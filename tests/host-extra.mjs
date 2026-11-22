// 宿主侧额外验证（不碰浏览器，只打 HTTP）：
//   1. 同一首歌连续三次 Range：状态码 / content-length 一致（播放地址缓存没被探测缓存打乱）
//   2. 模拟拖进度条：请求发出去就 abort，重复多次 —— 宿主不能崩、上游连接要被掐掉
//   3. abort 风浪过后还能正常播放
//
// 用法：
//   node tests/host-extra.mjs [lib/index.js]
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = process.argv[2] || path.join(here, '..', 'lib', 'index.js')

const mod = await import(pathToFileURL(entry).href)
let handler = null
mod.apply({
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
})
if (typeof handler !== 'function') {
  console.error('FAIL: apply() 没有注册路由')
  process.exit(1)
}

const server = http.createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/api/netease-player`

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failed += 1
}

try {
  const search = await (await fetch(base + '/search?keywords=' + encodeURIComponent('稻香 周杰伦') + '&limit=3')).json()
  const id = search.songs?.[0]?.id
  check('搜到一首可测的', !!id, String(id))
  if (!id) throw new Error('没搜到歌，跳过后面的用例')

  const ranges = []
  for (let i = 0; i < 3; i += 1) {
    const r = await fetch(`${base}/play?id=${id}`, { headers: { range: 'bytes=0-2047' } })
    ranges.push({ status: r.status, len: r.headers.get('content-length'), cr: r.headers.get('content-range') })
    await r.arrayBuffer()
  }
  check('三次 Range 都是 206', ranges.every((r) => r.status === 206), JSON.stringify(ranges.map((r) => r.status)))
  check('三次 Range 长度一致（同一个上游文件）', new Set(ranges.map((r) => r.len)).size === 1, JSON.stringify(ranges.map((r) => r.len)))
  check('带 content-range', ranges.every((r) => typeof r.cr === 'string' && r.cr.startsWith('bytes ')))

  // 拖进度条：请求刚拿到第一批字节就 abort，重复 8 次
  const handlesBefore = process._getActiveHandles?.().length ?? -1
  for (let i = 0; i < 8; i += 1) {
    const ac = new AbortController()
    try {
      const r = await fetch(`${base}/play?id=${id}`, {
        headers: { range: `bytes=${1024 * i}-${1024 * i + 65535}` },
        signal: ac.signal,
      })
      const reader = r.body.getReader()
      await reader.read()
      ac.abort()
    } catch {
      // abort 抛错是预期行为
    }
  }
  await new Promise((r) => setTimeout(r, 800))
  const handlesAfter = process._getActiveHandles?.().length ?? -1

  const again = await fetch(`${base}/play?id=${id}`, { headers: { range: 'bytes=0-1023' } })
  const buf = Buffer.from(await again.arrayBuffer())
  check('abort 之后还能正常播放', (again.status === 206 || again.status === 200) && buf.length === 1024, `status=${again.status} bytes=${buf.length}`)

  const state = await (await fetch(base + '/state')).json()
  check('/state 仍然正常', state.ok === true && typeof state.serviceOnline === 'boolean')
  check('abort 没有把句柄越攒越多', handlesAfter <= handlesBefore + 2, `${handlesBefore} → ${handlesAfter}`)
} catch (err) {
  check('用例没抛异常', false, String(err?.message ?? err))
} finally {
  server.close()
}

process.exit(failed === 0 ? 0 : 1)
