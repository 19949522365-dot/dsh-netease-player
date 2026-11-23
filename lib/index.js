/**
 * dsh-netease-player —— 宿主半侧。
 *
 * 只做三件事：
 *   1. 同源 API：/api/netease-player/* 代理到本地 NeteaseCloudMusicApi（默认 3020），
 *      浏览器那边不需要跨域、也不需要知道端口；
 *   2. 音源：/play?id= 在宿主里解析出真实 mp3 地址再流式转发（保留 Range，能拖进度条），
 *      顺便带上 Referer/UA —— 直接把 CDN 地址丢给网页会因为防盗链和时效 token 时好时坏；
 *   3. 兜底：3020 没起来时，搜索/歌词/详情直连 music.163.com 的公开接口，
 *      保证"什么都不装也能搜到歌、能听非 VIP 曲"；
 *   4. 自动拉起：宿主启动时若已登录（有 cookie）且本地服务不在线，后台拉起一次，
 *      不 await、不阻塞启动，失败了只记日志（手动「启动服务」仍然可用）。
 *
 * 0.6.0 起，扫码登录 / 账号 / 歌单也有一条不依赖本地服务的路（见 lib/weapi.js + lib/qr.js）：
 * 本地服务不在线时，/proxy 里这几个接口由插件自己直连 music.163.com 完成 ——
 * 别人下载插件后不装任何东西，也能「扫码 → 听歌 → 看自己的歌单」。
 *
 * 配置落盘在 <DSH_HOME>/netease-player.json（cookie 只存在本机，接口不回显明文）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { searchBili, biliAudio, isBiliId, BILI_FETCH_HEADERS, forgetBiliAudio } from './bili.js'
import { qrSvg } from './qr.js'
import { qrKey, qrCheck, accountOf, userPlaylists, playlistDetail, songsByIds } from './weapi.js'

export const name = 'netease-player'
// 命名空间属于 webServer seam：等它就绪再注册路由。
export const inject = ['webServer']

const PREFIX = '/api/netease-player'
// /state 里回给前端，排查「装的是哪个版本」用。
const VERSION = '0.6.1'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STORE_PATH = path.join(DSH_HOME, 'netease-player.json')
const DEFAULT_API = 'http://127.0.0.1:3020'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://music.163.com/'
const OUTER = 'https://music.163.com/song/media/outer/url?id='

// 网易云的风控按「请求来源 IP」判地区：宿主机挂梯子/海外机房时，/song/url 会直接回
// code -460「检测到您的网络环境存在风险」。NeteaseCloudMusicApi 支持 realIP 参数伪造来源 IP，
// 需要的话在设置（POST /config）里填，或用 DSH_NETEASE_REAL_IP 环境变量。
// 这里不内置任何 IP —— 公开包不能替别人选出口 IP。
const DEFAULT_REAL_IP = process.env.DSH_NETEASE_REAL_IP || ''

// ---- 配置 -----------------------------------------------------------------

const DEFAULTS = {
  cookie: '',
  apiBase: DEFAULT_API,
  serviceDir: '',
  level: 'standard',
  nickname: '',
  userId: 0,
  realIP: DEFAULT_REAL_IP,
}

// 配置读得很频繁：每个 /play Range 请求、每次切歌都会走一遍。
// 以前每次都 readFileSync + JSON.parse，浏览器拖进度条时一秒几十次同步磁盘 IO；
// 现在内存里存一份，最多每 STORE_STAT_TTL 毫秒 stat 一次确认文件没被别人改过。
const STORE_STAT_TTL = 1000
let storeCache = null // { data, mtimeMs, checkedAt }

function readStore() {
  const now = Date.now()
  if (storeCache !== null && now - storeCache.checkedAt < STORE_STAT_TTL) return storeCache.data
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(STORE_PATH).mtimeMs
  } catch {
    // 文件还没生成：照样给默认值，但别把「不存在」也钉在缓存里太久。
    storeCache = { data: { ...DEFAULTS }, mtimeMs: 0, checkedAt: now }
    return storeCache.data
  }
  if (storeCache !== null && storeCache.mtimeMs === mtimeMs) {
    storeCache.checkedAt = now
    return storeCache.data
  }
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    if (data === null || typeof data !== 'object') return { ...DEFAULTS }
    const merged = { ...DEFAULTS, ...data }
    storeCache = { data: merged, mtimeMs, checkedAt: now }
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

function writeStore(next) {
  const data = { ...readStore(), ...next }
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8')
    // 写盘后就地更新缓存，别让紧接着的 /state 读到旧值。
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(STORE_PATH).mtimeMs
    } catch {}
    storeCache = { data, mtimeMs, checkedAt: Date.now() }
  } catch {
    // 写不进去就算了：本次会话仍然用内存里的值。
    storeCache = { data, mtimeMs: 0, checkedAt: Date.now() }
  }
  return data
}

// ---- 小工具 ---------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (c) => {
      size += c.length
      // 恶意/异常体：直接收摊，别再往内存里堆（以前只是 return，后面的 chunk 还在 push）。
      if (size > 2 * 1024 * 1024) {
        chunks.length = 0
        finish({})
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') return finish({})
      try {
        finish(JSON.parse(text))
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
    req.on('close', () => finish({}))
  })
}

function queryOf(req) {
  const qs = (req.url ?? '').split('?')[1] ?? ''
  return new URLSearchParams(qs)
}

/** NeteaseCloudMusicApi 的 song 对象 → 前端统一的瘦结构。 */
function slimSong(s) {
  if (s === null || typeof s !== 'object') return null
  const artists = Array.isArray(s.ar) ? s.ar : Array.isArray(s.artists) ? s.artists : []
  const album = s.al ?? s.album ?? {}
  return {
    id: s.id,
    name: s.name ?? '',
    artist: artists.map((a) => a?.name ?? '').filter(Boolean).join(' / '),
    album: album?.name ?? '',
    // 只认专辑封面。以前这里还兜底 artists[0].img1v1Url，但搜索接口给的
    // 多半是网易云的默认歌手头像（一张通用的灰图），用它会让「这首歌有封面」
    // 判断成立，于是缺封面的歌永远走不到补详情那一步 —— 全列表一片灰。
    cover: album?.picUrl ?? album?.blurPicUrl ?? '',
    duration: Number(s.dt ?? s.duration ?? 0) || 0,
    fee: Number(s.fee ?? 0) || 0,
  }
}

