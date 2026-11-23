// 交互自测：一个带「状态 + 副作用 + 重渲染」的假 React，把播放器真渲染出来，
// 然后模拟点击（底栏、页签、外观开关、静音、播放键、Esc、点外面），逐项断言。
//
// 目的：抓那些渲染没问题、但一点就错的问题（点了没反应 / 点错地方 / 状态不生效）。
//
// 用法：node tests/interact.mjs [lib/client.js]
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
  const slots = new Map() // key -> { hooks: [], cursor }
  const effectSlots = new Map() // key -> { deps, cleanup }
  let dirty = false
  let keyStack = []
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
    return { key, i, s: st.hooks[i] }
  }

  function useState(init) {
    const { s } = slotFor('state' + slotHint())
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
  let hintSeq = 0
  function slotHint() {
    return '#'
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
    const ekey = key + '#' + i
    if (!s.deps || !sameDeps(s.deps, deps)) {
      s.deps = deps
      pending.push({ ekey, fn })
    }
  }
  function useLayoutEffect(fn, deps) {
    useEffect(fn, deps)
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
    useLayoutEffect,
    Component,
    Fragment: 'fragment',
  }

  function setKey(k) {
    keyStack.push(k)
  }
  function popKey() {
    keyStack.pop()
  }

  function flushEffects() {
    const run = pending
    pending = []
    for (const { ekey, fn } of run) {
      const prev = effectSlots.get(ekey)
      if (prev && typeof prev.cleanup === 'function') {
        try {
          prev.cleanup()
        } catch {}
      }
      const cleanup = fn()
      effectSlots.set(ekey, { cleanup })
    }
  }

  return {
    React,
    setKey,
    popKey,
    flushEffects,
    isDirty: () => dirty,
    clearDirty: () => (dirty = false),
    // 每次重新渲染前必须把所有 hook 游标归零，否则第二次渲染读到的槽位全错（状态就像没生效）
    resetCursors: () => {
      for (const st of slots.values()) st.cursor = 0
    },
  }
}

// ---------------------------------------------------------------- 渲染器 ---
function makeRenderer(rt) {
  const React = rt.React

  function renderNode(node, depth) {
    if (node === null || node === undefined || node === false || node === true || node === '') return null
    if (Array.isArray(node)) return node.map((n, i) => renderNode(n, depth)).filter((n) => n !== null)
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node.$$el) return null
    const { type, props } = node
    if (typeof type === 'function') {
      rt.setKey(String(type.name || 'anon') + ':' + depth)
      let child
      try {
        if (type.prototype && type.prototype.isReactComponent) {
          const inst = new type(props)
          child = inst.render()
        } else {
          child = type(props)
        }
      } finally {
        rt.popKey()
      }
      return renderNode(child, depth + 1)
    }
    return { $$el: true, type, props: Object.assign({}, props, { children: renderNode(props.children, depth + 1) }) }
  }

  return (rootNode) => renderNode(rootNode, 0)
}

// ---------------------------------------------------------------- 工具 ---
function walk(node, fn) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn))
  if (typeof node !== 'object' || !node.$$el) return
  fn(node)
  walk(node.props.children, fn)
}
function findByClass(tree, cls) {
  let hit = null
  walk(tree, (n) => {
    if (hit) return
    const c = n.props && n.props.className
    if (typeof c === 'string' && c.split(/\s+/).indexOf(cls) >= 0) hit = n
  })
  return hit
}
function findByClassAll(tree, cls) {
  const hits = []
  walk(tree, (n) => {
    const c = n.props && n.props.className
    if (typeof c === 'string' && c.split(/\s+/).indexOf(cls) >= 0) hits.push(n)
  })
  return hits
}
function textOf(node) {
  let s = ''
  walk(node, (n) => {
    if (typeof n.props.children === 'string') s += n.props.children
  })
  return s
}
function click(node, extra) {
  const ev = Object.assign(
    {
      preventDefault() {},
      stopPropagation() {},
      currentTarget: { releasePointerCapture() {}, setPointerCapture() {}, closest: () => null },
      target: { closest: () => null },
      pointerId: 1,
      clientX: 0,
      key: '',
    },
    extra || {},
  )
  if (!node || !node.props || typeof node.props.onClick !== 'function') return false
  node.props.onClick(ev)
  return true
}
function byText(tree, cls, text) {
  return findByClassAll(tree, cls).filter((n) => textOf(n).indexOf(text) >= 0)[0] || null
}
/** 找到「文字正好是 label 且真的能点」的按钮（页面里同名文字不止一处时用） */
function buttonByLabel(tree, label, scope) {
  let hit = null
  walk(scope || tree, (n) => {
    if (hit) return
    if (n.props && typeof n.props.onClick === 'function' && textOf(n) === label) hit = n
  })
  return hit
}

