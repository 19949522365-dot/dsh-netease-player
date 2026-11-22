// v0.3.8 底栏 44px 专项自测
// ---------------------------------------------------------------------------
// A 部分：真交互（假 React：状态 + 副作用 + 重渲染），模拟点击/指针拖动，断言状态与重渲染结果
// B 部分：CSS 层叠断言（最终生效的那条规则是不是走 --np-bar-h）
// C 部分：把真渲染树序列化成 HTML，交给 Edge 无头浏览器做真实布局/命中测试（见 probe 脚本）
//
// 用法：node tests/bar44.mjs [lib/client.js] [outDir]
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = process.argv[2] || path.join(here, '..', 'lib', 'client.js')
const outDir = process.argv[3] || path.join(here, '..', 'out')
const source = fs.readFileSync(clientPath, 'utf8')

let failed = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failed += 1
}

// ---------------------------------------------------------------- 假 React ---
function makeRuntime() {
  const slots = new Map()
  let dirty = false
  const keyStack = []
  let pending = []
  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  function createElement(type, props, ...children) {
    const p = props ? Object.assign({}, props) : {}
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { $$el: true, type, props: p }
  }
  function slotFor(kind) {
    const key = (keyStack[keyStack.length - 1] || 'root') + '|' + kind
    let st = slots.get(key)
    if (!st) {
      st = { hooks: [], cursor: 0 }
      slots.set(key, st)
    }
    const i = st.cursor++
    if (!(i in st.hooks)) st.hooks[i] = { value: undefined, ref: null, memo: undefined, deps: undefined, fn: undefined }
    return { s: st.hooks[i], key, i }
  }
  function useState(init) {
    const { s } = slotFor('state')
    if (s.value === undefined) s.value = typeof init === 'function' ? init() : init
    return [
      s.value,
      (next) => {
        const v = typeof next === 'function' ? next(s.value) : next
        if (!Object.is(v, s.value)) {
          s.value = v
          dirty = true
        }
      },
    ]
  }
  function useRef(init) {
    const { s } = slotFor('ref')
    if (s.ref === null) s.ref = { current: init === undefined ? null : init }
    return s.ref
  }
  function useMemo(fn, deps) {
    const { s } = slotFor('memo')
    if (!s.deps || !sameDeps(s.deps, deps)) {
      s.memo = fn()
      s.deps = deps
    }
    return s.memo
  }
  function useCallback(fn, deps) {
    const { s } = slotFor('cb')
    if (!s.deps || !sameDeps(s.deps, deps)) {
      s.fn = fn
      s.deps = deps
    }
    return s.fn
  }
  function useEffect(fn, deps) {
    const { key, i, s } = slotFor('effect')
    if (!s.deps || !sameDeps(s.deps, deps)) {
      s.deps = deps
      pending.push({ ekey: key + '#' + i, fn })
    }
  }
  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(patch) {
      this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch)
      dirty = true
    }
  }
  Component.prototype.isReactComponent = {}
  const React = {
    createElement,
    useState,
    useRef,
    useMemo,
    useCallback,
    useEffect,
    useLayoutEffect: useEffect,
    Component,
    Fragment: 'fragment',
  }
  function flushEffects() {
    const run = pending
    pending = []
    for (const { ekey, fn } of run) {
      try {
        fn()
      } catch (e) {
        console.log('      [effect 抛错] ' + (e && e.message))
      }
    }
  }
  return {
    React,
    flushEffects,
    isDirty: () => dirty,
    clearDirty: () => (dirty = false),
    resetCursors: () => {
      for (const st of slots.values()) st.cursor = 0
    },
    setKey: (k) => keyStack.push(k),
    popKey: () => keyStack.pop(),
  }
}