function slimSongs(list) {
  return (Array.isArray(list) ? list : []).map(slimSong).filter((s) => s !== null && s.id)
}

// ---- 与本地服务通信 --------------------------------------------------------

// /state、/search、/play、/lyric 每次都要先问一句「本地服务在不在」。
// 一次播放浏览器会连发好几个 Range 请求，等于每次多打一次 3020；
// 这里给 1.5 秒的短缓存 + 单飞：并发请求共用同一次探测，冷启动也照样能很快感知上线。
const ONLINE_TTL = 1500
let onlineCache = { ok: false, at: 0, base: '' }
let onlineInFlight = null

async function probeService(apiBase) {
  try {
    const r = await fetch(new URL('/login/status', apiBase), {
      signal: AbortSignal.timeout(1500),
      headers: { 'user-agent': UA },
    })
    return r.ok
  } catch {
    return false
  }
}

async function serviceOnline(apiBase, force = false) {
  const now = Date.now()
  if (!force && onlineCache.base === apiBase && now - onlineCache.at < ONLINE_TTL) return onlineCache.ok
  if (onlineInFlight !== null) return onlineInFlight
  onlineInFlight = probeService(apiBase)
    .then((ok) => {
      onlineCache = { ok, at: Date.now(), base: apiBase }
      return ok
    })
    .finally(() => {
      onlineInFlight = null
    })
  return onlineInFlight
}

async function apiGet(apiBase, apiPath, params, cookie, realIP) {
  const url = new URL(apiPath, apiBase)
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  // realIP 放在最后，但别盖掉调用方显式传的（比如 /proxy 透传里自己带了 realIP）。
  if (realIP && !url.searchParams.has('realIP')) url.searchParams.set('realIP', String(realIP))
  if (cookie) url.searchParams.set('cookie', cookie)
  const r = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { 'user-agent': UA },
  })
  const text = await r.text()
  try {
    return JSON.parse(text)
  } catch {
    return { code: r.status, raw: text.slice(0, 400) }
  }
}

/** 直连网易云公开接口（不需要 cookie，也不需要本地服务）。 */
async function publicApi(apiPath, params) {
  const url = new URL(apiPath, 'https://music.163.com')
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const r = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { 'user-agent': UA, referer: REFERER },
  })
  const text = await r.text()
  try {
    return JSON.parse(text)
  } catch {
    return { code: r.status, raw: text.slice(0, 400) }
  }
}

// ---- 拉起本地 API 服务 -----------------------------------------------------

let spawnNote = ''

function findNodeExe() {
  const candidates = [
    process.env.DSH_NODE,
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  // 宿主自己就是 node 起的（非 Electron）时可以直接复用
  if (/node(\.exe)?$/i.test(process.execPath)) return process.execPath
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

function findServiceDir(store) {
  const candidates = [
    store.serviceDir,
    path.join(DSH_HOME, 'netease-service'),
    path.resolve(process.cwd(), 'netease-service'),
  ].filter(Boolean)
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'server.js'))) return dir
    } catch {}
  }
  return ''
}

async function startService(store) {
  const base = store.apiBase || DEFAULT_API
  if (await serviceOnline(base)) return { ok: true, note: '本地 API 服务已经在跑了', dir: findServiceDir(store) }

  const dir = findServiceDir(store)
  if (dir === '') return { ok: false, error: '没找到 netease-service 目录（server.js），可以在设置里填路径' }
  const npm = path.join(dir, 'node_modules', 'NeteaseCloudMusicApi')
  try {
    if (!fs.existsSync(npm)) return { ok: false, error: 'netease-service 没装依赖，先在那个目录里 npm/pnpm install' }
  } catch {}

  const port = new URL(store.apiBase || DEFAULT_API).port || '3020'
  try {
    const child = spawn(findNodeExe(), ['server.js'], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
    })
    child.unref()
    spawnNote = `已拉起 ${path.join(dir, 'server.js')}（pid ${child.pid ?? '?'}）`
  } catch (err) {
    return { ok: false, error: `拉起失败：${err?.message ?? err}` }
  }

  // 给服务一点启动时间：NeteaseCloudMusicApi 冷启动要 10 秒上下，别用 8 秒就判死。
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 600))
    // 轮询要绕过短缓存，否则服务已经起来了还要多等一两秒才认。
    if (await serviceOnline(store.apiBase || DEFAULT_API, true)) return { ok: true, note: spawnNote, dir }
  }
  return { ok: false, error: '服务进程起来了但端口没响应，看一眼 netease-service/service.log', dir }
}

