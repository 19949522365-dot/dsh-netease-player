// B 站音源：搜索（WBI 签名）+ 解析可播放的 dash 音频流。
//
// 为什么单独一个文件：B 站这套接口跟网易云完全不搭界（签名、cookie、Referer、
// 多档音频），塞进 index.js 会把那边已经很长的路由逻辑淹掉。
//
// 实测链路（2026-11）：
//   nav(拿 wbi 密钥) -> spi(拿 buvid3) -> wbi/search/type -> view(拿 cid)
//   -> player/playurl?fnval=16(拿 dash.audio) -> 带 Referer 拉音频流 200 全套可用。
//   未登录时 nav 回 -101，但 wbi_img 照样有，搜索不受影响。

import { createHash } from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
  11, 36, 20, 34, 44, 52,
]

const md5 = (s) => createHash('md5').update(s).digest('hex')

function mixinKey(orig) {
  return MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32)
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': UA, referer: REFERER, ...headers },
  })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: r.status, json, text }
}

// ---- wbi 密钥 / buvid3 ------------------------------------------------------

let wbiCache = null // { mixin, at }
let buvidCache = null // { value, at }
const KEY_TTL = 2 * 60 * 60 * 1000

async function wbiMixin() {
  if (wbiCache && Date.now() - wbiCache.at < KEY_TTL) return wbiCache.mixin
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav')
  const imgUrl = nav.json?.data?.wbi_img?.img_url ?? ''
  const subUrl = nav.json?.data?.wbi_img?.sub_url ?? ''
  if (imgUrl === '' || subUrl === '') throw new Error('拿不到 B 站 wbi 密钥')
  const imgKey = imgUrl.split('/').pop().split('.')[0]
  const subKey = subUrl.split('/').pop().split('.')[0]
  const mixin = mixinKey(imgKey + subKey)
  wbiCache = { mixin, at: Date.now() }
  return mixin
}

async function buvid3() {
  if (buvidCache && Date.now() - buvidCache.at < KEY_TTL) return buvidCache.value
  try {
    const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi')
    const value = spi.json?.data?.b_3 ?? ''
    if (value !== '') {
      buvidCache = { value, at: Date.now() }
      return value
    }
  } catch {}
  return ''
}