// ---------------------------------------------------------------- 渲染器 + ref 绑定 ---
function makeRenderer(rt, hooks) {
  function makeElStub(tag) {
    if (tag === 'audio') {
      const handlers = new Map()
      const a = {
        currentTime: 0,
        volume: 1,
        duration: 0,
        src: '',
        paused: true,
        style: {},
        addEventListener(t, fn) {
          if (!handlers.has(t)) handlers.set(t, [])
          handlers.get(t).push(fn)
        },
        removeEventListener() {},
        getAttribute: () => null,
        removeAttribute() {},
        setAttribute() {},
        load() {},
        pause() {
          a.paused = true
        },
        play() {
          a.paused = false
          return Promise.resolve()
        },
        // 让测试能主动派发音频事件（durationchange / timeupdate）
        __fire(t) {
          for (const fn of handlers.get(t) || []) fn()
        },
      }
      hooks.audio = a
      return a
    }
    return {
      // ProgressBar 的 valueAt() 用这个矩形算 seek 目标
      getBoundingClientRect: () => ({ left: 300, top: 700, width: 400, height: 22, right: 700, bottom: 722 }),
      closest: () => null,
      setPointerCapture() {},
      releasePointerCapture() {},
      style: {},
      querySelector: () => null,
    }
  }

  function renderNode(node, depth) {
    if (node === null || node === undefined || node === false || node === true || node === '') return null
    if (Array.isArray(node)) return node.map((n) => renderNode(n, depth)).filter((n) => n !== null)
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node.$$el) return null
    const { type, props } = node
    if (typeof type === 'function') {
      rt.setKey(String(type.name || 'anon') + ':' + depth)
      let child
      try {
        child = type.prototype && type.prototype.isReactComponent ? new type(props).render() : type(props)
      } finally {
        rt.popKey()
      }
      return renderNode(child, depth + 1)
    }
    if (props && props.ref && props.ref.current === null) props.ref.current = makeElStub(type)
    return { $$el: true, type, props: Object.assign({}, props, { children: renderNode(props.children, depth + 1) }) }
  }
  return (rootNode) => renderNode(rootNode, 0)
}

// ---------------------------------------------------------------- DOM 工具 ---
function walk(node, fn) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn))
  if (typeof node !== 'object' || !node.$$el) return
  fn(node)
  walk(node.props.children, fn)
}
function findAll(tree, cls) {
  const hits = []
  walk(tree, (n) => {
    const c = n.props && n.props.className
    if (typeof c === 'string' && c.split(/\s+/).indexOf(cls) >= 0) hits.push(n)
  })
  return hits
}
function find(tree, cls) {
  return findAll(tree, cls)[0] || null
}
function textOf(node) {
  let s = ''
  walk(node, (n) => {
    if (typeof n.props.children === 'string') s += n.props.children
  })
  return s
}
function ev(extra) {
  return Object.assign(
    {
      preventDefault() {},
      stopPropagation() {},
      currentTarget: { setPointerCapture() {}, releasePointerCapture() {}, closest: () => null },
      target: { closest: () => null },
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      key: '',
    },
    extra || {},
  )
}
function clickNode(node, extra) {
  if (!node || !node.props || typeof node.props.onClick !== 'function') return false
  node.props.onClick(ev(extra))
  return true
}

// ---------------------------------------------------------------- 装载 ---
const rt = makeRuntime()
const hooks = {}
const render = makeRenderer(rt, hooks)