// ---- 拉起去重 & 启动时自动拉起 ---------------------------------------------

// apply() 可能被装配多次，手动「启动服务」也可能和自动拉起撞到一起：
// 同一时刻只留一个 in-flight 的 startService，后来者直接复用同一个 promise。
let startInFlight = null

// 拉起失败后冷却一段时间。以前只要失败（比如端口被别的进程占着），
// 每个 /play Range 请求都会再 spawn 一个 node 进程 —— 拖一下进度条能炸出十几个。
const START_FAIL_COOLDOWN = 60 * 1000
let lastStartFailAt = 0

function startServiceOnce(store, force = false) {
  if (startInFlight !== null) return startInFlight
  if (!force && lastStartFailAt !== 0 && Date.now() - lastStartFailAt < START_FAIL_COOLDOWN) {
    return Promise.resolve({
      ok: false,
      error: '上次拉起失败，一分钟内不再自动重试（想立刻再试就点「启动服务」）',
    })
  }
  startInFlight = startService(store)
    .then((result) => {
      if (result.ok) lastStartFailAt = 0
      else lastStartFailAt = Date.now()
      return result
    })
    .catch((err) => {
      lastStartFailAt = Date.now()
      throw err
    })
    .finally(() => {
      startInFlight = null
    })
  return startInFlight
}

// 每个进程只自动拉一次；没登录（无 cookie）就不拉，省得白占内存。
let autoStartTried = false

function autoStartService() {
  if (autoStartTried) return
  const store = readStore()
  if (!store.cookie) return
  autoStartTried = true

  // fire-and-forget：startService 最多轮询约 24 秒，绝不能挡在 apply() 的路径上。
  void (async () => {
    try {
      if (await serviceOnline(store.apiBase)) return
      const result = await startServiceOnce(store)
      if (result.ok) {
        console.log(`[netease-player] 自动拉起本地 API 服务：${result.note ?? 'ok'}`)
      } else {
        console.warn(`[netease-player] 自动拉起本地 API 服务失败：${result.error ?? '未知原因'}`)
      }
    } catch (err) {
      console.warn(`[netease-player] 自动拉起本地 API 服务失败：${err?.message ?? err}`)
    }
  })()
}

// ---- 搜索 -----------------------------------------------------------------

const detailCache = new Map()

async function detailsOf(ids, store) {
  const wanted = ids.filter((id) => id && !detailCache.has(String(id)))
  if (wanted.length > 0) {
    let data = null
    if (await serviceOnline(store.apiBase)) {
      // 本地服务的 /song/detail 要的是逗号分隔（ids=1,2,3）；
      // 传 JSON 数组字面量 `[1,2]` 它会当成一个非法 id，回一个空的 songs —— 封面就全丢了。
      data = await apiGet(store.apiBase, '/song/detail', { ids: wanted.join(',') }, store.cookie, store.realIP)
    } else {
      // 网易云自己的公开接口反过来只吃 `ids=[1,2]` 这种 JSON 写法。
      data = await publicApi('/api/song/detail', { ids: JSON.stringify(wanted) })
    }
    for (const s of slimSongs(data?.songs)) detailCache.set(String(s.id), s)
    if (detailCache.size > 600) {
      // 简单封顶，别在长会话里无限长
      for (const k of [...detailCache.keys()].slice(0, 200)) detailCache.delete(k)
    }
  }
  return ids.map((id) => detailCache.get(String(id))).filter(Boolean)
}

async function doSearch(keywords, limit, store) {
  const kw = String(keywords ?? '').trim()
  if (kw === '') return []
  const lim = Math.min(60, Math.max(1, Number(limit) || 30))

  let songs = []
  if (await serviceOnline(store.apiBase)) {
    const j = await apiGet(store.apiBase, '/search', { keywords: kw, limit: lim, type: 1 }, store.cookie, store.realIP)
    songs = slimSongs(j?.result?.songs)
  }
  if (songs.length === 0) {
    const j = await publicApi('/api/search/get/web', { s: kw, type: 1, offset: 0, limit: lim })
    songs = slimSongs(j?.result?.songs)
  }

  // 补封面：两条搜索路径都只给 album.picId，**不给 picUrl**（picId 拼不出 CDN 地址，
  // 那个 URL 要带加密 hash），所以缺封面的统一走一次批量 /song/detail 补回来。
  if (songs.some((s) => !s.cover)) {
    const extra = await detailsOf(
      songs.filter((s) => !s.cover).map((s) => s.id),
      store,
    )
    const byId = new Map(extra.map((s) => [String(s.id), s]))
    songs = songs.map((s) => {
      if (s.cover) return s
      const d = byId.get(String(s.id))
      return d ? { ...s, cover: d.cover || '', album: s.album || d.album, duration: s.duration || d.duration } : s
    })
  }
  return songs
}

