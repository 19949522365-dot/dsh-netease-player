// 用 Edge 的 DevTools 协议跑真实布局：拿 getBoundingClientRect / elementFromPoint 的实测值
// 前提：另开一个 `msedge --headless=new --remote-debugging-port=9411`（由 PowerShell 启动）
// 用法：node tests/probe-edge.mjs 9411 <probeDir> <outDir>
import fs from 'node:fs'
import path from 'node:path'

const port = process.argv[2] || '9411'
const probeDir = process.argv[3]
const outDir = process.argv[4] || path.join(process.cwd(), 'out')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failed += 1
}

async function targets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) return await r.json()
    } catch (e) {}
    await sleep(250)
  }
  throw new Error('连不上 Edg 的调试端口 ' + port)
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const waiting = new Map()
    const listeners = []
    ws.addEventListener('open', () =>
      resolve({
        send(method, params) {
          const mid = ++id
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
          return new Promise((res, rej) => waiting.set(mid, { res, rej }))
        },
        on(fn) {
          listeners.push(fn)
        },
        close: () => ws.close(),
      }),
    )
    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data)
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.error) w.rej(new Error(msg.error.message))
        else w.res(msg.result)
        return
      }
      for (const fn of listeners) fn(msg)
    })
    ws.addEventListener('error', (e) => reject(new Error('WS 连接失败')))
  })
}

const list = await targets()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('没有 page target: ' + JSON.stringify(list.map((t) => t.type)))
const cdp = await connect(page.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

let loaded = false
cdp.on((m) => {
  if (m.method === 'Page.loadEventFired') loaded = true
})

const fileUrl = (f) => new URL('file:///' + path.resolve(probeDir, f).replace(/\\/g, '/')).href

const CASES = [
  { name: '1280-collapsed', w: 1280, h: 800, file: 'bar44-collapsed.html' },
  { name: '1280-expanded', w: 1280, h: 800, file: 'bar44-expanded.html' },
  { name: '1440-expanded', w: 1440, h: 900, file: 'bar44-expanded.html' },
  { name: '1024-collapsed', w: 1024, h: 768, file: 'bar44-collapsed.html' },
  { name: '860-expanded', w: 860, h: 700, file: 'bar44-expanded.html' },
  { name: '760-collapsed', w: 760, h: 700, file: 'bar44-collapsed.html' },
  { name: 'short-expanded', w: 900, h: 460, file: 'bar44-expanded.html' },
  { name: 'flat1280', w: 1280, h: 800, file: 'bar44-flat-collapsed.html' },
]

fs.mkdirSync(outDir, { recursive: true })
const results = {}

for (const c of CASES) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: c.w,
    height: c.h,
    deviceScaleFactor: 1,
    mobile: false,
  })
  loaded = false
  await cdp.send('Page.navigate', { url: fileUrl(c.file) })
  for (let i = 0; i < 80 && !loaded; i += 1) await sleep(100)
  await sleep(250)
  const r = await cdp.send('Runtime.evaluate', {
    expression: "document.getElementById('probe') ? document.getElementById('probe').textContent : 'NO_PROBE'",
    returnByValue: true,
  })
  const txt = String(r.result && r.result.value)
  if (txt === 'NO_PROBE' || txt.length < 20) {
    console.log(`FAIL  ${c.name}: 探针没跑起来 -> ${txt.slice(0, 80)}`)
    failed += 1
    continue
  }
  const data = JSON.parse(txt)
  results[c.name] = data
  fs.writeFileSync(path.join(outDir, `measure-${c.name}.json`), JSON.stringify(data, null, 2))
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const buf = Buffer.from(shot.data, 'base64')
  fs.writeFileSync(path.join(outDir, `shot-${c.name}.png`), buf)
  console.log(`      ${c.name}: ${c.w}x${c.h} bar=${data.bar.h}px 截图 ${buf.length} 字节`)
}

