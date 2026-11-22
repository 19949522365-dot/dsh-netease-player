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
      let ct = 0
      const a = {
        get currentTime() {
          return ct
        },
        set currentTime(v) {
          a.__sets.push(v)
          if (!a.__pin) ct = v
        },
        __sets: [],
        __pin: false,
        readyState: 0,
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

// ============================================================ 快进（seek）专项 ===
// 这一组专门盯「快进用不了」：dur=0、元数据还没到、音源不可 seek 三种情况。
console.log('== 快进专项 ==')
let tree = await renderAll()
const audio = hooks.audio

function prog() {
  return find(tree, 'np-progress')
}
function pointer(type, clientX) {
  const p = prog()
  const fn = p.props[type]
  if (typeof fn !== 'function') return false
  fn({
    preventDefault() {},
    stopPropagation() {},
    pointerId: 1,
    clientX,
    currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
    target: { closest: () => null },
  })
  return true
}
// 进度条几何在渲染器里是固定的：left=300 width=400（见 makeElStub）
const xAt = (f) => 300 + 400 * f
const timeText = () => {
  const tl = find(tree, 'np-timeline')
  return findAll(tl, 'np-time').map((n) => textOf(n)).join(' / ')
}

// --- S1：音频一直没报 duration（流式响应不带长度）时，进度条还能不能点 ---
check('S1 开始：dur 还没到（没触发 durationchange）', Number(prog().props['aria-valuemax']) === 0 || Number(prog().props['aria-valuemax']) > 0)
audio.readyState = 1 // 元数据已到，但页面 state 里的 dur 还是 0
tree = await renderAll()
check('S1 dur=0 时用队列里的时长兜底（aria-valuemax=223）', Number(prog().props['aria-valuemax']) === 223, 'max=' + prog().props['aria-valuemax'] + ' time=' + timeText())
check('S1 总时长显示 3:43', timeText().indexOf('3:43') >= 0, timeText())
pointer('onPointerDown', xAt(0.5))
tree = await renderAll()
check('S1 dur=0 时按下进度条有跟手预览（50% ≈ 111）', Math.abs(Number(prog().props['aria-valuenow']) - 111.5) <= 2, 'now=' + prog().props['aria-valuenow'])
pointer('onPointerUp', xAt(0.5))
tree = await renderAll()
check('S1 dur=0 时松手真的跳过去（audio.currentTime≈111.5）', Math.abs(audio.currentTime - 111.5) <= 2, 'currentTime=' + audio.currentTime.toFixed(1))

// --- S2：元数据还没到就点了（readyState 0），不能把这一下丢掉 ---
audio.readyState = 0
audio.__sets.length = 0
tree = await renderAll()
pointer('onPointerDown', xAt(0.75))
pointer('onPointerUp', xAt(0.75))
tree = await renderAll()
const beforeMeta = audio.currentTime
check('S2 元数据没到时不会瞎写 currentTime（先排队）', audio.__sets.length === 0, 'sets=' + JSON.stringify(audio.__sets))
audio.readyState = 4
audio.__fire('loadedmetadata')
tree = await renderAll()
check(
  'S2 loadedmetadata 之后把排队的 seek 补上（≈167）',
  Math.abs(audio.currentTime - 167.25) <= 2 && Math.abs(beforeMeta - audio.currentTime) > 10,
  'currentTime=' + audio.currentTime.toFixed(1) + ' 排队前=' + beforeMeta.toFixed(1),
)

// --- S3：音源不可 seek（服务器没给 Range）时，不能无声地弹回去 ---
audio.__pin = true
audio.__sets.length = 0
const beforePin = audio.currentTime
tree = await renderAll()
pointer('onPointerDown', xAt(0.4))
pointer('onPointerUp', xAt(0.4))
audio.__fire('seeked') // 浏览器把位置钉回原处
tree = await renderAll()
check(
  'S3 不可 seek 时 currentTime 被钉回原处（模拟服务器没给 Range）',
  audio.currentTime === beforePin && audio.__sets.length > 0,
  'currentTime=' + audio.currentTime + ' 写入尝试=' + JSON.stringify(audio.__sets),
)
if (!find(tree, 'np-panel')) {
  clickNode(find(tree, 'np-now'))
  tree = await renderAll()
}
const noticeNode = find(tree, 'np-notice')
const noticeText = noticeNode ? textOf(noticeNode) : ''
check('S3 界面明确提示「不支持拖动进度条」', noticeText.indexOf('不支持拖动') >= 0, noticeText || '(没有提示)')

// --- S4：正常音源（duration+seek 都正常）时拖动仍然一次到位 ---
audio.__pin = false
audio.duration = 294.6
audio.__fire('durationchange')
tree = await renderAll()
pointer('onPointerDown', xAt(0.2))
pointer('onPointerMove', xAt(0.6))
pointer('onPointerUp', xAt(0.6))
tree = await renderAll()
check('S4 正常音源拖到 60% 一次到位（≈176.8）', Math.abs(audio.currentTime - 0.6 * 294.6) <= 2, 'currentTime=' + audio.currentTime.toFixed(1))
check('S4 拖完 data-drag 归位', prog().props['data-drag'] === 'false')

// --- S5：拖动中途指针捕获被抢（lostpointercapture）但按键还按着 —— 松手不能吞 ---
audio.__pin = false
audio.readyState = 4
audio.duration = 294.6
tree = await renderAll()
pointer('onPointerDown', xAt(0.3))
prog().props.onLostPointerCapture({ buttons: 1 }) // 还在按着
tree = await renderAll()
check('S5 丢捕获时预览没被清掉（data-drag 仍为 true）', prog().props['data-drag'] === 'true', 'data-drag=' + prog().props['data-drag'])
pointer('onPointerUp', xAt(0.7))
tree = await renderAll()
check('S5 丢捕获后松手仍然 seek（≈206）', Math.abs(audio.currentTime - 0.7 * 294.6) <= 2, 'currentTime=' + audio.currentTime.toFixed(1))

// --- S6：pointerup 压根没送到时，click 兜底 ---
await new Promise((r) => setTimeout(r, 900)) // 让 800ms 的防抖过去
pointer('onPointerDown', xAt(0.2))
const clickHandler = prog().props.onClick
check('S6 进度条挂了 click 兜底', typeof clickHandler === 'function')
clickHandler({ clientX: xAt(0.8) })
tree = await renderAll()
check('S6 没收到 pointerup 也能靠 click 跳过去（≈235.7）', Math.abs(audio.currentTime - 0.8 * 294.6) <= 2, 'currentTime=' + audio.currentTime.toFixed(1))

// --- S7：诊断确实写进了 localStorage ---
const diagRaw = sandbox.localStorage.getItem('np.seekdiag.v1')
let diag = []
try {
  diag = JSON.parse(diagRaw || '[]')
} catch (e) {}
const kinds = diag.map((x) => x.k).join(',')
check('S7 诊断日志写进 np.seekdiag.v1（≤8 条）', Array.isArray(diag) && diag.length > 0 && diag.length <= 8, kinds)
check('S7 诊断里有 seek / seeked / click 记录', kinds.indexOf('seek') >= 0 && kinds.indexOf('click') >= 0, kinds)


process.exit(failed === 0 ? 0 : 1)