// ---- 音源 -----------------------------------------------------------------

// 最近一次播放失败的原因，/state 会回传，方便在页面里直接看到（不用翻日志）。
let lastPlayError = ''

// 最近 30 次 /play：浏览器拖进度条时到底发了哪些 Range、宿主回了什么状态，
// 只靠猜定位不了「拖完弹回去」，/state 里带出来一看就知道。
const recentPlay = []
function notePlay(id, range, status, contentRange) {
  try {
    recentPlay.push({
      at: Date.now(),
      id: String(id ?? ''),
      range: String(range ?? ''),
      status: Number(status) || 0,
      cr: String(contentRange ?? ''),
    })
    while (recentPlay.length > 30) recentPlay.shift()
  } catch {}
}

/** 上游回来的到底是不是音频：外链失效时网易会 302 到 /404，塞回来一张 HTML。 */
function isAudioResponse(upstream) {
  const type = (upstream.headers.get('content-type') ?? '').toLowerCase()
  return !(type.includes('text/html') || type.includes('application/json') || type.includes('text/plain'))
}

/**
 * 本地服务没起来时的直连兜底：music.163.com 的公开 player/url 接口。
 * 带 Cookie 就能拿到普通曲目（甚至部分会员曲）的真实地址，不用等本地服务冷启动。
 * 没 Cookie 时会回 -110，那就真没辙了。
 */
async function publicSongUrl(id, store) {
  if (!store.cookie) return ''
  for (const br of [320000, 192000, 128000]) {
    const url = new URL('/api/song/enhance/player/url', 'https://music.163.com')
    url.searchParams.set('ids', JSON.stringify([Number(id)]))
    url.searchParams.set('br', String(br))
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(12000),
        headers: { 'user-agent': UA, referer: REFERER, cookie: store.cookie },
      })
      const j = await r.json()
      const u = j?.data?.[0]?.url
      if (typeof u === 'string' && u !== '') return u
    } catch {}
  }
  return ''
}

/**
 * 解析一首歌的候选音源，按优先级排队：
 *   1. 本地服务 /song/url/v1（音质逐档退，风控时带 realIP 换来源 IP）
 *   2. 本地服务老接口 /song/url
 *   3. 直连 music.163.com 的公开 player/url（本地服务没起来时顶上）
 *   4. music.163.com 外链（网易这个外链现在基本是 404 页面了，只当最后兜底）
 */
async function resolveSongUrls(id, store) {
  const urls = []
  const realIP = store.realIP || DEFAULT_REAL_IP
  if (await serviceOnline(store.apiBase)) {
    const levels = [...new Set([store.level || 'standard', 'exhigh', 'higher', 'standard'])]
    for (const level of levels) {
      try {
        const j = await apiGet(store.apiBase, '/song/url/v1', { id, level }, store.cookie, realIP)
        const u = j?.data?.[0]?.url
        if (typeof u === 'string' && u !== '') {
          urls.push(u)
          break
        }
      } catch {}
    }
    if (urls.length === 0) {
      try {
        const j = await apiGet(store.apiBase, '/song/url', { id, br: 320000 }, store.cookie, realIP)
        const u = j?.data?.[0]?.url
        if (typeof u === 'string' && u !== '') urls.push(u)
      } catch {}
    }
  }
  if (urls.length === 0) {
    const pub = await publicSongUrl(id, store)
    if (pub !== '') urls.push(pub)
  }
  urls.push(OUTER + encodeURIComponent(id) + '.mp3')
  return urls
}

// 同一首歌的播放地址必须稳定：浏览器拖进度条时会连着发好几个 Range 请求，
// 要是每次请求都重新问一次 /song/url，回来可能是**另一个码率的文件**（实测同一个
// id 一次 11.7MB、下一次 4.7MB），Content-Range 里的总长度跟着变，浏览器就 seek 不动了。
// 所以按 id+音质 缓存解析结果，TTL 内所有 Range 请求打同一个上游文件。
const urlCache = new Map()
const URL_TTL = 20 * 60 * 1000
const URL_CACHE_MAX = 40

async function cachedSongUrls(id, level, store) {
  const key = `${id}:${level || 'standard'}`
  const hit = urlCache.get(key)
  if (hit && Date.now() - hit.at < URL_TTL) return hit.urls
  const urls = await resolveSongUrls(id, store)
  urlCache.set(key, { urls, at: Date.now() })
  if (urlCache.size > URL_CACHE_MAX) {
    const drop = [...urlCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 12)
    for (const [k] of drop) urlCache.delete(k)
  }
  return urls
}

/**
 * 把上游音频流接到响应上，同时盯着浏览器那侧：它一断开就把上游也掐掉。
 * 拖进度条 / 切歌时浏览器会主动 abort 旧请求，不掐上游的话这些连接会一直挂着，
 * 连拖几下就能看到一堆没关的 socket（还占着带宽）。
 */
