/**
 * dsh-netease-player —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 在窗口底部注册一条常驻播放条（slot: shell.bottom），点开是搜歌 / 队列 / 歌词 / 账号面板。
 * 与宿主只走同源 HTTP（/api/netease-player/*）：音源由宿主解析并流式转发，
 * 所以这里不用碰跨域、也不用知道本地 API 服务在哪个端口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-netease-player',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback
    var useMemo = React.useMemo

    var API = '/api/netease-player'
    // 桌面端页面跑在 `dsh-app://` 这类自定义协议下。Chromium 的媒体管线对自定义
    // 协议的响应不会发 Range，`<audio>.seekable` 恒为 [0,0]：进度条能拖动画面、
    // 写 currentTime 却会被钉回原处，听起来就是「快进不了」。音源必须换成宿主
    // 自己的 http(s) 地址（由 /state 的 mediaOrigin 告诉这里），走正常 HTTP 栈。
    var IS_CUSTOM_SCHEME_PAGE = (function () {
      try {
        if (typeof location === 'undefined' || location === null) return false
        var proto = String(location.protocol || '')
        return proto !== '' && proto !== 'http:' && proto !== 'https:'
      } catch (e) {
        return false
      }
    })()
    // 宿主自动拉起本地 API 服务是冷启动，十几秒才有响应：
    // 离线时按这个节奏补抓 state，最多试 HEAL_MAX_TRIES 次（约 30 秒）就收手。
    var HEAL_INTERVAL_MS = 2000
    var HEAL_MAX_TRIES = 15
    var LS = {
      queue: 'np.queue.v1',
      index: 'np.index.v1',
      volume: 'np.volume.v1',
      cookie: 'nc_cookie',
      source: 'np.source.v1',
      look: 'np.look.v1',
    }

    // ---- HTTP --------------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (e) {
          data = null
        }
        if (!res.ok) {
          var msg = data && data.error ? data.error : 'HTTP ' + res.status
          var err = new Error(msg)
          err.status = res.status
          throw err
        }
        return data
      })
    }

    function apiGet(path, params) {
      var q = []
      var obj = params || {}
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
        if (obj[k] === undefined || obj[k] === null || obj[k] === '') continue
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
      }
      return fetch(API + path + (q.length ? '?' + q.join('&') : ''), { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function proxy(path, params) {
      return apiGet('/proxy', Object.assign({ path: path }, params || {}))
    }

    // ---- 小工具 ------------------------------------------------------------

    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    function fmtTime(sec) {
      var s = Math.max(0, Math.round(Number(sec) || 0))
      return Math.floor(s / 60) + ':' + pad2(s % 60)
    }

    function readLS(key) {
      try {
        return window.localStorage.getItem(key)
      } catch (e) {
        return null
      }
    }

    function writeLS(key, value) {
      try {
        if (value === null || value === undefined) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
      } catch (e) {}
    }

    function loadQueue() {
      var raw = readLS(LS.queue)
      if (!raw) return []
      try {
        var list = JSON.parse(raw)
        if (!Array.isArray(list)) return []
        return list
          .filter(function (s) {
            // B 站音源的 id 是 BV 号字符串；以前这里只认 number，
            // 结果刷新页面后队列里的 B 站歌全被静悄悄扔掉了。
            var idOk = typeof s.id === 'number' || (typeof s.id === 'string' && s.id !== '')
            return s && idOk && typeof s.name === 'string'
          })
          .slice(0, 300)
      } catch (e) {
        return []
      }
    }

    function loadVolume() {
      var text = readLS(LS.volume)
      // 没有记录才用默认 0.7；记录里就是 0（静音）也得照办，别每次刷新都自己弹回有声。
      if (text === null || text === '') return 0.7
      var raw = Number(text)
      if (!isFinite(raw) || raw < 0) return 0.7
      return Math.min(1, Math.max(0, raw))
    }

    // ---- 外观 --------------------------------------------------------------
    // 0.3.2 起，外观页只放「真的会改变界面」的开关：
    // 主题色 / 面板布局 / 宽度 / 密度 / 打开时的页签 / 底栏歌词行 / 底栏进度线 / 毛玻璃 / 动效。
    // 以前那些「风格」「形象」「小鱼」「鲸鱼大小」控制的是 0.3.0 已经隐藏的装饰，留着只会骗人。

    var LOOK_DEFAULT = {
      theme: 'deep',
      split: 'two', // two = 左歌词右列表；one = 单栏
      width: 'md', // md = 600px；wide = 680px
      density: 'cozy', // cozy = 舒适；dense = 紧凑
      openTab: 'queue', // 从底栏展开面板时落在哪个页签
      barLyric: true,
      barLine: true,
      glass: true,
      // 光晕：浓度（off/light/mid/heavy）和色调（neutral/theme/aurora/sunset/ice）分开调。
      // 默认中性冷白 —— 红橙粉那套直接用强调色会糊成一片，中性光跟哪个主题都不打架。
      glow: 'mid',
      glowTone: 'neutral',
      motion: 'normal',
    }
    // 光晕色调预设（rgb 三元组，配合 rgba(...) 用）
    var GLOW_TONES = [
      { id: 'neutral', name: '中性', desc: '冷白光', color: '#c9d6e6' },
      { id: 'theme', name: '跟随主题', desc: '当前强调色', color: '#ec4141' },
      { id: 'aurora', name: '极光', desc: '青绿 + 紫', color: '#5fd6c6' },
      { id: 'sunset', name: '落日', desc: '暖金 + 玫红', color: '#f0a864' },
      { id: 'ice', name: '冰蓝', desc: '淡蓝白', color: '#8fb6ff' },
      { id: 'dawn', name: '晨雾', desc: '蜜桃 + 奶白', color: '#f2c4ac' },
      { id: 'moss', name: '苔绿', desc: '草绿 + 浅黄绿', color: '#9cc47a' },
      { id: 'dusk', name: '暮紫', desc: '紫罗兰 + 浅紫', color: '#a88ce8' },
      { id: 'ember', name: '炭火', desc: '橙红 + 暗红', color: '#e0603c' },
      { id: 'sea', name: '海水', desc: '青蓝 + 海绿', color: '#4fbcc8' },
      { id: 'sand', name: '沙金', desc: '沙金 + 米白', color: '#e0c48a' },
      { id: 'prism', name: '虹彩', desc: '青 + 品红 + 金', color: '#a06cff' },
    ]
    var LOOK_THEMES = [
      { id: 'deep', name: '红', color: '#ec4141' },
      { id: 'ocean', name: '蓝', color: '#0a84ff' },
      { id: 'coral', name: '橙', color: '#ff7a45' },
      { id: 'sakura', name: '粉', color: '#ff5f9e' },
      { id: 'mint', name: '绿', color: '#1fc39a' },
      { id: 'slate', name: '石墨', color: '#7c8698' },
      { id: 'indigo', name: '靛蓝', color: '#5b66e0' },
      { id: 'forest', name: '森绿', color: '#3f9070' },
      { id: 'amber', name: '琥珀', color: '#d39a3f' },
      { id: 'plum', name: '紫', color: '#9d6a9e' },
      { id: 'wine', name: '酒红', color: '#b04a5c' },
    ]

    function loadLook() {
      var raw = readLS(LS.look)
      if (!raw) return LOOK_DEFAULT
      try {
        var o = JSON.parse(raw) || {}
        var out = {
          theme: typeof o.theme === 'string' ? o.theme : LOOK_DEFAULT.theme,
          split: o.split === 'one' ? 'one' : 'two',
          width: o.width === 'wide' ? 'wide' : 'md',
          density: o.density === 'dense' ? 'dense' : 'cozy',
          openTab: ['search', 'queue', 'lyric'].indexOf(o.openTab) >= 0 ? o.openTab : LOOK_DEFAULT.openTab,
          // 老版本存的是 whale/fish/bubbles/whaleSize/style/mascot，这里忽略，缺的字段补默认
          barLyric: o.barLyric !== false,
          barLine: o.barLine !== false,
          glass: o.glass !== false,
          glow: ['off', 'light', 'mid', 'heavy'].indexOf(o.glow) >= 0 ? o.glow : LOOK_DEFAULT.glow,
          glowTone: glowToneKnown(o.glowTone) ? o.glowTone : LOOK_DEFAULT.glowTone,
          motion: o.motion === 'calm' ? 'calm' : 'normal',
        }
        var known = false
        for (var i = 0; i < LOOK_THEMES.length; i += 1) if (LOOK_THEMES[i].id === out.theme) known = true
        if (!known) out.theme = LOOK_DEFAULT.theme
        return out
      } catch (e) {
        return LOOK_DEFAULT
      }
    }

    function glowToneKnown(id) {
      for (var i = 0; i < GLOW_TONES.length; i += 1) if (GLOW_TONES[i].id === id) return true
      return false
    }

    function saveLook(look) {
      try {
        localStorage.setItem(LS.look, JSON.stringify(look))
      } catch (e) {}
    }

    function lookClasses(look) {
      var glowOn = look.glow === 'light' || look.glow === 'mid' || look.glow === 'heavy'
      return (
        ' np-theme-' + (look.theme || 'deep') +
        (look.split === 'one' ? ' np-split-one' : '') +
        (look.width === 'wide' ? ' np-panel-wide' : '') +
        (look.density === 'dense' ? ' np-dense' : '') +
        (look.barLyric ? '' : ' np-hide-bar-lyric') +
        (look.barLine ? '' : ' np-hide-bar-line') +
        (look.glass ? '' : ' np-solid') +
        (glowOn ? ' np-glow-' + look.glow + ' np-tone-' + (look.glowTone || 'neutral') : '') +
        (look.motion === 'calm' ? ' np-calm' : '')
      )
    }

    // ---- 歌单小工具 --------------------------------------------------------

    // /playlist/track/all 的 limit 上限就是 1000（再大直接 code 400），长歌单要按 offset 翻页。
    var TRACK_PAGE = 1000
    var TRACK_MAX = 10000

    /** 封面地址统一成 https、去掉原 query（Cover 自己会接 ?param=）。 */
    function coverUrl(url) {
      var s = typeof url === 'string' ? url.trim() : ''
      if (s === '') return ''
      return s.split('?')[0].replace(/^http:\/\//i, 'https://')
    }

    /** 网易云的 song 对象 → 前端统一的瘦结构（和宿主 slimSong 字段一致）。 */
    function slimTrack(s) {
      if (s === null || typeof s !== 'object') return null
      var artists = Array.isArray(s.ar) ? s.ar : Array.isArray(s.artists) ? s.artists : []
      var album = s.al || s.album || {}
      return {
        id: s.id,
        name: s.name || '',
        artist: artists
          .map(function (a) {
            return a && a.name ? a.name : ''
          })
          .filter(Boolean)
          .join(' / '),
        album: album.name || '',
        cover: coverUrl(album.picUrl || album.blurPicUrl || ''),
        duration: Number(s.dt || s.duration || 0) || 0,
        fee: Number(s.fee || 0) || 0,
      }
    }

    function slimTracks(list) {
      return (Array.isArray(list) ? list : []).map(slimTrack).filter(function (s) {
        return s !== null && s.id !== undefined && s.id !== null && s.id !== ''
      })
    }

    /** 接口错误 → 能给用户看的中文；409 是宿主明说的「本地 API 服务没起来」。 */
    function plainError(err, what) {
      var status = err && err.status
      var msg = err && err.message ? String(err.message) : ''
      if (status === 409) return '本地服务未启动，请到「账号」启动服务'
      if (status === 401 || status === 403) return '登录已失效，请重新登录'
      if (msg !== '') return what + '读取失败：' + msg
      return what + '读取失败，稍后再试'
    }

    /**
     * 分页拉完整曲目：一页最多 1000 条，长歌单按 offset 翻页。
     * 冷启动时一页要一秒多，所以 onProgress 回传进度，别让面板干等。
     */
    function fetchTracksInPages(playlistId, total, onProgress) {
      var want = Math.min(Number(total) || 0, TRACK_MAX)
      if (want <= 0) return Promise.resolve([])
      var out = []
      function step(offset) {
        var limit = Math.min(TRACK_PAGE, want - offset)
        if (limit <= 0) return Promise.resolve(out)
        return proxy('/playlist/track/all', { id: playlistId, limit: limit, offset: offset }).then(function (data) {
          var songs = slimTracks(data && data.songs)
          out = out.concat(songs)
          if (typeof onProgress === 'function') onProgress(out.length, want)
          if (songs.length < limit || out.length >= want) return out
          return step(offset + songs.length)
        })
      }
      return step(0)
    }

    // ---- 图标 --------------------------------------------------------------

    var ICONS = {
      play: 'M8 5v14l11-7z',
      pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
      prev: 'M7 6h2.2v12H7zm3.6 6L20 18V6z',
      next: 'M14.8 6H17v12h-2.2zM4 18l9.4-6L4 6z',
      volume: 'M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z',
      mute: 'M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4zm12.1-1.8l1.4 1.4-2.2 2.2 2.2 2.2-1.4 1.4-2.2-2.2-2.2 2.2-1.4-1.4 2.2-2.2-2.2-2.2 1.4-1.4 2.2 2.2z',
      search: 'M10.5 4a6.5 6.5 0 1 0 4.03 11.6l4.22 4.22 1.41-1.41-4.22-4.22A6.5 6.5 0 0 0 10.5 4zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
      list: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z',
      lyrics: 'M5 5h9v2H5zm0 4h9v2H5zm0 4h6v2H5zm11-8h3v12.2a3.4 3.4 0 1 1-2-3.1V7z',
      user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 10c4.42 0 8 2.24 8 5v1H4v-1c0-2.76 3.58-5 8-5z',
      up: 'M12 6l6 7h-4v5h-4v-5H6z',
      down: 'M12 18l-6-7h4V6h4v5h4z',
      close: 'M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
      plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
      trash: 'M7 8h10l-1 12H8zM9 5h6v2H9z',
      note: 'M19 3.5v13.7a3.4 3.4 0 1 1-2-3.1V8.2l-7 1.6v9.3a3.4 3.4 0 1 1-2-3.1V7.4z',
      refresh: 'M12 4a8 8 0 1 1-7.6 5.5h2.2A5.8 5.8 0 1 0 12 6.2V9l-4-3.5L12 2z',
      palette: 'M12 3a9 9 0 0 0 0 18c1.3 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.9-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3zm-5.2 8.6a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8zm3.1-3.6a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8zm4.6 0a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8zm3.4 3.1a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8z',
      whale: 'M6 12c0-3 2.4-5 5.5-5 2.6 0 4.3 1.2 5.2 2.6.6-.4 1.3-.6 2-.6 1.4 0 2.4.7 3 1.6-1.2.2-1.7.7-1.9 1.2.5.5.8 1.2.8 2 0 .7-.2 1.3-.6 1.8.6 1.6-.4 2.1-.4 2.1s-.7-1.4-1.9-1.4c-.6 0-1 .3-1.5.5-.9 1.3-2.6 2.4-5.1 2.4C8.4 19.2 6 17 6 15c0-.7.2-1.3.6-1.8C6 12.8 6 12.4 6 12z',
    }

    function Icon(props) {
      var d = ICONS[props.name] || ''
      var size = props.size || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': true,
          fill: 'currentColor',
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', { d: d }),
      )
    }

    // ---- 小鲸鱼 ------------------------------------------------------------

    /** 外观页用的小开关。 */
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'np-switch' + (props.on ? ' np-switch--on' : ''),
        role: 'switch',
        'aria-checked': props.on ? 'true' : 'false',
        'aria-label': props.label || '',
        onClick: props.onClick,
      })
    }

    // ---- 快进诊断 ----------------------------------------------------------
    // 「拖了松手又弹回去」这类问题没法靠猜：把最近 8 次指针 / seek 过程记在本地，
    // 出问题直接看 localStorage 的 np.seekdiag.v1（只记数字和长度，不记歌名）。
    function seekDiagLog(rec) {
      try {
        var list = JSON.parse(localStorage.getItem('np.seekdiag.v1') || '[]')
        if (!Array.isArray(list)) list = []
        list.push(rec)
        while (list.length > 8) list.shift()
        localStorage.setItem('np.seekdiag.v1', JSON.stringify(list))
      } catch (e) {}
    }

    function ProgressBar(props) {
      var barRef = useRef(null)
      var draggingRef = useRef(false)
      var lastSeekAtRef = useRef(0)
      var [dragPos, setDragPos] = useState(null)
      var pos = Number(props.pos) || 0
      var dur = Number(props.dur) || 0
      // 拖动过程中只跟手更新画面，松手才真的改 currentTime：
      // 每移动一次就 seek 一次会让浏览器不断中止旧请求、重发 Range，音频听着就是卡。
      var shown = dragPos === null ? pos : dragPos
      var pct = dur > 0 ? Math.min(1, Math.max(0, shown / dur)) : 0

      function valueAt(clientX) {
        var el = barRef.current
        if (!el || dur <= 0) return 0
        var rect = el.getBoundingClientRect()
        if (rect.width <= 0) return 0
        return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * dur
      }

      function release(e) {
        draggingRef.current = false
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch (err) {}
      }

      return h(
        'div',
        {
          ref: barRef,
          className: 'np-progress' + (props.compact ? ' np-progress--compact' : ''),
          role: 'slider',
          'aria-label': '播放进度',
          'aria-valuemin': 0,
          'aria-valuemax': dur > 0 ? Math.round(dur) : 0,
          'aria-valuenow': Math.round(shown),
          'data-drag': dragPos === null ? 'false' : 'true',
          onPointerDown: function (e) {
            if (dur <= 0) return
            draggingRef.current = true
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch (err) {}
            setDragPos(valueAt(e.clientX))
            var r = barRef.current ? barRef.current.getBoundingClientRect() : null
            seekDiagLog({ k: 'down', x: Math.round(e.clientX), left: r ? Math.round(r.left) : 0, w: r ? Math.round(r.width) : 0, dur: Math.round(dur) })
          },
          onPointerMove: function (e) {
            if (!draggingRef.current) return
            setDragPos(valueAt(e.clientX))
          },
          onPointerUp: function (e) {
            if (!draggingRef.current) {
              seekDiagLog({ k: 'up-ignored' })
              return
            }
            release(e)
            var target = valueAt(e.clientX)
            setDragPos(null)
            if (dur > 0) {
              lastSeekAtRef.current = Date.now()
              seekDiagLog({ k: 'up', target: Math.round(target), x: Math.round(e.clientX) })
              props.onSeek(target)
            }
          },
          onPointerCancel: function (e) {
            release(e)
            setDragPos(null)
          },
          onLostPointerCapture: function (e) {
            // 指针被系统抢走时别把预览位置卡住；但按键还按着就别清 ——
            // 拖动中途捕获一丢就清掉 dragging，松手那一下会被当成「没在拖」直接吞掉，
            // 表现就是拖的时候跟手、一松手弹回原处。
            if (e && typeof e.buttons === 'number' && (e.buttons & 1) !== 0) {
              seekDiagLog({ k: 'lost-capture-while-pressed' })
              return
            }
            draggingRef.current = false
            setDragPos(null)
          },
          // pointerup 万一没送到（捕获被抢 / 合成事件异常），click 兜底再跳一次
          onClick: function (e) {
            if (dur <= 0) return
            if (Date.now() - lastSeekAtRef.current < 800) return
            var target = valueAt(e.clientX)
            if (target <= 0) return
            lastSeekAtRef.current = Date.now()
            seekDiagLog({ k: 'click', target: Math.round(target) })
            props.onSeek(target)
          },
        },
        h('div', { className: 'np-progress-track' }, h('div', { className: 'np-progress-fill', style: { width: (pct * 100).toFixed(2) + '%' } })),
        h('div', { className: 'np-progress-knob', style: { left: (pct * 100).toFixed(2) + '%' } }),
      )
    }

    // ---- 封面 --------------------------------------------------------------

    function Cover(props) {
      var song = props.song
      var size = props.size || 44
      var src = song ? coverUrl(song.cover) : ''
      if (src !== '') {
        // 取 2 倍图：列表里是 36~46px，高 DPI 屏用原尺寸会糊成一团色块。
        var px = Math.round(size * 2)
        return h('img', {
          className: 'np-cover' + (props.playing ? ' np-cover--playing' : ''),
          src: src + '?param=' + px + 'y' + px,
          alt: '',
          width: size,
          height: size,
          loading: 'lazy',
          // 列表里几十张封面同时解码会卡主线程：交给浏览器异步解码；
          // 另外图片默认能被拖走（会把整行拖成一张幽灵图），关掉。
          decoding: 'async',
          draggable: false,
          onError: function (e) {
            e.currentTarget.style.display = 'none'
          },
        })
      }
      return h(
        'div',
        { className: 'np-cover np-cover--empty', style: { width: size, height: size } },
        h(Icon, { name: 'note', size: Math.round(size * 0.5) }),
      )
    }

    // ---- 主体 --------------------------------------------------------------

    function NeteasePlayer() {
      var audioRef = useRef(null)
      var [queue, setQueue] = useState(function () {
        return loadQueue()
      })
      var [index, setIndex] = useState(function () {
        var n = Number(readLS(LS.index))
        return isFinite(n) && n >= 0 ? Math.floor(n) : -1
      })
      var [playing, setPlaying] = useState(false)
      var [expanded, setExpanded] = useState(false)
      var [tab, setTab] = useState('search')
      var [pos, setPos] = useState(0)
      var [dur, setDur] = useState(0)
      var [volume, setVolume] = useState(loadVolume)
      // 外观：主题色 + 鲸鱼/小鱼/气泡开关 + 动效强度，全部存在 localStorage
      var [look, setLook] = useState(loadLook)
      var patchLook = useCallback(function (patch) {
        setLook(function (prev) {
          var next = Object.assign({}, prev, patch)
          saveLook(next)
          return next
        })
      }, [])
      var [hostState, setHostState] = useState(null)
      // /state 一直不回来时的兜底（5 秒）：不能因为拿不到宿主地址就永远不出声。
      var [stateDeadlinePassed, setStateDeadlinePassed] = useState(false)
      var [autoProbing, setAutoProbing] = useState(false)
      var [healTick, setHealTick] = useState(0)
      var [keyword, setKeyword] = useState('')
      var [results, setResults] = useState([])
      // 搜索源：netease（网易云）| bili（B 站）。B 站搜的是视频，靠宿主那边排序筛过一遍。
      var [source, setSource] = useState(function () {
        try {
          return localStorage.getItem(LS.source) === 'bili' ? 'bili' : 'netease'
        } catch (e) {
          return 'netease'
        }
      })
      var [searching, setSearching] = useState(false)
      var [notice, setNotice] = useState('')
      var [lyric, setLyric] = useState({ raw: [], trans: [] })
      var [login, setLogin] = useState({ step: 'idle', key: '', img: '', msg: '' })
      var [cookieInput, setCookieInput] = useState('')
      var [playlists, setPlaylists] = useState([])
      var [playlistStep, setPlaylistStep] = useState('idle') // idle | loading | ready | error
      var [playlistError, setPlaylistError] = useState('')
      var [openList, setOpenList] = useState(null)
      var [tracks, setTracks] = useState([])
      var [trackStep, setTrackStep] = useState('idle') // idle | loading | ready | error
      var [trackError, setTrackError] = useState('')
      var [trackProgress, setTrackProgress] = useState('')
      var [shownTracks, setShownTracks] = useState(300)
      var lyricBoxRef = useRef(null)
      var pollRef = useRef(null)
      var healTimerRef = useRef(null)
      var healTriesRef = useRef(0)
      var searchSeq = useRef(0)
      var playlistSeq = useRef(0)
      var trackSeq = useRef(0)
      var uidRef = useRef(0)

      var current = index >= 0 && index < queue.length ? queue[index] : null

      // 自定义协议页面（桌面端）音源要带绝对前缀。hostState 还没回来时先别起播 ——
      // 用相对的 dsh-app:// 地址起播等于把「不可 seek」的音源塞给浏览器；等宿主把
      // 自己的 http 地址报上来（通常几百毫秒）再一次性挂对。宿主没报（插件版本旧 /
      // /state 失败）就退回相对路径：歌能放，只是拖不动进度条。
      var hostReady = hostState !== null || stateDeadlinePassed
      var mediaBase = ''
      if (IS_CUSTOM_SCHEME_PAGE && hostReady) {
        var rawOrigin = hostState && typeof hostState.mediaOrigin === 'string' ? hostState.mediaOrigin.trim() : ''
        if (/^https?:\/\/[^/]+$/i.test(rawOrigin)) mediaBase = rawOrigin.replace(/\/+$/, '')
      }
      // 音频还没报出 duration 时（刚切歌 / 流式响应不带长度）拿队列里这首歌的时长兜底：
      // dur=0 时进度条的按下会被直接 return 掉 —— 表现就是「点了没反应、拖不动」。
      var metaDur = current && Number(current.duration) > 0 ? Number(current.duration) / 1000 : 0
      var viewDur = dur > 0 ? dur : metaDur
      // 登录态 / 本地服务状态：账号页和歌单页共用这一份判断。
      var loggedIn = !!(hostState && hostState.hasCookie)
      var serviceOnline = !!(hostState && hostState.serviceOnline)

      // 队列/当前曲目持久化
      useEffect(function () {
        writeLS(LS.queue, JSON.stringify(queue.slice(0, 300)))
      }, [queue])
      useEffect(function () {
        writeLS(LS.index, index)
      }, [index])

      // ---- 宿主状态 ----
      // fresh=true 时让宿主跳过 1.5 秒的探测缓存：手动点「重新检测」要的是此刻的真相。
      var refreshState = useCallback(function (fresh) {
        return apiGet('/state', fresh ? { fresh: 1 } : null)
          .then(function (s) {
            setHostState(s)
            return s
          })
          .catch(function () {
            setHostState({ ok: false, serviceOnline: false, hasCookie: false })
            return null
          })
      }, [])

      useEffect(function () {
        refreshState()
      }, [refreshState])

      // 自定义协议页面要等 /state 里的 mediaOrigin 才挂音源。万一 /state 一直不回来
      // （宿主卡死 / 请求悬着），5 秒后放行：退回相对路径，至少能出声。
      useEffect(function () {
        if (!IS_CUSTOM_SCHEME_PAGE || hostState !== null || stateDeadlinePassed) return undefined
        var timer = setTimeout(function () {
          setStateDeadlinePassed(true)
        }, 5000)
        return function () {
          clearTimeout(timer)
        }
      }, [hostState, stateDeadlinePassed])

      // ---- 冷启动自愈 ----
      // 页面刚打开时宿主可能正在拉起本地服务（约 10 秒冷启动），这一刻抓到的 state
      // 只能是 serviceOnline:false；不补抓的话歌单页会一直停在「服务没起来」。
      // 只在「有 Cookie 且服务离线」时按固定间隔重抓，一上线立刻停，在线时不多打请求。
      function stopHeal() {
        if (healTimerRef.current !== null) {
          clearInterval(healTimerRef.current)
          healTimerRef.current = null
        }
        healTriesRef.current = 0
      }

      var startHeal = useCallback(function () {
        if (healTimerRef.current !== null) return
        healTriesRef.current = HEAL_MAX_TRIES
        setAutoProbing(true)
        healTimerRef.current = setInterval(function () {
          if (healTriesRef.current <= 0) {
            stopHeal()
            setAutoProbing(false)
            return
          }
          healTriesRef.current -= 1
          refreshState().then(function (s) {
            // 拿到在线就收手；试满次数也收手，别在离线时无限打接口。
            if ((s && s.serviceOnline) || healTriesRef.current <= 0) {
              stopHeal()
              setAutoProbing(false)
            }
          })
        }, HEAL_INTERVAL_MS)
      }, [refreshState])

      // 「重新检测」按钮：立刻重抓一次，并把自愈计数复位重新盯一会儿。
      var recheckService = useCallback(function () {
        setAutoProbing(true)
        setHealTick(function (n) {
          return n + 1
        })
        return refreshState(true)
      }, [refreshState])

      useEffect(
        function () {
          var offline = !!(hostState && hostState.hasCookie && !hostState.serviceOnline)
          // 收起面板 / 已在线 / 没 Cookie 都不轮询；卸载时下面这个 cleanup 也会清掉定时器。
          if (!expanded || !offline) {
            setAutoProbing(false)
            return undefined
          }
          startHeal()
          return function () {
            stopHeal()
          }
        },
        [expanded, loggedIn, serviceOnline, healTick, startHeal],
      )

      // 切到「账号」页签先问一次宿主状态：登录态 / 本地服务可能在别处变了
      // （扫码在别的窗口完成、宿主自动拉起了服务），不刷新就会一直停在旧判断上。
      useEffect(
        function () {
          if (tab !== 'account') return
          refreshState()
        },
        [tab, refreshState],
      )

      // ---- audio 接线 ----
      useEffect(function () {
        var a = audioRef.current
        if (!a) return
        a.volume = volume
        writeLS(LS.volume, volume)
      }, [volume])

      useEffect(function () {
        var a = audioRef.current
        if (!a) return undefined

        function onTime() {
          setPos(a.currentTime || 0)
          // 边下边播的流不一定补发 durationchange，duration 到得比 timeupdate 晚；
          // 这里顺手兜一次，否则 dur 一直是 0，进度条就永远拖不动。
          if (isFinite(a.duration) && a.duration > 0) {
            setDur(function (d) {
              return d > 0 ? d : a.duration
            })
          }
        }
        function onDur() {
          setDur(isFinite(a.duration) ? a.duration : 0)
        }
        function onSeeked() {
          var at = a.currentTime || 0
          seekDiagLog({ k: 'seeked', at: Math.round(at * 10) / 10 })
          setPos(at)
          // 服务器没返回 Range / 流本身不可 seek 时，浏览器会把 currentTime 钉回原处，
          // 用户看到的就是「拖完又弹回去」。这种只能换源，说清楚一次，别让人反复试。
          var want = wantSeekRef.current
          if (want) {
            wantSeekRef.current = null
            if (Math.abs(at - want.t) > 3 && Date.now() - want.at < 5000) {
              var src = String(a.src || '')
              if (seekWarnRef.current !== src) {
                seekWarnRef.current = src
                setNotice('这个音源不支持拖动进度条')
              }
            }
          }
        }
        function onEnded() {
          nextRef.current(true)
        }
        function onErr() {
          // 切歌 / 重新 seek 会被动中止上一个请求，这种 abort 不是真的拿不到音源，别误报。
          if (a.error && a.error.code === 1) return
          if (!a.getAttribute('src')) return
          setPlaying(false)
          setNotice('这首歌没有可用音源，换一首')
          // 宿主那边记着真正的失败原因（风控 / 404 外链 / 服务没起来），抓回来贴上去，
          // 不然页面上永远只有一句「拿不到音源」，排障全靠猜。
          apiGet('/state')
            .then(function (s) {
              var why = s && typeof s.lastPlayError === 'string' ? s.lastPlayError : ''
              if (why !== '') setNotice('音源不可用：' + why)
            })
            .catch(function () {})
        }
        function onPlay() {
          setPlaying(true)
          setNotice('')
        }
        function onPause() {
          setPlaying(false)
        }
        a.addEventListener('timeupdate', onTime)
        function applyPendingSeek() {
          var t = pendingSeekRef.current
          if (t === null || t === undefined) return
          pendingSeekRef.current = null
          try {
            a.currentTime = t
          } catch (e) {}
        }
        a.addEventListener('loadedmetadata', applyPendingSeek)
        a.addEventListener('canplay', applyPendingSeek)
        a.addEventListener('durationchange', onDur)
        a.addEventListener('seeked', onSeeked)
        a.addEventListener('ended', onEnded)
        a.addEventListener('error', onErr)
        a.addEventListener('play', onPlay)
        a.addEventListener('pause', onPause)
        return function () {
          a.removeEventListener('timeupdate', onTime)
          a.removeEventListener('loadedmetadata', applyPendingSeek)
          a.removeEventListener('canplay', applyPendingSeek)
          a.removeEventListener('durationchange', onDur)
          a.removeEventListener('seeked', onSeeked)
          a.removeEventListener('ended', onEnded)
          a.removeEventListener('error', onErr)
          a.removeEventListener('play', onPlay)
          a.removeEventListener('pause', onPause)
        }
      }, [])

      var playAt = useCallback(
        function (nextIndex, nextQueue) {
          var list = nextQueue || queue
          if (list.length === 0) return
          var i = ((nextIndex % list.length) + list.length) % list.length
          if (nextQueue) setQueue(nextQueue)
          setIndex(i)
          setPos(0)
          setDur(0)
          setNotice('')
          setPlaying(true)
        },
        [queue],
      )

      // 当前曲目的「身份」：只有它变了才换 <audio> 的 src。
      // 以前只盯着 index，从队列里删掉当前这首之后 index 没动、歌其实已经换人了，
      // <audio> 还挂着上一首的地址，按播放就会放出错误的那首。
      var currentKey = current
        ? String(current.id) + '@' + (current.src === 'bili' ? 'bili' : 'netease')
        : ''

      // 换歌只换 src：同一个 <audio> 复用（DOM 里始终是同一个节点），
      // 别再额外 load()+play()，那会把刚发出的请求再中止一次，播放交给下面的播放/暂停 effect。
      useEffect(function () {
        var a = audioRef.current
        if (!a) return
        if (!current) {
          a.pause()
          a.removeAttribute('src')
          try {
            a.load()
          } catch (e) {}
          return
        }
        // 自定义协议下还没拿到宿主的 http 地址：先不挂 src，避免用不可 seek 的
        // dsh-app:// 起播、拿到地址后又从头重载一次。
        if (IS_CUSTOM_SCHEME_PAGE && !hostReady) return
        var bili = current.src === 'bili'
        a.src =
          mediaBase +
          API +
          '/play?id=' +
          encodeURIComponent(current.id) +
          (bili ? '&source=bili' : '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [currentKey, mediaBase, hostReady])

      // 播放/暂停（唯一的 play()/pause() 入口）
      useEffect(function () {
        var a = audioRef.current
        if (!a || !current) return
        if (!playing) {
          a.pause()
          return
        }
        if (!a.getAttribute('src')) return
        var p = a.play()
        if (p && p.catch) p.catch(function () {})
        // mediaBase 变化会重挂 src；这时如果本来在放，要接着 play()。
      }, [playing, current, mediaBase])

      var nextRef = useRef(function () {})
      nextRef.current = function (auto) {
        if (queue.length === 0) return
        if (auto) {
          if (queue.length === 1) {
            var a = audioRef.current
            if (a) {
              a.currentTime = 0
              var p = a.play()
              if (p && p.catch) p.catch(function () {})
            }
            return
          }
          playAt(index + 1)
        } else {
          playAt(index + 1)
        }
      }

      var prev = useCallback(
        function () {
          var a = audioRef.current
          if (a && a.currentTime > 4 && current) {
            a.currentTime = 0
            return
          }
          if (queue.length === 0) return
          if (index <= 0) playAt(queue.length - 1)
          else playAt(index - 1)
        },
        [queue, index, playAt, current],
      )

      var toggle = useCallback(
        function () {
          if (!current) {
            setTab('search')
            setExpanded(true)
            return
          }
          setPlaying(function (v) {
            return !v
          })
        },
        [current],
      )

      // 「想跳到哪儿」：seeked 回来要核对，跳不到就说明这个音源不可 seek
      var wantSeekRef = useRef(null)
      var pendingSeekRef = useRef(null)
      var seekWarnRef = useRef(null)
      var seekTo = useCallback(function (t) {
        var a = audioRef.current
        if (!a) return
        var target = Math.max(0, Number(t) || 0)
        wantSeekRef.current = { t: target, at: Date.now() }
        setPos(target)
        var seekable0 = null
        try {
          if (a.seekable && a.seekable.length > 0) seekable0 = [Math.round(a.seekable.start(0)), Math.round(a.seekable.end(0))]
        } catch (e) {}
        seekDiagLog({
          k: 'seek',
          target: Math.round(target),
          before: Math.round((a.currentTime || 0) * 10) / 10,
          ready: a.readyState,
          dur: isFinite(a.duration) ? Math.round(a.duration) : String(a.duration),
          seekable: seekable0,
          paused: !!a.paused,
          // 页面协议：dsh-app:// 下必须走 http 音源，否则 seekable 恒为 [0,0]
          proto: IS_CUSTOM_SCHEME_PAGE ? 'custom' : 'http',
          cur: String(a.currentSrc || a.src || '').slice(-20),
        })
        setTimeout(function () {
          var b = audioRef.current
          if (!b || b !== a) return
          var got = b.currentTime || 0
          if (Math.abs(got - target) > 2.5) {
            var sk = null
            try {
              if (b.seekable && b.seekable.length > 0) sk = [Math.round(b.seekable.start(0)), Math.round(b.seekable.end(0))]
            } catch (e) {}
            seekDiagLog({ k: 'seek-failed', want: Math.round(target), got: Math.round(got * 10) / 10, seekable: sk })
          }
        }, 1500)
        // readyState 0 = 元数据还没到，这时候写 currentTime 会被浏览器丢掉，先排队
        if (a.readyState === 0) {
          pendingSeekRef.current = target
          return
        }
        try {
          a.currentTime = target
        } catch (e) {
          pendingSeekRef.current = target
        }
      }, [])

      /**
       * 展开 / 收起面板。展开时落在「外观」里选的默认页签（没在放歌就回搜歌），
       * 这样常看队列的人不用每次再点一下页签。
       */
      var togglePanel = useCallback(
        function () {
          if (expanded) {
            setExpanded(false)
            return
          }
          setTab(current ? look.openTab || 'queue' : 'search')
          setExpanded(true)
        },
        [expanded, current, look.openTab],
      )

      // ---- 搜索 ----
      var runSearch = useCallback(function () {
        var kw = keyword.trim()
        if (kw === '') return
        var seq = searchSeq.current + 1
        searchSeq.current = seq
        setSearching(true)
        setNotice('')
        apiGet('/search', { keywords: kw, limit: 40, source: source })
          .then(function (data) {
            if (searchSeq.current !== seq) return
            setResults((data && data.songs) || [])
            if (!data || !data.songs || data.songs.length === 0) {
              setNotice(source === 'bili' ? 'B 站没有结果，换个关键词' : '没有搜到结果')
            }
            // 宿主那侧还是旧代码时（改完插件没重启），/search 会忽略 source 直接回网易云结果。
            // 这里认出来，给一句能直接照做的提示，省得以为是 B 站没搜到。
            if (source === 'bili' && data && data.ok !== false && data.source !== 'bili') {
              setNotice('B 站搜索需要重启 DSH 后生效')
            }
          })
          .catch(function (err) {
            if (searchSeq.current !== seq) return
            setResults([])
            setNotice(err && err.message ? err.message : '搜索失败')
          })
          .then(function () {
            if (searchSeq.current === seq) setSearching(false)
          })
      }, [keyword, source])

      /**
       * 从任意列表里点一首：队列里已经有就切过去，否则拿这个列表当播放队列。
       * 搜索页和歌单页共用这一份，别各写一套播放逻辑。
       */
      var playFromList = useCallback(
        function (song, list) {
          if (!song) return
          for (var i = 0; i < queue.length; i += 1) {
            if (queue[i].id === song.id) {
              playAt(i)
              return
            }
          }
          var pool = Array.isArray(list) ? list : []
          var start = -1
          for (var k = 0; k < pool.length; k += 1) {
            if (pool[k] && pool[k].id === song.id) {
              start = k
              break
            }
          }
          if (start >= 0) {
            playAt(start, pool.slice())
            return
          }
          var next = queue.slice()
          next.push(song)
          playAt(next.length - 1, next)
        },
        [queue, playAt],
      )

      var playFromSearch = useCallback(
        function (song) {
          playFromList(song, results)
        },
        [playFromList, results],
      )

      // 队列最新值：给「不想把 queue 塞进依赖数组」的回调用。
      // 塞进去的话 queue 一变，搜索结果/歌单行的 useMemo 就整片重建，上千行会明显卡一下。
      var queueRef = useRef(queue)
      queueRef.current = queue

      var addToQueue = useCallback(
        function (song) {
          if (!song) return
          var key = String(song.id)
          // 已经在队列里就直说，别报「已加入队列」骗人（以前重复点 + 也会这么写）。
          var exists = queueRef.current.some(function (s) {
            return String(s.id) === key
          })
          if (exists) {
            setNotice('已经在队列里了')
            return
          }
          setQueue(function (q) {
            if (q.some(function (s) { return String(s.id) === key })) return q
            return q.concat([song])
          })
          setNotice('已加入队列')
        },
        [],
      )

      /** 批量入队（歌单页的「全部加入队列」）：按 id 去重，只报真正加进去的数量。 */
      var addManyToQueue = useCallback(
        function (list) {
          var pool = Array.isArray(list) ? list : []
          if (pool.length === 0) return
          var seen = {}
          var next = []
          for (var i = 0; i < queue.length; i += 1) {
            seen[String(queue[i].id)] = true
            next.push(queue[i])
          }
          var added = 0
          for (var k = 0; k < pool.length; k += 1) {
            var song = pool[k]
            if (!song || song.id === undefined || song.id === null) continue
            var key = String(song.id)
            if (seen[key]) continue
            seen[key] = true
            next.push(song)
            added += 1
          }
          if (added === 0) {
            setNotice('这些歌已经在队列里了')
            return
          }
          setQueue(next)
          setNotice('已加入 ' + added + ' 首')
        },
        [queue],
      )

      // ---- 歌单 ----
      // 登录态只认现成的 hostState（hasCookie / userId），uid 缺了再问一次 /user/account。
      var resolveUid = useCallback(
        function () {
          var known = Number(hostState && hostState.userId) || 0
          if (known > 0) return Promise.resolve(known)
          if (uidRef.current > 0) return Promise.resolve(uidRef.current)
          return proxy('/user/account').then(function (data) {
            var uid = Number(data && data.profile && data.profile.userId) || 0
            if (uid > 0) uidRef.current = uid
            return uid
          })
        },
        [hostState],
      )

      var loadPlaylists = useCallback(
        function () {
          var seq = playlistSeq.current + 1
          playlistSeq.current = seq
          setPlaylistStep('loading')
          setPlaylistError('')
          resolveUid()
            .then(function (uid) {
              if (!uid) throw new Error('拿不到你的用户 id，去「账号」页签重新登录')
              return proxy('/user/playlist', { uid: uid, limit: 100, offset: 0 })
            })
            .then(function (data) {
              if (playlistSeq.current !== seq) return
              var raw = data && Array.isArray(data.playlist) ? data.playlist : []
              var list = []
              for (var i = 0; i < raw.length; i += 1) {
                var p = raw[i]
                if (!p || !p.id) continue
                list.push({
                  id: p.id,
                  name: p.name || '未命名歌单',
                  // Cover 会自己接 ?param=，封面 URL 上原有的 query 先去掉
                  cover: coverUrl(p.coverImgUrl || p.picUrl),
                  trackCount: Number(p.trackCount) || 0,
                  creator: (p.creator && p.creator.nickname) || '',
                })
              }
              setPlaylists(list)
              setPlaylistStep('ready')
            })
            .catch(function (err) {
              if (playlistSeq.current !== seq) return
              setPlaylists([])
              setPlaylistStep('error')
              setPlaylistError(plainError(err, '歌单列表'))
            })
        },
        [resolveUid],
      )

      var loadTracks = useCallback(function (pl) {
        if (!pl || !pl.id) return
        var seq = trackSeq.current + 1
        trackSeq.current = seq
        setTrackStep('loading')
        setTrackError('')
        setTrackProgress('')
        proxy('/playlist/detail', { id: pl.id })
          .then(function (data) {
            if (trackSeq.current !== seq) return null
            var p = data && data.playlist
            if (!p) throw new Error('没拿到歌单详情')
            // 用 trackIds 拿总数：track 列表可能只给了前 N 首，trackIds 才是全量。
            var ids = (Array.isArray(p.trackIds) ? p.trackIds : [])
              .map(function (t) {
                return t && t.id
              })
              .filter(Boolean)
            setOpenList({
              id: p.id || pl.id,
              name: p.name || pl.name,
              cover: coverUrl(p.coverImgUrl || pl.cover),
              trackCount: ids.length,
            })
            if (ids.length === 0) {
              setTracks([])
              setTrackStep('ready')
              return null
            }
            return fetchTracksInPages(p.id || pl.id, ids.length, function (got, all) {
              if (trackSeq.current === seq) setTrackProgress(got + '/' + all)
            })
          })
          .then(function (songs) {
            if (trackSeq.current !== seq || !songs) return
            setTracks(songs)
            setTrackStep('ready')
          })
          .catch(function (err) {
            if (trackSeq.current !== seq) return
            setTracks([])
            setTrackStep('error')
            setTrackError(plainError(err, '歌单曲目'))
          })
      }, [])

      var openPlaylist = useCallback(
        function (pl) {
          if (!pl || !pl.id) return
          setOpenList({ id: pl.id, name: pl.name, cover: pl.cover, trackCount: pl.trackCount })
          setTracks([])
          setTrackStep('idle')
          setTrackError('')
          setTrackProgress('')
          setShownTracks(300)
          loadTracks(pl)
        },
        [loadTracks],
      )

      var backToPlaylists = useCallback(function () {
        trackSeq.current += 1 // 丢掉还在路上的详情请求
        setOpenList(null)
        setTracks([])
        setTrackStep('idle')
        setTrackError('')
        setTrackProgress('')
        setShownTracks(300)
      }, [])

      // 登录态 / 服务状态一变，歌单缓存就作废，下次进页签重拉。
      useEffect(
        function () {
          playlistSeq.current += 1
          trackSeq.current += 1
          setPlaylists([])
          setPlaylistStep('idle')
          setPlaylistError('')
          setOpenList(null)
          setTracks([])
          setTrackStep('idle')
          setTrackError('')
          setTrackProgress('')
          setShownTracks(300)
        },
        [loggedIn, serviceOnline],
      )

      // 切到歌单页签且条件齐了才去拉，别在启动时就打接口。
      useEffect(
        function () {
          if (tab !== 'playlist' || !loggedIn) return
          if (playlistStep !== 'idle') return
          loadPlaylists()
        },
        [tab, loggedIn, playlistStep, loadPlaylists],
      )

      // ---- 歌词 ----
      useEffect(function () {
        if (!current) {
          setLyric({ raw: [], trans: [] })
          return
        }
        // B 站音源是视频音轨，没有 LRC，直接留空，别去打 /lyric 换一个 400。
        if (current && current.src === 'bili') {
          setLyric({ raw: [], trans: [] })
          return
        }
        var id = current.id
        var alive = true
        apiGet('/lyric', { id: id })
          .then(function (data) {
            if (!alive) return
            setLyric({ raw: (data && data.raw) || [], trans: (data && data.trans) || [] })
          })
          .catch(function () {
            if (alive) setLyric({ raw: [], trans: [] })
          })
        return function () {
          alive = false
        }
      }, [current])

      var lyricLines = useMemo(
        function () {
          var raw = lyric.raw || []
          var trans = lyric.trans || []
          var map = {}
          for (var i = 0; i < trans.length; i += 1) {
            map[Math.round(trans[i].t * 10)] = trans[i].text
          }
          return raw.map(function (line) {
            return { t: line.t, text: line.text, trans: map[Math.round(line.t * 10)] || '' }
          })
        },
        [lyric],
      )

      var activeLine = -1
      for (var li = 0; li < lyricLines.length; li += 1) {
        if (lyricLines[li].t <= pos + 0.25) activeLine = li
        else break
      }

      // 歌词跟唱：只滚歌词自己的容器，别用 scrollIntoView ——
      // 那会把外层面板/页面也一起滚走（双栏之后歌词只是左栏一个小滚动区）。
      useEffect(function () {
        var box = lyricBoxRef.current
        if (!box) return
        var el = box.querySelector('[data-active="true"]')
        if (!el) return
        var top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2
        try {
          box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
        } catch (e) {
          box.scrollTop = Math.max(0, top)
        }
      }, [activeLine, tab, expanded])

      // ---- 登录 ----
      function stopPoll() {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }

      useEffect(function () {
        return function () {
          stopPoll()
        }
      }, [])

      var startQr = useCallback(function () {
        stopPoll()
        setLogin({ step: 'loading', key: '', img: '', qrpath: '', qrsize: 0, msg: '' })
        proxy('/login/qr/key')
          .then(function (k) {
            var key = k && k.data && k.data.unikey
            if (!key) throw new Error('拿不到二维码 key')
            return proxy('/login/qr/create', { key: key, qrimg: true }).then(function (c) {
              var img = c && c.data && c.data.qrimg
              // 宿主自己算的二维码是内联 SVG（qrpath/qrsize）；装了本地服务时回的是 qrimg。
              var path = c && c.data && c.data.qrpath
              var size = Number(c && c.data && c.data.qrsize) || 0
              setLogin({
                step: 'scan',
                key: key,
                img: img || '',
                qrpath: typeof path === 'string' ? path : '',
                qrsize: size,
                msg: '用网易云 App 扫码',
              })
              pollRef.current = setInterval(function () {
                proxy('/login/qr/check', { key: key })
                  .then(function (r) {
                    var code = Number(r && r.code)
                    if (code === 803) {
                      stopPoll()
                      var cookie = r.cookie || ''
                      if (!cookie) {
                        setLogin({ step: 'error', key: '', img: '', msg: '登录成功但未获取到 Cookie，请使用 Cookie 登录' })
                        return
                      }
                      apiPost('/cookie', { cookie: cookie })
                        .then(function (saved) {
                          writeLS(LS.cookie, cookie)
                          setLogin({ step: 'done', key: '', img: '', msg: '已登录' + (saved && saved.nickname ? '：' + saved.nickname : '') })
                          refreshState()
                        })
                        .catch(function (err) {
                          setLogin({ step: 'error', key: '', img: '', msg: err && err.message ? err.message : '保存失败' })
                        })
                    } else if (code === 800) {
                      stopPoll()
                      setLogin({ step: 'expired', key: '', img: '', msg: '二维码已过期，请刷新' })
                    } else if (code === 802) {
                      setLogin(function (prev) {
                        return prev.step === 'scan'
                          ? {
                              step: 'scan',
                              key: key,
                              img: prev.img,
                              qrpath: prev.qrpath,
                              qrsize: prev.qrsize,
                              msg: '已扫码，请在手机上确认',
                            }
                          : prev
                      })
                    }
                  })
                  .catch(function () {})
              }, 2200)
            })
          })
          .catch(function (err) {
            setLogin({ step: 'error', key: '', img: '', msg: err && err.message ? err.message : '二维码登录不可用' })
          })
      }, [refreshState])

      var submitCookie = useCallback(function () {
        var raw = cookieInput.trim()
        if (raw === '') return
        setLogin({ step: 'loading', key: '', img: '', msg: '' })
        apiPost('/cookie', { cookie: raw })
          .then(function (saved) {
            writeLS(LS.cookie, raw)
            setCookieInput('')
            setLogin({ step: 'done', key: '', img: '', msg: '已登录' + (saved && saved.nickname ? '：' + saved.nickname : '') })
            refreshState()
          })
          .catch(function (err) {
            // 服务没起来时也允许先存着，下次服务起来就能用
            var status = err && err.status
            if (status === 409) {
              writeLS(LS.cookie, raw)
              setLogin({ step: 'error', key: '', img: '', msg: 'Cookie 已保存，但本地服务未启动，无法校验' })
            } else {
              setLogin({ step: 'error', key: '', img: '', msg: err && err.message ? err.message : 'Cookie 无效' })
            }
          })
      }, [cookieInput, refreshState])

      var logout = useCallback(function () {
        apiPost('/cookie', { cookie: '' })
          .catch(function () {})
          .then(function () {
            writeLS(LS.cookie, null)
            setLogin({ step: 'idle', key: '', img: '', msg: '' })
            refreshState()
          })
      }, [refreshState])

      var startService = useCallback(function () {
        setNotice('正在启动本地服务…')
        apiPost('/service/start', {})
          .then(function (r) {
            if (r && r.ok) {
              setNotice('本地服务已启动')
              // 刚拉起来的服务也要冷启动，交给自愈轮询去等它真正可用。
              recheckService()
            } else {
              setNotice((r && r.error) || '启动失败')
            }
          })
          .catch(function (err) {
            setNotice(err && err.message ? err.message : '启动失败')
          })
      }, [recheckService])

      // ---- 展开面板：点外面 / Esc 关闭 ----
      useEffect(function () {
        if (!expanded) return undefined
        function onKey(e) {
          if (e.key === 'Escape') setExpanded(false)
        }
        // 点面板和底栏以外的地方也收起来（README 里一直这么写，但以前只做了 Esc）。
        // 用捕获阶段：面板内部按钮自己 stopPropagation 也不影响这里判断。
        function onPointerDown(e) {
          var t = e.target
          if (!t || typeof t.closest !== 'function') return
          if (t.closest('.np-panel') || t.closest('.np-bar')) return
          setExpanded(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointerDown, true)
        return function () {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [expanded])

      // 普通提示（「已加入队列」「本地 API 服务已启动」）自己收掉，别一直挂在面板顶上；
      // 报错类的留着，用户要能照着排查。
      useEffect(function () {
        if (notice === '') return undefined
        if (/失败|拿不到|没起来|无效|过期|不可用|稍后再试|还没重载/.test(notice)) return undefined
        var timer = setTimeout(function () {
          setNotice('')
        }, 4000)
        return function () {
          clearTimeout(timer)
        }
      }, [notice])

      // ---- 渲染 ----

      // 加载占位：一排呼吸的骨架行，比一行「正在读…」更像成品。
      function skeletonRows(n, keyPrefix) {
        var out = []
        for (var i = 0; i < n; i += 1) {
          out.push(
            h(
              'div',
              { key: keyPrefix + i, className: 'np-row np-row--skeleton' },
              h('div', { className: 'np-sk-art' }),
              h(
                'div',
                { className: 'np-row-main' },
                h('div', { className: 'np-sk-line np-sk-line--title' }),
                h('div', { className: 'np-sk-line np-sk-line--sub' }),
              ),
            ),
          )
        }
        return out
      }

      function songRow(song, opts) {
        var isCurrent = current && current.id === song.id
        return h(
          'div',
          {
            key: String(song.id) + (opts && opts.suffix ? opts.suffix : ''),
            className: 'np-row' + (isCurrent ? ' np-row--current' : ''),
            title: song.name || '',
            onClick: function () {
              if (opts && opts.onPlay) opts.onPlay()
            },
            role: 'button',
            tabIndex: 0,
            onKeyDown: function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (opts && opts.onPlay) opts.onPlay()
              }
            },
          },
          h(
            'div',
            { className: 'np-row-art' + (isCurrent ? ' np-row-art--on' : '') },
            h(Cover, { song: song, size: 40 }),
            isCurrent && playing
              ? h('span', { className: 'np-row-eq', 'aria-hidden': true }, h('i', null), h('i', null), h('i', null))
              : null,
          ),
          h(
            'div',
            { className: 'np-row-main' },
            h('div', { className: 'np-row-title' }, song.name || '未知歌曲'),
            h('div', { className: 'np-row-sub' }, (song.artist || '未知歌手') + (song.album ? ' · ' + song.album : '')),
          ),
          h('div', { className: 'np-row-time' }, song.duration ? fmtTime(song.duration / 1000) : ''),
          opts && opts.onRemove
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'np-icon-btn np-icon-btn--ghost',
                  title: '从队列移除',
                  onClick: function (e) {
                    e.stopPropagation()
                    opts.onRemove()
                  },
                },
                h(Icon, { name: 'trash', size: 14 }),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'np-icon-btn np-icon-btn--ghost',
                  title: '加入队列',
                  onClick: function (e) {
                    e.stopPropagation()
                    addToQueue(song)
                  },
                },
                h(Icon, { name: 'plus', size: 14 }),
              ),
        )
      }

      function playlistRow(pl) {
        return h(
          'div',
          {
            key: 'pl' + pl.id,
            className: 'np-row np-pl-row',
            role: 'button',
            tabIndex: 0,
            title: pl.name,
            onClick: function () {
              openPlaylist(pl)
            },
            onKeyDown: function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openPlaylist(pl)
              }
            },
          },
          h(Cover, { song: { cover: pl.cover, name: pl.name }, size: 44 }),
          h(
            'div',
            { className: 'np-row-main' },
            h('div', { className: 'np-row-title' }, pl.name || '未命名歌单'),
            h(
              'div',
              { className: 'np-row-sub' },
              (pl.trackCount > 0 ? pl.trackCount + ' 首' : '歌单') + (pl.creator ? ' · ' + pl.creator : ''),
            ),
          ),
          h('span', { className: 'np-pl-go' }, h(Icon, { name: 'next', size: 13 })),
        )
      }

      // timeupdate 每 250ms 就 setPos → 整个组件重渲染。歌单动辄上千行，
      // 用 useMemo 把行元素钉住，React 按引用相等就能跳过这些子树，播放时不再跟着抖。
      var searchRows = useMemo(
        function () {
          return results.map(function (song) {
            return songRow(song, {
              suffix: 's',
              onPlay: function () {
                playFromSearch(song)
              },
            })
          })
        },
        [results, current, playing, playFromSearch, addToQueue],
      )

      var queueRows = useMemo(
        function () {
          return queue.map(function (song, i) {
            return songRow(song, {
              suffix: 'q' + i,
              onPlay: function () {
                playAt(i)
              },
              onRemove: function () {
                setQueue(function (q) {
                  return q.filter(function (_, k) {
                    return k !== i
                  })
                })
                // 删掉的是当前这首时 index 留在原地，currentKey 就落到下一首上，
                // src effect 会自己换歌（正在播就直接接下一首）；删空了才需要停。
                if (i < index) setIndex(index - 1)
                else if (i === index && queue.length === 1) setPlaying(false)
              },
            })
          })
        },
        [queue, index, current, playing, playAt, addToQueue],
      )

      var trackRows = useMemo(
        function () {
          return tracks.slice(0, shownTracks).map(function (song, i) {
            return songRow(song, {
              suffix: 'p' + i,
              onPlay: function () {
                playFromList(song, tracks)
              },
            })
          })
        },
        [tracks, shownTracks, current, playing, playFromList, addToQueue],
      )

      var playlistRows = useMemo(
        function () {
          return playlists.map(function (pl) {
            return playlistRow(pl)
          })
        },
        [playlists, openPlaylist],
      )

      var panel = null
      if (expanded) {
        var body = null
        if (tab === 'search') {
          body = h(
            'div',
            { className: 'np-list' },
            searching
              ? h('div', { className: 'np-hint' }, '搜索中…')
              : results.length === 0
                ? h('div', { className: 'np-empty' }, h(Icon, { name: 'search', size: 26 }), h('div', null, '输入关键词搜索'))
                : searchRows,
          )
        } else if (tab === 'queue') {
          body = h(
            'div',
            { className: 'np-list' },
            queue.length === 0
              ? h('div', { className: 'np-empty' }, h(Icon, { name: 'list', size: 26 }), h('div', null, '队列为空'))
              : queueRows,
          )
        } else if (tab === 'playlist') {
          if (openList) {
            // 第二层：这个歌单里的曲目
            var trackContent = null
            if (trackStep === 'loading' || trackStep === 'idle') {
              trackContent = h(
                'div',
                { className: 'np-skeleton' },
                skeletonRows(6, 'sk-t-'),
                h(
                  'div',
                  { className: 'np-skel-note' },
                  '正在读取曲目…' + (trackProgress ? ' ' + trackProgress : ''),
                ),
              )
            } else if (trackStep === 'error') {
              trackContent = h(
                'div',
                { className: 'np-empty' },
                h(Icon, { name: 'list', size: 26 }),
                h('div', { className: 'np-empty-msg' }, trackError || '歌单曲目读取失败'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'np-text-btn',
                    onClick: function () {
                      loadTracks(openList)
                    },
                  },
                  '重试',
                ),
              )
            } else if (tracks.length === 0) {
              trackContent = h('div', { className: 'np-empty' }, h(Icon, { name: 'list', size: 26 }), h('div', null, '歌单为空'))
            } else {
              // 上千首的歌单一次全渲染会卡，先铺 300 行，剩下的按需「显示更多」。
              trackContent = trackRows
            }
            body = h(
              'div',
              { className: 'np-playlist' },
              h(
                'div',
                { className: 'np-subhead' },
                h(
                  'button',
                  { type: 'button', className: 'np-icon-btn np-icon-btn--ghost', title: '返回歌单列表', onClick: backToPlaylists },
                  h(Icon, { name: 'prev', size: 15 }),
                ),
                h(
                  'div',
                  { className: 'np-subhead-text' },
                  h('div', { className: 'np-subhead-title', title: openList.name }, openList.name || '歌单'),
                  h(
                    'div',
                    { className: 'np-subhead-sub' },
                    trackStep === 'ready'
                      ? tracks.length + ' 首'
                      : openList.trackCount > 0
                        ? openList.trackCount + ' 首'
                        : '',
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'np-text-btn',
                    disabled: trackStep !== 'ready' || tracks.length === 0,
                    onClick: function () {
                      addManyToQueue(tracks)
                    },
                  },
                  '全部加入队列',
                ),
              ),
              h(
                'div',
                { className: 'np-list' },
                trackContent,
                tracks.length > shownTracks
                  ? h(
                      'div',
                      { className: 'np-more' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'np-text-btn',
                          onClick: function () {
                            setShownTracks(shownTracks + 500)
                          },
                        },
                        '显示更多（还有 ' + (tracks.length - shownTracks) + ' 首）',
                      ),
                    )
                  : null,
              ),
            )
          } else {
            // 第一层：登录用户自己的歌单（本地服务离线也能读：宿主会走公开接口）
            var listContent = null
            if (!loggedIn) {
              listContent = h(
                'div',
                { className: 'np-empty' },
                h(Icon, { name: 'user', size: 26 }),
                h('div', null, '未登录'),
                h('div', { className: 'np-hint np-empty-hint' }, '登录后可读取你的歌单'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'np-text-btn',
                    onClick: function () {
                      setTab('account')
                    },
                  },
                  '去「账号」登录',
                ),
              )
            } else if (playlistStep === 'loading' || playlistStep === 'idle') {
              listContent = h('div', { className: 'np-skeleton' }, skeletonRows(5, 'sk-p-'))
            } else if (playlistStep === 'error') {
              listContent = h(
                'div',
                { className: 'np-empty' },
                h(Icon, { name: 'list', size: 26 }),
                h('div', { className: 'np-empty-msg' }, playlistError || '歌单列表读取失败'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'np-text-btn',
                    onClick: function () {
                      loadPlaylists()
                    },
                  },
                  '重试',
                ),
              )
            } else if (playlists.length === 0) {
              listContent = h('div', { className: 'np-empty' }, h(Icon, { name: 'list', size: 26 }), h('div', null, '暂无歌单'))
            } else {
              listContent = playlistRows
            }
            body = h(
              'div',
              { className: 'np-playlist' },
              h(
                'div',
                { className: 'np-subhead' },
                h('div', { className: 'np-subhead-text' }, h('div', { className: 'np-subhead-title' }, '我的歌单')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'np-icon-btn np-icon-btn--ghost',
                    title: '刷新歌单',
                    disabled: playlistStep === 'loading',
                    onClick: function () {
                      loadPlaylists()
                    },
                  },
                  h(Icon, { name: 'refresh', size: 15 }),
                ),
              ),
              h('div', { className: 'np-list' }, listContent),
            )
          }
        } else if (tab === 'lyric') {
          body = h(
            'div',
            { className: 'np-lyric', ref: lyricBoxRef },
            !current
              ? h('div', { className: 'np-empty' }, h(Icon, { name: 'lyrics', size: 26 }), h('div', null, '未在播放'))
              : lyricLines.length === 0
                ? h('div', { className: 'np-empty' }, h(Icon, { name: 'lyrics', size: 26 }), h('div', null, '无歌词'))
                : lyricLines.map(function (line, i) {
                    return h(
                      'div',
                      {
                        key: i,
                        className: 'np-lyric-line' + (i === activeLine ? ' np-lyric-line--on' : ''),
                        'data-active': i === activeLine ? 'true' : 'false',
                        onClick: function () {
                          seekTo(line.t)
                        },
                      },
                      h('div', null, line.text),
                      line.trans ? h('div', { className: 'np-lyric-trans' }, line.trans) : null,
                    )
                  }),
          )
        } else if (tab === 'look') {
          var segRow = function (key, options) {
            return h(
              'div',
              { className: 'np-seg' },
              options.map(function (pair) {
                return h(
                  'button',
                  {
                    key: pair[0],
                    type: 'button',
                    className: look[key] === pair[0] ? 'np-seg--on' : '',
                    onClick: function () {
                      var patch = {}
                      patch[key] = pair[0]
                      patchLook(patch)
                    },
                  },
                  pair[1],
                )
              }),
            )
          }
          var switchRow = function (key, label) {
            return h(Switch, {
              on: look[key] !== false,
              label: label,
              onClick: function () {
                var patch = {}
                patch[key] = !(look[key] !== false)
                patchLook(patch)
              },
            })
          }
          var lookRow = function (key, title, desc, control) {
            return h(
              'div',
              { className: 'np-look-row', key: key },
              h('div', { className: 'np-look-label' }, h('b', null, title), h('span', null, desc)),
              control,
            )
          }
          var curTheme = LOOK_THEMES.filter(function (t) {
            return t.id === look.theme
          })[0] || LOOK_THEMES[0]
          body = h(
            'div',
            { className: 'np-look' },
            // 预览条：用真实底栏的类名，改上面任何一个开关都能在这儿看到（不可点）
            h(
              'div',
              { className: 'np-look-preview' },
              h(
                'div',
                { className: 'np-bar np-bar--playing' },
                h(
                  'div',
                  { className: 'np-left' },
                  h(
                    'button',
                    { className: 'np-now', type: 'button' },
                    h(Cover, { song: current, size: 22 }),
                    h(
                      'div',
                      { className: 'np-now-text' },
                      h('div', { className: 'np-now-title' }, current ? current.name : '稻香'),
                      h('div', { className: 'np-now-sub' }, current ? current.artist || '未知歌手' : '周杰伦 · 魔杰座'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'np-bar-lyric np-bar-lyric--on' },
                  h(
                    'div',
                    { className: 'np-bar-lyric-body' },
                    h('div', { className: 'np-bar-lyric-cur' }, '暂无歌词'),
                  ),
                ),
                h(
                  'div',
                  { className: 'np-controls' },
                  h('button', { className: 'np-icon-btn', type: 'button' }, h(Icon, { name: 'prev', size: 17 })),
                  h(
                    'button',
                    { className: 'np-play-btn', type: 'button' },
                    h(Icon, { name: playing ? 'pause' : 'play', size: 20 }),
                  ),
                  h('button', { className: 'np-icon-btn', type: 'button' }, h(Icon, { name: 'next', size: 17 })),
                ),
                h(
                  'div',
                  { className: 'np-right' },
                  h(
                    'div',
                    { className: 'np-timeline' },
                    h('span', { className: 'np-time' }, fmtTime(pos)),
                    h(
                      'div',
                      { className: 'np-progress' },
                      h(
                        'div',
                        { className: 'np-progress-track' },
                        h('div', {
                          className: 'np-progress-fill',
                          style: { width: (dur > 0 ? Math.min(1, pos / dur) : 0.32) * 100 + '%' },
                        }),
                      ),
                    ),
                    h('span', { className: 'np-time' }, fmtTime(dur || 223)),
                  ),
                ),
                h('div', { className: 'np-bar-line' }, h('i', { style: { width: '32%' } })),
              ),
            ),
            h(
              'div',
              { className: 'np-look-note' },
              curTheme.name +
                ' · ' +
                (look.split === 'one' ? '单栏' : '双栏') +
                ' · ' +
                (look.glass ? '毛玻璃' : '实底') +
                ' · ' +
                (look.density === 'dense' ? '紧凑' : '舒适'),
            ),
            h('div', { className: 'np-look-group-title' }, '颜色'),
            h(
              'div',
              { className: 'np-theme-cards' },
              LOOK_THEMES.map(function (t) {
                var on = look.theme === t.id
                return h(
                  'button',
                  {
                    key: t.id,
                    type: 'button',
                    className: 'np-theme-card' + (on ? ' np-theme-card--on' : ''),
                    title: t.name,
                    'aria-pressed': on ? 'true' : 'false',
                    onClick: function () {
                      patchLook({ theme: t.id })
                    },
                  },
                  h('span', { className: 'np-theme-dot', style: { background: t.color } }),
                  h('span', { className: 'np-theme-name' }, t.name),
                  on ? h('span', { className: 'np-theme-tick' }, '✓') : null,
                )
              }),
            ),
            h('div', { className: 'np-look-group-title' }, '面板'),
            lookRow(
              'split',
              '布局',
              null,
              segRow('split', [['two', '双栏'], ['one', '单栏']]),
            ),
            lookRow(
              'width',
              '面板宽度',
              null,
              segRow('width', [['md', '适中'], ['wide', '宽']]),
            ),
            lookRow(
              'density',
              '密度',
              null,
              segRow('density', [['cozy', '舒适'], ['dense', '紧凑']]),
            ),
            lookRow(
              'openTab',
              '默认页签',
              null,
              segRow('openTab', [['search', '搜歌'], ['queue', '队列'], ['lyric', '歌词']]),
            ),
            h('div', { className: 'np-look-group-title' }, '底栏'),
            lookRow('barLyric', '歌词行', null, switchRow('barLyric', '显示底栏歌词')),
            lookRow('barLine', '进度线', null, switchRow('barLine', '显示底栏进度线')),
            h('div', { className: 'np-look-group-title' }, '视觉'),
            lookRow(
              'glow',
              '光晕',
              null,
              segRow('glow', [['off', '关'], ['light', '淡'], ['mid', '中'], ['heavy', '浓']]),
            ),
            look.glow === 'off'
              ? null
              : lookRow(
                  'glowTone',
                  '光晕颜色',
                  '暖色主题建议用中性',
                  h(
                    'div',
                    { className: 'np-glow-swatches' },
                    GLOW_TONES.map(function (t) {
                      var on = (look.glowTone || 'neutral') === t.id
                      return h('button', {
                        key: t.id,
                        type: 'button',
                        title: t.name + '：' + t.desc,
                        'aria-pressed': on ? 'true' : 'false',
                        className: 'np-glow-swatch' + (on ? ' np-glow-swatch--on' : ''),
                        style: t.id === 'theme' ? { background: 'var(--np-accent)' } : t.id === 'prism' ? { background: 'conic-gradient(from 210deg,#5fd6ff,#ff6bd6,#ffd166,#5fffc2,#5fd6ff)' } : { background: t.color },
                        onClick: function () {
                          patchLook({ glowTone: t.id })
                        },
                      })
                    }),
                  ),
                ),
            lookRow('glass', '毛玻璃', null, switchRow('glass', '毛玻璃')),
            lookRow(
              'motion',
              '动效',
              null,
              segRow('motion', [['normal', '正常'], ['calm', '收敛']]),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'np-look-reset',
                onClick: function () {
                  setLook(LOOK_DEFAULT)
                  saveLook(LOOK_DEFAULT)
                },
              },
              '恢复默认',
            ),
          )
        } else {
          body = h(
            'div',
            { className: 'np-account' },
            h(
              'div',
              { className: 'np-account-row' },
              h(Icon, { name: 'user', size: 16 }),
              h('div', { className: 'np-account-name' }, loggedIn ? hostState.nickname || '已登录' : '未登录'),
              loggedIn
                ? h(
                    'button',
                    { type: 'button', className: 'np-text-btn', onClick: logout },
                    '退出',
                  )
                : null,
            ),
            h(
              'div',
              { className: 'np-account-status' + (serviceOnline ? ' np-account-status--on' : ' np-account-status--off') },
              serviceOnline ? '本地服务：在线' : '本地服务：离线（会员曲目 / 更高音质才需要它）',
              serviceOnline
                ? null
                : h(
                    'button',
                    { type: 'button', className: 'np-text-btn', onClick: startService },
                    '启动服务',
                  ),
            ),
            h(
              'div',
              { className: 'np-hint np-account-version' },
              '扫码登录不需要本地服务：二维码由插件自己生成，扫完直接听歌',
              hostState && hostState.version ? ' · v' + hostState.version : '',
            ),
            loggedIn
              ? h('div', { className: 'np-hint' }, '已登录，可使用更高音质和会员曲目')
              : h(
                  'div',
                  { className: 'np-login-box' },
                  login.step === 'scan' || login.step === 'loading'
                    ? h(
                        'div',
                        { className: 'np-qr' },
                        login.qrpath
                          ? h(
                              'svg',
                              {
                                className: 'np-qr-canvas',
                                width: 168,
                                height: 168,
                                viewBox: '0 0 ' + login.qrsize + ' ' + login.qrsize,
                                role: 'img',
                                'aria-label': '登录二维码',
                              },
                              h('rect', {
                                x: 0,
                                y: 0,
                                width: login.qrsize,
                                height: login.qrsize,
                                fill: '#fff',
                              }),
                              h('path', { d: login.qrpath, fill: '#000' }),
                            )
                          : login.img
                            ? h('img', { src: login.img, alt: '登录二维码', width: 168, height: 168 })
                            : h('div', { className: 'np-qr-wait' }, login.step === 'loading' ? '生成中…' : ''),
                        h('div', { className: 'np-hint' }, login.msg),
                        h(
                          'button',
                          { type: 'button', className: 'np-text-btn', onClick: startQr },
                          '换个二维码',
                        ),
                      )
                    : h(
                        'div',
                        { className: 'np-qr' },
                        h(
                          'button',
                          { type: 'button', className: 'np-primary-btn', onClick: startQr },
                          '扫码登录',
                        ),
                        login.msg ? h('div', { className: 'np-hint' }, login.msg) : h('div', { className: 'np-hint' }, '扫码或粘贴 Cookie 登录'),
                      ),
                  h(
                    'div',
                    { className: 'np-cookie' },
                    h('textarea', {
                      className: 'np-cookie-input',
                      placeholder: '或者粘贴 music.163.com 的 Cookie 整段…',
                      value: cookieInput,
                      rows: 2,
                      onChange: function (e) {
                        setCookieInput(e.target.value)
                      },
                    }),
                    h(
                      'button',
                      { type: 'button', className: 'np-text-btn', onClick: submitCookie },
                      '保存 Cookie',
                    ),
                  ),
                ),
          )
        }

        // ---- 面板头：封面 + 曲目 + 音量 + 收起 -------------------------------
        // 海报区（118px 的虚化封面）拿掉了：面板一打开就该是能用的东西。
        // 底栏的滑杆收起之后，音量得有个不别扭的落脚点 —— 就放这儿，常驻。
        var natHead = h(
          'div',
          { className: 'np-nat-head' },
          h(Cover, { song: current, size: 34, playing: playing }),
          h(
            'div',
            { className: 'np-nat-id' },
            h('div', { className: 'np-nat-title', title: current ? current.name : '' }, current ? current.name : '未在播放'),
            h(
              'div',
              { className: 'np-nat-sub' },
              !current
                ? '未在播放'
                : (current.artist || '未知歌手') + (playing ? ' · 正在播放' : ' · 已暂停'),
            ),
          ),
          h(
            'div',
            { className: 'np-nat-vol', title: '音量' },
            h(Icon, { name: volume > 0 ? 'volume' : 'mute', size: 15 }),
            h('input', {
              className: 'np-nat-vol-range',
              type: 'range',
              min: 0,
              max: 100,
              value: Math.round(volume * 100),
              'aria-label': '音量',
              onChange: function (e) {
                setVolume(Math.max(0, Math.min(100, Number(e.target.value))) / 100)
              },
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'np-nat-close',
              title: '收起面板',
              onClick: function () {
                setExpanded(false)
              },
            },
            h(Icon, { name: 'down', size: 16 }),
          ),
        )

        // ---- 歌词栏：常驻左栏，点一句跳过去 -------------------------------
        var lyricColumnInner =
          lyricLines.length === 0
            ? h(
                'div',
                { className: 'np-nat-lyric-empty' },
                !current ? '未在播放' : current.src === 'bili' ? 'B 站音源无歌词' : '无歌词',
              )
            : lyricLines.map(function (line, i) {
                return h(
                  'div',
                  {
                    key: 'lc' + i,
                    className: 'np-lyric-line' + (i === activeLine ? ' np-lyric-line--on' : ''),
                    'data-active': i === activeLine ? 'true' : 'false',
                    onClick: function () {
                      seekTo(line.t)
                    },
                  },
                  h('div', null, line.text),
                  line.trans ? h('div', { className: 'np-lyric-trans' }, line.trans) : null,
                )
              })

        var lyricColumn = h(
          'div',
          { className: 'np-nat-col np-nat-col--lyric' },
          h(
            'div',
            { className: 'np-nat-colhead' },
            h('span', null, lyricLines.length ? '歌词' : '歌词'),
            h(
              'button',
              {
                type: 'button',
                className: 'np-nat-full',
                title: '铺满整个面板',
                onClick: function () {
                  setTab('lyric')
                },
              },
              current && current.src === 'bili' ? '无 LRC' : '全屏',
            ),
          ),
          h('div', { className: 'np-nat-lyric', ref: lyricBoxRef }, lyricColumnInner),
        )

        // ---- 页签行（六个都留着，只是换成下划线式，不占两行）------------------
        var TAB_LIST = [
          ['search', '搜歌', 'search'],
          ['queue', '队列', 'list'],
          ['playlist', '歌单', 'note'],
          ['lyric', '歌词', 'lyrics'],
          ['look', '外观', 'palette'],
          ['account', '账号', 'user'],
        ]
        var tabRow = h(
          'div',
          { className: 'np-tabs', role: 'tablist' },
          TAB_LIST.map(function (pair) {
            return h(
              'button',
              {
                key: pair[0],
                type: 'button',
                role: 'tab',
                'aria-selected': tab === pair[0] ? 'true' : 'false',
                className: 'np-tab' + (tab === pair[0] ? ' np-tab--on' : ''),
                onClick: function () {
                  setTab(pair[0])
                },
              },
              h(Icon, { name: pair[2], size: 14 }),
              h('span', { className: 'np-tab-label' }, pair[1]),
            )
          }),
        )

        // ---- 底部搜索：任何页签都能直接搜 -----------------------------------
        var natFoot = h(
          'form',
          {
            className: 'np-nat-foot',
            onSubmit: function (e) {
              e.preventDefault()
              runSearch()
            },
          },
          h(
            'div',
            { className: 'np-search' },
            h(Icon, { name: 'search', size: 15 }),
            h('input', {
              className: 'np-search-input',
              placeholder: source === 'bili' ? '搜 B 站：歌名 + 歌手' : '搜歌名、歌手或专辑',
              value: keyword,
              autoFocus: tab === 'search',
              onChange: function (e) {
                setKeyword(e.target.value)
              },
            }),
          ),
          h(
            'div',
            { className: 'np-src', role: 'group', 'aria-label': '搜索源' },
            ['netease', 'bili'].map(function (key) {
              return h(
                'button',
                {
                  key: key,
                  type: 'button',
                  className: 'np-src-btn' + (source === key ? ' np-src-btn--on' : ''),
                  title:
                    key === 'bili'
                      ? 'B 站音源（视频音轨）'
                      : '网易云音源',
                  onClick: function () {
                    setSource(key)
                    try {
                      localStorage.setItem(LS.source, key)
                    } catch (e) {}
                  },
                },
                key === 'bili' ? 'B站' : '网易云',
              )
            }),
          ),
          h('button', { type: 'submit', className: 'np-text-btn', disabled: searching }, '搜索'),
        )

        // ---- 正文：左歌词 + 右当前页签 ---------------------------------------
        // 双栏只给「需要边听边挑」的页签（搜歌 / 队列 / 歌单）。
        // 外观和账号是设置页，塞一条 240px 的歌词只会把卡片和二维码挤扁 —— 这两个走单栏。
        var COL_TITLE = {
          search: '搜索结果',
          queue: '播放队列',
          playlist: '我的歌单',
          look: '外观',
          account: '账号',
          lyric: '歌词',
        }
        var mainHead = h(
          'div',
          { className: 'np-nat-colhead' },
          h('span', null, COL_TITLE[tab] || ''),
          h('span', null, tab === 'queue' ? queue.length + ' 首' : tab === 'search' && results.length ? results.length + ' 首' : ''),
        )
        var singleColumn = tab === 'lyric' || tab === 'look' || tab === 'account'
        var natBody = singleColumn
          ? h(
              'div',
              { className: 'np-nat-body np-nat-body--single' },
              // 设置页自己有标题，别再顶一条重复的栏头
              h('div', { className: 'np-nat-col' }, body),
            )
          : h(
              'div',
              { className: 'np-nat-body' },
              lyricColumn,
              h('div', { className: 'np-nat-div', 'aria-hidden': true }),
              h('div', { className: 'np-nat-col np-nat-col--main' }, mainHead, body),
            )

        panel = h(
          'div',
          {
            className: 'np-panel' + (tab === 'lyric' ? ' np-panel--lyric' : ''),
            role: 'dialog',
            'aria-label': '网易云播放器',
          },
          natHead,
          tabRow,
          notice ? h('div', { className: 'np-notice' }, notice) : null,
          natBody,
          natFoot,
        )
      }

      // 面板背后那层 RGB 环境光：面板是半透明毛玻璃，这层会被磨砂透出来
      var panelGlow = expanded ? h('div', { className: 'np-panel-glow', 'aria-hidden': true }) : null

      var bar = h(
        'div',
        { className: 'np-bar' + (current ? '' : ' np-bar--idle') + (playing ? ' np-bar--playing' : '') },
        // 0.3.2 起底栏是干净的状态行：海浪画布、小鱼、氛围光全部删掉了（连 DOM 都不再生成），
        // 只剩一条 1px 进度线。
        h(
          'div',
          { className: 'np-left' },
          h(
            'button',
            {
              type: 'button',
              className: 'np-now',
              title: current ? '展开播放器' : '打开网易云播放器',
            onClick: function () {
              togglePanel()
            },
          },
          // 封面色的柔光垫在左边，让底栏不只是一种灰
          current && current.cover
            ? h('span', {
                className: 'np-now-glow',
                'aria-hidden': true,
                style: { backgroundImage: 'url("' + coverUrl(current.cover) + '?param=160y160")' },
              })
            : null,
          h(Cover, { song: current, size: 46, playing: playing }),
          h(
            'div',
            { className: 'np-now-text' },
            h('div', { className: 'np-now-title' }, current ? current.name : '未在播放'),
            h('div', { className: 'np-now-sub' }, current ? current.artist || '未知歌手' : '选一首歌开始'),
          ),
          playing
            ? h(
                'div',
                { className: 'np-eq', 'aria-hidden': true },
                h('i', null),
                h('i', null),
                h('i', null),
              )
            : null,
        ),
        // 底栏歌词：跟着进度滚动当前句，下一句淡一档；点一下开面板的歌词页
        (function () {
          var curLyric = activeLine >= 0 && activeLine < lyricLines.length ? lyricLines[activeLine] : null
          var nextLyric = activeLine + 1 < lyricLines.length ? lyricLines[activeLine + 1] : null
          return h(
            'div',
            {
              className: 'np-bar-lyric' + (curLyric ? ' np-bar-lyric--on' : ''),
              role: 'button',
              tabIndex: -1,
              title: curLyric ? '查看完整歌词' : '歌词',
              onClick: function () {
                setTab('lyric')
                setExpanded(true)
              },
            },
            h('span', { className: 'np-bar-lyric-mark', 'aria-hidden': true }, h(Icon, { name: 'lyrics', size: 13 })),
            h(
              'div',
              { className: 'np-bar-lyric-body' },
              h(
                'div',
                { className: 'np-bar-lyric-cur' },
                curLyric ? curLyric.text : current ? '暂无歌词' : '未在播放',
              ),
              nextLyric ? h('div', { className: 'np-bar-lyric-next' }, nextLyric.text) : null,
            ),
          )
        })(),
        ),
        h(
          'div',
          { className: 'np-controls' },
          h(
            'button',
            {
              type: 'button',
              className: 'np-icon-btn',
              title: '上一首',
              onClick: prev,
              disabled: queue.length === 0,
            },
            h(Icon, { name: 'prev', size: 17 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'np-play-btn' + (playing ? ' np-play-btn--on' : ''),
              title: playing ? '暂停' : '播放',
              onClick: toggle,
            },
            h(Icon, { name: playing ? 'pause' : 'play', size: 20 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'np-icon-btn',
              title: '下一首',
              onClick: function () {
                nextRef.current(false)
              },
              disabled: queue.length === 0,
            },
            h(Icon, { name: 'next', size: 17 }),
          ),
        ),
        h(
          'div',
          { className: 'np-right' },
          h(
            'div',
            { className: 'np-timeline' },
            h('span', { className: 'np-time' }, fmtTime(pos)),
            h(ProgressBar, { pos: pos, dur: viewDur, onSeek: seekTo, compact: true }),
            h('span', { className: 'np-time' }, fmtTime(viewDur)),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'np-icon-btn np-icon-btn--ghost',
              title: volume === 0 ? '打开声音' : '静音',
              onClick: function () {
                setVolume(function (v) {
                  return v > 0 ? 0 : 0.7
                })
              },
            },
            h(Icon, { name: volume > 0 ? 'volume' : 'mute', size: 16 }),
          ),
          h('input', {
            className: 'np-volume',
            type: 'range',
            min: 0,
            max: 100,
            value: Math.round(volume * 100),
            'aria-label': '音量',
            onChange: function (e) {
              setVolume(Math.max(0, Math.min(100, Number(e.target.value))) / 100)
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'np-icon-btn np-icon-btn--ghost' + (expanded ? ' np-icon-btn--on' : ''),
              title: expanded ? '收起面板' : '展开面板',
              onClick: function () {
                togglePanel()
              },
            },
            h(Icon, { name: expanded ? 'down' : 'up', size: 16 }),
          ),
        ),
        // 底边那条极细的进度光，和面板里的进度条同一个进度
        h(
          'div',
          { className: 'np-bar-line', 'aria-hidden': true },
          h('i', {
            style: { width: (dur > 0 ? Math.min(1, Math.max(0, pos / dur)) * 100 : 0).toFixed(2) + '%' },
          }),
        ),
      )

      return h(
        'div',
        { className: 'np-root np-theme-' + look.theme + lookClasses(look) },
        h('audio', { ref: audioRef, preload: 'auto' }),
        // 底栏背后那层 RGB 环境光：从栏顶往上散，跟面板那圈是同一套
        h('span', { className: 'np-bar-glow' + (playing ? ' np-bar-glow--on' : ''), 'aria-hidden': true }),
        bar,
        panelGlow,
        panel,
      )
    }

    // ---- 错误边界 ----------------------------------------------------------

    var Component = React.Component

    // 错误边界必须是 class：渲染异常被吃掉的话，整个底栏会变成空白，
    // 用户只看到「播放器没了」，连原因都不知道。
    class PlayerBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: String((error && error.message) || error) }
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'np-root np-crash' }, '播放器出错：' + this.state.error)
        }
        return this.props.children
      }
    }

    // ---- 样式 --------------------------------------------------------------

    var CSS = [
      '.np-root{--np-fg:var(--dsw-alias-label-primary,#1b1b1f);--np-muted:var(--dsw-alias-label-secondary,#6b6b73);--np-faint:var(--dsw-alias-label-tertiary,#9a9aa2);--np-bg:var(--dsw-alias-bg-layer-1,#fff);--np-bar:var(--dsw-alias-bg-layer-2,#f6f6f8);--np-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--np-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.07));--np-red:var(--np-accent,#ec4141);--np-red-hi:var(--np-accent-hi,#ff5f6d);--np-red-deep:var(--np-accent-deep,#df2b2b);--np-red-lite:var(--np-accent-lite,#ff8a8a);--np-red-soft:rgba(var(--np-accent-rgb),.12);--np-accent:#ec4141;--np-accent-hi:#ff5f6d;--np-accent-deep:#df2b2b;--np-accent-lite:#ff8a8a;--np-accent-rgb:236,65,65;--np-accent-hi-rgb:255,95,109;--np-accent-lite-rgb:255,138,138;--np-ease:cubic-bezier(.22,.61,.36,1);--np-out:cubic-bezier(.16,1,.3,1);--np-radius:22px;--np-bar-h:44px;--np-lift:0 40px 90px rgba(0,0,0,.5),0 14px 34px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.08);color:var(--np-fg);-webkit-font-smoothing:antialiased;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);}',
      '.np-root audio{display:none}',
      '.np-root button{font-family:inherit}',
      '.np-root button:focus-visible{outline:2px solid rgba(var(--np-accent-rgb),.55);outline-offset:2px;}',
      '.np-boundary{display:contents}',
      '.np-bar{position:relative;display:flex;align-items:center;gap:14px;height:var(--np-bar-h);padding:0 18px;background:var(--np-bar);border-top:1px solid var(--np-line);min-width:0;backdrop-filter:blur(18px) saturate(1.9) brightness(1.03);-webkit-backdrop-filter:blur(18px) saturate(1.9) brightness(1.03);box-shadow:inset 0 1px 0 rgba(255,255,255,.1);}',
      '.np-bar::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:-1;background:radial-gradient(58% 150% at 8% 55%,rgba(var(--np-accent-rgb),.30),transparent 64%),radial-gradient(46% 132% at 46% 26%,rgba(var(--np-accent-rgb),.16),transparent 66%),radial-gradient(50% 142% at 88% 72%,rgba(var(--np-accent-rgb),.20),transparent 68%);mix-blend-mode:soft-light;opacity:.85;transition:opacity .6s var(--np-ease);}',
      '.np-bar--playing::after{opacity:1;}',
      '.np-bar::before{content:"";position:absolute;left:0;right:0;top:-1px;height:1px;background:linear-gradient(90deg,transparent,rgba(127,127,127,.22),transparent);pointer-events:none;}',
      '.np-bar-bg{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1;}',
      '.np-bar-glow{position:fixed;left:0;right:0;bottom:var(--np-bar-h);height:190px;pointer-events:none;z-index:50;background:linear-gradient(90deg,transparent,rgba(var(--np-accent-rgb),.55) 42%,rgba(var(--np-accent-rgb),.38) 68%,transparent);background-size:100% 100%;filter:blur(64px) saturate(1.15);opacity:.2;-webkit-mask-image:linear-gradient(180deg,transparent 0,rgba(0,0,0,.35) 52%,#000 100%);mask-image:linear-gradient(180deg,transparent 0,rgba(0,0,0,.35) 52%,#000 100%);transition:opacity .6s var(--np-ease);}',
      '.np-bar-glow--on{opacity:.44}',
      '.np-bar-bg::before{content:"";position:absolute;inset:-40% -14%;background:radial-gradient(38% 95% at 14% 55%,rgba(var(--np-accent-rgb),.30),transparent 62%),radial-gradient(32% 85% at 62% 40%,rgba(var(--np-accent-rgb),.14),transparent 68%);filter:blur(26px) saturate(1.15);animation:np-aurora 24s ease-in-out infinite alternate;}',
      '.np-bar-wave{position:absolute;left:0;right:0;bottom:0;width:100%;height:34px;display:block;pointer-events:none;opacity:.45;transition:opacity .5s var(--np-ease);}',
      '.np-bar--playing .np-bar-wave{opacity:.85}',
      '@keyframes np-aurora{0%{transform:translate3d(-2.2%,0,0) scale(1)}100%{transform:translate3d(2.2%,-1.4%,0) scale(1.07)}}',
      '@supports (background:color-mix(in srgb,#000 50%,transparent)){.np-bar{background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,0) 46%,rgba(127,127,127,.05)),color-mix(in srgb,var(--np-bar) 28%,transparent)}}',
      '.np-bar-line{position:absolute;left:0;right:0;bottom:0;height:2px;background:rgba(127,127,127,.16);overflow:hidden;pointer-events:none;}',
      '.np-bar-line i{display:block;height:100%;background:linear-gradient(90deg,var(--np-red-lite),var(--np-red));box-shadow:0 0 10px rgba(var(--np-accent-rgb),.7);transition:width .3s var(--np-ease);}',
      '.np-left{display:flex;align-items:center;gap:4px;flex:1 1 0;min-width:0;}',
      '.np-now{position:relative;display:flex;align-items:center;gap:12px;min-width:0;flex:0 1 300px;max-width:300px;background:none;border:0;padding:6px 12px;border-radius:16px;cursor:pointer;color:inherit;text-align:left;font:inherit;overflow:hidden;isolation:isolate;transition:background .16s var(--np-ease);}',
      '.np-now:hover{background:linear-gradient(90deg,rgba(127,127,127,.12),rgba(127,127,127,.05))}',
      '.np-now:active{background:rgba(127,127,127,.18)}',
      '.np-now-glow{position:absolute;left:-6%;top:-90%;width:52%;height:260%;background-size:cover;background-position:center;filter:blur(30px) saturate(1.8);opacity:.26;z-index:-1;pointer-events:none;-webkit-mask-image:linear-gradient(90deg,#000,transparent 92%);mask-image:linear-gradient(90deg,#000,transparent 92%);}',
      '.np-now:hover .np-now-glow{opacity:.38}',
      '.np-now-text{min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.np-now-title{font-size:14px;font-weight:650;line-height:1.3;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
      '.np-now-sub{font-size:11.5px;line-height:1.3;color:var(--np-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
      '.np-cover{width:42px;height:42px;border-radius:10px;object-fit:cover;flex:0 0 auto;background:rgba(127,127,127,.14);display:flex;align-items:center;justify-content:center;color:var(--np-muted);}',
      '.np-bar .np-cover{width:46px;height:46px;border-radius:14px;box-shadow:0 10px 24px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08)}',
      '.np-bar--playing .np-cover{box-shadow:0 10px 26px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.12),0 0 22px rgba(var(--np-accent-rgb),.26)}',
      '.np-bar--playing .np-now-glow{animation:np-glow 6s ease-in-out infinite}',
      '@keyframes np-glow{0%,100%{opacity:.22}50%{opacity:.42}}',
      '.np-cover--empty{opacity:.85}',
      '.np-eq{display:flex;align-items:flex-end;gap:2px;height:16px;margin-left:2px;flex:0 0 auto;}',
      '.np-eq i{display:block;width:3px;border-radius:2px;background:var(--np-red);animation:np-eq .9s ease-in-out infinite;}',
      '.np-eq i:nth-child(1){height:60%;animation-delay:0s}',
      '.np-eq i:nth-child(2){height:100%;animation-delay:.18s}',
      '.np-eq i:nth-child(3){height:75%;animation-delay:.36s}',
      '@keyframes np-eq{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}',
      '.np-controls{display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:999px;background:rgba(127,127,127,.09);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 1px 2px rgba(0,0,0,.06);flex:0 0 auto;transition:box-shadow .4s var(--np-ease);}',
      '.np-bar--playing .np-controls{box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 0 26px rgba(var(--np-accent-rgb),.18);}',
      '.np-controls .np-icon-btn{width:34px;height:34px;border-radius:50%;background:rgba(127,127,127,.12);color:var(--np-fg);box-shadow:inset 0 0 0 1px rgba(127,127,127,.10);transition:background .16s var(--np-ease),color .16s var(--np-ease),box-shadow .2s var(--np-ease),transform .12s var(--np-ease);}',
      '.np-controls .np-icon-btn:hover{background:var(--np-red-soft);color:var(--np-red);box-shadow:0 0 16px rgba(var(--np-accent-rgb),.3),inset 0 0 0 1px rgba(var(--np-accent-rgb),.3);}',
      '.np-controls .np-icon-btn:active{transform:scale(.9);background:rgba(var(--np-accent-rgb),.2);}',
      '.np-controls .np-icon-btn:disabled{opacity:.3;background:rgba(127,127,127,.06);box-shadow:none;transform:none;}',
      '.np-icon-btn{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:9px;background:none;color:var(--np-fg);cursor:pointer;transition:background .15s var(--np-ease),color .15s var(--np-ease),transform .12s var(--np-ease);}',
      '.np-icon-btn:hover{background:rgba(127,127,127,.16)}',
      '.np-icon-btn:active{transform:scale(.92);background:rgba(127,127,127,.24)}',
      '.np-icon-btn:disabled{opacity:.32;cursor:default;background:none;transform:none}',
      '.np-icon-btn--ghost{color:var(--np-muted)}',
      '.np-icon-btn--ghost:hover{color:var(--np-fg)}',
      '.np-icon-btn--on{color:var(--np-red);background:var(--np-red-soft)}',
      '.np-bar .np-icon-btn--ghost{color:var(--np-fg);opacity:.7}',
      '.np-bar .np-icon-btn--ghost:hover{opacity:1;box-shadow:0 0 14px rgba(127,127,127,.22)}',
      '.np-bar .np-icon-btn--on{color:var(--np-red);opacity:1;background:var(--np-red-soft);box-shadow:0 0 16px rgba(var(--np-accent-rgb),.25)}',
      '.np-play-btn{position:relative;display:flex;align-items:center;justify-content:center;width:46px;height:46px;padding:0;border:0;border-radius:50%;background:linear-gradient(160deg,var(--np-red-hi),var(--np-red-deep));color:#fff;cursor:pointer;box-shadow:0 8px 22px rgba(var(--np-accent-rgb),.45),inset 0 1px 0 rgba(255,255,255,.3),0 0 24px rgba(var(--np-accent-rgb),.26);transition:transform .12s var(--np-ease),box-shadow .2s var(--np-ease),filter .2s var(--np-ease);}',
      '.np-play-btn::before{content:"";position:absolute;inset:-9px;border-radius:50%;background:radial-gradient(circle at 50% 50%,transparent 62%,rgba(var(--np-accent-rgb),.34) 76%,transparent 88%);filter:blur(6px);opacity:.7;pointer-events:none;transition:opacity .5s var(--np-ease);}',
      '.np-play-btn--on::before{opacity:1;}',
      '.np-play-btn--on{box-shadow:0 10px 28px rgba(var(--np-accent-rgb),.55),inset 0 1px 0 rgba(255,255,255,.32),0 0 36px rgba(var(--np-accent-rgb),.45);}',
      '.np-play-btn--on::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1.5px solid rgba(var(--np-accent-hi-rgb),.42);animation:np-ping 2.8s var(--np-out) infinite;pointer-events:none;}',
      '@keyframes np-ping{0%{transform:scale(.98);opacity:.55}70%,100%{transform:scale(1.14);opacity:0}}',
      '.np-play-btn:hover{transform:scale(1.06);filter:brightness(1.06);box-shadow:0 8px 20px rgba(var(--np-accent-rgb),.45);}',
      '.np-play-btn:active{transform:scale(.95);filter:brightness(.98)}',
      '.np-bar-lyric{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;height:100%;padding:0 4px;cursor:pointer;overflow:hidden;transition:background .18s var(--np-ease);}',
      '.np-bar-lyric:hover{background:rgba(127,127,127,.07)}',
      '.np-bar-lyric-mark{flex:0 0 auto;color:var(--np-faint);opacity:.75;transition:color .3s var(--np-ease),opacity .3s var(--np-ease);}',
      '.np-bar-lyric--on .np-bar-lyric-mark{color:var(--np-red);opacity:.95}',
      '.np-bar-lyric-body{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1px;}',
      '.np-bar-lyric-cur{font-size:13px;line-height:1.35;color:var(--np-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .3s var(--np-ease);}',
      '.np-bar-lyric--on .np-bar-lyric-cur{color:var(--np-fg);font-weight:600;}',
      '.np-bar-lyric-next{font-size:11px;line-height:1.3;color:var(--np-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.72;}',
      '.np-timeline{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:90px;max-width:520px;}',
      '.np-time{font-size:11px;color:var(--np-faint);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:31px;text-align:center;}',
      '.np-progress{position:relative;flex:1;height:18px;display:flex;align-items:center;cursor:pointer;touch-action:none;}',
      '.np-progress-track{position:relative;width:100%;height:5px;border-radius:999px;background:rgba(127,127,127,.24);overflow:hidden;transition:height .16s var(--np-ease),background .16s var(--np-ease);}',
      '.np-progress:hover .np-progress-track,.np-progress[data-drag="true"] .np-progress-track{height:7px;background:rgba(127,127,127,.32);}',
      '.np-progress-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#ff6a6a,var(--np-red));box-shadow:0 0 12px rgba(var(--np-accent-rgb),.5);transition:width .12s linear;}',
      '.np-progress-knob{position:absolute;top:50%;width:12px;height:12px;margin-left:-6px;margin-top:-6px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 0 5px rgba(var(--np-accent-rgb),.16),0 1px 6px rgba(0,0,0,.45);opacity:0;transform:scale(.7);transition:opacity .16s var(--np-ease),transform .16s var(--np-ease);}',
      '.np-progress:hover .np-progress-knob,.np-progress[data-drag="true"] .np-progress-knob{opacity:1;transform:none;}',
      '.np-right{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:1 1 0;min-width:0;padding-left:12px;margin-left:2px;border-left:1px solid rgba(127,127,127,.14);}',
      '.np-right .np-icon-btn{background:rgba(127,127,127,.10);border-radius:50%;box-shadow:inset 0 0 0 1px rgba(127,127,127,.08);}',
      '.np-right .np-icon-btn:hover{background:rgba(127,127,127,.18);box-shadow:0 0 14px rgba(127,127,127,.18),inset 0 0 0 1px rgba(127,127,127,.16);}',
      '.np-volume{-webkit-appearance:none;appearance:none;width:78px;height:18px;background:transparent;accent-color:var(--np-red);cursor:pointer;}',
      '.np-volume::-webkit-slider-runnable-track{height:5px;border-radius:999px;background:rgba(127,127,127,.24);}',
      '.np-volume::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-3.5px;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.4);transition:transform .12s var(--np-ease);}',
      '.np-volume:hover::-webkit-slider-thumb{transform:scale(1.15)}',
      '.np-volume::-moz-range-track{height:5px;border-radius:999px;background:rgba(127,127,127,.24);}',
      '.np-volume::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.4);}',
      '.np-panel{position:fixed;right:16px;bottom:calc(var(--np-bar-h) + 8px);width:420px;max-width:calc(100vw - 32px);height:min(620px,calc(100vh - var(--np-bar-h) - 84px));display:flex;flex-direction:column;background:var(--np-bg);border:1px solid rgba(127,127,127,.24);border-radius:var(--np-radius);box-shadow:var(--np-lift);overflow:hidden;z-index:60;font-size:13px;backdrop-filter:blur(26px) saturate(1.5);-webkit-backdrop-filter:blur(26px) saturate(1.5);animation:np-panel-in .24s var(--np-out);}',
      '.np-panel::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);z-index:5;}',
      '.np-panel-glow{position:fixed;right:2px;bottom:calc(var(--np-bar-h) - 6px);width:448px;max-width:calc(100vw - 4px);height:min(648px,calc(100vh - var(--np-bar-h) - 8px));border-radius:36px;pointer-events:none;z-index:59;background:radial-gradient(120% 90% at 62% 8%,rgba(var(--np-accent-rgb),.5),rgba(var(--np-accent-rgb),.22) 46%,transparent 72%);filter:blur(52px) saturate(1.1);opacity:.2;-webkit-mask-image:linear-gradient(180deg,#000 55%,rgba(0,0,0,.4) 88%,transparent);mask-image:linear-gradient(180deg,#000 55%,rgba(0,0,0,.4) 88%,transparent);}',
      '@keyframes np-panel-hue{from{filter:blur(44px) saturate(1.35) hue-rotate(0deg)}to{filter:blur(44px) saturate(1.35) hue-rotate(360deg)}}',
      '@supports (background:color-mix(in srgb,#000 50%,transparent)){.np-panel{background:color-mix(in srgb,var(--np-bg) 84%,transparent)}}',
      '@keyframes np-panel-in{from{opacity:0}to{opacity:1}}',
      '.np-hero{position:relative;flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:18px 50px 16px 16px;min-height:118px;overflow:hidden;isolation:isolate;}',
      '.np-hero-bg{position:absolute;inset:-24%;background-size:cover;background-position:center;filter:blur(46px) saturate(1.7);opacity:.75;z-index:-2;}',
      '.np-hero-scrim{position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,rgba(6,6,10,.74),rgba(6,6,10,.36) 68%,rgba(6,6,10,.18)),linear-gradient(180deg,rgba(6,6,10,.06),rgba(6,6,10,.52));}',
      '.np-hero--on{color:#fff}',
      '.np-hero--off{background:linear-gradient(135deg,rgba(var(--np-accent-rgb),.18),rgba(127,127,127,.06) 55%,rgba(127,127,127,0));}',
      '.np-hero--off .np-hero-scrim{display:none}',
      '.np-hero-art{position:relative;width:68px;height:68px;flex:0 0 auto;border-radius:18px;overflow:hidden;box-shadow:0 16px 34px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.16);animation:np-art-in .4s var(--np-out);}',
      '@keyframes np-art-in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}',
      '.np-hero-art .np-cover{width:68px;height:68px;border-radius:18px}',
      '.np-hero-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.np-hero-kicker{font-size:10px;letter-spacing:.18em;color:rgba(255,255,255,.62);}',
      '.np-hero--off .np-hero-kicker{color:var(--np-faint)}',
      '.np-hero-title{font-size:16px;font-weight:650;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.np-hero-sub{font-size:12px;line-height:1.35;color:rgba(255,255,255,.68);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.np-hero--off .np-hero-sub{color:var(--np-muted)}',
      '.np-hero-eq{display:flex;align-items:flex-end;gap:2.5px;height:18px;margin-right:2px;flex:0 0 auto;}',
      '.np-hero-eq i{width:3px;border-radius:2px;background:rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(0,0,0,.45);animation:np-eq 1s ease-in-out infinite;}',
      '.np-hero-eq i:nth-child(1){height:55%}',
      '.np-hero-eq i:nth-child(2){height:100%;animation-delay:.18s}',
      '.np-hero-eq i:nth-child(3){height:68%;animation-delay:.36s}',
      '.np-hero-eq i:nth-child(4){height:86%;animation-delay:.09s}',
      '.np-hero-close{position:absolute;top:10px;right:10px;display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:9px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.82);cursor:pointer;transition:background .16s var(--np-ease),color .16s var(--np-ease),transform .12s var(--np-ease);z-index:2;}',
      '.np-hero-close:hover{background:rgba(255,255,255,.22);color:#fff}',
      '.np-hero-close:active{transform:scale(.94)}',
      '.np-hero--off .np-hero-close{background:rgba(127,127,127,.14);color:var(--np-muted)}',
      '.np-hero--off .np-hero-close:hover{background:rgba(127,127,127,.22);color:var(--np-fg)}',
      '.np-panel-head{padding:2px 15px 12px;}',
      '.np-search{display:flex;align-items:center;gap:8px;flex:1;min-width:0;background:rgba(127,127,127,.10);border:1px solid rgba(127,127,127,.14);border-radius:13px;padding:8px 11px;color:var(--np-muted);transition:background .16s var(--np-ease),border-color .16s var(--np-ease),box-shadow .16s var(--np-ease);}',
      '.np-search:focus-within{background:rgba(127,127,127,.13);border-color:rgba(var(--np-accent-rgb),.42);box-shadow:0 0 0 3px rgba(var(--np-accent-rgb),.12);}',
      '.np-search-input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--np-fg);font-size:13px;font-family:inherit;}',
      '.np-search-input::placeholder{color:var(--np-faint)}',
      '.np-src{display:flex;gap:2px;flex:0 0 auto;padding:2px;border-radius:8px;background:rgba(127,127,127,.10)}',
      '.np-src-btn{appearance:none;border:0;background:none;color:var(--np-faint);font-size:11px;line-height:1;padding:5px 7px;border-radius:6px;cursor:pointer;white-space:nowrap;transition:background .16s var(--np-ease),color .16s var(--np-ease)}',
      '.np-src-btn:hover{color:var(--np-fg)}',
      '.np-src-btn--on{background:rgba(var(--np-accent-rgb),.18);color:var(--np-red)}',
      '.np-text-btn{border:0;background:none;color:var(--np-red);font-size:12px;font-family:inherit;cursor:pointer;padding:4px 8px;border-radius:8px;flex:0 0 auto;transition:background .15s var(--np-ease),color .15s var(--np-ease),transform .12s var(--np-ease);}',
      '.np-text-btn:hover{background:var(--np-red-soft)}',
      '.np-text-btn:active{transform:scale(.96)}',
      '.np-text-btn:disabled{opacity:.5;cursor:default;transform:none}',
      '.np-tabs{display:flex;gap:4px;margin:0 15px 12px;padding:4px;border-radius:14px;background:rgba(127,127,127,.10);box-shadow:inset 0 1px 2px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.04);}',
      '.np-tab{display:flex;align-items:center;justify-content:center;gap:5px;flex:1;min-width:0;border:0;background:none;color:var(--np-muted);font-size:12px;font-family:inherit;line-height:1;padding:8px 4px;border-radius:11px;cursor:pointer;transition:background .18s var(--np-ease),color .18s var(--np-ease),box-shadow .18s var(--np-ease),transform .12s var(--np-ease);}',
      '.np-tab svg{opacity:.8;transition:opacity .16s var(--np-ease)}',
      '.np-tab:hover{color:var(--np-fg);background:rgba(127,127,127,.13)}',
      '.np-tab:hover svg{opacity:1}',
      '.np-tab:active{transform:scale(.97)}',
      '.np-tab--on,.np-tab--on:hover{color:#fff;background:linear-gradient(135deg,var(--np-red-hi),var(--np-red-deep));font-weight:600;box-shadow:0 6px 16px rgba(var(--np-accent-rgb),.35);}',
      '.np-tab--on svg{opacity:1}',
      '.np-notice{margin:0 15px 10px;padding:9px 12px;border-radius:11px;background:var(--np-red-soft);border-left:2px solid var(--np-red);color:#d84545;font-size:12px;line-height:1.5;}',
      '.np-panel-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;}',
      '.np-list{flex:1;min-height:0;overflow:auto;padding:4px 10px 12px;-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 7px,#000 calc(100% - 10px),transparent 100%);mask-image:linear-gradient(180deg,transparent 0,#000 7px,#000 calc(100% - 10px),transparent 100%);}',
      '.np-row{position:relative;display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:12px;cursor:pointer;min-width:0;transition:background .15s var(--np-ease);}',
      '.np-row+.np-row{margin-top:2px}',
      '.np-row:hover{background:rgba(127,127,127,.10);box-shadow:inset 0 0 0 1px rgba(127,127,127,.09);}',
      '.np-row:active{background:rgba(127,127,127,.16)}',
      '.np-row--current{background:rgba(var(--np-accent-rgb),.10);}',
      '.np-row--current::before{content:"";position:absolute;left:1px;top:10px;bottom:10px;width:2px;border-radius:2px;background:var(--np-red);}',
      '.np-row--current .np-row-title{color:var(--np-fg);font-weight:600;}',
      '.np-row--current .np-row-sub{color:var(--np-muted)}',
      '.np-row--current:hover{background:rgba(var(--np-accent-rgb),.16);}',
      '.np-row-art{position:relative;flex:0 0 auto;width:40px;height:40px;border-radius:10px;overflow:hidden;background:rgba(127,127,127,.12);}',
      '.np-row-art .np-cover{width:40px;height:40px;border-radius:10px;display:block;}',
      '.np-row-art::after{content:"";position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0;transition:opacity .16s var(--np-ease);}',
      '.np-row-art::before{content:"";position:absolute;left:50%;top:50%;margin:-6px 0 0 -4px;width:0;height:0;border-left:9px solid #fff;border-top:6px solid transparent;border-bottom:6px solid transparent;opacity:0;transform:scale(.7);transition:opacity .16s var(--np-ease),transform .16s var(--np-ease);z-index:2;}',
      '.np-row:hover .np-row-art::after{opacity:1}',
      '.np-row:hover .np-row-art::before{opacity:1;transform:none}',
      '.np-row-art--on::before,.np-row-art--on::after{display:none}',
      '.np-row-eq{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;gap:2px;padding-bottom:9px;background:rgba(0,0,0,.4);z-index:2;}',
      '.np-row-eq i{width:2.5px;border-radius:2px;background:#fff;height:45%;animation:np-eq .9s ease-in-out infinite;}',
      '.np-row-eq i:nth-child(2){height:75%;animation-delay:.15s}',
      '.np-row-eq i:nth-child(3){height:55%;animation-delay:.3s}',
      '.np-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.np-row-title{font-size:13px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.np-row-sub{font-size:11px;line-height:1.35;color:var(--np-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.np-row-time{font-size:11px;color:var(--np-faint);font-variant-numeric:tabular-nums;flex:0 0 auto;padding-left:4px;}',
      '.np-row--skeleton{pointer-events:none}',
      '.np-sk-art{width:40px;height:40px;border-radius:10px;background:rgba(127,127,127,.12);flex:0 0 auto;}',
      '.np-sk-line{height:9px;border-radius:999px;background:rgba(127,127,127,.12);}',
      '.np-sk-line--title{width:58%}',
      '.np-sk-line--sub{width:34%;height:8px;opacity:.7}',
      '.np-skeleton{position:relative;overflow:hidden;padding:0 2px;}',
      '.np-skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 22%,rgba(127,127,127,.15) 50%,transparent 78%);transform:translateX(-100%);animation:np-shimmer 1.5s infinite;}',
      '@keyframes np-shimmer{to{transform:translateX(100%)}}',
      '.np-skel-note{padding:6px 12px 14px;text-align:center;font-size:11.5px;color:var(--np-faint);}',
      '.np-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:180px;color:var(--np-faint);font-size:12.5px;}',
      '.np-empty svg{width:24px;height:24px;padding:14px;box-sizing:content-box;border-radius:50%;background:rgba(127,127,127,.10);color:var(--np-muted);opacity:1;}',
      '.np-hint{font-size:11.5px;color:var(--np-faint);line-height:1.6;}',
      '.np-playlist{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;}',
      '.np-subhead{display:flex;align-items:center;gap:8px;margin:0 9px 4px;padding:6px 4px 9px;min-width:0;border-bottom:1px solid var(--np-line-soft);}',
      '.np-subhead-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.np-subhead-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.np-subhead-sub{font-size:11px;color:var(--np-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.np-list-hint{padding:20px 14px;text-align:center;}',
      '.np-more{display:flex;justify-content:center;padding:10px 0 12px;}',
      '.np-empty-hint{max-width:250px;text-align:center;line-height:1.6;}',
      '.np-empty-actions{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;}',
      '.np-empty-msg{max-width:270px;text-align:center;line-height:1.6;color:var(--np-muted);}',
      '.np-pl-row .np-cover{width:44px;height:44px;border-radius:12px;transition:transform .2s var(--np-ease);}',
      '.np-pl-row:hover .np-cover{transform:scale(1.04)}',
      '.np-pl-row .np-row-title{font-weight:600}',
      '.np-pl-go{display:flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--np-faint);flex:0 0 auto;opacity:0;transform:translateX(-3px);transition:opacity .16s var(--np-ease),transform .16s var(--np-ease);}',
      '.np-pl-row:hover .np-pl-go{opacity:1;transform:none}',
      '.np-list::-webkit-scrollbar,.np-lyric::-webkit-scrollbar,.np-account::-webkit-scrollbar{width:6px;height:6px;}',
      '.np-list::-webkit-scrollbar-track,.np-lyric::-webkit-scrollbar-track,.np-account::-webkit-scrollbar-track{background:transparent;}',
      '.np-list::-webkit-scrollbar-thumb,.np-lyric::-webkit-scrollbar-thumb,.np-account::-webkit-scrollbar-thumb{background:rgba(127,127,127,.3);border-radius:999px;}',
      '.np-list::-webkit-scrollbar-thumb:hover,.np-lyric::-webkit-scrollbar-thumb:hover,.np-account::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.52);}',
      '.np-list,.np-lyric,.np-account{scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.38) transparent;}',
      '.np-lyric{flex:1;min-height:0;overflow:auto;padding:16px 18px 44px;display:flex;flex-direction:column;gap:2px;}',
      '.np-lyric-line{padding:8px 9px;border-radius:10px;color:var(--np-muted);line-height:1.55;cursor:pointer;transition:color .18s var(--np-ease),background .18s var(--np-ease);font-size:12.5px;}',
      '.np-lyric-line:hover{background:rgba(127,127,127,.08);color:var(--np-fg)}',
      '.np-lyric-line--on{color:var(--np-red);font-weight:600;background:var(--np-red-soft);font-size:13.5px;}',
      '.np-lyric-trans{font-size:11px;color:var(--np-faint);font-weight:400;margin-top:2px;}',
      '.np-account{padding:14px;display:flex;flex-direction:column;gap:12px;overflow:auto;flex:1;min-height:0;}',
      '.np-account-row{display:flex;align-items:center;gap:8px;color:var(--np-fg);}',
      '.np-account-name{flex:1;font-weight:600;}',
      '.np-account-status{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--np-muted);line-height:1.6;flex-wrap:wrap;}',
      '.np-account-status::before{content:"";width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--np-faint);}',
      '.np-account-status--on::before{background:#3ecf8e}',
      '.np-account-status--off::before{background:#e05555}',
      '.np-login-box{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:14px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.12);}',
      '.np-qr{display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 0;}',
      '.np-qr img{border-radius:12px;background:#fff;padding:4px;}',
      '.np-qr svg{border-radius:12px;background:#fff;padding:4px;display:block;}',
      '.np-qr-wait{width:168px;height:168px;border-radius:12px;background:rgba(127,127,127,.10);display:flex;align-items:center;justify-content:center;color:var(--np-faint);font-size:12px;}',
      '.np-primary-btn{border:0;border-radius:10px;background:var(--np-red);color:#fff;font-size:13px;font-family:inherit;padding:9px 20px;cursor:pointer;box-shadow:0 4px 14px rgba(var(--np-accent-rgb),.28);transition:transform .12s var(--np-ease),filter .18s var(--np-ease),box-shadow .2s var(--np-ease);}',
      '.np-primary-btn:hover{filter:brightness(1.06);box-shadow:0 6px 18px rgba(var(--np-accent-rgb),.36)}',
      '.np-primary-btn:active{transform:scale(.97)}',
      '.np-cookie{display:flex;flex-direction:column;gap:6px;}',
      '.np-cookie-input{width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--np-line);border-radius:10px;background:rgba(127,127,127,.08);color:var(--np-fg);font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:11px;padding:9px 10px;outline:0;transition:border-color .16s var(--np-ease),box-shadow .16s var(--np-ease);}',
      '.np-cookie-input:focus{border-color:rgba(var(--np-accent-rgb),.55);box-shadow:0 0 0 3px rgba(var(--np-accent-rgb),.12)}',
      '.np-cookie .np-text-btn{align-self:flex-end}',
      '.np-crash{padding:12px 14px;background:var(--np-red-soft);color:#d84545;font-size:12px;}',
      '@media (prefers-reduced-motion:reduce){.np-bar-bg::before,.np-bar-glow,.np-bar-glow::after,.np-panel-glow,.np-now-glow,.np-play-btn::before,.np-play-btn--on::after,.np-bar-wave{animation:none!important}}',
      '@media (max-width:900px){.np-timeline{display:none}.np-volume{display:none}}',
      '@media (max-width:760px){.np-bar-lyric{display:none}}',
      '@media (max-width:640px){.np-now-sub{display:none}.np-right .np-icon-btn{display:none}}',
      '@media (max-width:460px){.np-tab svg{display:none}}',
      /* ---- 外观主题：只换一组强调色变量，其余样式全部跟着走 ---- */
      '.np-theme-ocean{--np-accent:#0a84ff;--np-accent-hi:#37a3ff;--np-accent-deep:#0060df;--np-accent-lite:#7cc4ff;--np-accent-rgb:10,132,255;--np-accent-hi-rgb:55,163,255;--np-accent-lite-rgb:124,196,255}',
      '.np-theme-coral{--np-accent:#ff7a45;--np-accent-hi:#ff9a6b;--np-accent-deep:#e05a26;--np-accent-lite:#ffb894;--np-accent-rgb:255,122,69;--np-accent-hi-rgb:255,154,107;--np-accent-lite-rgb:255,184,148}',
      '.np-theme-sakura{--np-accent:#ff5f9e;--np-accent-hi:#ff86b8;--np-accent-deep:#e03f7e;--np-accent-lite:#ffb3d1;--np-accent-rgb:255,95,158;--np-accent-hi-rgb:255,134,184;--np-accent-lite-rgb:255,179,209}',
      '.np-theme-mint{--np-accent:#1fc39a;--np-accent-hi:#4ddbb7;--np-accent-deep:#0e9a78;--np-accent-lite:#8fedd4;--np-accent-rgb:31,195,154;--np-accent-hi-rgb:77,219,183;--np-accent-lite-rgb:143,237,212}',
      '.np-theme-slate{--np-accent:#7c8698;--np-accent-hi:#98a2b4;--np-accent-deep:#616b7d;--np-accent-lite:#b8c0cd;--np-accent-rgb:124,134,152;--np-accent-hi-rgb:152,162,180;--np-accent-lite-rgb:184,192,205}',
      '.np-theme-indigo{--np-accent:#5b66e0;--np-accent-hi:#7f88ea;--np-accent-deep:#4750c2;--np-accent-lite:#a5abf2;--np-accent-rgb:91,102,224;--np-accent-hi-rgb:127,136,234;--np-accent-lite-rgb:165,171,242}',
      '.np-theme-forest{--np-accent:#3f9070;--np-accent-hi:#5bab8b;--np-accent-deep:#2f7257;--np-accent-lite:#8ac9b0;--np-accent-rgb:63,144,112;--np-accent-hi-rgb:91,171,139;--np-accent-lite-rgb:138,201,176}',
      '.np-theme-amber{--np-accent:#d39a3f;--np-accent-hi:#e5b360;--np-accent-deep:#b07b28;--np-accent-lite:#efd29a;--np-accent-rgb:211,154,63;--np-accent-hi-rgb:229,179,96;--np-accent-lite-rgb:239,210,154}',
      '.np-theme-plum{--np-accent:#9d6a9e;--np-accent-hi:#b98aba;--np-accent-deep:#7f5180;--np-accent-lite:#d2b3d3;--np-accent-rgb:157,106,158;--np-accent-hi-rgb:185,138,186;--np-accent-lite-rgb:210,179,211}',
      '.np-theme-wine{--np-accent:#b04a5c;--np-accent-hi:#cb6d7d;--np-accent-deep:#8f384a;--np-accent-lite:#dda0aa;--np-accent-rgb:176,74,92;--np-accent-hi-rgb:203,109,125;--np-accent-lite-rgb:221,160,170}',
      /* ---- 小鲸鱼 ---- */
      '.np-whale{position:relative;flex:0 0 auto;display:flex;align-items:center;justify-content:center;pointer-events:none}',
      '.np-whale-img{display:block;filter:drop-shadow(0 5px 10px rgba(0,0,0,.36));user-select:none;-webkit-user-drag:none;pointer-events:none}',
      '.np-whale--bob{animation:np-whale-bob 3.6s ease-in-out infinite}',
      '@keyframes np-whale-bob{0%,100%{transform:translateY(0) rotate(-1.6deg)}50%{transform:translateY(-3px) rotate(1.6deg)}}',
      '.np-whale--sing .np-whale-img{animation-duration:1.9s}',
      /* ---- 气泡 ---- */
      /* 风格档位：极简 / 标准 / 水族馆 —— 一键决定"装饰和光"的浓度 */
      '.np-style-minimal .np-fish,.np-style-minimal .np-bubble{display:none}',
      '.np-style-minimal .np-bar-glow,.np-style-minimal .np-panel-glow{opacity:.08}',
      '.np-style-minimal .np-bar::after{opacity:.5}',
      '.np-style-standard .np-fish{display:none}',
      '.np-style-aquarium .np-bar-glow{opacity:.26}',
      '.np-style-aquarium .np-panel-glow{opacity:.24}',
      '.np-deco{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:-1}',
      '.np-bubble{position:absolute;bottom:-16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.95),rgba(255,255,255,.28) 58%,rgba(var(--np-accent-rgb),.16));box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 0 8px rgba(var(--np-accent-rgb),.18);animation:np-bubble-rise linear infinite}',
      '@keyframes np-bubble-rise{0%{transform:translateY(0) scale(.72);opacity:0}14%{opacity:.75}100%{transform:translateY(-250px) scale(1.14);opacity:0}}',
      /* ---- 小鱼 ---- */
      '.np-fish{position:absolute;left:-70px;opacity:.45;animation:np-fish-swim linear infinite}',
      '@keyframes np-fish-swim{0%{transform:translateX(0)}49%{transform:translateX(360px) scaleX(1)}50%{transform:translateX(360px) scaleX(-1)}99%{transform:translateX(0) scaleX(-1)}100%{transform:translateX(0)}}',
      '.np-hide-whale .np-whale{display:none}',
      '.np-hide-fish .np-fish{display:none}',
      '.np-hide-bubbles .np-bubble{display:none}',
      '.np-calm .np-whale--bob,.np-calm .np-fish,.np-calm .np-bubble{animation:none!important}',
      /* ---- 外观设置页 ---- */
      '.np-look{display:flex;flex-direction:column;gap:10px;padding:14px 16px 22px;overflow:auto}',
      '.np-look-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.07);border:1px solid var(--np-line-soft)}',
      '.np-look-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.np-look-label b{font-size:13px;font-weight:600}',
      '.np-look-label span{font-size:11.5px;line-height:1.35;color:var(--np-muted)}',
      '.np-swatches{display:flex;gap:8px;flex:0 0 auto}',
      '.np-swatch{width:26px;height:26px;padding:0;border:0;border-radius:9px;cursor:pointer;position:relative;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28),0 2px 6px rgba(0,0,0,.22);transition:transform .14s var(--np-ease),box-shadow .16s var(--np-ease)}',
      '.np-swatch:hover{transform:translateY(-1px) scale(1.07)}',
      '.np-swatch--on{box-shadow:0 0 0 2px var(--np-bg),0 0 0 4px currentColor,0 3px 10px rgba(0,0,0,.28)}',
      '.np-switch{position:relative;flex:0 0 auto;width:42px;height:24px;padding:0;border:0;border-radius:999px;background:rgba(127,127,127,.3);cursor:pointer;transition:background .18s var(--np-ease)}',
      '.np-switch::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.32);transition:transform .2s var(--np-out)}',
      '.np-switch--on{background:var(--np-red)}',
      '.np-switch--on::after{transform:translateX(18px)}',
      '.np-seg{display:flex;flex:0 0 auto;padding:2px;border-radius:9px;background:rgba(127,127,127,.15)}',
      '.np-seg button{appearance:none;border:0;background:none;color:var(--np-muted);font-size:11.5px;padding:5px 10px;border-radius:7px;cursor:pointer;transition:background .16s var(--np-ease),color .16s var(--np-ease)}',
      '.np-seg button.np-seg--on{background:var(--np-red-soft);color:var(--np-red)}',
      '.np-look-reset{align-self:flex-start;appearance:none;border:1px solid var(--np-line);background:none;color:var(--np-muted);font-size:12px;padding:7px 13px;border-radius:10px;cursor:pointer;transition:color .16s var(--np-ease),border-color .16s var(--np-ease)}',
      '.np-look-reset:hover{color:var(--np-fg);border-color:var(--np-red)}',
      /* 外观页：预览卡 + 主题色卡 + 滑杆 */
      '.np-look-hero{position:relative;height:96px;flex:0 0 auto;border-radius:16px;overflow:hidden;display:flex;align-items:center;gap:14px;padding:0 16px;isolation:isolate;border:1px solid var(--np-line-soft);background:linear-gradient(135deg,rgba(var(--np-accent-rgb),.34),rgba(var(--np-accent-rgb),.08) 56%,rgba(127,127,127,.10))}',
      '.np-look-hero .np-deco{z-index:0}',
      '.np-look-hero-whale{flex:0 0 auto;z-index:1}',
      '.np-look-hero-text{display:flex;flex-direction:column;gap:3px;min-width:0;z-index:1}',
      '.np-look-hero-text b{font-size:15px;letter-spacing:.02em}',
      '.np-look-hero-text span{font-size:11.5px;line-height:1.4;color:var(--np-muted)}',
      '.np-look-group-title{font-size:10.5px;letter-spacing:.08em;color:var(--np-faint);padding:8px 2px 0}',
      '.np-theme-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(86px,1fr));gap:8px}',
      '.np-look-hint{font-size:11px;line-height:1.4;color:var(--np-faint);padding:0 2px}',
      '.np-theme-card{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:9px 10px;border-radius:8px;border:1px solid var(--np-line-soft);background:rgba(127,127,127,.06);cursor:pointer;transition:border-color .16s var(--np-ease),background .16s var(--np-ease)}',
      '.np-theme-card:hover{background:rgba(127,127,127,.11)}',
      '.np-theme-card--on{border-color:var(--np-red);background:var(--np-red-soft)}',
      '.np-theme-dot{width:14px;height:14px;border-radius:4px}',
      '.np-theme-name{font-size:11.5px;color:var(--np-fg);white-space:nowrap}',
      '.np-theme-tick{position:absolute;top:8px;right:9px;font-size:11px;line-height:1;color:var(--np-red)}',
      '.np-look-ico{flex:0 0 auto;display:flex;align-items:center;color:var(--np-muted);opacity:.9}',
      '.np-look-row--col{flex-direction:column;align-items:stretch;gap:9px}',
      '.np-range{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:999px;background:linear-gradient(90deg,var(--np-red),var(--np-red-lite));outline:0;cursor:pointer}',
      '.np-range::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35),0 0 0 3px rgba(var(--np-accent-rgb),.28);cursor:pointer}',
      '.np-range::-moz-range-thumb{width:15px;height:15px;border:0;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35)}',
      '@media (prefers-reduced-motion:reduce){.np-panel{animation:none}.np-eq i,.np-hero-eq i,.np-row-eq i,.np-skeleton::after,.np-play-btn--on::after,.np-bar-bg::before,.np-bar--playing .np-bar-bg::after,.np-bar-glow,.np-panel-glow{animation:none}.np-bar--playing .np-now-glow{animation:none;opacity:.3}.np-progress-fill{transition:none}}',
      '@supports not (color:var(--dsw-alias-label-primary)){.np-root{--np-fg:#1b1b1f;--np-muted:#6b6b73;--np-faint:#9a9aa2;--np-bg:#fff;--np-bar:#f6f6f8;--np-line:rgba(0,0,0,.12);--np-line-soft:rgba(0,0,0,.07)}}',

      /* ======================================================================
         0.3.0 版式：D 隐形底栏（46px）+ F 双栏面板
         这一层放在最后，用 --np-* / --dsw-alias-* 令牌，所以深浅主题都跟着走。
         底栏不再是"播放器"，是一条状态行；面板不再是展示柜，是工具箱。
         ====================================================================== */

      /* ---- 底栏 ---- */
      '.np-bar{height:var(--np-bar-h);min-height:0;padding:0 12px;gap:0;border-top:1px solid var(--np-line);box-shadow:none;overflow:visible;background:var(--np-bar)}',
      '@supports (background:color-mix(in srgb,#000 50%,transparent)){.np-bar{background:color-mix(in srgb,var(--np-bar) 76%,transparent)}}',
      '@supports (backdrop-filter:blur(1px)){.np-bar{backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4)}}',
      '.np-bar::after,.np-bar::before{display:none}',
      '.np-bar-bg,.np-bar-glow,.np-whale{display:none}',
      '.np-left{flex:0 0 auto;gap:0;min-width:0}',
      '.np-now{max-width:none;flex:0 0 auto;padding:3px 6px;border-radius:7px;gap:8px}',
      '.np-now:hover{background:rgba(127,127,127,.10)}',
      '.np-now-glow,.np-eq{display:none}',
      '.np-bar .np-cover{width:22px;height:22px;border-radius:5px;box-shadow:inset 0 0 0 1px var(--np-line)}',
      '.np-bar--playing .np-cover{box-shadow:inset 0 0 0 1px var(--np-line)}',
      '.np-now-text{flex-direction:row;align-items:baseline;gap:7px;min-width:0}',
      '.np-now-title{font-size:12.5px;font-weight:560;letter-spacing:.01em}',
      '.np-now-sub{font-size:11.5px;color:var(--np-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.np-now-sub::before{content:"— ";opacity:.7}',
      /* 歌词 = 一条不出声的行情线 */
      '.np-bar-lyric{display:flex;flex:1 1 auto;min-width:0;height:auto;padding:0 26px 0 30px}',
      '.np-bar-lyric-mark{display:none}',
      '.np-bar-lyric-body{width:100%;gap:0}',
      '.np-bar-lyric-cur{font-size:11px;letter-spacing:.04em;color:var(--np-faint);font-weight:450;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 88%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 88%,transparent)}',
      '.np-bar-lyric--on .np-bar-lyric-cur{color:var(--np-muted);font-weight:480}',
      '.np-bar-lyric-next{display:none}',
      '.np-bar-lyric:hover{background:none}',
      /* 控制键：平时几乎隐形 */
      '.np-controls{margin-left:auto;flex:0 0 auto;gap:2px;background:none;box-shadow:none;padding:0}',
      '.np-bar--playing .np-controls,.np-controls{box-shadow:none;background:none}',
      '.np-controls .np-icon-btn{width:26px;height:26px;border-radius:6px;background:none;box-shadow:none;color:var(--np-fg);opacity:.6;transition:opacity .16s var(--np-ease),background .16s var(--np-ease)}',
      '.np-bar:hover .np-controls .np-icon-btn{opacity:.85}',
      '.np-controls .np-icon-btn:hover{opacity:1;background:rgba(127,127,127,.14);box-shadow:none}',
      '.np-play-btn{width:26px;height:26px;border-radius:6px;background:none;color:var(--np-fg);box-shadow:none;opacity:.92}',
      '.np-play-btn::before,.np-play-btn::after,.np-play-btn--on::before,.np-play-btn--on::after{display:none}',
      '.np-play-btn:hover{transform:none;background:rgba(127,127,127,.16);box-shadow:none;filter:none}',
      '.np-play-btn:active{transform:scale(.94)}',
      /* 右侧：细时间轴 + 展开 */
      '.np-right{gap:8px;padding-left:10px;margin-left:10px;border-left:1px solid var(--np-line);flex:0 0 auto}',
      '.np-timeline{width:150px;max-width:none;min-width:0;gap:6px;flex:0 0 auto}',
      '.np-time{font:500 9.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;color:var(--np-faint);min-width:24px}',
      '.np-progress{height:16px}',
      '.np-progress-track{height:2px;background:rgba(127,127,127,.26)}',
      '.np-progress:hover .np-progress-track,.np-progress[data-drag="true"] .np-progress-track{height:4px;background:rgba(127,127,127,.38)}',
      '.np-progress-fill{background:var(--np-fg);opacity:.85;box-shadow:none}',
      '.np-progress-knob{display:none}',
      '.np-volume{display:none}',
      '.np-right .np-icon-btn{width:24px;height:24px;border-radius:6px;background:none;box-shadow:none;color:var(--np-fg);opacity:.6}',
      '.np-right .np-icon-btn:hover{opacity:1;background:rgba(127,127,127,.14);box-shadow:none}',
      '.np-icon-btn--on{color:var(--np-accent);opacity:1;background:none;box-shadow:none}',
      '.np-bar-line{height:1px;background:rgba(127,127,127,.22)}',
      '.np-bar-line i{background:var(--np-fg);opacity:.55;box-shadow:none;transition:width .25s linear}',
      '@media (max-width:820px){.np-timeline{display:none}}',

      /* ---- 面板：双栏工具箱 ---- */
      '.np-panel{right:14px;bottom:calc(var(--np-bar-h) + 10px);width:540px;max-width:calc(100vw - 28px);height:min(560px,calc(100vh - var(--np-bar-h) - 46px));border-radius:12px;border:1px solid var(--np-line);background:var(--np-bg);box-shadow:0 18px 46px rgba(0,0,0,.34),0 2px 8px rgba(0,0,0,.14);font-size:12.5px}',
      '@supports (background:color-mix(in srgb,#000 50%,transparent)){.np-panel{background:color-mix(in srgb,var(--np-bg) 96%,transparent)}}',
      '@supports (backdrop-filter:blur(1px)){.np-panel{backdrop-filter:blur(30px) saturate(1.35);-webkit-backdrop-filter:blur(30px) saturate(1.35)}}',
      '.np-panel::after{box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}',
      '.np-panel-glow{display:none}',
      '.np-panel-head,.np-hero,.np-panel-body{display:none}',

      /* 面板头 */
      '.np-nat-head{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--np-line-soft);flex:0 0 auto}',
      '.np-nat-head .np-cover{width:34px;height:34px;border-radius:8px;flex:0 0 auto}',
      '.np-nat-id{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:1px}',
      '.np-nat-title{font-size:13px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.np-nat-sub{font-size:11px;color:var(--np-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.np-nat-head .np-icon-btn{width:26px;height:26px;border-radius:7px;flex:0 0 auto}',

      /* 页签：一行六格，下划线 */
      '.np-tabs{margin:0;padding:0 14px;gap:4px;border-bottom:1px solid var(--np-line-soft);border-radius:0;background:none;box-shadow:none;flex:0 0 auto}',
      '.np-tab{flex:1;min-width:0;padding:9px 0 10px;border-radius:0;background:none;font-size:11.5px;color:var(--np-faint);border-bottom:2px solid transparent;margin-bottom:-1px;gap:4px}',
      '.np-tab svg{display:none}',
      '.np-tab:hover{background:none;color:var(--np-muted)}',
      '.np-tab:active{transform:none}',
      '.np-tab--on,.np-tab--on:hover{background:none;color:var(--np-fg);font-weight:600;box-shadow:none;border-bottom-color:var(--np-accent)}',

      /* 双栏 */
      '.np-nat-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,44%) 1px minmax(0,56%)}',
      '.np-nat-body--single{grid-template-columns:minmax(0,1fr)}',
      '.np-nat-div{background:var(--np-line-soft)}',
      '.np-nat-col{min-width:0;min-height:0;display:flex;flex-direction:column}',
      '.np-nat-colhead{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 4px;font-size:9.5px;letter-spacing:.08em;color:var(--np-faint);flex:0 0 auto}',
      '.np-nat-lyric{position:relative;flex:1;min-height:0;overflow:auto;padding:2px 10px 16px;scroll-behavior:smooth}',
      '.np-nat-lyric .np-lyric-line{padding:5px 8px;border-radius:7px;font-size:12.5px;line-height:1.5;color:var(--np-muted)}',
      '.np-nat-lyric .np-lyric-line--on{color:var(--np-accent);font-weight:600;background:rgba(var(--np-accent-rgb),.12);font-size:12.5px}',
      '.np-nat-lyric-empty{padding:16px 10px;font-size:11.5px;color:var(--np-faint);line-height:1.6}',
      '.np-nat-col--main .np-list,.np-nat-col--main .np-playlist{padding:2px 8px 10px}',
      '.np-nat-col--main .np-subhead{margin:0 4px 4px}',
      '.np-nat-col--main .np-row{padding:7px 8px;border-radius:8px;gap:9px}',
      '.np-nat-col--main .np-row+.np-row{margin-top:1px}',
      '.np-nat-col--main .np-row-art,.np-nat-col--main .np-row-art .np-cover{width:32px;height:32px;border-radius:6px}',
      '.np-nat-col--main .np-row-title{font-size:12.5px}',
      '.np-nat-col--main .np-row-sub{font-size:10.5px}',
      '.np-nat-col--main .np-row-time{font:500 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding-left:2px}',
      '.np-nat-col--main .np-row--current::before{top:10px;bottom:10px}',
      '.np-panel--lyric .np-lyric{padding:8px 14px 20px}',

      /* 底部搜索 */
      '.np-nat-foot{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--np-line-soft);flex:0 0 auto}',
      '.np-nat-foot .np-search{flex:1;min-width:0;padding:6px 10px;border-radius:9px;background:rgba(127,127,127,.10);border:1px solid var(--np-line-soft)}',
      '.np-nat-foot .np-search-input{font-size:12px}',
      '.np-nat-foot .np-text-btn{font-size:11.5px}',
      '.np-notice{margin:8px 14px 0;font-size:11.5px}',

      /* 窄屏：收单栏（歌词走「歌词」页签） */
      '@media (max-width:760px){.np-nat-body{grid-template-columns:minmax(0,1fr)}.np-nat-col--lyric,.np-nat-div{display:none}.np-panel{width:calc(100vw - 20px)}}',

      /* ======================================================================
         0.3.1 打磨：点击目标放大 + 双栏适配 + 音量落脚点
         ====================================================================== */

      /* ---- 底栏：48px，按钮做成 32px 的可点方块（图标本身不变大）---- */
      '.np-bar{height:var(--np-bar-h);padding:0 14px}',
      '.np-left{flex:0 1 auto;max-width:46%}',
      '.np-now{flex:1 1 auto;min-width:0;padding:5px 8px;border-radius:8px;cursor:pointer}',
      '.np-controls .np-icon-btn{width:32px;height:32px;border-radius:8px}',
      '.np-play-btn{width:32px;height:32px;border-radius:8px}',
      '.np-controls{gap:4px}',
      '.np-right .np-icon-btn{width:30px;height:30px;border-radius:8px}',
      '.np-timeline{width:158px;gap:7px}',
      /* 进度：可点区域 22px，悬停才冒出一个小滑钮（告诉你可以抓） */
      '.np-progress{height:22px}',
      '.np-progress-knob{display:block;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:var(--np-fg);box-shadow:0 1px 4px rgba(0,0,0,.5);opacity:0;transition:opacity .12s var(--np-ease)}',
      '.np-progress:hover .np-progress-knob,.np-progress[data-drag="true"] .np-progress-knob{opacity:1;transform:none}',

      /* ---- 面板：600px，双栏 40/60，设置页走单栏 ---- */
      '.np-panel{width:600px;max-width:calc(100vw - 28px);bottom:calc(var(--np-bar-h) + 10px);height:min(600px,calc(100vh - var(--np-bar-h) - 46px))}',
      '.np-nat-body{grid-template-columns:minmax(0,40%) 1px minmax(0,60%)}',
      '.np-nat-body--single{grid-template-columns:minmax(0,1fr)}',
      '.np-nat-head{padding:12px 14px;gap:12px}',
      '.np-nat-head .np-cover{width:36px;height:36px;border-radius:9px}',
      '.np-nat-title{font-size:13.5px}',
      /* 音量：常驻在面板头（底栏那个滑杆收起来了，这里补位） */
      '.np-nat-vol{display:flex;align-items:center;gap:6px;flex:0 0 auto;color:var(--np-muted)}',
      '.np-nat-vol-range{-webkit-appearance:none;appearance:none;width:66px;height:20px;background:transparent;cursor:pointer;accent-color:var(--np-accent)}',
      '.np-nat-vol-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:rgba(127,127,127,.32)}',
      '.np-nat-vol-range::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-3.5px;border-radius:50%;background:var(--np-fg);box-shadow:0 1px 3px rgba(0,0,0,.4)}',
      '.np-nat-vol-range::-moz-range-track{height:4px;border-radius:999px;background:rgba(127,127,127,.32)}',
      '.np-nat-vol-range::-moz-range-thumb{width:11px;height:11px;border:0;border-radius:50%;background:var(--np-fg)}',
      '.np-nat-close{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:none;color:var(--np-muted);cursor:pointer;flex:0 0 auto;transition:background .15s var(--np-ease),color .15s var(--np-ease)}',
      '.np-nat-close:hover{background:rgba(127,127,127,.14);color:var(--np-fg)}',
      /* 页签：目标高度 38px，字号提一档 */
      '.np-tab{padding:10px 0 11px;font-size:12px}',
      /* 左栏：底部渐隐 + 「全屏」按钮 */
      '.np-nat-colhead{padding:11px 14px 4px}',
      '.np-nat-full{border:0;background:none;color:var(--np-faint);font:inherit;font-size:9.5px;letter-spacing:.1em;cursor:pointer;padding:3px 7px;border-radius:6px;transition:background .15s var(--np-ease),color .15s var(--np-ease)}',
      '.np-nat-full:hover{color:var(--np-fg);background:rgba(127,127,127,.14)}',
      '.np-nat-lyric{padding:2px 10px 20px;-webkit-mask-image:linear-gradient(180deg,#000 0,#000 calc(100% - 22px),transparent 100%);mask-image:linear-gradient(180deg,#000 0,#000 calc(100% - 22px),transparent 100%)}',
      '.np-nat-lyric .np-lyric-line{padding:6px 9px;border-radius:8px;font-size:12.5px;line-height:1.55}',
      /* 右栏：行 48px、封面 34、操作键 28px */
      '.np-nat-col--main .np-row{padding:8px 9px;gap:10px;min-height:48px}',
      '.np-nat-col--main .np-row-art,.np-nat-col--main .np-row-art .np-cover{width:34px;height:34px;border-radius:7px}',
      '.np-nat-col--main .np-row .np-icon-btn{width:28px;height:28px;border-radius:7px;flex:0 0 auto}',
      '.np-nat-col--main .np-row-title{font-size:12.5px}',
      '.np-nat-col--main .np-row-time{min-width:30px;text-align:right}',
      /* 底栏搜索：更大的按钮 */
      '.np-nat-foot{padding:10px 14px}',
      '.np-nat-foot .np-text-btn{font-size:12.5px;padding:6px 12px}',
      '.np-nat-foot .np-src-btn{padding:6px 9px;font-size:11.5px}',
      '.np-nat-foot .np-search{padding:7px 11px}',
      /* 外观 / 账号（单栏）里的内容留点呼吸 */
      '.np-nat-body--single .np-look,.np-nat-body--single .np-account{padding:12px 16px 20px}',

      /* ======================================================================
         0.3.2：外观页重做 —— 每个开关都真的作用在界面上
         ====================================================================== */

      /* 预览条：直接摆一条真底栏（不可点），改开关立刻能看到 */
      '.np-look{padding:12px 16px 24px;gap:9px}',
      '.np-look-preview{position:relative;flex:0 0 auto;border-radius:12px;overflow:hidden;border:1px solid var(--np-line-soft);pointer-events:none;background:var(--np-bar)}',
      '.np-look-preview .np-bar{height:var(--np-bar-h);min-height:0;padding:0 10px;border-top:0}',
      '.np-look-preview .np-bar::before,.np-look-preview .np-bar::after{display:none}',
      /* 预览条比真底栏窄一半：左侧信息 + 歌词 + 进度，时间数字先省掉 */
      '.np-look-preview .np-right{display:flex;flex:1 1 auto;min-width:0;justify-content:flex-end;gap:6px;padding-left:6px;margin-left:4px;border-left:0}',
      '.np-look-preview .np-time{display:none}',
      '.np-look-preview .np-timeline{flex:1 1 auto;width:auto;min-width:70px;max-width:none}',
      '.np-look-preview .np-left{max-width:none}',
      '.np-look-preview .np-now{padding:3px 6px}',
      '.np-look-preview .np-now-title{max-width:126px}',
      '.np-look-preview .np-bar-lyric{flex:0 1 28%;max-width:28%;padding:0 6px}',
      '.np-look-preview .np-bar-lyric-cur{font-size:10.5px}',
      '.np-look-preview .np-controls{gap:0}',
      '.np-look-preview .np-controls .np-icon-btn,.np-look-preview .np-play-btn{width:24px;height:24px}',
      '.np-look-note{font-size:10.5px;letter-spacing:.08em;color:var(--np-faint);padding:0 2px}',
      '.np-look-row{padding:11px 13px;border-radius:12px}',
      '.np-look-label b{font-size:12.5px}',
      '.np-look-label span{font-size:11px;color:var(--np-muted);line-height:1.4}',
      '.np-look-group-title{padding:10px 2px 0}',

      /* 布局：单栏 */
      '.np-split-one .np-nat-body{grid-template-columns:minmax(0,1fr)}',
      '.np-split-one .np-nat-col--lyric,.np-split-one .np-nat-div{display:none}',
      /* 宽度 */
      '.np-panel-wide .np-panel{width:680px;max-width:calc(100vw - 28px)}',
      /* 密度：紧凑 */
      '.np-dense .np-nat-head{padding:9px 14px}',
      '.np-dense .np-tab{padding:8px 0 9px;font-size:11.5px}',
      '.np-dense .np-nat-colhead{padding:8px 14px 2px}',
      '.np-dense .np-nat-col--main .np-row{min-height:42px;padding:5px 8px}',
      '.np-dense .np-nat-col--main .np-row-art,.np-dense .np-nat-col--main .np-row-art .np-cover{width:30px;height:30px}',
      '.np-dense .np-nat-col--main .np-row-title{font-size:12px}',
      '.np-dense .np-nat-col--main .np-row-sub{font-size:10px}',
      '.np-dense .np-nat-lyric .np-lyric-line{font-size:12px;padding:4px 8px}',
      '.np-dense .np-look-row{padding:9px 12px}',
      '.np-dense .np-nat-foot{padding:8px 14px}',
      /* 底栏两个开关 */
      '.np-hide-bar-lyric .np-bar-lyric{display:none}',
      '.np-hide-bar-line .np-bar-line{display:none}',
      /* 毛玻璃关掉：不透明底板 */
      '.np-solid .np-bar{background:var(--np-bar);-webkit-backdrop-filter:none;backdrop-filter:none}',
      '.np-solid .np-panel{background:var(--np-bg);-webkit-backdrop-filter:none;backdrop-filter:none}',
      /* 动效收敛 */
      '.np-calm *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}',
      '.np-calm .np-nat-lyric{scroll-behavior:auto}',

      /* ======================================================================
         0.3.3：光晕回来（可调强弱，收进外观菜单）+ 底栏中段填实
         ====================================================================== */

      /* ---- 光晕：浓度(np-glow-*) × 色调(np-tone-*)，默认中性冷白 ---- */
      '.np-tone-neutral{--glg1:186,205,232;--glg2:255,255,255;--glg3:146,170,206}',
      '.np-tone-theme{--glg1:var(--np-accent-rgb);--glg2:var(--np-accent-hi-rgb);--glg3:var(--np-accent-rgb)}',
      '.np-tone-aurora{--glg1:88,208,192;--glg2:124,107,255;--glg3:78,172,255}',
      '.np-tone-sunset{--glg1:246,178,112;--glg2:220,110,140;--glg3:255,148,98}',
      '.np-tone-ice{--glg1:118,172,255;--glg2:198,222,255;--glg3:104,144,214}',
      '.np-tone-dawn{--glg1:255,206,180;--glg2:255,236,224;--glg3:232,160,140}',
      '.np-tone-moss{--glg1:150,196,122;--glg2:196,224,150;--glg3:92,150,102}',
      '.np-tone-dusk{--glg1:168,140,232;--glg2:214,188,255;--glg3:124,96,196}',
      '.np-tone-ember{--glg1:232,96,60;--glg2:255,160,96;--glg3:170,48,44}',
      '.np-tone-sea{--glg1:79,188,200;--glg2:110,210,190;--glg3:60,130,190}',
      '.np-tone-sand{--glg1:224,196,138;--glg2:255,236,200;--glg3:200,160,100}',
      '.np-tone-prism{--glg1:95,214,255;--glg2:255,107,214;--glg3:255,209,102}',
      '.np-glow-light{--glg-k:.42}',
      '.np-glow-mid{--glg-k:.68}',
      '.np-glow-heavy{--glg-k:1}',
      /* 底栏的三团光：直接画在底栏背景层上（压在背景之下会被半透明底吃掉，等于看不见） */
      '.np-glow-light .np-bar,.np-glow-mid .np-bar,.np-glow-heavy .np-bar{background-image:linear-gradient(180deg,rgba(var(--glg2),calc(.09 * var(--glg-k))),transparent 58%),radial-gradient(66% 180% at 6% 50%,rgba(var(--glg1),calc(.26 * var(--glg-k))),transparent 66%),radial-gradient(52% 150% at 44% 12%,rgba(var(--glg2),calc(.14 * var(--glg-k))),transparent 70%),radial-gradient(62% 170% at 92% 78%,rgba(var(--glg3),calc(.18 * var(--glg-k))),transparent 72%);background-repeat:no-repeat;transition:background-image .4s var(--np-ease)}',
      /* 栏顶往上散的环境光：三团色慢速漂移 + 一道扫光，随浓度增减 */
      '.np-glow-light .np-bar-glow,.np-glow-mid .np-bar-glow,.np-glow-heavy .np-bar-glow{display:block;bottom:var(--np-bar-h);height:240px;overflow:hidden;background:radial-gradient(38% 120% at 18% 78%,rgba(var(--glg1),.62),transparent 70%),radial-gradient(34% 115% at 52% 92%,rgba(var(--glg2),.5),transparent 72%),radial-gradient(40% 120% at 86% 74%,rgba(var(--glg3),.58),transparent 70%);background-size:160% 100%;background-repeat:no-repeat;opacity:calc(.16 + .3 * var(--glg-k));animation:np-glow-flow 16s ease-in-out infinite alternate}',
      '.np-glow-light .np-bar-glow::after,.np-glow-mid .np-bar-glow::after,.np-glow-heavy .np-bar-glow::after{content:"";position:absolute;top:0;bottom:0;left:-45%;width:55%;background:linear-gradient(90deg,transparent,rgba(var(--glg2),.5),rgba(var(--glg3),.42),transparent);mix-blend-mode:screen;opacity:calc(.25 + .3 * var(--glg-k));animation:np-glow-sheen 9s ease-in-out infinite}',
      '@keyframes np-glow-flow{from{background-position:0% 50%}to{background-position:100% 50%}}',
      '@keyframes np-glow-sheen{0%{transform:translateX(0)}100%{transform:translateX(300%)}}',
      /* 面板背后那圈：径向 + 圆锥叠加，慢慢呼吸/漂移 */
      '.np-glow-light .np-panel-glow,.np-glow-mid .np-panel-glow,.np-glow-heavy .np-panel-glow{display:block;right:-8px;bottom:calc(var(--np-bar-h) + 2px);width:632px;max-width:calc(100vw - 8px);height:min(632px,calc(100vh - var(--np-bar-h) - 34px));background:radial-gradient(118% 92% at 66% 6%,rgba(var(--glg2),calc(.42 * var(--glg-k))),rgba(var(--glg1),calc(.2 * var(--glg-k))) 46%,transparent 74%),conic-gradient(from 210deg at 60% 12%,rgba(var(--glg1),calc(.18 * var(--glg-k))),rgba(var(--glg3),calc(.22 * var(--glg-k))),rgba(var(--glg2),calc(.2 * var(--glg-k))),rgba(var(--glg1),calc(.18 * var(--glg-k))));filter:blur(56px) saturate(1.25);opacity:.72;animation:np-panel-flow 20s ease-in-out infinite alternate}',
      '@keyframes np-panel-flow{from{transform:translate3d(-1%,1%,0) scale(1)}to{transform:translate3d(1%,-1%,0) scale(1.05)}}',
      '.np-panel-wide.np-glow-light .np-panel-glow,.np-panel-wide.np-glow-mid .np-panel-glow,.np-panel-wide.np-glow-heavy .np-panel-glow{width:712px}',
      /* 播放键外圈光：会转的彩色光环 */
      '.np-glow-light .np-play-btn::before,.np-glow-mid .np-play-btn::before,.np-glow-heavy .np-play-btn::before{display:block;inset:-8px;border-radius:50%;filter:blur(7px);opacity:calc(.55 + .25 * var(--glg-k));background:conic-gradient(from 0deg,rgba(var(--glg1),.8),rgba(var(--glg2),.55),rgba(var(--glg3),.8),rgba(var(--glg1),.8));animation:np-play-spin 8s linear infinite}',
      '@keyframes np-play-spin{to{transform:rotate(360deg)}}',
      /* 封面渗色：轻微呼吸，不是死光 */
      '.np-glow-light .np-now-glow,.np-glow-mid .np-now-glow,.np-glow-heavy .np-now-glow{display:block;opacity:calc(.06 + .16 * var(--glg-k));animation:np-now-hue 14s ease-in-out infinite alternate}',
      '@keyframes np-now-hue{from{filter:blur(30px) saturate(1.6) hue-rotate(-14deg)}to{filter:blur(30px) saturate(2.1) hue-rotate(20deg)}}',
      /* 开光晕时去掉右侧那道 1px 竖分割线（窄屏会把时间轴收起，它就贴在最右边） */
      '.np-glow-light .np-bar .np-right,.np-glow-mid .np-bar .np-right,.np-glow-heavy .np-bar .np-right{border-left-color:transparent}',
      /* 外观页的光晕色板 */
      '.np-glow-swatches{display:flex;flex-wrap:wrap;gap:8px;flex:0 0 auto;align-items:center;justify-content:flex-end;max-width:176px}',
      '.np-glow-swatch{width:20px;height:20px;padding:0;border:0;border-radius:50%;cursor:pointer;position:relative;box-shadow:inset 0 0 0 1px rgba(255,255,255,.3),0 2px 6px rgba(0,0,0,.35);transition:transform .14s var(--np-ease),box-shadow .16s var(--np-ease)}',
      '.np-glow-swatch:hover{transform:scale(1.1)}',
      '.np-glow-swatch--on{box-shadow:0 0 0 2px var(--np-bg),0 0 0 4px var(--np-fg),0 2px 8px rgba(0,0,0,.45)}',
      /* ---- 底栏中段：歌词居中 + 进度条拉长，别让中间空一大块 ---- */
      '.np-bar .np-now{gap:9px}',
      '.np-bar .np-cover{width:24px;height:24px;border-radius:6px}',
      '.np-bar .np-now-title{font-size:14px}',
      '.np-bar .np-bar-lyric{flex:0 1 34%;max-width:34%;min-width:0;padding:0 18px;justify-content:center}',
      '.np-bar .np-bar-lyric-body{width:100%;align-items:center}',
      '.np-bar .np-bar-lyric-cur{font-size:12.5px;text-align:center;width:100%;color:var(--np-muted);-webkit-mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)}',
      '.np-bar .np-bar-lyric--on .np-bar-lyric-cur{color:var(--np-fg);opacity:.75;font-weight:500}',
      '.np-bar .np-right{flex:1 1 auto;min-width:0;justify-content:flex-end}',
      '.np-bar .np-timeline{flex:1 1 auto;width:auto;min-width:180px;max-width:none}',

      /* 外观页预览条只有一半宽，按比例收紧（放最后，压过上面那套底栏排布） */
      '.np-look-preview .np-bar .np-left{max-width:none}',
      '.np-look-preview .np-bar .np-now{padding:3px 6px;gap:7px}',
      '.np-look-preview .np-bar .np-cover{width:20px;height:20px}',
      '.np-look-preview .np-bar .np-now-title{font-size:11.5px;max-width:118px}',
      '.np-look-preview .np-bar .np-now-sub{font-size:10px}',
      '.np-look-preview .np-bar .np-bar-lyric{flex:0 1 26%;max-width:26%;padding:0 6px}',
      '.np-look-preview .np-bar .np-bar-lyric-cur{font-size:10.5px}',
      '.np-look-preview .np-bar .np-controls .np-icon-btn,.np-look-preview .np-bar .np-play-btn{width:24px;height:24px}',
      '.np-look-preview .np-bar .np-right{gap:5px;padding-left:6px;margin-left:4px;border-left:0}',
      '.np-look-preview .np-bar .np-time{display:none}',
      '.np-look-preview .np-bar .np-timeline{flex:1 1 auto;min-width:60px;max-width:none;gap:0}',

      /* ======================================================================
         0.3.5 底栏重排：三个块（信息+歌词 / 运输键 / 进度+操作）+ 均匀间距
         之前是 flex + 四处 auto/flex 抢空间，间距变成 170/220/100/30，进度条被拉到 560px，
         视觉重心全歪。现在交给 space-between 均分间距，运输键自然落在中间。
         ====================================================================== */
      '.np-bar{height:var(--np-bar-h);padding:0 18px;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;column-gap:20px}',
      '.np-bar .np-left{display:flex;align-items:center;justify-self:stretch;min-width:0;max-width:none;gap:16px}',
      '.np-bar .np-now{flex:0 1 auto;max-width:286px;padding:4px 8px;gap:10px}',
      '.np-bar .np-cover{width:32px;height:32px;border-radius:8px}',
      '.np-bar .np-now-title{font-size:14px}',
      '.np-bar .np-now-sub{font-size:11.5px}',
      /* 歌词贴着歌名右边，左对齐 + 省略号，不再是一块居中的空场 */
      '.np-bar .np-bar-lyric{flex:1 1 auto;min-width:0;max-width:none;padding:0;justify-content:center}',
      '.np-bar .np-bar-lyric-body{width:auto;align-items:flex-start;min-width:0}',
      '.np-bar .np-bar-lyric-cur{font-size:12.5px;text-align:center;width:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;-webkit-mask-image:none;mask-image:none;color:var(--np-muted)}',
      '.np-bar .np-bar-lyric--on .np-bar-lyric-cur{color:var(--np-fg);opacity:.62;font-weight:450}',
      '.np-bar .np-controls{justify-self:center;flex:0 0 auto;margin-left:0}',
      '.np-bar .np-right{display:flex;align-items:center;justify-self:stretch;min-width:0;justify-content:flex-end;gap:8px;padding-left:0;margin-left:0;border-left:0}',
      '.np-bar .np-timeline{flex:1 1 auto;width:auto;min-width:170px;max-width:400px;gap:9px}',
      /* 底栏高 52，面板/光晕跟着下移 */
      '.np-panel{bottom:calc(var(--np-bar-h) + 10px);height:min(600px,calc(100vh - var(--np-bar-h) - 46px))}',
      '.np-glow-light .np-panel-glow,.np-glow-mid .np-panel-glow,.np-glow-heavy .np-panel-glow{bottom:calc(var(--np-bar-h) + 2px)}',
      '.np-glow-light .np-bar-glow,.np-glow-mid .np-bar-glow,.np-glow-heavy .np-bar-glow{bottom:var(--np-bar-h)}',
      /* 外观页预览条：同样三块，但宽度只有一半 */
      '.np-look-preview .np-bar{height:var(--np-bar-h);padding:0 12px;gap:10px}',
      '.np-look-preview .np-bar .np-left{gap:10px}',
      '.np-look-preview .np-bar .np-now{max-width:150px}',
      '.np-look-preview .np-bar .np-bar-lyric{max-width:120px}',
      '.np-look-preview .np-bar .np-now-sub{display:none}',
      '.np-bar .np-controls .np-icon-btn{width:32px;height:32px;border-radius:10px;opacity:.6}',
      '.np-bar:hover .np-controls .np-icon-btn{opacity:.8}',
      '.np-bar .np-controls .np-icon-btn:hover{opacity:1;background:rgba(127,127,127,.14)}',
      '.np-bar .np-play-btn{width:38px;height:38px;background:rgba(127,127,127,.18);border-radius:12px;opacity:1}',
      '.np-bar .np-play-btn:hover{background:rgba(127,127,127,.26);transform:none}',
      '.np-bar .np-play-btn:active{transform:scale(.95)}',
      '.np-glow-light .np-bar .np-play-btn::before,.np-glow-mid .np-bar .np-play-btn::before,.np-glow-heavy .np-bar .np-play-btn::before{border-radius:14px;inset:-10px}',
      '.np-bar .np-time{font-size:10.5px}',      /* 运输键收进一个淡淡的胶囊里（0.2.8 那版的收法，但去掉发光），
         播放键做成白底实心 —— 中间这块才有"锚"，两边留白才像呼吸而不是空洞 */
      '.np-bar .np-controls{background:rgba(127,127,127,.10);border-radius:999px;padding:3px;gap:2px;box-shadow:inset 0 0 0 1px rgba(127,127,127,.07)}',
      '.np-bar .np-controls .np-icon-btn{width:30px;height:30px;border-radius:50%;background:none;opacity:.62}',
      '.np-bar:hover .np-controls .np-icon-btn{opacity:.85}',
      '.np-bar .np-controls .np-icon-btn:hover{opacity:1;background:rgba(127,127,127,.18)}',
      '.np-bar .np-play-btn{width:34px;height:34px;border-radius:50%;background:var(--np-fg);color:var(--np-bg);opacity:1;box-shadow:0 1px 3px rgba(0,0,0,.35)}',
      '.np-bar .np-play-btn:hover{background:var(--np-fg);filter:brightness(1.06);transform:none}',
      '.np-bar .np-play-btn:active{transform:scale(.94)}',
      '.np-glow-light .np-bar .np-play-btn::before,.np-glow-mid .np-bar .np-play-btn::before,.np-glow-heavy .np-bar .np-play-btn::before{border-radius:50%;inset:-9px}',      /* 歌词栏铺满左半，但只有文字本身可点 —— 否则点空白也会跳到歌词页 */
      '.np-bar .np-bar-lyric{pointer-events:none;cursor:default}',
      '.np-bar .np-bar-lyric-body{pointer-events:auto;cursor:pointer;width:auto;margin:0 auto;display:flex}',      '.np-look-preview .np-bar .np-timeline{width:110px;min-width:70px}',
      /* ======================================================================
         0.3.8：底栏 52px -> 44px
         高度统一收进 --np-bar-h（定义在 .np-root 上），面板 / 光晕的偏移全部
         用 calc() 跟着它走，以后只改这一个数就不会出现「底栏变了、面板还悬着」。
         44px 下把内部控件再收一档：播放键 32、图标键 28、封面 30，
         胶囊 = 32 + 2*2 = 36，上下各留 4px；进度条热区保持 22px 不动（拖动手感不缩水）。
         ====================================================================== */
      '.np-bar{padding:0 16px;column-gap:18px}',
      /* 52px 那版 height 量的是内容盒，加上 1px 上边框实际占 53px；
         44px 要的是「真的 44px」，所以改成 border-box 把边框算进来 */
      '.np-bar{box-sizing:border-box}',
      '.np-bar .np-now{max-width:280px;padding:3px 8px;gap:9px}',
      '.np-bar .np-cover{width:30px;height:30px;border-radius:7px}',
      '.np-bar .np-now-title{font-size:13.5px}',
      '.np-bar .np-now-sub{font-size:11px}',
      '.np-bar .np-bar-lyric-cur{font-size:12px}',
      '.np-bar .np-timeline{min-width:168px;max-width:400px;gap:8px}',
      '.np-bar .np-time{font-size:10px}',
      /* 运输键胶囊：36px 高，落在 44px 的中间 */
      '.np-bar .np-controls{padding:2px;gap:2px}',
      '.np-bar .np-controls .np-icon-btn{width:28px;height:28px;border-radius:50%}',
      '.np-bar .np-play-btn{width:32px;height:32px;border-radius:50%}',
      '.np-bar .np-play-btn svg{width:18px;height:18px}',
      '.np-bar .np-right .np-icon-btn{width:28px;height:28px;border-radius:7px}',
      /* 面板：底边离底栏 10px，高度给顶部留 36px，不再写死 98px */
      '.np-panel{bottom:calc(var(--np-bar-h) + 10px);height:min(600px,calc(100vh - var(--np-bar-h) - 46px))}',
      '.np-glow-light .np-panel-glow,.np-glow-mid .np-panel-glow,.np-glow-heavy .np-panel-glow{bottom:calc(var(--np-bar-h) + 2px);height:min(632px,calc(100vh - var(--np-bar-h) - 34px))}',
      '.np-glow-light .np-bar-glow,.np-glow-mid .np-bar-glow,.np-glow-heavy .np-bar-glow{bottom:var(--np-bar-h)}',
      /* 歌词行：只有文字可点（点空白不跳歌词页）—— 放在最后，别被上面的排布覆盖掉 */
      '.np-bar .np-bar-lyric{pointer-events:none;cursor:default}',
      '.np-bar .np-bar-lyric-body,.np-bar .np-bar-lyric-cur{pointer-events:auto;cursor:pointer}',
    ].join('')

    function PlayerRoot() {
      return h(PlayerBoundary, null, h(NeteasePlayer))
    }

    function apply(ctx) {
      ctx.effect(
        function () {
          var id = 'dsh-netease-player-styles'
          if (document.getElementById(id) === null) {
            var style = document.createElement('style')
            style.id = id
            style.textContent = CSS
            document.head.appendChild(style)
          }
          return function () {
            var el = document.getElementById(id)
            if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
          }
        },
        'dsh-netease-player: styles',
      )

      // 窗口底部常驻一条：和输入框分开，不挡任何东西。
      ctx.slots.inject('shell.bottom', function () {
        return ctx.slots.register(
          {
            name: 'shell.bottom',
            id: 'netease-player',
            order: 20,
          },
          function () {
            return h(PlayerRoot)
          },
        )
      })
    }

    return {
      name: 'netease-player',
      inject: ['slots'],
      apply: apply,
    }
  },
})