async function signedQuery(params) {
  const mixin = await wbiMixin()
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const q = Object.keys(p)
    .sort()
    .map((k) => {
      const v = String(p[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  return q + '&w_rid=' + md5(q + mixin)
}

// ---- 时长 / 标题清洗 --------------------------------------------------------

/** "3:43" / "1:02:11" -> 秒 */
function durationTextToSec(text) {
  const parts = String(text ?? '').split(':').map((x) => Number(x))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function cleanTitle(raw) {
  return String(raw ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// 明显不是"一首歌"的东西。命中就重罚，但不直接丢——万一是某个冷门歌唯一版本。
const BAD_WORDS = [
  '鼓谱', '乐谱', '简谱', '吉他谱', '教程', '教学', '指弹教学', '翻唱', '鬼畜',
  '纯音乐合集', '合集', '盘点', '排行', 'top10', 'reaction', '解说', '直播',
  '录屏', '混剪', '挑战', '钢琴改编', '光遇', '红石', 'Minecraft', '我的世界',
  '葫芦丝', '口琴', '八音盒', 'midi', '音源演示', '听歌识曲', '十首', '首相似',
]

// 专业搬运号：标题干净、音质好、基本是原曲完整版。
const GOOD_UPS = [
  '音乐私藏馆', 'JLRS-LeoFM', 'VV音乐局', '4K修复', 'Hi-Res', 'HiRes',
  '无损音质', '蓝光原盘', '官方MV', 'MV', '音乐银行', '音悦台',
]

const GOOD_TITLE_KEYWORDS = ['hi-res', 'hires', '无损', '4k', '官方', 'mv', '原曲', '超清']

function score(item, keyword) {
  const title = cleanTitle(item.title)
  const lower = title.toLowerCase()
  const up = String(item.author ?? '')
  const sec = durationTextToSec(item.duration)
  let s = 0

  // 时长：一首歌常见 2:30 ~ 6:30，太短是切片、太长是播客/盘点。
  if (sec >= 150 && sec <= 400) s += 6
  else if (sec >= 90 && sec <= 480) s += 2
  else s -= 8

  // 关键词命中（把查询拆成 token，长的更值钱）。
  const tokens = keyword.toLowerCase().split(/\s+/).filter((t) => t.length >= 2)
  for (const t of tokens) if (lower.includes(t)) s += t.length >= 4 ? 3 : 2

  for (const w of BAD_WORDS) if (lower.includes(w.toLowerCase())) s -= 9
  for (const w of GOOD_UPS) if (up.includes(w) || title.includes(w)) s += 3
  for (const w of GOOD_TITLE_KEYWORDS) if (lower.includes(w)) s += 1

  // 播放量：取对数，别让爆款把冷门但正确的版本压死。
  const play = Number(item.play ?? 0) || 0
  s += Math.log10(Math.max(play, 1)) * 0.8

  // 分 P 合集里的某一 P 容易挑错段，轻微减分。
  const nPages = Number(item.videos ?? 0) || 0
  if (nPages > 1) s -= 2

  return s
}

// ---- 对外：搜索 -------------------------------------------------------------

/**
 * 搜 B 站视频并映射成前端统一的瘦结构。
 * id 用原始 BV 号；前端靠 item.src === 'bili' 决定播放时带上 source 参数。
 */
export async function searchBili(keywords, limit = 30) {
  const kw = String(keywords ?? '').trim()
  if (kw === '') return []
  const lim = Math.min(50, Math.max(1, Number(limit) || 30))

  const qs = await signedQuery({
    search_type: 'video',
    keyword: kw,
    page: 1,
    page_size: 30,
  })
  const cookie = await buvid3()
  const res = await getJson(
    'https://api.bilibili.com/x/web-interface/wbi/search/type?' + qs,
    cookie !== '' ? { cookie: `buvid3=${cookie}` } : {},
  )
  if (res.json?.code !== 0) {
    throw new Error(`B 站搜索失败 code=${res.json?.code ?? '?'} ${res.json?.message ?? ''}`.trim())
  }

  const raw = Array.isArray(res.json?.data?.result) ? res.json.data.result : []
  const scored = raw
    .filter((r) => r && typeof r.bvid === 'string' && r.bvid.startsWith('BV'))
    .map((r) => ({ r, s: score(r, kw) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, lim)

  return scored.map(({ r }) => {
    const sec = durationTextToSec(r.duration)
    const pic = typeof r.pic === 'string' && r.pic !== '' ? (r.pic.startsWith('//') ? 'https:' + r.pic : r.pic) : ''
    return {
      id: r.bvid,
      src: 'bili',
      name: cleanTitle(r.title),
      artist: String(r.author ?? ''),
      album: `B站 · ${r.duration ?? ''}`.trim(),
      cover: pic,
      duration: sec * 1000,
      fee: 0,
      play: Number(r.play ?? 0) || 0,
    }
  })
}

// ---- 对外：取音频 -----------------------------------------------------------

const audioCache = new Map() // bvid -> { url, at }
const AUDIO_TTL = 10 * 60 * 1000 // B 站地址带时效签名，别存太久

export function isBiliId(id) {
  return /^BV[0-9A-Za-z]{10}$/.test(String(id ?? ''))
}

async function cidOf(bvid) {
  const view = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid)
  if (view.json?.code !== 0) throw new Error(`B 站取视频信息失败 code=${view.json?.code}`)
  const cid = view.json?.data?.cid
  if (!cid) throw new Error('这条视频没有 cid（可能是番剧/特殊稿件）')
  return cid
}

/** 解析 bvid 的最高码率音频直链。 */
export async function biliAudio(bvid) {
  if (!isBiliId(bvid)) throw new Error('不是合法的 BV 号')
  const hit = audioCache.get(bvid)
  if (hit && Date.now() - hit.at < AUDIO_TTL) return hit.url

  const cid = await cidOf(bvid)
  const cookie = await buvid3()
  const play = await getJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fnver=0&fourk=1`,
    cookie !== '' ? { cookie: `buvid3=${cookie}` } : {},
  )
  if (play.json?.code !== 0) throw new Error(`B 站取播放地址失败 code=${play.json?.code}`)

  const audios = Array.isArray(play.json?.data?.dash?.audio) ? play.json.data.dash.audio : []
  if (audios.length === 0) {
    // 老视频可能只有 durl（整段 flv/mp4），那种得先下载再抽音轨，这里不兜。
    throw new Error('这条视频没有 dash 音频流（可能是老稿件或充电专属）')
  }
  const best = audios.reduce((a, b) => ((b.bandwidth ?? 0) > (a.bandwidth ?? 0) ? b : a))
  const url = best.baseUrl || (Array.isArray(best.backupUrl) ? best.backupUrl[0] : '')
  if (!url) throw new Error('拿到的音频流没有地址')

  audioCache.set(bvid, { url, at: Date.now() })
  if (audioCache.size > 60) {
    for (const k of [...audioCache.keys()].slice(0, 20)) audioCache.delete(k)
  }
  return url
}

/** 丢掉某条视频缓存的播放地址（地址带时效，过期了要重新问一次）。 */
export function forgetBiliAudio(bvid) {
  audioCache.delete(String(bvid ?? ''))
}

/** 拉音频流时要带的头（B 站 CDN 查防盗链）。 */
export const BILI_FETCH_HEADERS = { 'user-agent': UA, referer: REFERER }
