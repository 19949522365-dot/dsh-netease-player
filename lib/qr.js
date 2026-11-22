/**
 * 极简 QR 编码器（byte 模式 / EC 级别 M / 版本 1–40）。
 *
 * 为什么要自己带一个：扫码登录需要宿主在本地生成二维码，而
 * NeteaseCloudMusicApi 的 /login/qr/create 用的是 qrcode 这个 npm 包。
 * 插件要在「什么都没装」的机器上也能扫码，就不能引依赖，也不能依赖那个本地服务。
 *
 * 实现按 ISO/IEC 18004：byte 模式数据段 → Reed-Solomon（GF(256)）→ 分块交织 →
 * 功能图形 → 8 种掩码按惩罚分挑一个 → 格式/版本信息 BCH。
 * 生成的模块矩阵已和 qrcode@1.5 的 byte 模式输出逐位比对过（版本 1–40、8 种掩码全部一致）。
 *
 * 对外只暴露 qrSvg()：给一段文本，返回 { size, path }，
 * 前端用 <svg viewBox="0 0 size size"><path d={path}/></svg> 直接画出来。
 */

// ---- GF(256) ----
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function initGF() {
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
})()

function gmul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function genPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gmul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function rsEncode(data, degree) {
  const gen = genPoly(degree)
  const res = new Uint8Array(data.length + degree)
  res.set(data)
  for (let i = 0; i < data.length; i += 1) {
    const factor = res[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j += 1) res[i + j] ^= gmul(gen[j], factor)
  }
  return res.slice(data.length)
}

// ---- 常量表（M 级，版本 1–40） ----
const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
]
const EC_CODEWORDS = [
  0, 10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198, 216, 240, 280, 308, 338, 364, 416,
  442, 476, 504, 560, 588, 644, 700, 728, 784, 812, 868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372,
]
const BLOCKS = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
]

const symbolSize = (version) => version * 4 + 17

class Bits {
  constructor() {
    this.bits = []
  }
  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }
  length() {
    return this.bits.length
  }
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8))
    for (let i = 0; i < this.bits.length; i += 1) if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7)
    return out
  }
}

function maskBit(pattern, i, j) {
  switch (pattern) {
    case 0:
      return (i + j) % 2 === 0
    case 1:
      return i % 2 === 0
    case 2:
      return j % 3 === 0
    case 3:
      return (i + j) % 3 === 0
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0
    default:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0
  }
}

function alignmentCoords(version) {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const size = symbolSize(version)
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2
  const positions = [size - 7]
  for (let i = 1; i < count - 1; i += 1) positions[i] = positions[i - 1] - intervals
  positions.push(6)
  return positions.reverse()
}

function alignmentPositions(version) {
  const coords = alignmentCoords(version)
  const size = symbolSize(version)
  const out = []
  for (const row of coords) {
    for (const col of coords) {
      const nearFinder =
        (row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)
      if (!nearFinder) out.push([row, col])
    }
  }
  return out
}

function bchDigit(data) {
  let digit = 0
  let v = data
  while (v !== 0) {
    digit += 1
    v >>>= 1
  }
  return digit
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1

function formatBits(mask) {
  // EC 级别 M 的 2 位编码是 00，所以只有掩码在变
  const data = mask
  let d = data << 10
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15))
  return ((data << 10) | d) ^ G15_MASK
}

function versionBits(version) {
  let d = version << 12
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18))
  return (version << 12) | d
}

class Matrix {
  constructor(size) {
    this.size = size
    this.data = new Uint8Array(size * size)
    this.reserved = new Uint8Array(size * size)
  }
  set(row, col, value, reserved = false) {
    const i = row * this.size + col
    this.data[i] = value ? 1 : 0
    if (reserved) this.reserved[i] = 1
  }
  get(row, col) {
    return this.data[row * this.size + col]
  }
  xor(row, col, value) {
    this.data[row * this.size + col] ^= value ? 1 : 0
  }
  isReserved(row, col) {
    return this.reserved[row * this.size + col] === 1
  }
}