function pipeAudio(upstream, res) {
  if (upstream.body === null) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(upstream.body)
  const stop = () => {
    try {
      stream.destroy()
    } catch {}
  }
  res.once('close', stop)
  stream.on('error', () => {
    if (!res.writableEnded) {
      try {
        res.destroy()
      } catch {}
    }
  })
  stream.on('end', () => {
    res.off('close', stop)
  })
  stream.pipe(res)
}

/** 按候选顺序试；成功就把响应写出去并返回 { ok: true }。 */
async function streamBest(urls, range, res) {
  const tried = []
  for (const url of urls) {
    let upstream
    try {
      upstream = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          referer: REFERER,
          ...(typeof range === 'string' && range !== '' ? { range } : {}),
        },
      })
    } catch (err) {
      tried.push(`拉取失败：${err?.message ?? err}`)
      continue
    }

    const okStatus = upstream.ok || upstream.status === 206
    if (!okStatus || !isAudioResponse(upstream)) {
      // 不是音频（多半是风控/404 页面）：扔掉这个候选，换下一个。
      tried.push(`HTTP ${upstream.status} ${upstream.headers.get('content-type') ?? '无 content-type'}`)
      try {
        await upstream.body?.cancel()
      } catch {}
      continue
    }

    const rawType = upstream.headers.get('content-type') ?? ''
    const headers = {
      // 直连兜底回来的是 application/octet-stream，有些浏览器不肯直接当音频播，统一成 audio/mpeg。
      'content-type': /^audio\//i.test(rawType) ? rawType : 'audio/mpeg',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    }
    const len = upstream.headers.get('content-length')
    if (len) headers['content-length'] = len
    const cr = upstream.headers.get('content-range')
    if (cr) headers['content-range'] = cr

    res.writeHead(upstream.status, headers)
    pipeAudio(upstream, res)
    return { ok: true, status: upstream.status, cr: cr ?? '' }
  }
  return { ok: false, tried }
}

/**
 * B 站音源的播放：必须由宿主代理转发 —— 直链带时效签名，而且 B 站 CDN 查 Referer，
 * 直接把地址丢给 <audio> 会 403。浏览器拖进度条会连着发 Range，所以这里要把
 * Range 透传上去、把 206 和 Content-Range 原样带回来。
 */
async function handleBiliPlay(req, res, bvid) {
  if (!isBiliId(bvid)) return sendJson(res, 400, { ok: false, error: '缺少合法的 BV 号' })

  const range = req.headers.range

  // B 站的地址带时效签名：第一次 403/410 大概率是缓存过期，丢掉重解析一次就活。
  // 拖进度条时浏览器会连发好几个 Range，所以重试只做一次，别把失效打成风暴。
  let upstream = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let url
    try {
      url = await biliAudio(bvid)
    } catch (err) {
      lastPlayError = `B 站解析音频失败：${err?.message ?? err}`
      return sendJson(res, 502, { ok: false, error: lastPlayError })
    }
    try {
      upstream = await fetch(url, {
        redirect: 'follow',
        headers: {
          ...BILI_FETCH_HEADERS,
          ...(typeof range === 'string' && range !== '' ? { range } : {}),
        },
      })
    } catch (err) {
      lastPlayError = `B 站拉流失败：${err?.message ?? err}`
      if (attempt === 0) {
        forgetBiliAudio(bvid)
        continue
      }
      return sendJson(res, 502, { ok: false, error: lastPlayError })
    }

    if (upstream.ok || upstream.status === 206) break

    // 403/410/404：地址过期或这条稿件拿不到音频，重解析一次。
    lastPlayError = `B 站返回 HTTP ${upstream.status}`
    try {
      await upstream.body?.cancel()
    } catch {}
    upstream = null
    if (attempt === 0) {
      forgetBiliAudio(bvid)
      continue
    }
    return sendJson(res, 502, { ok: false, error: lastPlayError })
  }

  if (upstream === null) {
    return sendJson(res, 502, { ok: false, error: lastPlayError || 'B 站拉流失败' })
  }

  const rawType = (upstream.headers.get('content-type') ?? '').toLowerCase()
  const headers = {
    // dash 音频回来一般是 application/octet-stream（其实是 fMP4），统一成 audio/mp4
    'content-type': /^audio\//i.test(rawType) ? rawType : 'audio/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  const len = upstream.headers.get('content-length')
  if (len) headers['content-length'] = len
  const cr = upstream.headers.get('content-range')
  if (cr) headers['content-range'] = cr

  lastPlayError = ''
  notePlay(bvid, range, upstream.status, cr)
  res.writeHead(upstream.status, headers)
  pipeAudio(upstream, res)
}