const store = {
  'np.queue.v1': JSON.stringify([
    { id: 210049, name: '稻香', artist: '周杰伦', album: '魔杰座', cover: '', duration: 223000, fee: 0 },
    { id: 186016, name: '晴天', artist: '周杰伦', album: '叶惠美', cover: '', duration: 269000, fee: 0 },
  ]),
  'np.index.v1': '0',
}
const listeners = new Map()
const captured = { styles: [] }
const doc = {
  getElementById: () => null,
  createElement: () => {
    const el = { id: '', textContent: '' }
    captured.styles.push(el)
    return el
  },
  head: { appendChild() {} },
  body: { appendChild() {} },
  querySelector: () => null,
  addEventListener(t, fn) {
    if (!listeners.has(t)) listeners.set(t, [])
    listeners.get(t).push(fn)
  },
  removeEventListener(t, fn) {
    const list = listeners.get(t) || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  },
}
function dispatchDoc(type, event) {
  for (const fn of (listeners.get(type) || []).slice()) fn(event)
}
let factory = null
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => (store[k] = String(v)),
    removeItem: (k) => delete store[k],
  },
  document: doc,
  fetch: () => Promise.reject(new Error('自测不发网络请求')),
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = { load: (spec) => (factory = spec.factory) }
vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.js' })
const mod = factory((id) => {
  if (id === 'react') return rt.React
  throw new Error('未知依赖 ' + id)
})
let rootFn = null
mod.apply({
  effect(fn) {
    return fn()
  },
  slots: {
    inject(_s, fn) {
      fn()
    },
    register(_c, fn) {
      rootFn = fn
      return () => {}
    },
  },
})
const CSS = (captured.styles[0] && captured.styles[0].textContent) || ''

async function renderAll() {
  let tree = null
  for (let i = 0; i < 30; i += 1) {
    rt.clearDirty()
    rt.resetCursors()
    tree = render(rootFn())
    rt.flushEffects()
    await new Promise((r) => setTimeout(r, 0))
    if (!rt.isDirty()) break
  }
  return tree
}

// ============================================================ A. 真交互 ===
console.log('== A. 真交互（点击 / 拖动 / 状态重渲染）==')
let tree = await renderAll()
const audio = hooks.audio

// 让 duration 有值（真实环境由 durationchange 事件带进来）
if (audio) {
  audio.duration = 223
  audio.__fire('durationchange')
}
tree = await renderAll()

const bar = find(tree, 'np-bar')
check('底栏渲染出来了', !!bar)

// A1 五个控件都在，且都挂着 onClick
const controls = find(tree, 'np-controls')
const iconBtns = findAll(controls, 'np-icon-btn')
const playBtn = find(controls, 'np-play-btn')
const rightBox = find(tree, 'np-right')
const rightBtns = findAll(rightBox, 'np-icon-btn')
check('运输键：上一首 / 下一首', iconBtns.length === 2 && iconBtns.every((b) => typeof b.props.onClick === 'function'), 'n=' + iconBtns.length)
check('运输键：播放键', !!playBtn && typeof playBtn.props.onClick === 'function')
check('右侧：静音键 + 展开键', rightBtns.length >= 2 && rightBtns.every((b) => typeof b.props.onClick === 'function'), 'n=' + rightBtns.length)
check('歌曲信息可点（展开面板）', !!find(bar, 'np-now') && typeof find(bar, 'np-now').props.onClick === 'function')
check('底栏歌词可点（进歌词页）', !!find(bar, 'np-bar-lyric') && typeof find(bar, 'np-bar-lyric').props.onClick === 'function')

// A2 上一首 / 下一首真的换歌
const titleNow = () => {
  const t = find(tree, 'np-now-title')
  return t ? textOf(t) : ''
}
const before = titleNow()
clickNode(iconBtns[1]) // 下一首
tree = await renderAll()
const afterNext = titleNow()
check('点「下一首」换到下一首', afterNext === '晴天', before + ' -> ' + afterNext)
clickNode(findAll(find(tree, 'np-controls'), 'np-icon-btn')[0]) // 上一首
tree = await renderAll()
check('点「上一首」换回来', titleNow() === '稻香', 'now=' + titleNow())