function setupFinder(matrix) {
  const size = matrix.size
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r < 0 || row + r >= size) continue
      for (let c = -1; c <= 7; c += 1) {
        if (col + c < 0 || col + c >= size) continue
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        matrix.set(row + r, col + c, dark, true)
      }
    }
  }
}

function setupTiming(matrix) {
  const size = matrix.size
  for (let r = 8; r < size - 8; r += 1) {
    const dark = r % 2 === 0
    matrix.set(r, 6, dark, true)
    matrix.set(6, r, dark, true)
  }
}

function setupAlignment(matrix, version) {
  for (const [row, col] of alignmentPositions(version)) {
    for (let r = -2; r <= 2; r += 1) {
      for (let c = -2; c <= 2; c += 1) {
        const dark = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)
        matrix.set(row + r, col + c, dark, true)
      }
    }
  }
}

function setupVersionInfo(matrix, version) {
  if (version < 7) return
  const size = matrix.size
  const bits = versionBits(version)
  for (let i = 0; i < 18; i += 1) {
    const row = Math.floor(i / 3)
    const col = (i % 3) + size - 11
    const dark = ((bits >> i) & 1) === 1
    matrix.set(row, col, dark, true)
    matrix.set(col, row, dark, true)
  }
}

function setupFormatInfo(matrix, mask) {
  const size = matrix.size
  const bits = formatBits(mask)
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 6) matrix.set(i, 8, dark, true)
    else if (i < 8) matrix.set(i + 1, 8, dark, true)
    else matrix.set(size - 15 + i, 8, dark, true)

    if (i < 8) matrix.set(8, size - i - 1, dark, true)
    else if (i < 9) matrix.set(8, 15 - i, dark, true)
    else matrix.set(8, 15 - i - 1, dark, true)
  }
  matrix.set(size - 8, 8, 1, true)
}

function setupData(matrix, codewords) {
  const size = matrix.size
  let inc = -1
  let row = size - 1
  let bitIndex = 7
  let byteIndex = 0
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (!matrix.isReserved(row, col - c)) {
          let dark = false
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1
          matrix.set(row, col - c, dark)
          bitIndex -= 1
          if (bitIndex === -1) {
            byteIndex += 1
            bitIndex = 7
          }
        }
      }
      row += inc
      if (row < 0 || row >= size) {
        row -= inc
        inc = -inc
        break
      }
    }
  }
}

function penaltyN1(m) {
  const size = m.size
  let points = 0
  for (let row = 0; row < size; row += 1) {
    let sameCol = 0
    let sameRow = 0
    let lastCol = null
    let lastRow = null
    for (let col = 0; col < size; col += 1) {
      let v = m.get(row, col)
      if (v === lastCol) sameCol += 1
      else {
        if (sameCol >= 5) points += 3 + (sameCol - 5)
        lastCol = v
        sameCol = 1
      }
      v = m.get(col, row)
      if (v === lastRow) sameRow += 1
      else {
        if (sameRow >= 5) points += 3 + (sameRow - 5)
        lastRow = v
        sameRow = 1
      }
    }
    if (sameCol >= 5) points += 3 + (sameCol - 5)
    if (sameRow >= 5) points += 3 + (sameRow - 5)
  }
  return points
}

function penaltyN2(m) {
  const size = m.size
  let points = 0
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const sum = m.get(row, col) + m.get(row, col + 1) + m.get(row + 1, col) + m.get(row + 1, col + 1)
      if (sum === 0 || sum === 4) points += 1
    }
  }
  return points * 3
}

function penaltyN3(m) {
  const size = m.size
  let points = 0
  for (let row = 0; row < size; row += 1) {
    let bitsCol = 0
    let bitsRow = 0
    for (let col = 0; col < size; col += 1) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | m.get(row, col)
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 1
      bitsRow = ((bitsRow << 1) & 0x7ff) | m.get(col, row)
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 1
    }
  }
  return points * 40
}

function penaltyN4(m) {
  let dark = 0
  for (let i = 0; i < m.data.length; i += 1) dark += m.data[i]
  const k = Math.abs(Math.ceil((dark * 100) / m.data.length / 5) - 10)
  return k * 10
}