async function handlePlay(req, res, query, store) {
  const id = String(query.get('id') ?? '').trim()
  if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: '缺少合法的歌曲 id' })
  const cacheKey = `${id}:${store.level || 'standard'}`

  // 服务没起来但登录过：顺手再拉一次，别让「自动拉起还没跑完」变成一次播放失败。
  if (store.cookie && !(await serviceOnline(store.apiBase))) void startServiceOnce(store)

  const range = req.headers.range

  let urls
  try {
    urls = await cachedSongUrls(id, store.level, store)
  } catch (err) {
    lastPlayError = `解析音源失败：${err?.message ?? err}`
    return sendJson(res, 502, { ok: false, error: lastPlayError })
  }

  let result = await streamBest(urls, range, res)
  notePlay(id, range, result?.status ?? 0, result?.cr ?? '')
  if (!result.ok) {
    // 缓存里的地址可能已经过期（CDN 的 vuutv 有时效）：丢掉重解析一次再试。
    urlCache.delete(cacheKey)
    try {
      urls = await cachedSongUrls(id, store.level, store)
      result = await streamBest(urls, range, res)
    } catch (err) {
      result = { ok: false, tried: [...(result.tried ?? []), String(err?.message ?? err)] }
    }
  }
  if (result.ok) {
    lastPlayError = ''
    return
  }

  const tried = result.tried ?? []
  const online = await serviceOnline(store.apiBase)
  if (online) {
    lastPlayError = `没有可用音源（${tried.join('；') || '未知原因'}）`
  } else if (!store.cookie) {
    lastPlayError = '本地 API 服务没起来，而且没登录、直连兜底也拿不到音源'
  } else {
    lastPlayError = `本地 API 服务没起来，直连兜底也失败（${tried.join('；') || '未知原因'}）`
  }
  return sendJson(res, online ? 502 : 503, {
    ok: false,
    error: lastPlayError,
    hint: online ? '这首可能真的没版权，换一首试试' : '去「账号」页签点「启动服务」，冷启动大概十几秒',
  })
}

// ---- 歌词 -----------------------------------------------------------------

function parseLrc(text) {
  if (typeof text !== 'string' || text === '') return []
  const out = []
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of text.split(/\r?\n/)) {
    const stamps = []
    let m
    re.lastIndex = 0
    while ((m = re.exec(line)) !== null) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0
      stamps.push(min * 60 + sec + frac)
    }
    if (stamps.length === 0) continue
    const body = line.replace(re, '').trim()
    if (body === '') continue
    for (const t of stamps) out.push({ t, text: body })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

async function handleLyric(res, query, store) {
  const id = String(query.get('id') ?? '').trim()
  // B 站音源没有 LRC：返回空歌词，而不是 400（前端会当成错误弹提示）。
  if (isBiliId(id)) return sendJson(res, 200, { raw: [], trans: [] })
  if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: '缺少合法的歌曲 id' })
  let data = null
  if (await serviceOnline(store.apiBase)) {
    data = await apiGet(store.apiBase, '/lyric', { id }, store.cookie, store.realIP)
  } else {
    data = await publicApi('/api/song/lyric', { id, lv: -1, kv: -1, tv: -1 })
  }
  return sendJson(res, 200, {
    raw: parseLrc(data?.lrc?.lyric),
    trans: parseLrc(data?.tlyric?.lyric),
  })
}

// ---- 路由 -----------------------------------------------------------------

/**
 * 宿主自己的 http(s) 根地址（如 http://127.0.0.1:54154）。
 *
 * 桌面端页面跑在 `dsh-app://` 自定义协议下：Chromium 的媒体管线对自定义协议
 * 不会发 Range 请求，`<audio>.seekable` 恒为 [0,0]，写 currentTime 会被钉回
 * 原处 —— 用户看到的就是「进度条拖了松手又弹回去」。把音源指到这个真实 http
 * 地址，Range / 206 才走浏览器正常的 HTTP 栈，进度条才能拖。
 *
 * 取不到监听地址时退一步用本次请求的 Host（自定义协议的转发请求里就是宿主自己的
 * 地址）；两者都拿不到才返回空串。客户端拿到空串就退回相对路径：歌照样能放，
 * 只是拖不动进度条，比整首放不出来强。
 */
function hostOriginOf(ctx, req) {
  try {
    const origin = ctx?.webServer?.getOrigin?.()
    if (typeof origin === 'string' && origin !== '') return origin.replace(/\/+$/, '')
  } catch {}
  // getOrigin() 在监听端口绑好之前会抛错；退一步用本次请求的 Host（自定义协议
  // 的转发请求里就是宿主自己的地址）。只接受 host[:port] 形状，别把请求头里
  // 的奇怪内容拼进 URL。
  const host = String(req?.headers?.host ?? '').trim()
  if (host === '' || !/^[A-Za-z0-9.\-:[\]]+$/.test(host)) return ''
  const proto = ctx?.webServer?.protocol === 'https:' ? 'https://' : 'http://'
  return proto + host
}

// ---- 不依赖本地服务的原生接口 ---------------------------------------------
// 本地服务没起来时，/proxy 里下面这几个接口由插件自己直连 music.163.com：
//   扫码登录 unikey / 二维码 / 轮询、账号信息、自己的歌单、歌单详情与曲目。
// 返回 null 表示「这个 path 原生不管」，交回给原来的 409 提示。

// 扫码链路留一小段脚印：只记状态码、HTTP 码、有没有带上 Cookie，不记 key 本身。
// 别的机器登不上时，账号页能把最后几条直接说出来，不用让对方翻控制台。
const qrTrace = []
function traceQr(line) {
  qrTrace.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  while (qrTrace.length > 12) qrTrace.shift()
}