// A3 播放 / 暂停 图标换 + playing 状态影响底栏类名
const playPath = () => {
  let d = ''
  walk(find(tree, 'np-play-btn'), (n) => {
    if (!d && n.type === 'path') d = n.props.d
  })
  return d
}
const p1 = playPath()
clickNode(find(tree, 'np-play-btn'))
tree = await renderAll()
const p2 = playPath()
check('点播放键：图标会翻转', p1 !== p2 && p1 !== '' && p2 !== '', p1.slice(0, 8) + ' -> ' + p2.slice(0, 8))
const isPauseNow = p2.indexOf('M6 5h4') === 0
const clsNow = String(find(tree, 'np-bar').props.className)
check('底栏类名与播放状态一致（np-bar--playing 跟着图标走）', (clsNow.indexOf('np-bar--playing') >= 0) === isPauseNow, clsNow + ' / pauseIcon=' + isPauseNow)
// 再点一次，状态与类名都要跟着变
clickNode(find(tree, 'np-play-btn'))
tree = await renderAll()
const p3 = playPath()
const cls3 = String(find(tree, 'np-bar').props.className)
const isPause3 = p3.indexOf('M6 5h4') === 0
check(
  '再点一次：图标翻转回来 + 类名同步',
  p3 !== p2 && isPause3 === (cls3.indexOf('np-bar--playing') >= 0),
  p3.slice(0, 8) + ' / ' + cls3,
)

// A4 静音键：volume 归 0，再点回 0.7
const volInput = () => findAll(tree, 'np-volume')[0]
const muteBtn = () => findAll(find(tree, 'np-right'), 'np-icon-btn')[0]
check('底栏有静音键', !!muteBtn())
clickNode(muteBtn())
tree = await renderAll()
check('点静音后音量滑杆为 0', volInput() && Number(volInput().props.value) === 0, 'value=' + (volInput() ? volInput().props.value : '?'))
clickNode(muteBtn())
tree = await renderAll()
check('再点一次音量回到 70', volInput() && Number(volInput().props.value) === 70, 'value=' + (volInput() ? volInput().props.value : '?'))

// A5 进度条：指针按下 -> 跟手预览（重渲染）-> 松手 seek
// 换歌（playAt）会把 dur 归零，等音频 durationchange 回来才有值 —— 这里补一次事件
if (audio) {
  audio.duration = 223
  audio.__fire('durationchange')
}
tree = await renderAll()
const prog = () => find(tree, 'np-progress')
check('进度条拿到时长（aria-valuemax=223）', Number(prog().props['aria-valuemax']) === 223, 'max=' + prog().props['aria-valuemax'])
const drag = (type, clientX) => {
  const p = prog()
  const fn = p.props[type]
  if (typeof fn !== 'function') return false
  fn(ev({ clientX, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } }))
  return true
}
check('进度条有指针事件', ['onPointerDown', 'onPointerMove', 'onPointerUp'].every((k) => typeof prog().props[k] === 'function'))
drag('onPointerDown', 420) // (420-300)/400 = 30%
tree = await renderAll()
const pctNb = Number(prog().props['aria-valuenow'])
check('按下 30% 处：进度预览跟到 30%', Math.abs(pctNb - 0.3 * 223) <= 2, 'aria-valuenow=' + pctNb)
check('拖动中标记 data-drag=true', prog().props['data-drag'] === 'true')
drag('onPointerMove', 620) // 80%
tree = await renderAll()
check('拖到 80% 处：预览跟到 80%', Math.abs(Number(prog().props['aria-valuenow']) - 0.8 * 223) <= 2, 'aria-valuenow=' + prog().props['aria-valuenow'])
drag('onPointerUp', 620)
tree = await renderAll()
check('松手后真的 seek（audio.currentTime=80%）', audio && Math.abs(audio.currentTime - 0.8 * 223) <= 2, 'currentTime=' + (audio ? audio.currentTime.toFixed(1) : 'n/a'))
check('松手后 data-drag=false', prog().props['data-drag'] === 'false')
// 边界：拖到 0% / 100% 不越界
drag('onPointerDown', 100)
tree = await renderAll()
check('拖到最左（越界）夹到 0', Number(prog().props['aria-valuenow']) === 0, 'aria-valuenow=' + prog().props['aria-valuenow'])
drag('onPointerUp', 100)
drag('onPointerDown', 2000)
tree = await renderAll()
check('拖到最右（越界）夹到 dur', Number(prog().props['aria-valuenow']) === 223, 'aria-valuenow=' + prog().props['aria-valuenow'])
drag('onPointerUp', 2000)
tree = await renderAll()