// ---------------------------------------------------------------- 断言 ---
function assertLayout(name, d, opts) {
  const b = d.bar
  check(`[${name}] 底栏实际高度 = 44px`, b.h === 44, 'h=' + b.h + ' (viewport ' + d.vw + 'x' + d.vh + ')')
  check(`[${name}] 底栏底边贴住视口底`, Math.abs(b.b - d.vh) <= 0.5, 'bar.bottom=' + b.b + ' vh=' + d.vh)
  const keys = Object.keys(d.items)
  // display:none 的（窄屏被媒体查询收起的进度/时间）没有盒子，不参与「是否被裁 / 居中 / 文字」判断
  const vis = keys.filter((k) => d.items[k].w > 0 && d.items[k].h > 0)
  const outside = vis.filter((k) => d.inside[k] === false)
  check(`[${name}] 底栏内所有子元素都在 44px 内、没被裁`, outside.length === 0, outside.length ? outside.join(',') : vis.length + ' 个可见元素')
  const badCenter = vis.filter((k) => d.center[k] !== undefined && Math.abs(d.center[k]) > 0.51)
  check(`[${name}] 子元素垂直居中`, badCenter.length === 0, badCenter.length ? badCenter.map((k) => k + ':' + d.center[k]).join(' ') : 'ok')
  const badText = vis.filter((k) => d.textFit[k] && !d.textFit[k].ok)
  check(`[${name}] 文字没被压扁（行高容得下）`, badText.length === 0, badText.length ? JSON.stringify(badText.map((k) => d.textFit[k])) : 'now-title/lyric/time')
  check(`[${name}] 左/中/右三块不重叠`, d.overlap.leftVsControls !== false && d.overlap.controlsVsRight !== false, JSON.stringify(d.overlap))
  check(`[${name}] 底栏没有横向溢出`, d.overflow.barScroll <= d.overflow.barClient + 1, d.overflow.barScroll + '/' + d.overflow.barClient)
  check(`[${name}] 整页没有横向溢出`, d.overflow.docScroll <= d.overflow.vw, d.overflow.docScroll + '/' + d.overflow.vw)
  const hitsNeeded = vis.filter((k) => ['play', 'prev', 'next', 'mute', 'expand', 'now', 'progress'].indexOf(k) >= 0)
  const badHit = hitsNeeded.filter((k) => !d.hits[k] || d.hits[k].indexOf('np-') < 0)
  check(`[${name}] 控件热区都命中自己（${hitsNeeded.length} 个）`, badHit.length === 0, hitsNeeded.map((k) => k + '=' + (d.hits[k] || 'miss')).join(' '))
  const closestChecked = Object.keys(d.hitClosest).filter((k) => vis.indexOf(k) >= 0)
  check(`[${name}] elementFromPoint 精确落在控件上`, closestChecked.every((k) => d.hitClosest[k] === 'yes'), closestChecked.map((k) => k + '=' + d.hitClosest[k]).join(' '))
  if (d.lyricBlankHit && d.items.lyric && d.items.lyric.w > 0) {
    check(`[${name}] 歌词行空白处打不到歌词（点了不跳页）`, d.lyricBlankHit.inLyric === false, JSON.stringify(d.lyricBlankHit))
  }
  if (d.seekMath.width > 0) {
    check(`[${name}] 进度条 seek 换算（25%/75% → 55.8/167.3s）`, Math.abs(d.seekMath.t25 - 55.8) < 1 && Math.abs(d.seekMath.t75 - 167.3) < 1, JSON.stringify(d.seekMath))
  }
  if (opts.expanded) {
    const p = d.panel
    check(`[${name}] 面板底边离底栏 10px（不压底栏）`, p && Math.abs(p.gapToBar - 10) <= 0.5, p ? 'gap=' + p.gapToBar : 'no panel')
    check(`[${name}] 面板底边偏移 = 44+10 = 54px`, p && Math.abs(p.bottomOffset - 54) <= 0.5, p ? 'offset=' + p.bottomOffset : 'no panel')
    check(`[${name}] 面板没顶出视口顶部`, p && p.rect.t >= -0.5, p ? 'top=' + p.rect.t + ' bottom=' + p.rect.b + ' h=' + p.rect.h : 'no panel')
    check(`[${name}] 面板高度不超过 600（+2px 边框）`, p && p.rect.h <= 602.5, p ? 'h=' + p.rect.h + '（600 内容 + 2 边框）' : 'no panel')
    check(`[${name}] 面板光晕底边偏移 = 46px`, d.panelGlow && Math.abs(d.panelGlow.bottomOffset - 46) <= 0.5, d.panelGlow ? 'offset=' + d.panelGlow.bottomOffset : 'no glow')
    check(`[${name}] 底栏光晕贴底栏顶边（bottom = 44）`, d.barGlow && Math.abs(d.barGlow.bottomOffset - 44) <= 0.5, d.barGlow ? 'offset=' + d.barGlow.bottomOffset : 'no glow')
  } else {
    check(`[${name}] 收起态没有面板/面板光晕`, d.panel === null && d.panelGlow === null, JSON.stringify({ panel: d.panel, glow: d.panelGlow }))
  }
}

for (const c of CASES) {
  if (!results[c.name]) continue
  assertLayout(c.name, results[c.name], { expanded: c.file.indexOf('expanded') >= 0 })
}

// 展开/收起：底栏本身不能跳
const a = results['1280-collapsed']
const e = results['1280-expanded']
if (a && e) {
  check(
    '展开/收起时底栏几何完全不变（没有留白跳变）',
    a.bar.t === e.bar.t && a.bar.h === e.bar.h && a.bar.b === e.bar.b,
    JSON.stringify({ collapsed: [a.bar.t, a.bar.h], expanded: [e.bar.t, e.bar.h] }),
  )
}

fs.writeFileSync(path.join(outDir, 'measure-all.json'), JSON.stringify(results, null, 2))
console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
cdp.close()
process.exit(failed === 0 ? 0 : 1)