async function nativeQrCreate(params) {
  const key = String(params.key ?? '').trim()
  if (key === '') return { code: 400, error: '缺少二维码 key' }
  const qrurl = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`
  try {
    // 前端直接画内联 SVG：不用 data: URL，也不受页面 CSP 的 img-src 影响。
    const { size, path: d } = qrSvg(qrurl)
    return { code: 200, data: { qrurl, qrpath: d, qrsize: size } }
  } catch (err) {
    return { code: 500, error: `生成二维码失败：${err?.message ?? err}` }
  }
}

const TRACK_BATCH = 200

async function nativeTrackAll(params, store) {
  const id = String(params.id ?? '').trim()
  const limit = Math.min(1000, Math.max(1, Number(params.limit) || 1000))
  const offset = Math.max(0, Number(params.offset) || 0)
  const detail = await playlistDetail(id, store.cookie)
  if (!detail.ok) return { code: 502, error: detail.error }
  const playlist = detail.playlist ?? {}

  // 歌单详情本来就带回前 1000 首完整曲目，offset 落在这段里直接切。
  if (Array.isArray(playlist.tracks) && playlist.tracks.length >= offset + limit) {
    return { code: 200, songs: playlist.tracks.slice(offset, offset + limit) }
  }

  const ids = (Array.isArray(playlist.trackIds) ? playlist.trackIds : [])
    .map((t) => (t && t.id ? Number(t.id) : 0))
    .filter((n) => n > 0)
    .slice(offset, offset + limit)
  if (ids.length === 0) return { code: 200, songs: [] }

  const songs = []
  for (let i = 0; i < ids.length; i += TRACK_BATCH) {
    const chunk = await songsByIds(ids.slice(i, i + TRACK_BATCH), store.cookie)
    songs.push(...chunk)
  }
  return { code: 200, songs }
}

async function nativeProxy(apiPath, params, store) {
  try {
    if (apiPath === '/login/qr/key') {
      const r = await qrKey()
      if (!r.ok) {
        traceQr(`key 失败：${r.error}`)
        return { code: 502, error: r.error }
      }
      traceQr(`key ok（HTTP ${r.status}，cookie ${r.cookieCount} 条）`)
      return { code: 200, data: { unikey: r.key, qrurl: r.qrurl } }
    }
    if (apiPath === '/login/qr/create') return await nativeQrCreate(params)
    if (apiPath === '/login/qr/check') {
      const key = String(params.key ?? '').trim()
      if (key === '') return { code: 400, error: '缺少二维码 key' }
      const r = await qrCheck(key)
      traceQr(`check ${r.code}${r.status ? '/HTTP ' + r.status : ''}${r.hasJar ? ' +cookie' : ' 无cookie'}${r.error ? ' ' + r.error : ''}`)
      return {
        code: r.code,
        message: r.message,
        cookie: r.cookie,
        status: r.status,
        hasJar: r.hasJar,
        ...(r.error ? { error: r.error } : {}),
      }
    }
    if (apiPath === '/user/account') {
      const account = await accountOf(store.cookie)
      if (!account) return { code: 301, account: null, profile: null }
      return {
        code: 200,
        account: { id: account.userId },
        profile: { userId: account.userId, nickname: account.nickname },
      }
    }
    if (apiPath === '/user/playlist') {
      const uid = Number(params.uid) || store.userId
      const limit = Math.min(1000, Math.max(1, Number(params.limit) || 100))
      const offset = Math.max(0, Number(params.offset) || 0)
      const r = await userPlaylists(uid, { limit, offset }, store.cookie)
      if (!r.ok) return { code: 502, error: r.error }
      return { code: 200, more: r.more, playlist: r.playlist }
    }
    if (apiPath === '/playlist/detail') {
      const r = await playlistDetail(String(params.id ?? ''), store.cookie)
      if (!r.ok) return { code: 502, error: r.error }
      return { code: 200, playlist: r.playlist }
    }
    if (apiPath === '/playlist/track/all') return await nativeTrackAll(params, store)
  } catch (err) {
    return { code: 502, error: String(err?.message ?? err) }
  }
  return null
}

async function handle(req, res, mediaOrigin) {
  const route = (req.url ?? '').split('?')[0].slice(PREFIX.length) || '/'
  const query = queryOf(req)
  const store = readStore()

  if (route === '/state' && req.method === 'GET') {
    // fresh=1：跳过 1.5 秒的探测缓存，给用户点「重新检测」时用。
    const online = await serviceOnline(store.apiBase, query.get('fresh') === '1')
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      apiBase: store.apiBase,
      serviceOnline: online,
      serviceDir: findServiceDir(store),
      level: store.level,
      nickname: store.nickname,
      userId: store.userId,
      hasCookie: store.cookie !== '',
      realIP: store.realIP,
      lastPlayError,
      spawnNote,
      recentPlay: recentPlay.slice(-20),
      // 扫码最近几条状态（不含 key）：账号页登不上时直接显示，别的机器也能远程说清楚
      qrTrace: qrTrace.slice(-6),
      node: process.version,
      // 自定义协议页面拿它拼音源绝对地址（普通浏览器页面不用，走相对路径）
      mediaOrigin: typeof mediaOrigin === 'string' ? mediaOrigin : '',
    })
  }

  if (route === '/search' && req.method === 'GET') {
    const source = String(query.get('source') ?? 'netease')
    if (source === 'bili') {
      try {
        const songs = await searchBili(query.get('keywords'), query.get('limit'))
        return sendJson(res, 200, { ok: true, source, songs })
      } catch (err) {
        return sendJson(res, 502, { ok: false, source, error: String(err?.message ?? err) })
      }
    }
    try {
      const songs = await doSearch(query.get('keywords'), query.get('limit'), store)
      return sendJson(res, 200, { ok: true, source: 'netease', songs })
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: String(err?.message ?? err) })
    }
  }

  if (route === '/play' && req.method === 'GET') {
    const id = String(query.get('id') ?? '').trim()
    // B 站音源：id 是 BV 号，走 bilibili CDN（必须带 Referer，所以要代理转发）
    if (String(query.get('source') ?? '') === 'bili' || (isBiliId(id) && !/^\d+$/.test(id))) {
      return handleBiliPlay(req, res, id)
    }
    return handlePlay(req, res, query, store)
  }

  if (route === '/lyric' && req.method === 'GET') {
    try {
      return await handleLyric(res, query, store)
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: String(err?.message ?? err) })
    }
  }

  if (route === '/cookie' && req.method === 'POST') {
    const body = await readBody(req)
    const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : ''
    if (cookie === '') {
      writeStore({ cookie: '', nickname: '', userId: 0 })
      return sendJson(res, 200, { ok: true, loggedOut: true })
    }

    // 先用 music.163.com 的公开账号接口验：本地服务在不在都能验。
    let account = await accountOf(cookie)
    if (!account && (await serviceOnline(store.apiBase))) {
      const viaService = await apiGet(store.apiBase, '/user/account', {}, cookie)
      if (Number(viaService?.code) === 200 && viaService?.profile?.userId) {
        account = { userId: Number(viaService.profile.userId), nickname: String(viaService.profile.nickname ?? '') }
      }
    }
    if (!account) return sendJson(res, 400, { ok: false, error: '这个 Cookie 无效或已过期' })

    writeStore({ cookie, nickname: account.nickname, userId: account.userId })
    return sendJson(res, 200, { ok: true, nickname: account.nickname, userId: account.userId })
  }

  if (route === '/config' && req.method === 'POST') {
    const body = await readBody(req)
    const next = {}
    if (typeof body.apiBase === 'string' && body.apiBase !== '') next.apiBase = body.apiBase.replace(/\/+$/, '')
    if (typeof body.serviceDir === 'string') next.serviceDir = body.serviceDir
    if (typeof body.level === 'string' && body.level !== '') next.level = body.level
    if (typeof body.realIP === 'string') next.realIP = body.realIP.trim()
    writeStore(next)
    return sendJson(res, 200, { ok: true, ...readStore() })
  }

  if (route === '/service/start' && req.method === 'POST') {
    // 手动点的「启动服务」绕过节流冷却：用户就是要现在再试一次。
    const result = await startServiceOnce(store, true)
    return sendJson(res, 200, { ok: result.ok, ...result, serviceOnline: await serviceOnline(store.apiBase, true) })
  }

  // 通用透传：/proxy?path=/login/qr/key&...
  // 本地服务在线 → 原样透传（会员曲/更高音质走它）；离线 → 扫码登录、账号、歌单
  // 这几个接口由 nativeProxy 自己完成，剩下的才回 409。
  if (route === '/proxy' && req.method === 'GET') {
    const apiPath = query.get('path') ?? ''
    if (!apiPath.startsWith('/')) return sendJson(res, 400, { ok: false, error: 'path 必须以 / 开头' })
    const params = {}
    for (const [k, v] of query.entries()) if (k !== 'path') params[k] = v

    if (await serviceOnline(store.apiBase)) {
      try {
        const data = await apiGet(store.apiBase, apiPath, params, store.cookie, store.realIP)
        return sendJson(res, 200, data)
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: String(err?.message ?? err) })
      }
    }

    const native = await nativeProxy(apiPath, params, store)
    if (native !== null) return sendJson(res, 200, native)
    return sendJson(res, 409, { ok: false, error: '本地 API 服务没起来' })
  }

  return sendJson(res, 404, { ok: false, error: `未知接口 ${route}` })
}

export function apply(ctx) {
  // getOrigin() 要等监听绑好端口，而插件 apply 可能更早 —— 第一次请求时才取，取到就缓存。
  let mediaOrigin = ''
  const route = {
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      try {
        if (mediaOrigin === '') mediaOrigin = hostOriginOf(ctx, req)
        await handle(req, res, mediaOrigin)
      } catch (err) {
        try {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        } catch {}
      }
    },
  }

  // 必须挂在 ctx.effect 里：插件卸载 / 热重载时 cordis 才会把路由 dispose 掉。
  // 直接 register 的话，旧路由会一直挂着，重载时直接撞 "duplicate prefix route"。
  if (typeof ctx.effect === 'function') ctx.effect(() => ctx.webServer.register(route))
  else ctx.webServer.register(route)

  // 注册完路由就顺手在后台看一眼服务，不 await。
  autoStartService()
}