// A6 底栏歌词 -> 面板歌词页；点面板外/Esc 收起
clickNode(find(tree, 'np-bar-lyric'))
tree = await renderAll()
check('点底栏歌词：展开并落在歌词页', !!find(tree, 'np-panel--lyric') && !!find(tree, 'np-lyric'))
dispatchDoc('keydown', { key: 'Escape' })
tree = await renderAll()
check('Esc 收起面板', !find(tree, 'np-panel'))
clickNode(find(tree, 'np-now'))
tree = await renderAll()
check('点歌曲信息再次展开（落在默认页签）', !!find(tree, 'np-panel'))
dispatchDoc('pointerdown', { target: { closest: () => null } })
tree = await renderAll()
check('点面板外面收起', !find(tree, 'np-panel'))

// A7 单曲循环按钮：这一版底栏只有 上一首/播放/下一首，没有循环模式键
let repeatHit = null
walk(tree, (n) => {
  const t = (n.props && (n.props.title || '')) + ''
  if (!repeatHit && /循环|repeat|单曲/.test(t)) repeatHit = t
})
check('底栏不存在「单曲循环」键（所以无热区风险）', repeatHit === null, repeatHit ? '发现: ' + repeatHit : 'transport = prev/play/next')

// ============================================================ B. CSS 层叠 ===
console.log('\n== B. CSS：最终生效的规则 ==')
function declBlocks(sel) {
  const out = []
  let i = 0
  for (;;) {
    const at = CSS.indexOf(sel + '{', i)
    if (at < 0) break
    const end = CSS.indexOf('}', at)
    out.push({ at, body: CSS.slice(at + sel.length + 1, end) })
    i = at + 1
  }
  return out
}
function lastDecl(sel, prop) {
  const blocks = declBlocks(sel).filter((b) => new RegExp('(^|;)' + prop + ':').test(b.body))
  if (blocks.length === 0) return null
  const b = blocks[blocks.length - 1]
  const m = b.body.match(new RegExp('(?:^|;)' + prop + ':([^;]+)'))
  return m ? m[1] : null
}
check('定义了 --np-bar-h:44px', CSS.indexOf('--np-bar-h:44px') >= 0 && CSS.split('--np-bar-h:44px').length - 1 === 1)
check('.np-bar 最终 height = var(--np-bar-h)', lastDecl('.np-bar', 'height') === 'var(--np-bar-h)', String(lastDecl('.np-bar', 'height')))
check('.np-panel 最终 bottom = calc(var(--np-bar-h) + 10px)', lastDecl('.np-panel', 'bottom') === 'calc(var(--np-bar-h) + 10px)', String(lastDecl('.np-panel', 'bottom')))
check(
  '.np-panel 最终 height 用 100vh - var(--np-bar-h) - 46px',
  String(lastDecl('.np-panel', 'height')) === 'min(600px,calc(100vh - var(--np-bar-h) - 46px))',
  String(lastDecl('.np-panel', 'height')),
)
const glowPanelSel = '.np-glow-light .np-panel-glow,.np-glow-mid .np-panel-glow,.np-glow-heavy .np-panel-glow'
check('.np-panel-glow 最终 bottom = calc(var(--np-bar-h) + 2px)', lastDecl(glowPanelSel, 'bottom') === 'calc(var(--np-bar-h) + 2px)', String(lastDecl(glowPanelSel, 'bottom')))
check(
  '.np-panel-glow 最终 height 用 100vh - var(--np-bar-h) - 34px',
  String(lastDecl(glowPanelSel, 'height')) === 'min(632px,calc(100vh - var(--np-bar-h) - 34px))',
  String(lastDecl(glowPanelSel, 'height')),
)
const glowBarSel = '.np-glow-light .np-bar-glow,.np-glow-mid .np-bar-glow,.np-glow-heavy .np-bar-glow'
check('.np-bar-glow 最终 bottom = var(--np-bar-h)', lastDecl(glowBarSel, 'bottom') === 'var(--np-bar-h)', String(lastDecl(glowBarSel, 'bottom')))
check('底栏光晕不越到底栏上方内容里（bottom 恒等于底栏高度）', lastDecl('.np-bar-glow', 'bottom') === 'var(--np-bar-h)', String(lastDecl('.np-bar-glow', 'bottom')))
const hardcoded = ['bottom:72px', 'bottom:80px', 'bottom:66px', 'bottom:62px', 'bottom:58px', 'bottom:56px', 'bottom:54px', 'bottom:52px', 'bottom:50px', 'bottom:48px', 'calc(100vh - 92px)', 'calc(100vh - 94px)', 'calc(100vh - 98px)', 'calc(100vh - 156px)', 'calc(100vh - 82px)', 'height:52px', 'height:72px']
const leftOver = hardcoded.filter((s) => CSS.indexOf(s) >= 0)
check('没有残留写死的底栏高度相关偏移', leftOver.length === 0, leftOver.join(' | '))
// 空白处不跳歌词页：最终一层必须是容器 none / 文字 auto
const lyricBlocks = declBlocks('.np-bar .np-bar-lyric')
check('底栏歌词容器最终 pointer-events:none', /pointer-events:none/.test(lyricBlocks[lyricBlocks.length - 1].body), lyricBlocks[lyricBlocks.length - 1].body)
const bodyBlocks = declBlocks('.np-bar .np-bar-lyric-body,.np-bar .np-bar-lyric-cur')
check('歌词文字本体 pointer-events:auto', bodyBlocks.length > 0 && /pointer-events:auto/.test(bodyBlocks[bodyBlocks.length - 1].body), bodyBlocks.length ? bodyBlocks[bodyBlocks.length - 1].body.slice(0, 80) : 'missing')
check('底栏里的音量滑杆是隐藏的（由面板头滑杆接管）', /\.np-volume\{display:none\}/.test(CSS))

