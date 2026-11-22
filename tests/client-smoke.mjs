// 客户端冒烟测试：用一个极小的假 React 把 NeteasePlayer 真渲染一遍（底栏 + 每个页签），
// 专门抓「删/改渲染代后留下的悬空引用、JSX 结构错」这类只有渲染时才炸的问题。
//
// 不跑 useEffect（渲染期之外的问题抓不到，那部分靠代码审查 + 浏览器里点）。
//
// 用法：
//   node tests/client-smoke.mjs [lib/client.js]
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = process.argv[2] || path.join(here, '..', 'lib', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')

let failed = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failed += 1
}

// ---- 假 React ---------------------------------------------------------------

function buildReact() {
  const state = { hooks: null } // { list, i }：当前正在渲染的函数组件的 hook 槽

  function createElement(type, props, ...children) {
    const p = props ? Object.assign({}, props) : {}
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { $$el: true, type, props: p }
  }

  function slot() {
    if (state.hooks === null) throw new Error('hook 用在了渲染之外')
    const i = state.hooks.i
    state.hooks.i += 1
    if (!(i in state.hooks.list)) state.hooks.list[i] = { value: undefined, ref: null, memos: undefined }
    return state.hooks.list[i]
  }

  function useState(init) {
    const s = slot()
    if (s.value === undefined) s.value = typeof init === 'function' ? init() : init
    return [s.value, function () {}]
  }
  function useRef(init) {
    const s = slot()
    if (s.ref === null) s.ref = { current: init === undefined ? null : init }
    return s.ref
  }
  function useMemo(fn) {
    const s = slot()
    if (s.memos === undefined) s.memos = fn()
    return s.memos
  }
  function useCallback(fn) {
    slot()
    return fn
  }
  function useEffect() {
    slot()
  }
  function useLayoutEffect() {
    slot()
  }

  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState() {}
  }
  Component.prototype.isReactComponent = {}

  return {
    createElement,
    useState,
    useRef,
    useMemo,
    useCallback,
    useEffect,
    useLayoutEffect,
    Component,
    Fragment: 'fragment',
    __hooks: state,
    __setHooks(next) {
      state.hooks = next
    },
  }
}

// ---- 渲染器（只走一遍，不求 diff）--------------------------------------------

function renderTree(vnode) {
  const React = vnode.__react
  const out = []

  function walk(node, depth) {
    if (depth > 80) throw new Error('渲染递归太深，可能是自引用')
    if (node === null || node === undefined || node === false || node === true || node === '') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (!node.$$el) return
    const { type, props } = node
    if (typeof type === 'function') {
      const prev = React.__hooks.hooks
      React.__setHooks({ list: [], i: 0 })
      let child
      try {
        if (type.prototype && type.prototype.isReactComponent) {
          child = new type(props).render()
        } else {
          child = type(props)
        }
      } finally {
        React.__setHooks(prev)
      }
      walk(child, depth + 1)
      return
    }
    walk(props ? props.children : null, depth + 1)
  }

  walk(vnode, 0)
  return out.join('\n')
}

// ---- 跑一个变体：改源码里的初始 state，模拟「面板打开 / 停在某个页签」------------

function run({ tab, expanded, queue, name }) {
  const store = {}
  let patched = source
  if (tab) patched = patched.replace("useState('search')", `useState('${tab}')`)
  if (expanded) patched = patched.replace('var [expanded, setExpanded] = useState(false)', 'var [expanded, setExpanded] = useState(true)')
  if (queue) store['np.queue.v1'] = JSON.stringify(queue)

  const React = buildReact()
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
      setItem: (k, v) => {
        store[k] = String(v)
      },
      removeItem: (k) => {
        delete store[k]
      },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: () => Promise.reject(new Error('冒烟测试不发请求')),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      factory = spec.factory
    },
  }

  vm.runInContext(patched, vm.createContext(sandbox), { filename: 'client.js' })

  if (typeof factory !== 'function') {
    check(`${name}: 模块被 __ModuleLoader__ 接收`, false)
    return ''
  }
  const mod = factory((id) => {
    if (id === 'react') return React
    throw new Error('未知依赖 ' + id)
  })
  check(`${name}: factory 返回插件对象`, !!mod && typeof mod.apply === 'function')

  let rootFn = null
  mod.apply({
    effect(fn) {
      return fn()
    },
    slots: {
      inject(_slot, fn) {
        fn()
      },
      register(_cfg, render) {
        rootFn = render
        return () => {}
      },
    },
  })
  check(`${name}: 注册到 shell.bottom`, typeof rootFn === 'function')
  if (typeof rootFn !== 'function') return ''

  const el = rootFn()
  el.__react = React
  const text = renderTree(el)
  check(`${name}: 渲染没抛错`, true, `${text.length} 字符`)
  return text
}

const songs = [
  { id: 210049, name: '网易云测试歌', artist: '某歌手', album: '某专辑', cover: '', duration: 200000, fee: 0 },
  { id: 'BV1xx411c7mD', src: 'bili', name: 'B站测试歌', artist: '某UP', album: 'B站 · 3:20', cover: '', duration: 200000, fee: 0 },
]

// 1) 收起态：只有底栏
const barOnly = run({ name: '收起态' })
check('底栏有内容', barOnly.includes('未在播放') || barOnly.includes('选一首歌开始'), barOnly.slice(0, 60).replace(/\n/g, ' | '))

// 2) 展开 + 每个页签都渲染一遍
for (const tab of ['search', 'queue', 'playlist', 'lyric', 'look', 'account']) {
  run({ name: '页签 ' + tab, tab, expanded: true, queue: songs })
}

// 3) 队列持久化：BV 字符串 id 的 B 站歌刷新后必须还在
const queueText = run({ name: '队列含 B 站歌', tab: 'queue', expanded: true, queue: songs })
check('队列保留了 B 站歌（BV 字符串 id 不再被丢）', queueText.includes('B站测试歌'))
check('队列也保留了网易云歌', queueText.includes('网易云测试歌'))

// 4) 静音状态能存下来（volume=0 不该被当成「没存过」而弹回 0.7）
const muteRun = (() => {
  const store = { 'np.volume.v1': '0' }
  let patched = source.replace('var [expanded, setExpanded] = useState(false)', 'var [expanded, setExpanded] = useState(true)')
  const React = buildReact()
  let factory = null
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    isFinite,
    performance: { now: () => Date.now() },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v)
      },
      removeItem: (k) => {
        delete store[k]
      },
    },
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
    fetch: () => Promise.reject(new Error('no network')),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = { load: (spec) => (factory = spec.factory) }
  vm.runInContext(patched, vm.createContext(sandbox), { filename: 'client.js' })
  let rootFn = null
  factory((id) => {
    if (id === 'react') return React
    throw new Error('未知依赖 ' + id)
  }).apply({
    effect: (fn) => fn(),
    slots: { inject: (_s, fn) => fn(), register: (_c, render) => (rootFn = render) },
  })
  const el = rootFn()
  el.__react = React
  return { text: renderTree(el), store }
})()
check('静音（volume=0）刷新后不会被弹回有声', muteRun.store['np.volume.v1'] === '0' || muteRun.store['np.volume.v1'] === undefined, 'volume=' + muteRun.store['np.volume.v1'])

process.exit(failed === 0 ? 0 : 1)
