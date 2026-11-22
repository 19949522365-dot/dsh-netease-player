// 活体验证：把插件的 apply() 挂到一个假 ctx 上，起临时 http server，
// 真的去打 /search /lyric /play，确认宿主半侧能跑。
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(process.argv[2]).href)
let handler = null
const ctx = {
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
}
mod.apply(ctx)
if (typeof handler !== 'function') {
  console.error('FAIL: apply() 没有注册路由')
  process.exit(1)
}

const server = http.createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/netease-player`

async function get(path) {
  const r = await fetch(base + path)
  const text = await r.text()
  return { status: r.status, text }
}

let failed = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failed += 1
}

try {
  const state = await get('/state')
  const stateJson = JSON.parse(state.text)
  check('/state 200', state.status === 200, state.text.slice(0, 160))
  check('/state 带 serviceOnline', typeof stateJson.serviceOnline === 'boolean')
  // 桌面端页面在 dsh-app:// 下，音源要靠这个地址走真实 HTTP（自定义协议拿不到 Range）
  check(
    '/state 带 mediaOrigin（自定义协议页面用）',
    stateJson.mediaOrigin === 'http://127.0.0.1:' + port,
    stateJson.mediaOrigin,
  )

  const search = await get('/search?keywords=' + encodeURIComponent('周杰伦') + '&limit=5')
  const searchJson = JSON.parse(search.text)
  check('/search 有结果', search.status === 200 && searchJson.songs.length > 0, `songs=${searchJson.songs?.length}`)
  const first = searchJson.songs[0]
  console.log('      第一首:', JSON.stringify(first).slice(0, 220))
  check('/search 有封面', !!(first && first.cover), first?.cover ? 'ok' : '无')
  check('/search 有歌手', !!(first && first.artist), first?.artist || '无')

  if (first && first.id) {
    const lyric = await get('/lyric?id=' + first.id)
    const lyricJson = JSON.parse(lyric.text)
    check('/lyric 200', lyric.status === 200, `lines=${lyricJson.raw?.length ?? 0}`)

    const play = await fetch(base + '/play?id=' + first.id, { headers: { range: 'bytes=0-1023' } })
    const buf = Buffer.from(await play.arrayBuffer())
    check('/play 音频', play.status === 200 || play.status === 206, `status=${play.status} type=${play.headers.get('content-type')} bytes=${buf.length}`)
    check('/play 是真音频', buf.length > 100 && (buf[0] === 0x49 || buf[0] === 0xff || buf.subarray(0, 4).toString() === 'fLaC'), 'head=' + buf.subarray(0, 4).toString('hex'))
  }

  const missing = await get('/nope')
  check('/nope 404', missing.status === 404)
} finally {
  server.close()
}

process.exit(failed === 0 ? 0 : 1)