// ---------------------------------------------------------------- 装载 ---
const rt = makeRuntime()
const render = makeRenderer(rt)

const store = {
  'np.queue.v1': JSON.stringify([
    { id: 210049, name: '稻香', artist: '周杰伦', album: '魔杰座', cover: '', duration: 223000, fee: 0 },
    { id: 186016, name: '晴天', artist: '周杰伦', album: '叶惠美', cover: '', duration: 269000, fee: 0 },
  ]),
  'np.index.v1': '0',
}

const listeners = new Map()
const doc = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(fn)
  },
  removeEventListener(type, fn) {
    const list = listeners.get(type) || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  },
}
function dispatch(type, ev) {
  for (const fn of (listeners.get(type) || []).slice()) fn(ev)
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
  fetch: () => Promise.reject(new Error('交互测试不发网络请求')),
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = { load: (spec) => (factory = spec.factory) }

console.log('      [debug] 塞进 localStorage 的队列 =', String(sandbox.localStorage.getItem('np.queue.v1')).slice(0, 60))
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
    register(_c, renderFn) {
      rootFn = renderFn
      return () => {}
    },
  },
})

async function renderAll() {
  let tree = null
  for (let i = 0; i < 25; i += 1) {
    rt.clearDirty()
    rt.resetCursors()
    tree = render(rootFn())
    rt.flushEffects()
    await new Promise((r) => setTimeout(r, 0))
    if (!rt.isDirty()) break
  }
  return tree
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ---------------------------------------------------------------- 用例 ---
let tree = await renderAll()

// 0. 调试：看看队列/当前曲目有没有读进来
const titleNode = findByClass(tree, 'np-now-title')
console.log('      [debug] 底栏标题 =', titleNode ? textOf(titleNode) : '(无)')
console.log('      [debug] 队列存储 =', String(store['np.queue.v1']).slice(0, 40))

// 1. 收起态：底栏在，面板不在
check('收起态有底栏', !!findByClass(tree, 'np-bar'))
check('收起态没有面板', !findByClass(tree, 'np-panel'))

// 2. 点歌曲信息 → 打开面板，默认落在「队列」
const nowBtn = findByClass(tree, 'np-now')
check('底栏能点到歌曲信息', !!nowBtn && typeof nowBtn.props.onClick === 'function')
click(nowBtn)
tree = await renderAll()
const panel = findByClass(tree, 'np-panel')
check('点歌曲信息展开面板', !!panel)
check('默认页签是队列（外观里配的默认）', !!panel && textOf(panel).indexOf('播放队列') >= 0)

// 3. 点底栏歌词 → 切到歌词页
const barLyric = findByClass(tree, 'np-bar-lyric')
check('底栏歌词可点', !!barLyric && typeof barLyric.props.onClick === 'function')
click(barLyric)
tree = await renderAll()
check('点歌词进歌词页（铺满单栏）', !!findByClass(tree, 'np-panel--lyric') && !!findByClass(tree, 'np-lyric'))

// 4. 切页签：外观
click(byText(tree, 'np-tab', '外观'))
tree = await renderAll()
check('能切到外观页', !!findByClass(tree, 'np-look'))
check('外观页是单栏（不挤歌词）', !findByClass(tree, 'np-nat-col--lyric'))

// 5. 外观：单栏 / 宽 / 紧凑
const rootOf = (t) => findByClass(t, 'np-root')
const rootCls = () => (rootOf(tree) ? rootOf(tree).props.className : '')
click(buttonByLabel(tree, '单栏'))
tree = await renderAll()
check('点「单栏」生效（root 加了 np-split-one）', rootCls().indexOf('np-split-one') >= 0, rootCls())

// 6. 光晕浓度 + 颜色
const glowSeg = findByClassAll(tree, 'np-seg').filter((n) => textOf(n).indexOf('浓') >= 0)[0]
check('找到光晕浓度分段控件', !!glowSeg)
let heavyBtn = null
if (glowSeg) {
  walk(glowSeg, (n) => {
    if (!heavyBtn && n.props && typeof n.props.onClick === 'function' && textOf(n) === '浓') heavyBtn = n
  })
}
check('找到光晕浓度「浓」按钮', !!heavyBtn)
if (heavyBtn) {
  click(heavyBtn)
  tree = await renderAll()
  check('点「浓」生效', rootCls().indexOf('np-glow-heavy') >= 0, rootCls())
}

// 7. 光晕色板
const swatches = findByClassAll(tree, 'np-glow-swatch')
check('色板有 12 个颜色', swatches.length === 12, 'n=' + swatches.length)
if (swatches.length === 5) {
  click(swatches[2])
  tree = await renderAll()
  check('选色板第 3 个 → 极光', rootCls().indexOf('np-tone-aurora') >= 0, rootCls())
}

// 8. 底栏两个开关
const sws = findByClassAll(tree, 'np-switch')
check('外观里有开关（歌词行/进度线/毛玻璃）', sws.length >= 3, 'n=' + sws.length)
if (sws.length >= 3) {
  click(sws[0])
  tree = await renderAll()
  check('关掉歌词行 → np-hide-bar-lyric', rootCls().indexOf('np-hide-bar-lyric') >= 0, rootCls())
  const sws2 = findByClassAll(tree, 'np-switch')
  click(sws2[0])
  tree = await renderAll()
  check('再打开歌词行 → 类名消失', rootCls().indexOf('np-hide-bar-lyric') < 0, rootCls())
}

// 9. 静音键：图标从音量变静音，再点回来
const muteBtn = findByClassAll(tree, 'np-right').length
  ? findByClassAll(findByClassAll(tree, 'np-right')[0], 'np-icon-btn')[0]
  : null
check('底栏右侧有静音键', !!muteBtn)
if (muteBtn) {
  const svgPath = () => {
    let d = ''
    walk(findByClassAll(tree, 'np-right')[0], (n) => {
      if (!d && n.type === 'path') d = n.props.d
    })
    return d
  }
  const before = svgPath()
  click(muteBtn)
  tree = await renderAll()
  const after = svgPath()
  check('点静音会换图标（音量↔静音）', before !== after && before !== '' && after !== '', before.slice(0, 12) + ' → ' + after.slice(0, 12))
  // 复原，别影响后面
  const mute2 = findByClassAll(findByClassAll(tree, 'np-right')[0], 'np-icon-btn')[0]
  if (mute2) click(mute2)
  tree = await renderAll()
}

// 10. 播放键图标随状态切换
const playBtn = findByClass(tree, 'np-play-btn')
check('底栏有播放键', !!playBtn)
if (playBtn) {
  let d1 = ''
  walk(playBtn, (n) => {
    if (!d1 && n.type === 'path') d1 = n.props.d
  })
  click(playBtn)
  tree = await renderAll()
  const play2 = findByClass(tree, 'np-play-btn')
  let d2 = ''
  walk(play2, (n) => {
    if (!d2 && n.type === 'path') d2 = n.props.d
  })
  check('点播放键图标会变（play↔pause）', d1 !== d2, d1.slice(0, 10) + ' → ' + d2.slice(0, 10))
}

// 11. Esc 关闭面板
dispatch('keydown', { key: 'Escape' })
tree = await renderAll()
check('Esc 能收起面板', !findByClass(tree, 'np-panel'))

// 12. 点面板外面也能关
click(findByClass(tree, 'np-now'))
tree = await renderAll()
check('再次展开面板', !!findByClass(tree, 'np-panel'))
dispatch('pointerdown', { target: { closest: () => null } })
tree = await renderAll()
check('点面板外面能收起', !findByClass(tree, 'np-panel'))

// 13. 「打开时先看」生效：设成搜歌，下次展开落在搜歌
click(findByClass(tree, 'np-now'))
tree = await renderAll()
click(byText(tree, 'np-tab', '外观'))
tree = await renderAll()
const openTabSeg = findByClassAll(tree, 'np-seg').filter(
  (n) => textOf(n).indexOf('搜歌') >= 0 && textOf(n).indexOf('队列') >= 0 && textOf(n).indexOf('歌词') >= 0,
)[0]
let target = null
if (openTabSeg) {
  walk(openTabSeg, (n) => {
    if (!target && n.props && typeof n.props.onClick === 'function' && textOf(n) === '搜歌') target = n
  })
}
check('外观里能找到「打开时先看 · 搜歌」', !!target)
if (target) {
  click(target)
  tree = await renderAll()
  dispatch('keydown', { key: 'Escape' })
  tree = await renderAll()
  click(findByClass(tree, 'np-now'))
  tree = await renderAll()
  const p = findByClass(tree, 'np-panel')
  check('展开时落在搜歌页', !!p && textOf(p).indexOf('搜索结果') >= 0)
}

// 14. 搜索源开关：点 B站，输入框 placeholder 跟着变
const srcButtons = findByClassAll(tree, 'np-src-btn')
const biliBtn = srcButtons.filter((n) => textOf(n) === 'B站')[0]
check('底栏底部有「B站」源开关', !!biliBtn)
if (biliBtn) {
  click(biliBtn)
  tree = await renderAll()
  const input = findByClass(tree, 'np-search-input')
  check('切到 B 站后 placeholder 变了', !!input && String(input.props.placeholder).indexOf('B 站') >= 0, input ? input.props.placeholder : '')
  // 切回去，别影响后面的用例
  const back = findByClassAll(tree, 'np-src-btn').filter((n) => textOf(n) === '网易云')[0]
  if (back) click(back)
  tree = await renderAll()
}

// 15. 面板头音量滑杆能调
const vol = findByClass(tree, 'np-nat-vol-range')
check('面板头有音量滑杆', !!vol)
if (vol) {
  vol.props.onChange({ target: { value: '0' } })
  tree = await renderAll()
  const vol2 = findByClass(tree, 'np-nat-vol-range')
  check('拖到 0 音量会生效', !!vol2 && Number(vol2.props.value) === 0, vol2 ? 'value=' + vol2.props.value : '')
  if (vol2) vol2.props.onChange({ target: { value: '70' } })
  tree = await renderAll()
}

// 16. 队列里删歌：两首删一首 → 计数变 1 首
click(byText(tree, 'np-tab', '队列'))
tree = await renderAll()
const panelQ = findByClass(tree, 'np-panel')
check('队列页显示 2 首', !!panelQ && textOf(panelQ).indexOf('2 首') >= 0, panelQ ? textOf(panelQ).slice(0, 40) : '')
let trash = null
walk(panelQ, (n) => {
  if (!trash && n.props && n.props.title === '从队列移除') trash = n
})
check('队列行有移除按钮', !!trash)
if (trash) {
  click(trash)
  tree = await renderAll()
  const panelQ2 = findByClass(tree, 'np-panel')
  check('删掉一首后剩 1 首', !!panelQ2 && textOf(panelQ2).indexOf('1 首') >= 0, panelQ2 ? textOf(panelQ2).slice(0, 40) : '')
}

// 17. 点到「歌词」页签能铺满
click(byText(tree, 'np-tab', '歌词'))
tree = await renderAll()
check('歌词页签是单栏铺满', !!findByClass(tree, 'np-panel--lyric'))

// 18. 在别的页签用底部搜索框搜 → 自动翻到搜歌页（0.6.1）
check('此刻停在歌词页', !!findByClass(tree, 'np-panel--lyric'))
const searchInput = findByClass(tree, 'np-search-input')
check('底部有搜索框', !!searchInput)
if (searchInput) {
  searchInput.props.onChange({ target: { value: '晴天' } })
  tree = await renderAll()
  const footForm = findByClass(tree, 'np-nat-foot')
  check('搜索框在表单里', !!footForm && typeof footForm.props.onSubmit === 'function')
  if (footForm) {
    footForm.props.onSubmit({ preventDefault() {} })
    tree = await renderAll()
    const p2 = findByClass(tree, 'np-panel')
    check('搜完自动切到搜歌页', !!p2 && textOf(p2).indexOf('搜索结果') >= 0, p2 ? textOf(p2).slice(0, 40) : '')
    check('不再是歌词铺满', !findByClass(tree, 'np-panel--lyric'))
  }
}

process.exit(failed === 0 ? 0 : 1)