// ============================================================ C. 序列化 HTML ===
console.log('\n== C. 生成真实布局探针页 ==')
const VOID = new Set(['img', 'input', 'br', 'hr']) // audio 不是 void：不加闭合标签会把后面整棵子树吞进去
const ATTR_MAP = {
  className: 'class',
  tabIndex: 'tabindex',
  viewBox: 'viewBox',
  preserveAspectRatio: 'preserveAspectRatio',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function cssStyle(obj) {
  return Object.keys(obj || {})
    .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
    .map((k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + obj[k])
    .join(';')
}
function serialize(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (typeof node === 'string') return esc(node)
  if (!node.$$el) return ''
  const { type, props } = node
  const attrs = []
  // 所有「值能写进 HTML」的 prop 都要带上：svg 的 viewBox / fill / d 漏了，图标就整片消失
  for (const k of Object.keys(props)) {
    if (k === 'children' || k === 'ref' || k === 'key') continue
    const v = props[k]
    if (v === undefined || v === null || v === false || typeof v === 'function') continue
    const name = ATTR_MAP[k] || k
    if (k === 'style') attrs.push('style="' + esc(cssStyle(v)) + '"')
    else if (v === true) attrs.push(k.indexOf('aria-') === 0 ? name + '="true"' : name)
    else attrs.push(name + '="' + esc(v) + '"')
  }
  const open = '<' + type + (attrs.length ? ' ' + attrs.join(' ') : '') + '>'
  if (VOID.has(type)) return open
  return open + serialize(props.children) + '</' + type + '>'
}

const PROBE = String.raw`
(function(){
try{
  function R(el){ if(!el) return null; var r=el.getBoundingClientRect(); return {l:+r.left.toFixed(2),t:+r.top.toFixed(2),r:+r.right.toFixed(2),b:+r.bottom.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)}; }
  function q(s){ return document.querySelector(s); }
  function qa(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function center(r){ return [r.l + r.w/2, r.t + r.h/2]; }
  function hitClosest(r, sel){ if(!r) return 'no-rect'; var c=center(r); var e=document.elementFromPoint(c[0],c[1]); var n=e&&e.closest?e.closest(sel):null; return n? 'yes':'no('+((e&&(e.className||e.tagName))||'null')+')'; }
  var out={vw:innerWidth, vh:innerHeight, bar:R(q('.np-bar'))};
  var b=out.bar;
  var ctlBtns=qa('.np-bar .np-controls button');
  var rightBtns=qa('.np-bar .np-right button');
  var items={
    left:R(q('.np-bar .np-left')),
    now:R(q('.np-bar .np-now')),
    cover:R(q('.np-bar .np-cover')),
    lyric:R(q('.np-bar .np-bar-lyric')),
    lyricBody:R(q('.np-bar .np-bar-lyric-body')),
    lyricCur:R(q('.np-bar .np-bar-lyric-cur')),
    controls:R(q('.np-bar .np-controls')),
    play:R(q('.np-bar .np-play-btn')),
    prev:R(ctlBtns[0]),
    next:R(ctlBtns[ctlBtns.length-1]),
    right:R(q('.np-bar .np-right')),
    timeline:R(q('.np-bar .np-timeline')),
    progress:R(q('.np-bar .np-progress')),
    mute:R(rightBtns[0]),
    expand:R(rightBtns[rightBtns.length-1]),
    time:R(q('.np-bar .np-time'))
  };
  Object.keys(items).forEach(function(k){ if(!items[k]) delete items[k]; });
  out.items=items;
  var SEL={left:'.np-bar .np-left',now:'.np-bar .np-now',cover:'.np-bar .np-cover',lyric:'.np-bar .np-bar-lyric',lyricBody:'.np-bar .np-bar-lyric-body',lyricCur:'.np-bar .np-bar-lyric-cur',controls:'.np-bar .np-controls',play:'.np-bar .np-play-btn',right:'.np-bar .np-right',timeline:'.np-bar .np-timeline',progress:'.np-bar .np-progress',time:'.np-bar .np-time'};
  out.inside={}; out.center={}; out.textFit={};
  Object.keys(items).forEach(function(k){
    var r=items[k];
    out.inside[k]=(r.t>=b.t-0.5 && r.b<=b.b+0.5);
    if(/^(left|controls|right|timeline|progress|now|cover)$/.test(k)) out.center[k]=+(((r.t+r.b)/2)-((b.t+b.b)/2)).toFixed(2);
    var el=SEL[k]?q(SEL[k]):null;
    if(el && /^(lyricCur|time|now)$/.test(k)){
      var cs=getComputedStyle(el); var fs=parseFloat(cs.fontSize); var lh=cs.lineHeight==='normal'?fs*1.2:parseFloat(cs.lineHeight);
      out.textFit[k]={fs:fs,lh:lh,h:r.h,ok:(r.h+0.5>=lh) && (el.scrollHeight<=el.clientHeight+1)};
    }
  });
  out.overlap={ leftVsControls:(items.left&&items.controls)?(items.left.r<=items.controls.l+0.5):null, controlsVsRight:(items.controls&&items.right)?(items.controls.r<=items.right.l+0.5):null };
  out.overflow={ barScroll:q('.np-bar').scrollWidth, barClient:q('.np-bar').clientWidth, docScroll:document.scrollingElement.scrollWidth, vw:innerWidth };
  function npUp(e){ var n=e; while(n && n.nodeType===1){ var c=n.className; if(typeof c==='string' && c.indexOf('np-')>=0) return c; n=n.parentElement; } return e?String(e.tagName):'null'; }
  out.hits={};
  ['play','prev','next','mute','expand','now','progress','timeline'].forEach(function(k){ if(items[k]){ var c=center(items[k]); out.hits[k]=npUp(document.elementFromPoint(c[0],c[1])); } });
  out.hitClosest={ play:hitClosest(items.play,'.np-play-btn'), prev:hitClosest(items.prev,'.np-icon-btn'), next:hitClosest(items.next,'.np-icon-btn'), mute:hitClosest(items.mute,'.np-icon-btn'), expand:hitClosest(items.expand,'.np-icon-btn'), progress:hitClosest(items.progress,'.np-progress'), lyricBody:hitClosest(items.lyricBody,'.np-bar-lyric-body') };
  if(items.lyric && items.lyricBody){
    var x=Math.min(items.lyric.r-4, items.lyricBody.r+8), y=(items.lyric.t+items.lyric.b)/2;
    var e2=document.elementFromPoint(x,y);
    out.lyricBlankHit={x:+x.toFixed(1), y:+y.toFixed(1), inLyric: !!(e2&&e2.closest&&e2.closest('.np-bar-lyric')), got: e2?String(e2.className||e2.tagName):'null'};
  }
  var pr=items.progress;
  out.seekMath={ t25:+(0.25*223).toFixed(1), t75:+(0.75*223).toFixed(1), width:pr?pr.w:0 };
  var pn=q('.np-panel'); var pl=q('.np-panel-glow'); var bg=q('.np-bar-glow');
  out.panel = pn? {rect:R(pn), gapToBar:+(b.t - R(pn).b).toFixed(2), bottomOffset:+(innerHeight - R(pn).b).toFixed(2)} : null;
  out.panelGlow = pl? {rect:R(pl), bottomOffset:+(innerHeight - R(pl).b).toFixed(2)} : null;
  out.barGlow = bg? {rect:R(bg), bottomOffset:+(innerHeight - R(bg).b).toFixed(2)} : null;
  emit(JSON.stringify(out));
}catch(err){
  emit(JSON.stringify({error:String(err && err.stack || err)}));
}
function emit(txt){
  var pre=document.createElement('pre');
  pre.id='probe';
  pre.setAttribute('style','position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1');
  pre.textContent=txt;
  document.documentElement.appendChild(pre);
}
})();
`

function pageFor(treeHtml, extraCss) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>bar44</title><style>${CSS}</style><style>
html,body{margin:0;padding:0;height:100%;background:#fff;overflow:hidden}
#shell{height:100vh;display:flex;flex-direction:column;min-height:0}
#spacer{flex:1 1 auto;min-height:0}
${extraCss || ''}
</style></head><body><div id="shell"><div id="spacer"></div>${treeHtml}</div><script>${PROBE}<\/script></body></html>`
}

fs.mkdirSync(outDir, { recursive: true })

// 收起态：面板不在
tree = await renderAll()
if (find(tree, 'np-panel')) {
  dispatchDoc('keydown', { key: 'Escape' })
  tree = await renderAll()
}
const collapsedHtml = serialize(tree)
fs.writeFileSync(path.join(outDir, 'bar44-collapsed.html'), pageFor(collapsedHtml))

// 展开态：点开面板
clickNode(find(tree, 'np-now'))
tree = await renderAll()
const expandedHtml = serialize(tree)
const hasPanel = !!find(tree, 'np-panel')
check('展开态包含 .np-panel / .np-panel-glow', hasPanel && expandedHtml.indexOf('np-panel-glow') >= 0)
fs.writeFileSync(path.join(outDir, 'bar44-expanded.html'), pageFor(expandedHtml))

// 像素测量用的「去装饰」副本（光晕是 pointer-events:none 的装饰层，不影响布局）
const flatCss = '.np-bar-glow,.np-panel-glow{display:none!important}.np-glow-light .np-bar,.np-glow-mid .np-bar,.np-glow-heavy .np-bar{background-image:none!important}.np-bar::after{display:none!important}'
fs.writeFileSync(path.join(outDir, 'bar44-flat-collapsed.html'), pageFor(collapsedHtml, flatCss))
fs.writeFileSync(path.join(outDir, 'bar44-flat-expanded.html'), pageFor(expandedHtml, flatCss))

console.log('      probe: ' + path.join(outDir, 'bar44-collapsed.html'))
console.log('      probe: ' + path.join(outDir, 'bar44-expanded.html'))
console.log('      probe: ' + path.join(outDir, 'bar44-flat-collapsed.html'))

process.exit(failed === 0 ? 0 : 1)