function applyMask(m, pattern) {
  const size = m.size
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row < size; row += 1) {
      if (m.isReserved(row, col)) continue
      if (maskBit(pattern, row, col)) m.xor(row, col, 1)
    }
  }
}

/** 文本 → { size, data }（size 是不含静区的模块数） */
export function qrMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8')
  let version = 0
  for (let cand = 1; cand <= 40; cand += 1) {
    const dataBits = (TOTAL_CODEWORDS[cand] - EC_CODEWORDS[cand]) * 8
    const ccBits = cand < 10 ? 8 : 16
    if (4 + ccBits + bytes.length * 8 <= dataBits) {
      version = cand
      break
    }
  }
  if (version === 0) throw new Error('内容太长，放不进一个二维码')

  const totalCodewords = TOTAL_CODEWORDS[version]
  const ecCodewords = EC_CODEWORDS[version]
  const blocks = BLOCKS[version]
  const dataTotal = totalCodewords - ecCodewords
  const dataBits = dataTotal * 8

  const bb = new Bits()
  bb.put(4, 4) // byte 模式
  bb.put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) bb.put(b, 8)
  if (bb.length() + 4 <= dataBits) bb.put(0, 4)
  while (bb.length() % 8 !== 0) bb.put(0, 1)
  const remaining = (dataBits - bb.length()) / 8
  for (let i = 0; i < remaining; i += 1) bb.put(i % 2 ? 0x11 : 0xec, 8)
  const dataBytes = bb.toBytes()

  const blocksInGroup2 = totalCodewords % blocks
  const blocksInGroup1 = blocks - blocksInGroup2
  const dataCodewordsInGroup1 = Math.floor(dataTotal / blocks)
  const ecCount = Math.floor(totalCodewords / blocks) - dataCodewordsInGroup1

  const dc = []
  const ec = []
  let offset = 0
  let maxData = 0
  for (let b = 0; b < blocks; b += 1) {
    const size = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup1 + 1
    dc[b] = dataBytes.slice(offset, offset + size)
    ec[b] = rsEncode(dc[b], ecCount)
    offset += size
    maxData = Math.max(maxData, size)
  }

  const finalBytes = new Uint8Array(totalCodewords)
  let index = 0
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blocks; b += 1) if (i < dc[b].length) finalBytes[index++] = dc[b][i]
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (let b = 0; b < blocks; b += 1) finalBytes[index++] = ec[b][i]
  }

  const size = symbolSize(version)
  const m = new Matrix(size)
  setupFinder(m)
  setupTiming(m)
  setupAlignment(m, version)
  setupFormatInfo(m, 0) // 先占位，把格式区标成保留
  setupVersionInfo(m, version)
  setupData(m, finalBytes)

  let best = 0
  let lowest = Infinity
  for (let p = 0; p < 8; p += 1) {
    setupFormatInfo(m, p)
    applyMask(m, p)
    const penalty = penaltyN1(m) + penaltyN2(m) + penaltyN3(m) + penaltyN4(m)
    applyMask(m, p)
    if (penalty < lowest) {
      lowest = penalty
      best = p
    }
  }
  applyMask(m, best)
  setupFormatInfo(m, best)

  return { size, data: m.data, version, mask: best }
}

/**
 * 文本 → 可直接塞进 <svg viewBox="0 0 size size"> 的 { size, path }。
 * border 是静区（模块数），2 就够；白色底由前端画。
 */
export function qrSvg(text, { border = 2 } = {}) {
  const { size, data } = qrMatrix(text)
  const total = size + border * 2
  const parts = []
  for (let row = 0; row < size; row += 1) {
    let col = 0
    while (col < size) {
      if (data[row * size + col] === 0) {
        col += 1
        continue
      }
      let run = 1
      while (col + run < size && data[row * size + col + run] === 1) run += 1
      parts.push(`M${col + border} ${row + border}h${run}v1h-${run}z`)
      col += run
    }
  }
  return { size: total, path: parts.join('') }
}
