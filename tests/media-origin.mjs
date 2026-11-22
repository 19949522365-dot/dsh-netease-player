// 自定义协议（桌面端 dsh-app://）音源地址专项测试。
// ---------------------------------------------------------------------------
// 背景：桌面端页面跑在 dsh-app:// 下，Chromium 对自定义协议的媒体响应不发 Range，
// <audio>.seekable 恒为 [0,0]，进度条怎么写 currentTime 都会被钉回去。
// 修法：宿主在 /state 里报出自己的 http 地址（mediaOrigin），客户端在自定义协议页面
// 把音源换成这个绝对地址。这个测试盯三件事：
//   1. 自定义协议 + 宿主报了 mediaOrigin → src 是 http 绝对地址（且不是 dsh-app://）
//   2. 宿主还没回来之前不挂 src（不能先拿不可 seek 的地址起播）
//   3. 宿主没报 mediaOrigin（旧版本 / state 失败）→ 退回相对路径，能放不报错
// 顺带验证换成 http 源之后，进度条的 seek 确实落到 audio.currentTime 上。
//
// 用法：node tests/media-origin.mjs [lib/client.js]
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
    for (const { fn } of run) {
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
        readyState: 4,
        volume: 1,
        duration: 294.6,
        src: '',
        paused: true,
        style: {},
        addEventListener(t, fn) {
          if (!handlers.has(t)) handlers.set(t, [])
          handlers.get(t).push(fn)
        },
        removeEventListener() {},
        getAttribute: () => (a.src === '' ? null : a.src),
        removeAttribute() {
          a.src = ''
        },
        setAttribute() {},
        load() {},
        pause() {
          a.paused = true
        },
        play() {
          a.paused = false
          return Promise.resolve()
        },
        __fire(t) {
          for (const fn of handlers.get(t) || []) fn()
        },
      }
      hooks.audio = a
      return a
    }
    return {
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

// ---------------------------------------------------------------- 装载 ---
/**
 * @param {{ protocol: string, state: object|null, stateFails?: boolean }} opts
 */
async function boot(opts) {
  const rt = makeRuntime()
  const hooks = {}
  const render = makeRenderer(rt, hooks)

  const store = {
    'np.queue.v1': JSON.stringify([
      { id: 210049, name: '稻香', artist: '周杰伦', album: '魔杰座', cover: '', duration: 294600, fee: 0 },
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
    removeEventListener() {},
  }
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
    location: { protocol: opts.protocol, href: opts.protocol + '//app/' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v)
      },
      removeItem: (k) => {
        delete store[k]
      },
    },
    document: doc,
    fetch: (url) => {
      if (opts.stateFails) return Promise.reject(new Error('网络挂了'))
      if (typeof url === 'string' && url.indexOf('/state') >= 0) {
        const body = JSON.stringify(
          opts.state === null
            ? { ok: true, serviceOnline: false, hasCookie: false }
            : Object.assign({ ok: true, serviceOnline: false, hasCookie: false }, opts.state),
        )
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) })
      }
      return Promise.reject(new Error('自测不发其它请求: ' + url))
    },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = { load: (spec) => (factory = spec.factory) }
  let factory = null
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

  async function renderAll() {
    let tree = null
    for (let i = 0; i < 40; i += 1) {
      rt.clearDirty()
      rt.resetCursors()
      tree = render(rootFn())
      rt.flushEffects()
      await new Promise((r) => setTimeout(r, 0))
      if (!rt.isDirty()) break
    }
    return tree
  }

  return { tree: await renderAll(), hooks, renderAll }
}

// ============================================================ 用例 ===
console.log('== 自定义协议音源 ==')

// 1) dsh-app:// + 宿主报了 http 地址 → 音源必须是 http 绝对地址
{
  const { tree, hooks } = await boot({ protocol: 'dsh-app:', state: { mediaOrigin: 'http://127.0.0.1:54154' } })
  const audio = hooks.audio
  const prog = find(tree, 'np-progress')
  check('dsh-app：进度条渲染出来了', !!prog)
  check(
    'dsh-app：src 换成了宿主 http 地址',
    audio.src === 'http://127.0.0.1:54154/api/netease-player/play?id=210049',
    audio.src,
  )
  check('dsh-app：不再用 dsh-app:// 起播', !/^dsh-app:/i.test(audio.src), audio.src)

  // 拖动 50% → 111.5? 这里 duration 用真实 294.6；50% = 147.3
  prog.props.onPointerDown({ pointerId: 1, clientX: 300 + 200, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } })
  prog.props.onPointerUp({ pointerId: 1, clientX: 300 + 200, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } })
  check('dsh-app：松手后 seek 落到 currentTime（50%）', Math.abs(audio.currentTime - 147.3) <= 2, 'currentTime=' + audio.currentTime.toFixed(1))
}

// 2) 普通浏览器页面（http）→ 保持相对路径，不该被媒体源前缀影响
{
  const { tree, hooks } = await boot({ protocol: 'http:', state: { mediaOrigin: 'http://127.0.0.1:54154' } })
  check(
    'http：音源仍是同源相对路径',
    hooks.audio.src === '/api/netease-player/play?id=210049',
    hooks.audio.src,
  )
  check('http：进度条渲染出来了', !!find(tree, 'np-progress'))
}

// 3) 旧宿主没报 mediaOrigin → 退回相对路径（能播，不炸）
{
  const { hooks } = await boot({ protocol: 'dsh-app:', state: { mediaOrigin: '' } })
  check(
    'dsh-app 旧宿主：退回相对路径而不是没声音',
    hooks.audio.src === '/api/netease-player/play?id=210049',
    hooks.audio.src,
  )
}

// 4) /state 失败 → 也退回相对路径
{
  const { hooks } = await boot({ protocol: 'dsh-app:', stateFails: true })
  check(
    'dsh-app + state 失败：仍按相对路径起播',
    hooks.audio.src === '/api/netease-player/play?id=210049',
    hooks.audio.src,
  )
}

// 5) B 站音源也带上前缀
{
  const rt = makeRuntime()
  const hooks = {}
  const render = makeRenderer(rt, hooks)
  const store = {
    'np.queue.v1': JSON.stringify([{ id: 'BV1xx411c7mD', src: 'bili', name: 'B站歌', artist: 'UP', album: '', cover: '', duration: 200000, fee: 0 }]),
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
    removeEventListener() {},
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
    location: { protocol: 'dsh-app:', href: 'dsh-app://app/' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v)
      },
      removeItem: (k) => {
        delete store[k]
      },
    },
    document: doc,
    fetch: (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true, mediaOrigin: 'http://127.0.0.1:54154', serviceOnline: false, hasCookie: false })),
      }),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = { load: (spec) => (factory = spec.factory) }
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.js' })
  let rootFn = null
  factory((id) => {
    if (id === 'react') return rt.React
    throw new Error('未知依赖 ' + id)
  }).apply({
    effect: (fn) => fn(),
    slots: { inject: (_s, fn) => fn(), register: (_c, fn) => (rootFn = fn) },
  })
  for (let i = 0; i < 40; i += 1) {
    rt.clearDirty()
    rt.resetCursors()
    render(rootFn())
    rt.flushEffects()
    await new Promise((r) => setTimeout(r, 0))
    if (!rt.isDirty()) break
  }
  check(
    'dsh-app + B 站：B 站音源也带 http 前缀和 source=bili',
    hooks.audio.src === 'http://127.0.0.1:54154/api/netease-player/play?id=BV1xx411c7mD&source=bili',
    hooks.audio.src,
  )
}

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
