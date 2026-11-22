/**
 * 不依赖 NeteaseCloudMusicApi 的那一半：自己跟网易云 Web 接口说话。
 *
 * 为什么要自己写：
 *   插件的扫码登录原来整套代理给本地 NeteaseCloudMusicApi（/login/qr/*），
 *   别人下载插件后没这个服务，二维码就永远是「本地 API 服务没起来」。
 *   扫码登录本身只需要两个 weapi 接口（unikey / client/login）+ 一次
 *   music.163.com 的公开账号接口，用 node:crypto 就能算签名，不必带一个 Node 服务。
 *
 * weapi 签名：明文本 → AES-128-CBC(presetKey) → AES-128-CBC(随机 16 位 secretKey)，
 * 再把 secretKey 倒序用 RSA 公钥（NO_PADDING，前面补 0 到 128 字节）算出 encSecKey。
 *
 * 这里只管「读」：扫码拿 Cookie、账号信息、自己的歌单、歌单里的曲目。
 * 会员曲目 / 更高音质仍然建议装本地服务（宿主里那条 /song/url/v1 的路径）。
 */

import crypto from 'node:crypto'

const IV = Buffer.from('0102030405060708')
const PRESET_KEY = Buffer.from('0CoJUm6Qyw8W8jud')
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://music.163.com/'
const TIMEOUT_MS = 12000

function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV)
  return Buffer.concat([cipher.update(text), cipher.final()]).toString('base64')
}

/** 明文对象 → { params, encSecKey } */
export function weapi(data) {
  const text = JSON.stringify(data)
  const secretKey = crypto.randomBytes(8).toString('hex') // 16 个字符
  const params = aesEncrypt(aesEncrypt(text, PRESET_KEY), Buffer.from(secretKey))
  const padded = Buffer.concat([Buffer.alloc(128 - 16, 0), Buffer.from(secretKey.split('').reverse().join(''))])
  const encSecKey = crypto
    .publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded)
    .toString('hex')
  return { params, encSecKey }
}

function cookiePairs(setCookie) {
  const out = []
  for (const raw of setCookie ?? []) {
    if (typeof raw !== 'string') continue
    const head = raw.split(';')[0]
    if (head === '') continue
    const eq = head.indexOf('=')
    if (eq <= 0) continue
    out.push(head)
  }
  return out
}

/** 把两次响应里的 Cookie 合起来：同名以新的为准 */
export function mergeCookies(...lists) {
  const map = new Map()
  for (const list of lists) {
    for (const item of list) {
      for (const pair of String(item).split(';')) {
        const p = pair.trim()
        if (p === '') continue
        const eq = p.indexOf('=')
        if (eq <= 0) continue
        map.set(p.slice(0, eq), p.slice(eq + 1))
      }
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'user-agent': UA, referer: REFERER, ...headers },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  return { status: res.status, json, text, cookies: cookiePairs(setCookie) }
}

async function weapiPost(path, data, cookie = '') {
  const form = new URLSearchParams(weapi(data)).toString()
  return request(`https://music.163.com/weapi${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://music.163.com',
      ...(cookie ? { cookie } : {}),
    },
    body: form,
  })
}

async function publicGet(path, params, cookie = '') {
  const url = new URL(path, 'https://music.163.com')
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  return request(url.toString(), { headers: cookie ? { cookie } : {} })
}

// 扫码过程中要带着 unikey 那次响应给的 Cookie（主要是 NMTID）。
// 数量很少，超过 20 个就把最早的丢掉。
const qrJars = new Map()

function rememberJar(key, cookie) {
  qrJars.set(key, cookie)
  while (qrJars.size > 20) {
    const oldest = qrJars.keys().next().value
    qrJars.delete(oldest)
  }
}

/** 拿一个登录二维码的 unikey。 */
export async function qrKey() {
  const res = await weapiPost('/login/qrcode/unikey', { type: 1 })
  const key = res.json && typeof res.json.unikey === 'string' ? res.json.unikey : ''
  if (key === '') {
    return { ok: false, error: `拿不到二维码 key（HTTP ${res.status}）` }
  }
  const cookie = mergeCookies(res.cookies)
  rememberJar(key, cookie)
  return { ok: true, key, qrurl: `https://music.163.com/login?codekey=${encodeURIComponent(key)}`, cookie }
}

/**
 * 轮询扫码状态。
 * 801 等待扫码 / 802 已扫码待确认 / 803 成功（带 Cookie）/ 800 过期。
 */
export async function qrCheck(key) {
  const jar = qrJars.get(key) ?? ''
  const res = await weapiPost('/login/qrcode/client/login', { key, type: 1 }, jar)
  const json = res.json ?? {}
  const code = Number(json.code)
  const merged = mergeCookies([jar], res.cookies)
  if (merged !== '') rememberJar(key, merged)
  const hasAuth = /(^|;\s*)MUSIC_U=[^;\s]+/.test(merged)
  return {
    code: Number.isFinite(code) ? code : 0,
    message: typeof json.message === 'string' ? json.message : '',
    // 只有真正拿到 MUSIC_U 才算登录成功，别把 NMTID 当登录态
    cookie: code === 803 && hasAuth ? merged : '',
  }
}

/** 用 Cookie 问一次账号信息；没登录 / Cookie 失效返回 null。 */
export async function accountOf(cookie) {
  if (!cookie) return null
  const res = await publicGet('/api/nuser/account/get', null, cookie)
  const profile = res.json && res.json.profile
  if (!profile || !profile.userId) return null
  return { userId: Number(profile.userId), nickname: String(profile.nickname ?? '') }
}

/** 登录用户自己的歌单（含「我喜欢的音乐」）。 */
export async function userPlaylists(uid, { limit = 100, offset = 0 } = {}, cookie = '') {
  const res = await publicGet('/api/user/playlist', { uid, limit, offset }, cookie)
  const body = res.json ?? {}
  if (Number(body.code) !== 200) {
    return { ok: false, error: body.message || `歌单列表读取失败（HTTP ${res.status}）` }
  }
  return { ok: true, more: Boolean(body.more), playlist: Array.isArray(body.playlist) ? body.playlist : [] }
}

/** 歌单详情：曲目用 trackIds 表示（客户端按 id 再取详情）。 */
export async function playlistDetail(id, cookie = '') {
  const res = await publicGet('/api/v6/playlist/detail', { id, n: 1000, s: 0 }, cookie)
  const body = res.json ?? {}
  if (Number(body.code) !== 200 || !body.playlist) {
    return { ok: false, error: body.message || `歌单详情读取失败（HTTP ${res.status}）` }
  }
  return { ok: true, playlist: body.playlist }
}

/** 一批歌曲详情（公开接口，ids 用 JSON 数组写法）。 */
export async function songsByIds(ids, cookie = '') {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  if (list.length === 0) return []
  const res = await publicGet('/api/song/detail', { ids: JSON.stringify(list) }, cookie)
  const body = res.json ?? {}
  return Array.isArray(body.songs) ? body.songs : []
}
