/**
 * 0.6.0 的新链路自检：**本地 NeteaseCloudMusicApi 不可用**时，
 * 扫码登录 / 账号 / 歌单 / 曲目 / 音源 这些是否由插件自己扛下来。
 *
 * 用法：
 *   node tests/offline-native.mjs <插件目录>/lib/index.js [--with-cookie]
 *
 * 做法：把 DSH_HOME 指到一个临时目录，apiBase 故意指向没人监听的端口，
 * 再把 apply() 挂到假 ctx 上起一个临时 HTTP server，真的打网络。
 * 有 Cookie（临时目录里放一份或原 DSH_HOME 里有）就顺带验证账号/歌单/音源，
 * 没有也至少验证二维码能生成、能轮询、状态码正确。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: node tests/offline-native.mjs <lib/index.js> [--with-cookie]')
  process.exit(1)
}
const wantCookie = process.argv.includes('--with-cookie')

const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-netease-offline-'))

// 有原配置就把 Cookie 搬过来（只搬 Cookie / 昵称 / uid，apiBase 换成死端口）
let seed = { cookie: '', nickname: '', userId: 0 }
try {
  const real = JSON.parse(fs.readFileSync(path.join(realHome, 'netease-player.json'), 'utf8'))
  if (wantCookie || real.cookie) {
    seed = { cookie: real.cookie || '', nickname: real.nickname || '', userId: real.userId || 0 }
  }
} catch {}
fs.writeFileSync(
  path.join(testHome, 'netease-player.json'),
  JSON.stringify({ ...seed, apiBase: 'http://127.0.0.1:3999', serviceDir: '', level: 'standard' }, null, 2),
)
process.env.DSH_HOME = testHome

const mod = await import(pathToFileURL(path.resolve(entry)).href)
let handler = null
const server = http.createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
mod.apply({
  effect: (fn) => fn(),
  webServer: {
    protocol: 'http:',
    getOrigin: () => `http://127.0.0.1:${port}`,
    register: (route) => {
      handler = route.handler
    },
  },
})
if (typeof handler !== 'function') throw new Error('没拿到路由 handler')

const base = `http://127.0.0.1:${port}/api/netease-player`
const fails = []
const skip = []

function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name} ${detail}`)
    fails.push(name)
  }
}

async function getJson(p) {
  const res = await fetch(base + p, { cache: 'no-store' })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

const q = (p) => '/proxy?path=' + encodeURIComponent(p)

try {
  console.log('--- 状态')
  const state = await getJson('/state')
  check('version 是 0.6.0+', /^0\.6\./.test(String(state.json?.version)), state.json?.version)
  check('serviceOnline=false（故意指向死端口）', state.json?.serviceOnline === false)
  check('hasCookie 与种子一致', state.json?.hasCookie === Boolean(seed.cookie))

  console.log('--- 扫码登录（不需要本地服务）')
  const key = await getJson(q('/login/qr/key'))
  const unikey = key.json?.data?.unikey
  check('取到 unikey', key.status === 200 && typeof unikey === 'string' && unikey.length > 10, key.text.slice(0, 120))

  const create = await getJson(`${q('/login/qr/create')}&key=${encodeURIComponent(unikey || '')}&qrimg=true`)
  check('二维码是内联 SVG path', create.json?.code === 200 && typeof create.json?.data?.qrpath === 'string', create.text.slice(0, 120))
  check('qrsize 在 25–45 之间', create.json?.data?.qrsize >= 25 && create.json?.data?.qrsize <= 45, create.json?.data?.qrsize)

  const poll = await getJson(`${q('/login/qr/check')}&key=${encodeURIComponent(unikey || '')}`)
  check('轮询回 801（等待扫码）', poll.json?.code === 801, JSON.stringify(poll.json))
  check('轮询带上了 HTTP 码', typeof poll.json?.status === 'number' && poll.json.status > 0, JSON.stringify(poll.json))
  check('轮询报告有没有带 cookie', typeof poll.json?.hasJar === 'boolean', JSON.stringify(poll.json))
  check('/state 带回扫码脚印', Array.isArray(state.json?.qrTrace), JSON.stringify(state.json?.qrTrace))

  console.log('--- set-cookie 兼容（老 Node 没有 getSetCookie）')
  const w = await import(pathToFileURL(path.join(path.dirname(path.resolve(entry)), 'weapi.js')).href)
  const merged = w.splitSetCookie('NMTID=abc; Path=/, MUSIC_U=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/')
  check('合并的 set-cookie 能拆成两条', merged.length === 2, JSON.stringify(merged))
  check('Expires 里的逗号没被拆开', merged[1] === 'MUSIC_U=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/', merged[1])

  console.log('--- 未登录时的账号接口')
  if (!seed.cookie) {
    const acc = await getJson(q('/user/account'))
    check('无 Cookie 时 /user/account 回 301', acc.json?.code === 301, JSON.stringify(acc.json))
  }

  console.log('--- 有 Cookie 时的账号 / 歌单 / 曲目 / 音源')
  if (seed.cookie) {
    const acc = await getJson(q('/user/account'))
    check('账号信息', acc.json?.code === 200 && acc.json?.profile?.userId > 0, acc.text.slice(0, 120))
    const uid = acc.json?.profile?.userId

    const pls = await getJson(`${q('/user/playlist')}&uid=${uid}&limit=5&offset=0`)
    const playlist = pls.json?.playlist
    check('歌单列表', pls.json?.code === 200 && Array.isArray(playlist) && playlist.length > 0, pls.text.slice(0, 160))

    const pid = playlist?.[0]?.id
    if (pid) {
      const detail = await getJson(`${q('/playlist/detail')}&id=${pid}`)
      check('歌单详情有 trackIds', Array.isArray(detail.json?.playlist?.trackIds) && detail.json.playlist.trackIds.length > 0, detail.text.slice(0, 120))

      const tracks = await getJson(`${q('/playlist/track/all')}&id=${pid}&limit=3&offset=0`)
      const songs = tracks.json?.songs
      check('曲目 3 首', Array.isArray(songs) && songs.length === 3, tracks.text.slice(0, 160))
      check('曲目字段完整', Boolean(songs?.[0]?.id && songs?.[0]?.name))

      const songId = songs?.[0]?.id
      if (songId) {
        const play = await fetch(`${base}/play?id=${songId}`, { headers: { range: 'bytes=0-1023' } })
        const buf = Buffer.from(await play.arrayBuffer())
        const head = buf.slice(0, 3).toString('latin1')
        check('音源真的回音频', (play.status === 200 || play.status === 206) && buf.length > 0 && !/^(<|\{)/.test(head), `status=${play.status} type=${play.headers.get('content-type')} bytes=${buf.length}`)

        const lyric = await getJson(`/lyric?id=${songId}`)
        check('歌词接口', lyric.status === 200, lyric.text.slice(0, 120))
      }
    }
  } else {
    skip.push('账号 / 歌单 / 音源（没有 Cookie：用 --with-cookie 或先在本机登录一次）')
  }

  console.log('--- 服务离线时，不认识的 path 仍然 409')
  const unknown = await getJson(q('/something/else'))
  check('未知 path 409', unknown.status === 409, unknown.status)
} finally {
  server.close()
  try {
    fs.rmSync(testHome, { recursive: true, force: true })
  } catch {}
}

for (const s of skip) console.log(`  skip ${s}`)
console.log(fails.length === 0 ? '\nALL OK' : `\n${fails.length} FAIL: ${fails.join(', ')}`)
process.exitCode = fails.length === 0 ? 0 : 1
