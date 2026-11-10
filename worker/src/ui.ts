import { SECURITY, html } from './http'

/**
 * Trang quản lý của Worker (một trang, JS thuần, không thư viện) và trang hướng dẫn /help.
 * Mọi dữ liệu hiển thị đều đi qua textContent (hàm h() bên dưới) nên body alert lạ không tạo được phần tử (không XSS).
 * Script nội tuyến chỉ chạy khi mang đúng nonce của lần phản hồi này (CSP), không có inline event handler.
 * LƯU Ý khi sửa CLIENT_JS: nằm trong String.raw nên KHÔNG dùng dấu huyền (`) và chuỗi "${" trong mã JS.
 */

const CSS = String.raw`
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;background:#07131c;color:#e6f4f8}
main{max-width:980px;margin:0 auto}a{color:#19c3b1}
h1{font-size:16px;letter-spacing:.06em;margin:0}h2{font-size:15px;margin:22px 0 8px;color:#19c3b1}h3{font-size:14px;margin:0}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px}.grow{flex:1}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.tab{background:#0d2230;border:1px solid #17394d;color:#9fc3d1;border-radius:999px;padding:6px 14px;cursor:pointer;font:inherit}
.tab.on{background:#19c3b1;color:#04222a;border-color:#19c3b1;font-weight:600}
.card{background:#0d2230;border:1px solid #17394d;border-radius:12px;padding:12px 14px;margin:0 0 10px}
.card.locked{border-color:#7a3340}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.muted{color:#7fa3b3;font-size:12px}.mono{font:12px ui-monospace,monospace;color:#9fc3d1;word-break:break-all}
.badge{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid #17394d;color:#9fc3d1}
.badge.ok{color:#4ade80;border-color:#1f6b3f}.badge.warn{color:#f0c060;border-color:#7a5d1c}.badge.bad{color:#ff8a8a;border-color:#7a3340}
button,.btn{background:#12324a;color:#e6f4f8;border:1px solid #1f4d6b;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
button:hover{background:#17405e}button.pri{background:#19c3b1;color:#04222a;border-color:#19c3b1;font-weight:600}
button.dng{border-color:#7a3340;color:#ffb3b3}button:disabled{opacity:.45;cursor:not-allowed}
input,select{background:#07131c;color:#e6f4f8;border:1px solid #1f4d6b;border-radius:8px;padding:7px 10px;font:inherit;min-width:0}
input.url{flex:1;min-width:240px;font:12px ui-monospace,monospace}input.num{width:70px}
label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#7fa3b3}
.note{border-left:3px solid #19c3b1;padding:6px 10px;background:#0b1d29;margin:8px 0;color:#cfe8f0}
.warn{border-left:3px solid #e0a43a;padding:6px 10px;background:#1c1a0f;margin:8px 0;color:#f0d9a8}
.err{border-left:3px solid #e05a6a;padding:6px 10px;background:#1f0f13;margin:8px 0;color:#ffc2c9}
.secret{border:1px solid #19c3b1;background:#0b2a2a}
#toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#19c3b1;color:#04222a;padding:8px 16px;border-radius:10px;font-weight:600;display:none;max-width:90vw;z-index:9}
#toast.bad{background:#e05a6a;color:#fff}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid #17394d;text-align:left;vertical-align:top;font-size:13px}th{color:#7fa3b3;font-weight:500}
pre{background:#0b1d29;border:1px solid #17394d;border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,monospace;color:#cfe8f0;margin:6px 0}
.login{max-width:360px;margin:8vh auto 0}.login form{display:flex;flex-direction:column;gap:10px}
.sig pre{margin:6px 0 0}
`

const CLIENT_JS = String.raw`
(function () {
  'use strict'
  var root = document.getElementById('root')
  var S = { loaded: false, tab: 'conn', user: null, setup: 'ok', notice: '', ov: null, sigs: null, ret: null, codes: {}, secret: null, probes: {}, probing: {} }
  var toastTimer = 0

  function add(e, c) {
    if (c === null || c === undefined || c === false) return
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x) }); return }
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
  function h(tag, attrs) {
    var e = document.createElement(tag)
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]
      if (v === null || v === undefined || v === false) return
      if (k === 'class') e.className = v
      else if (k === 'text') e.textContent = String(v)
      else e.setAttribute(k, v === true ? '' : String(v))
    })
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i])
    return e
  }
  /** Đọc giá trị ô nhập theo tên. KHÔNG dùng form.name/form.action...: các tên đó là thuộc tính của chính form. */
  function val(f, n) {
    var e = f.elements.namedItem(n)
    return e ? e.value : ''
  }
  function ago(s) {
    if (s === null || s === undefined) return 'chưa lần nào'
    if (s < 5) return 'vừa xong'
    if (s < 60) return s + ' giây trước'
    if (s < 3600) return Math.floor(s / 60) + ' phút trước'
    if (s < 86400) return Math.floor(s / 3600) + ' giờ trước'
    return Math.floor(s / 86400) + ' ngày trước'
  }
  function toast(msg, bad) {
    var t = document.getElementById('toast')
    t.textContent = msg
    t.className = bad ? 'bad' : ''
    t.style.display = 'block'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { t.style.display = 'none' }, 3500)
  }
  function copy(text) {
    var ok = function () { toast('Đã sao chép') }
    var fallback = function () {
      var t = document.createElement('textarea')
      t.value = text
      t.style.position = 'fixed'
      t.style.opacity = '0'
      document.body.appendChild(t)
      t.select()
      try { document.execCommand('copy'); ok() } catch (e) { toast('Không sao chép được, hãy bôi đen và Ctrl+C', true) }
      document.body.removeChild(t)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback)
    else fallback()
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || ('Lỗi HTTP ' + r.status)); e.code = j.error; e.status = r.status; throw e }
        return j
      })
    })
  }
  function fail(e) {
    if (e.code === 'unauthenticated') { S.user = null; S.notice = 'Phiên đã hết hạn, hãy đăng nhập lại'; render(); return }
    if (e.code === 'must_change_password' && S.user) { S.user.must_change = true; render(); return }
    toast(e.message || 'Có lỗi xảy ra', true)
  }
  /** Gọi API; lỗi thì báo và trả null để nơi gọi dừng lại. */
  function call(method, path, body, okMsg) {
    return api(method, path, body).then(function (r) { if (okMsg) toast(okMsg); return r }).catch(function (e) { fail(e); return null })
  }
  /** Tải danh sách tín hiệu và thông tin dọn dẹp (số lượng, cấu hình tự dọn) của tab Tín hiệu. */
  function loadSigs() {
    return Promise.all([api('GET', '/api/signals'), api('GET', '/api/signals/retention')]).then(function (r) { S.sigs = r[0]; S.ret = r[1] })
  }
  function refresh() {
    return api('GET', '/api/overview').then(function (o) {
      S.ov = o
      S.user = o.user
      return S.tab === 'sigs' ? loadSigs() : null
    }).then(render).catch(fail)
  }

  // ---------- hiển thị ----------
  function render() {
    root.textContent = ''
    if (!S.loaded) return add(root, h('p', { class: 'muted', text: 'Đang tải…' }))
    if (!S.user) return add(root, loginView())
    if (S.user.must_change) return add(root, h('div', { class: 'login' }, h('h1', { text: 'OCEAN RELAY' }), passwordCard(true)))
    add(root, dashView())
  }

  function loginView() {
    var box = h('div', { class: 'login' }, h('h1', { text: 'OCEAN RELAY · Đăng nhập' }))
    if (S.setup !== 'ok') {
      add(box, h('div', { class: 'warn' },
        h('b', { text: 'Worker chưa có tài khoản Admin. ' }),
        'Người triển khai Worker đặt mật khẩu ban đầu cho Admin (không cần gõ lệnh), rồi tải lại trang này:',
        h('ol', null,
          h('li', { text: 'Cloudflare Dashboard → Workers & Pages → ocean-relay → Settings → Variables and Secrets → thêm secret ADMIN_PASSWORD (từ 8 ký tự) → Deploy.' }),
          h('li', { text: 'Hoặc ở GitHub: Settings → Secrets and variables → Actions → thêm secret ADMIN_PASSWORD, rồi Actions → Deploy Worker → Run workflow.' })),
        'Sau đó đăng nhập bằng tên admin và mật khẩu vừa đặt; hệ thống bắt đổi mật khẩu ở lần đầu.'))
    }
    if (S.notice) add(box, h('div', { class: 'err', text: S.notice }))
    add(box, h('form', { 'data-form': 'login' },
      h('label', { text: 'Tên đăng nhập' }, h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true })),
      h('label', { text: 'Mật khẩu' }, h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('button', { class: 'pri', type: 'submit', text: 'Đăng nhập' })))
    add(box, h('p', { class: 'muted' }, 'Không có đăng ký tự do: tài khoản do Admin cấp. Quên mật khẩu thì nhờ Admin đặt lại. ', h('a', { href: '/help', text: 'Hướng dẫn' })))
    return box
  }

  function passwordCard(forced) {
    return h('div', { class: 'card' },
      h('h3', { text: forced ? 'Đổi mật khẩu để tiếp tục' : 'Đổi mật khẩu' }),
      forced ? h('div', { class: 'note', text: 'Đây là lần đăng nhập đầu (hoặc Admin vừa đặt lại mật khẩu). Hãy tự đặt mật khẩu mới, tối thiểu 8 ký tự.' }) : null,
      h('form', { 'data-form': 'password', class: 'row' },
        h('label', { text: 'Mật khẩu hiện tại' }, h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
        h('label', { text: 'Mật khẩu mới' }, h('input', { name: 'next', type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
        h('label', { text: 'Nhập lại' }, h('input', { name: 'again', type: 'password', autocomplete: 'new-password', required: true })),
        h('button', { class: 'pri', type: 'submit', text: 'Đổi mật khẩu' }),
        forced ? h('button', { type: 'button', 'data-act': 'logout', text: 'Đăng xuất' }) : null))
  }

  function dashView() {
    var admin = S.user.role === 'admin'
    var tabs = [['conn', 'Kết nối'], ['sigs', 'Tín hiệu'], ['guide', 'Hướng dẫn']]
    if (admin) tabs.splice(1, 0, ['users', 'Người dùng'])
    tabs.push(['acct', 'Tài khoản'])
    var wrap = h('div', null,
      h('div', { class: 'top' },
        h('h1', { text: 'OCEAN RELAY' }),
        h('span', { class: 'badge ' + (admin ? 'ok' : ''), text: admin ? 'Admin' : 'Người dùng' }),
        h('span', { class: 'muted grow', text: S.user.username }),
        h('button', { 'data-act': 'logout', text: 'Đăng xuất' })),
      h('div', { class: 'tabs' }, tabs.map(function (t) {
        return h('button', { class: 'tab' + (S.tab === t[0] ? ' on' : ''), 'data-act': 'tab', 'data-v': t[0], text: t[1] })
      })))
    if (S.secret) add(wrap, secretBox())
    if (S.tab === 'conn') add(wrap, connView())
    else if (S.tab === 'users' && admin) add(wrap, usersView())
    else if (S.tab === 'sigs') add(wrap, sigsView())
    else if (S.tab === 'acct') add(wrap, passwordCard(false))
    else add(wrap, guideView())
    return wrap
  }

  function secretBox() {
    var s = S.secret
    var box = h('div', { class: 'card secret' }, h('h3', { text: s.title }))
    s.lines.forEach(function (l) {
      add(box, h('div', { class: 'row', style: 'margin-top:8px' },
        h('span', { class: 'muted', text: l[0] }),
        h('input', { class: 'url', readonly: true, value: l[1], 'data-sel': true }),
        h('button', { class: 'pri', 'data-act': 'copyText', 'data-v': l[1], text: 'Sao chép' })))
    })
    if (s.note) add(box, h('div', { class: 'note', text: s.note }))
    add(box, h('button', { 'data-act': 'closeSecret', text: 'Đóng' }))
    return box
  }

  function badge(s) {
    if (s.locked) return h('span', { class: 'badge bad', text: 'Đã khóa' })
    if (s.owner_locked) return h('span', { class: 'badge bad', text: 'Chủ bị khóa' })
    if (s.status === 'online') return h('span', { class: 'badge ok', text: 'Đang kết nối' })
    if (s.status === 'stale') return h('span', { class: 'badge warn', text: 'Mất liên lạc' })
    return h('span', { class: 'badge', text: 'Chưa kết nối' })
  }
  function serverHint(s) {
    if (s.locked) return 'VPS đang bị Admin khóa: không nhận tín hiệu và Worker từ chối mọi yêu cầu của VPS này.'
    if (s.owner_locked) return 'Tài khoản chủ VPS đang bị khóa nên VPS ngừng hoạt động.'
    if (s.status === 'never') return 'Chưa có liên lạc nào. Trên chính VPS, mở http://127.0.0.1:8090/#setup, dán mã kết nối (nút “Lấy mã kết nối”) rồi bấm “Lưu và kiểm tra kết nối”.'
    if (s.status === 'stale') return 'Mất liên lạc ' + ago(s.seen_ago) + '. Kiểm tra VPS đang bật, có Internet và dịch vụ OCEAN Relay đang chạy. Chỉ kéo bù được tín hiệu trong vòng 1 giờ gần nhất.'
    if (!s.has_url) return 'VPS chưa báo địa chỉ tunnel nên Worker chưa đẩy trực tiếp được; VPS vẫn nhận bằng kéo bù theo chu kỳ OCEAN_POLL_SEC (mặc định 5 phút khi có tunnel, 5 giây khi chưa có), nên có thể trễ.'
    if (s.pending > 0) return 'Đang chờ ' + s.pending + ' tín hiệu chưa giao: Worker đẩy lại nhiều lần ngay khi nhận và quét lại mỗi phút; nếu vẫn không được VPS sẽ kéo ở nhịp tới.'
    return ''
  }

  /** Giải thích mã lỗi đẩy/đo (Worker → VPS) bằng tiếng Việt, kèm hướng xử lý. */
  function pushReason(error, status) {
    var e = error || ''
    if (e === 'no_url') return 'VPS chưa báo địa chỉ tunnel nên Worker không có chỗ để đẩy'
    if (e === 'timeout') return 'hết thời gian chờ: tunnel chậm hoặc VPS không phản hồi'
    if (e === 'network') return 'không nối được tới địa chỉ tunnel (tunnel đã đổi hoặc đã chết)'
    if (e === 'bad_time') return 'VPS lệch giờ quá 5 phút so với Worker nên Server từ chối chữ ký. Hãy đồng bộ giờ Windows (w32tm /resync)'
    if (e === 'bad_sig') return 'sai khóa: mã kết nối trên VPS không khớp với Worker'
    if (e === 'too_many_attempts') return 'Server đang chặn tạm vì có quá nhiều lần sai khóa (HTTP 429)'
    if (status === 401) return 'Server từ chối chữ ký (lệch giờ hoặc sai khóa), HTTP 401'
    if (status === 403) return 'Server từ chối (HTTP 403)'
    if (status === 404) return 'địa chỉ tunnel cũ hoặc Server bản quá cũ (HTTP 404)'
    if (status === 530 || status === 1033) return 'Cloudflare báo tunnel này không còn chạy (HTTP 530): địa chỉ Worker đang giữ đã chết. Trên VPS, cloudflared không chạy hoặc đã đổi địa chỉ; Server sẽ tự báo lại địa chỉ mới ở lần kéo kế tiếp, hoặc mở trang Cài đặt trên VPS và bấm Lưu để chạy lại tunnel'
    if (status && status >= 500) return 'tunnel không thông tới VPS (HTTP ' + status + ')'
    return e || 'lỗi không rõ'
  }
  function lastPushLine(s) {
    var p = s.last_push
    if (!p) return null
    if (p.ok) return h('div', { class: 'muted', text: 'Lần đẩy gần nhất: thành công (' + p.tries + ' lần thử, ' + p.ms + ' ms, ' + ago(p.ago) + ')' })
    return h('div', { class: 'warn', text: 'Lần đẩy gần nhất: THẤT BẠI sau ' + p.tries + ' lần thử (' + ago(p.ago) + '): ' + pushReason(p.error, p.status) + '. Tín hiệu sẽ được Worker quét lại mỗi phút hoặc VPS kéo bù.' })
  }
  function probeView(id) {
    if (S.probing[id]) return h('div', { class: 'note', text: 'Đang đo độ trễ Worker → VPS (tối đa vài chục giây)…' })
    var r = S.probes[id]
    if (!r) return null
    var box = h('div', { class: r.ok ? 'note' : 'warn' })
    if (r.error) { add(box, h('div', { text: 'Không đo được: ' + pushReason(r.error, null) })); return box }
    if (!r.ok) {
      var f = r.samples[0] || {}
      add(box, h('div', { text: 'Worker KHÔNG gọi được VPS (' + r.sent + ' lần đều lỗi): ' + pushReason(f.error, f.status) }))
    } else {
      var q = r.avg < 600 ? 'Tốt' : (r.avg < 2000 ? 'Chậm' : 'Rất chậm')
      add(box, h('div', { text: q + ' · Worker → VPS: ' + r.received + '/' + r.sent + ' lần thành công · nhanh nhất ' + r.min + ' ms · trung bình ' + r.avg + ' ms · chậm nhất ' + r.max + ' ms' + (r.first !== null ? ' · lần đầu ' + r.first + ' ms' : '') }))
    }
    if (r.origin) add(box, h('div', { class: 'mono', text: 'Địa chỉ Worker đang đẩy tới: ' + r.origin }))
    add(box, h('div', { class: 'mono', text: 'Từng lần: ' + r.samples.map(function (x) { return x.error ? (x.ms !== null ? x.error + ' ' + x.ms + 'ms' : x.error) : x.ms + 'ms' }).join(' · ') }))
    if (r.skew !== null) add(box, h('div', { class: Math.abs(r.skew) > 120 ? 'warn' : 'muted', text: 'Giờ VPS so với Worker: ' + (r.skew > 0 ? '+' : '') + r.skew + ' giây' + (Math.abs(r.skew) > 120 ? ' (lệch nhiều: nguy cơ bị từ chối chữ ký khi quá 300 giây, hãy đồng bộ giờ Windows)' : '') }))
    if (!r.verified) add(box, h('div', { class: 'muted', text: 'VPS dùng Server bản cũ (chưa có /api/ping): mới đo được kết nối, chưa kiểm khóa và giờ. Hãy cập nhật Server lên bản mới.' }))
    return box
  }

  function serverCard(s, admin) {
    var code = S.codes[s.id]
    var hint = serverHint(s)
    var card = h('div', { class: 'card' + (s.locked || s.owner_locked ? ' locked' : ''), 'data-server': s.id },
      h('div', { class: 'row' },
        h('h3', { text: s.name }), badge(s),
        h('span', { class: 'muted grow', text: (admin && s.owner_name ? 'Chủ: ' + s.owner_name + ' · ' : '') + 'thấy lần cuối: ' + ago(s.seen_ago) }),
        s.id && !s.locked && !s.owner_locked ? h('button', { 'data-act': 'probeServer', 'data-id': s.id, disabled: S.probing[s.id] ? true : null, text: S.probing[s.id] ? 'Đang đo…' : 'Đo độ trễ' }) : null,
        s.id ? h('button', { 'data-act': 'getCode', 'data-id': s.id, text: 'Lấy mã kết nối' }) : null,
        admin && s.id ? h('button', { 'data-act': 'lockServer', 'data-id': s.id, 'data-v': s.locked ? '0' : '1', class: s.locked ? '' : 'dng', text: s.locked ? 'Mở khóa' : 'Khóa' }) : null,
        s.id ? h('button', { class: 'dng', 'data-act': 'delServer', 'data-id': s.id, text: 'Xóa' }) : null),
      h('div', { class: 'mono', text: s.id ? 'Server ID: ' + s.id : '' }),
      hint ? h('div', { class: s.status === 'stale' || s.locked || s.owner_locked ? 'warn' : 'note', text: hint }) : null,
      lastPushLine(s),
      s.id ? probeView(s.id) : null)
    if (code) {
      add(card, h('div', { class: 'row', style: 'margin-top:8px' },
        h('input', { class: 'url', readonly: true, value: code, 'data-sel': true }),
        h('button', { class: 'pri', 'data-act': 'copyText', 'data-v': code, text: 'Sao chép mã' })))
      add(card, h('div', { class: 'muted', text: 'Mã chứa khóa riêng của VPS này: chỉ dán vào VPS của bạn, không gửi công khai.' }))
    }
    return card
  }

  function hookCard(k, admin, servers) {
    var target = h('select', { 'data-change': 'hookTarget', 'data-id': k.id },
      h('option', { value: '', selected: !k.server, text: admin ? 'Mọi VPS của chủ Webhook' : 'Tất cả VPS của tôi' }),
      servers.filter(function (s) { return s.owner === k.owner && s.id }).map(function (s) {
        return h('option', { value: s.id, selected: k.server === s.id, text: s.name })
      }))
    return h('div', { class: 'card' + (k.locked ? ' locked' : ''), 'data-hook': k.id },
      h('div', { class: 'row' },
        h('h3', { text: k.name }),
        k.locked ? h('span', { class: 'badge bad', text: 'Đã khóa' }) : h('span', { class: 'badge ok', text: 'Đang bật' }),
        h('span', { class: 'muted grow', text: (admin ? 'Chủ: ' + k.owner_name + ' · ' : '') + 'dùng lần cuối: ' + ago(k.last_used_ago) + ' · ' + k.hits + ' alert' }),
        admin ? h('button', { 'data-act': 'lockHook', 'data-id': k.id, 'data-v': k.locked ? '0' : '1', class: k.locked ? '' : 'dng', text: k.locked ? 'Mở khóa' : 'Khóa' }) : null),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('input', { class: 'url', readonly: true, value: k.url, 'data-sel': true }),
        h('button', { class: 'pri', 'data-act': 'copyText', 'data-v': k.url, text: 'Sao chép URL' })),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('span', { class: 'muted', text: 'Giao cho:' }), target,
        h('button', { 'data-act': 'testHook', 'data-id': k.id, text: 'Gửi thử' }),
        h('button', { 'data-act': 'rotateHook', 'data-id': k.id, text: 'Đổi khóa' }),
        h('button', { class: 'dng', 'data-act': 'delHook', 'data-id': k.id, text: 'Xóa' })))
  }

  function connView() {
    var ov = S.ov
    if (!ov) return h('p', { class: 'muted', text: 'Đang tải…' })
    var u = ov.user
    var admin = u.role === 'admin'
    var out = h('div', null)
    if (!ov.https_ok) add(out, h('div', { class: 'warn', text: 'Địa chỉ Worker hiện tại (' + ov.worker_url + ') không phải https công khai: mã kết nối và Webhook URL tạo ra sẽ không dùng được. Hãy mở trang này bằng địa chỉ https://…workers.dev (hoặc đặt biến PUBLIC_URL).' }))
    if (!ov.sync_ready) add(out, h('div', { class: 'err', text: 'Worker chưa có SYNC_KEY nên chưa thể tạo mã kết nối VPS. Admin thêm secret SYNC_KEY (chuỗi ngẫu nhiên từ 32 ký tự) ở Cloudflare Dashboard (Settings → Variables and Secrets) hoặc ở GitHub Secrets rồi chạy Deploy Worker.' }))
    var mineS = ov.servers.filter(function (s) { return s.owner === u.id }).length
    var mineH = ov.hooks.filter(function (k) { return k.owner === u.id }).length
    var sOk = admin || (u.can_add_server && mineS < u.max_servers)
    var hOk = admin || (u.can_add_hook && mineH < u.max_hooks)
    var why = function (can, used, max, what) {
      if (can) return ''
      return !(what === 'VPS' ? u.can_add_server : u.can_add_hook) ? 'Admin đang khóa việc thêm ' + what + ' mới.' : 'Đã dùng hết hạn mức ' + what + ' (' + used + '/' + max + '). Liên hệ Admin để tăng.'
    }

    add(out, h('h2', { text: 'VPS' + (admin ? ' (tất cả đang có trong Worker)' : ' của tôi (' + mineS + '/' + u.max_servers + ')') }))
    add(out, h('form', { 'data-form': 'addServer', class: 'row' },
      h('input', { name: 'name', placeholder: 'Tên gọi, ví dụ VPS nhà / VPS công ty', maxlength: 60 }),
      h('button', { class: 'pri', type: 'submit', disabled: !sOk, text: '+ Thêm VPS' }),
      h('span', { class: 'muted', text: why(sOk, mineS, u.max_servers, 'VPS') })))
    if (ov.servers.length === 0) add(out, h('p', { class: 'muted', text: 'Chưa có VPS nào.' }))
    ov.servers.forEach(function (s) { add(out, serverCard(s, admin)) })

    add(out, h('h2', { text: 'Webhook URL cho TradingView' + (admin ? '' : ' (' + mineH + '/' + u.max_hooks + ')') }))
    add(out, h('form', { 'data-form': 'addHook', class: 'row' },
      h('input', { name: 'name', placeholder: 'Tên gọi, ví dụ Indicator XAUUSD', maxlength: 60 }),
      h('select', { name: 'server' },
        h('option', { value: '', text: 'Giao cho tất cả VPS của tôi' }),
        ov.servers.filter(function (s) { return s.owner === u.id && s.id }).map(function (s) { return h('option', { value: s.id, text: 'Chỉ ' + s.name }) })),
      h('button', { class: 'pri', type: 'submit', disabled: !hOk, text: '+ Tạo Webhook URL' }),
      h('span', { class: 'muted', text: why(hOk, mineH, u.max_hooks, 'Webhook') })))
    if (ov.hooks.length === 0) add(out, h('p', { class: 'muted', text: 'Chưa có Webhook URL. Bấm “Tạo Webhook URL”, rồi sao chép dán vào TradingView (xem tab Hướng dẫn).' }))
    ov.hooks.forEach(function (k) { add(out, hookCard(k, admin, ov.servers)) })
    if (admin && ov.legacy_hook_url) {
      add(out, h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h3', { text: 'Webhook URL chung (đời cũ)' }), h('span', { class: 'muted grow', text: 'Chỉ Admin thấy. Giao cho VPS của Admin và VPS đời cũ, không giao cho VPS của người dùng.' })),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('input', { class: 'url', readonly: true, value: ov.legacy_hook_url, 'data-sel': true }),
          h('button', { 'data-act': 'copyText', 'data-v': ov.legacy_hook_url, text: 'Sao chép URL' }))))
    }
    return out
  }

  function usersView() {
    var ov = S.ov
    if (!ov || !ov.users) return h('p', { class: 'muted', text: 'Đang tải…' })
    var out = h('div', null,
      h('h2', { text: 'Tạo tài khoản' }),
      h('form', { 'data-form': 'addUser', class: 'row' },
        h('label', { text: 'Tên đăng nhập' }, h('input', { name: 'username', required: true, autocapitalize: 'none', placeholder: 'vd: nam' })),
        h('label', { text: 'Hạn mức VPS' }, h('input', { class: 'num', name: 'max_servers', type: 'number', min: 0, max: 1000, value: 1 })),
        h('label', { text: 'Hạn mức Webhook' }, h('input', { class: 'num', name: 'max_hooks', type: 'number', min: 0, max: 1000, value: 1 })),
        h('label', { text: 'Vai trò' }, h('select', { name: 'role' }, h('option', { value: 'user', text: 'Người dùng' }), h('option', { value: 'admin', text: 'Admin' }))),
        h('button', { class: 'pri', type: 'submit', text: '+ Tạo' })),
      h('div', { class: 'muted', text: 'Mật khẩu tạm được sinh tự động và chỉ hiện một lần; người dùng phải tự đổi ở lần đăng nhập đầu.' }),
      h('h2', { text: 'Người dùng (' + ov.users.length + ')' }))
    ov.users.forEach(function (x) {
      var self = x.id === S.user.id
      add(out, h('div', { class: 'card' + (x.locked ? ' locked' : ''), 'data-user': x.id },
        h('div', { class: 'row' },
          h('h3', { text: x.username }),
          h('span', { class: 'badge ' + (x.role === 'admin' ? 'ok' : ''), text: x.role === 'admin' ? 'Admin' : 'Người dùng' }),
          x.locked ? h('span', { class: 'badge bad', text: 'Đã khóa' }) : null,
          x.must_change ? h('span', { class: 'badge warn', text: 'Chưa đổi mật khẩu' }) : null,
          h('span', { class: 'muted grow', text: 'VPS ' + x.servers + '/' + x.max_servers + ' · Webhook ' + x.hooks + '/' + x.max_hooks + ' · đăng nhập: ' + ago(x.last_login_ago) })),
        h('form', { 'data-form': 'limits', 'data-id': x.id, class: 'row', style: 'margin-top:8px' },
          h('label', { text: 'Hạn mức VPS' }, h('input', { class: 'num', name: 'max_servers', type: 'number', min: 0, max: 1000, value: x.max_servers })),
          h('label', { text: 'Hạn mức Webhook' }, h('input', { class: 'num', name: 'max_hooks', type: 'number', min: 0, max: 1000, value: x.max_hooks })),
          h('button', { type: 'submit', text: 'Lưu hạn mức' })),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { 'data-act': 'userFlag', 'data-id': x.id, 'data-k': 'can_add_server', 'data-v': x.can_add_server ? '0' : '1', text: x.can_add_server ? 'Khóa thêm VPS mới' : 'Mở khóa thêm VPS mới' }),
          h('button', { 'data-act': 'userFlag', 'data-id': x.id, 'data-k': 'can_add_hook', 'data-v': x.can_add_hook ? '0' : '1', text: x.can_add_hook ? 'Khóa tạo Webhook mới' : 'Mở khóa tạo Webhook mới' }),
          h('button', { 'data-act': 'addServerFor', 'data-id': x.id, text: '+ VPS cho người này' }),
          h('button', { 'data-act': 'addHookFor', 'data-id': x.id, text: '+ Webhook cho người này' })),
        h('div', { class: 'row', style: 'margin-top:8px' },
          self ? null : h('button', { class: x.locked ? '' : 'dng', 'data-act': 'userFlag', 'data-id': x.id, 'data-k': 'locked', 'data-v': x.locked ? '0' : '1', text: x.locked ? 'Mở khóa tài khoản' : 'Khóa tài khoản' }),
          h('button', { 'data-act': 'resetPw', 'data-id': x.id, text: 'Đặt lại mật khẩu' }),
          self ? null : h('button', { class: 'dng', 'data-act': 'delUser', 'data-id': x.id, text: 'Xóa tài khoản' }))))
    })
    return out
  }

  /** Thẻ dọn dẹp: Admin chọn thời gian tự dọn mỗi ngày; ai cũng xóa tay được (Admin: của mọi người, User: của mình). */
  function cleanupCard() {
    var admin = S.user.role === 'admin'
    var r = S.ret
    var card = h('div', { class: 'card' }, h('h3', { text: 'Dọn dẹp tín hiệu' }))
    if (!r) return add(card, h('p', { class: 'muted', text: 'Đang tải…' })) || card
    add(card, h('p', { class: 'muted', text: 'Đang lưu ' + r.count + ' tín hiệu' + (r.oldest_age !== null ? ', cũ nhất ' + ago(r.oldest_age) : '') + (admin ? ' (của mọi người).' : ' (của bạn).') }))
    if (admin) {
      var d = r.days
      var preset = d === 0 ? 'off' : (d === 7 || d === 30 || d === 90) ? String(d) : 'custom'
      var sel = h('select', { name: 'preset' }, [['off', 'Không tự xóa'], ['7', '7 ngày gần nhất'], ['30', '1 tháng gần nhất'], ['90', '3 tháng gần nhất'], ['custom', 'Tùy chọn (số ngày bên cạnh)']].map(function (o) { return h('option', { value: o[0], text: o[1] }) }))
      sel.value = preset
      add(card, h('form', { class: 'row', 'data-form': 'retention' },
        h('label', null, 'Tự động giữ lại', sel),
        h('label', null, 'Số ngày tùy chọn', h('input', { class: 'num', name: 'custom', type: 'number', min: '1', max: '3650', value: preset === 'custom' ? String(d) : '' })),
        h('button', { class: 'pri', type: 'submit', text: 'Lưu' })))
      add(card, h('p', { class: 'muted', text: 'Worker tự dọn mỗi ngày lúc 03:00 (giờ Việt Nam)' + (r.last ? '. Lần dọn gần nhất ' + ago(r.last.ago) + ', đã xóa ' + r.last.deleted + ' tín hiệu.' : '. Chưa chạy lần nào.') }))
    }
    var keep = function (days, label) { return h('button', { 'data-act': 'purgeOlder', 'data-days': days, text: label }) }
    add(card, h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Xóa ngay:' }), keep(7, 'Giữ 7 ngày gần nhất'), keep(30, 'Giữ 1 tháng gần nhất'), keep(90, 'Giữ 3 tháng gần nhất'), h('button', { class: 'dng', 'data-act': 'purgeAll', text: 'Xóa hết' })))
    add(card, h('form', { class: 'row', 'data-form': 'purgeRange' },
      h('label', null, 'Xóa từ ngày', h('input', { name: 'from', type: 'date', required: true })),
      h('label', null, 'đến hết ngày', h('input', { name: 'to', type: 'date', required: true })),
      h('button', { class: 'dng', type: 'submit', text: 'Xóa khoảng này' })))
    add(card, h('p', { class: 'muted', text: 'Tín hiệu vừa nhận mà VPS chưa kịp nhận sẽ được giữ lại để không mất lệnh.' }))
    return card
  }

  function sigsView() {
    var out = h('div', null, h('h2', { text: 'Tín hiệu gần đây' }),
      h('div', { class: 'row' }, h('button', { 'data-act': 'reloadSigs', text: 'Tải lại' }), h('span', { class: 'muted', text: S.user.role === 'admin' ? 'Admin thấy của mọi người.' : 'Chỉ hiện tín hiệu đi qua Webhook của bạn.' })))
    add(out, cleanupCard())
    if (!S.sigs) return add(out, h('p', { class: 'muted', text: 'Đang tải…' })) || out
    if (S.sigs.signals.length === 0) add(out, h('p', { class: 'muted', text: 'Chưa có tín hiệu nào. Dùng nút “Gửi thử” ở tab Kết nối để kiểm tra đường đi.' }))
    S.sigs.signals.forEach(function (g) {
      var st = g.servers === 0 ? 'chưa có VPS nào để giao' : (g.delivered >= g.servers ? 'đã giao hết' : 'đã giao ' + g.delivered + '/' + g.servers + ' VPS')
      add(out, h('div', { class: 'card sig' },
        h('div', { class: 'row' }, h('b', { text: '#' + g.id }), h('span', { class: 'muted', text: ago(g.age) + ' · ' + st + (g.owner_name ? ' · ' + g.owner_name : '') })),
        h('pre', { text: g.raw })))
    })
    return out
  }

  function guideView() {
    var wu = S.ov ? S.ov.worker_url : location.origin
    var sec = function (title, body) { return h('div', { class: 'card' }, h('h3', { text: title }), body) }
    var ol = function (items) { return h('ol', null, items.map(function (t) { return h('li', { text: t }) })) }
    return h('div', null,
      h('h2', { text: 'Thiết lập lần đầu (3 bước)' }),
      sec('1 · Tạo kết nối trên trang này', ol([
        'Tab Kết nối → mục VPS → “+ Thêm VPS” → bấm “Lấy mã kết nối” rồi Sao chép (chuỗi bắt đầu bằng ocean1.).',
        'Tab Kết nối → mục Webhook → “+ Tạo Webhook URL” → Sao chép URL (dạng ' + wu + '/webhook?key=…).'
      ])),
      sec('2 · Dán mã trên VPS', h('div', null, h('p', null, 'Tải bộ cài: ', h('a', { href: S.ov ? S.ov.installer_url : '#', target: '_blank', rel: 'noopener noreferrer', text: 'OceanRelay-Setup.exe (trang Releases, chọn bản server-v…)' })), ol([
        'Cài OceanRelay-Setup.exe trên VPS (bộ cài không hỏi gì).',
        'Ngay TRÊN VPS, mở http://127.0.0.1:8090/#setup (xem từ xa sẽ không thấy nút Cài đặt).',
        'Dán mã ocean1.… vào ô “Mã kết nối”, điền tài khoản MT5, bấm “Lưu và kiểm tra kết nối”.',
        'Quay lại tab Kết nối: VPS chuyển sang “Đang kết nối” trong chừng nửa phút.'
      ]))),
      sec('MT5 (làm một lần trên VPS, bằng giao diện MT5)', ol([
        'MT5 → Tools → Options → Expert Advisors → bật Allow WebRequest và thêm địa chỉ Gateway (mặc định http://127.0.0.1:47860; trang Cài đặt trên VPS luôn ghi đúng địa chỉ đang dùng).',
        'Gắn EA OceanRelay lên MỘT chart. Thử trên tài khoản DEMO trước: thấy tín hiệu và ack trên giao diện VPS là thông.'
      ])),
      sec('MT4 (nếu dùng MT4 thay MT5)', ol([
        'MT4 không nhận địa chỉ có cổng: Allow WebRequest thêm http://127.0.0.1 (không cổng) và đặt InpGateway của EA là http://127.0.0.1.',
        'Trang Cài đặt trên VPS (http://127.0.0.1:8090/#setup, bước 3, mục “Dùng MT4?”) hướng dẫn từng bước kèm lệnh chép sẵn.'
      ])),
      sec('3 · Dán Webhook URL vào TradingView', ol([
        'Mở biểu đồ có indicator OCEAN VIP → bấm Alert (Alt+A) → Tạo alert.',
        'Condition: chọn indicator, rồi chọn “Any alert() function call”.',
        'Tab Notifications → bật Webhook URL → dán URL đã sao chép (đúng một dòng, không thừa dấu cách) → Create.',
        'Không cần sửa ô Message: indicator tự gửi một dòng text.',
        'Quay lại đây bấm “Gửi thử” ở Webhook: tab Tín hiệu phải hiện dòng OCEAN TEST và đã giao cho VPS.'
      ])),
      h('h2', { text: 'Sự cố thường gặp' }),
      h('div', { class: 'card' }, h('table', null,
        h('tr', null, h('th', { text: 'Triệu chứng' }), h('th', { text: 'Nguyên nhân hay gặp' }), h('th', { text: 'Cách xử lý' })),
        [
          ['TradingView không gửi được alert', 'TradingView chỉ cho Webhook khi tài khoản có gói trả phí và đã bật xác thực 2 lớp (2FA); URL không phải https; URL có khoảng trắng/xuống dòng.', 'Kiểm tra gói + 2FA trong cài đặt TradingView; sao chép lại URL bằng nút Sao chép rồi dán lại.'],
          ['Webhook trả 401 bad_key', 'URL thiếu ?key=…, dán sai hoặc cắt cụt; hoặc Webhook đã bị “Đổi khóa”/xóa.', 'Lấy lại URL ở tab Kết nối và cập nhật alert trong TradingView.'],
          ['Webhook trả 403 hook_locked / user_locked', 'Admin đang khóa Webhook hoặc tài khoản.', 'Liên hệ Admin để mở khóa.'],
          ['EA trên MT4 báo err=5200 (MT5 thì chạy bình thường)', 'MT4 không nhận địa chỉ Gateway có cổng (http://127.0.0.1:47860).', 'Trên VPS mở http://127.0.0.1:8090/#setup, bước 3, mục “Dùng MT4?” và làm theo (đặt InpGateway=http://127.0.0.1).'],
          ['Dán trang chủ Worker (không có /webhook) vào TradingView', 'URL phải có đuôi /webhook?key=…', 'Chỉ dùng URL do nút “Tạo Webhook URL” sinh ra.'],
          ['VPS “Chưa kết nối”', 'Chưa dán mã trên VPS, hoặc dán sai VPS (mỗi VPS một mã riêng).', 'Làm lại bước 2; mã đã dán ở VPS khác thì tạo VPS mới.'],
          ['VPS “Mất liên lạc”', 'VPS tắt, mất mạng, dịch vụ OCEAN Relay không chạy; hoặc bị Admin khóa.', 'Bật lại VPS/dịch vụ; xem huy hiệu Worker ở trang Cài đặt trên VPS (báo 403 = bị khóa, 401 = mã sai/đã xóa).'],
          ['Gửi thử nhưng VPS không nhận', 'VPS chưa báo địa chỉ tunnel nên Worker không đẩy trực tiếp được.', 'Cần VPS báo địa chỉ tunnel để Worker đẩy trực tiếp; nếu quá vài phút vẫn không thấy, kiểm tra trạng thái VPS và tunnel.'],
          ['Không tạo được VPS/Webhook mới', 'Hết hạn mức hoặc Admin đang khóa việc thêm mới.', 'Liên hệ Admin tăng hạn mức hoặc mở khóa.']
        ].map(function (r) { return h('tr', null, r.map(function (c) { return h('td', { text: c }) })) }))),
      h('p', { class: 'muted' }, 'Hướng dẫn vận hành Worker dành cho Admin: ', h('a', { href: '/help', text: '/help' })))
  }

  // ---------- thao tác ----------
  function showServerSecret(r, title) {
    S.secret = { title: title, lines: [['Mã kết nối', r.code]], note: 'Dán mã này vào trang Cài đặt TRÊN VPS (http://127.0.0.1:8090/#setup). Mã chứa khóa riêng của VPS, không gửi công khai.' }
  }
  function doPurge(body) {
    call('POST', '/api/signals/purge', body).then(function (r) {
      if (!r) return
      toast('Đã xóa ' + r.deleted + ' tín hiệu' + (r.kept_pending ? ' (giữ lại ' + r.kept_pending + ' tín hiệu đang chờ giao)' : ''))
      return loadSigs().then(render)
    }).catch(fail)
  }
  var acts = {
    tab: function (t) {
      S.tab = t.getAttribute('data-v')
      S.secret = null
      if (S.tab === 'sigs') loadSigs().then(render).catch(fail)
      else if (S.tab === 'conn' || S.tab === 'users') refresh()
      render()
    },
    logout: function () { call('POST', '/api/logout').then(function () { S.user = null; S.ov = null; S.sigs = null; S.codes = {}; S.secret = null; S.notice = ''; render() }) },
    copyText: function (t) { copy(t.getAttribute('data-v')) },
    closeSecret: function () { S.secret = null; render() },
    reloadSigs: function () { loadSigs().then(render).catch(fail) },
    purgeOlder: function (t) {
      var days = Number(t.getAttribute('data-days'))
      if (!window.confirm('Xóa các tín hiệu cũ hơn ' + days + ' ngày? Không hoàn tác được.')) return
      doPurge({ mode: 'older', days: days })
    },
    purgeAll: function () {
      if (!window.confirm('Xóa HẾT tín hiệu' + (S.user.role === 'admin' ? ' của mọi người' : ' của bạn') + '? Không hoàn tác được.')) return
      doPurge({ mode: 'all' })
    },
    getCode: function (t) {
      var id = t.getAttribute('data-id')
      call('GET', '/api/servers/' + id + '/code').then(function (r) { if (r) { S.codes[id] = r.code; render() } })
    },
    probeServer: function (t) {
      var id = t.getAttribute('data-id')
      if (S.probing[id]) return
      S.probing[id] = true
      render()
      api('POST', '/api/servers/' + id + '/probe').then(function (r) { S.probes[id] = r }).catch(function (e) {
        delete S.probes[id]
        fail(e)
      }).then(function () { delete S.probing[id]; render() })
    },
    delServer: function (t) {
      if (!window.confirm('Xóa VPS này? VPS sẽ không còn nhận tín hiệu và mã kết nối của nó bị thu hồi vĩnh viễn.')) return
      call('DELETE', '/api/servers/' + t.getAttribute('data-id'), null, 'Đã xóa VPS').then(function (r) { if (r) refresh() })
    },
    lockServer: function (t) {
      var lock = t.getAttribute('data-v') === '1'
      call('PATCH', '/api/servers/' + t.getAttribute('data-id'), { locked: lock }, lock ? 'Đã khóa VPS' : 'Đã mở khóa VPS').then(function (r) { if (r) refresh() })
    },
    testHook: function (t) {
      call('POST', '/api/hooks/' + t.getAttribute('data-id') + '/test').then(function (r) {
        if (!r) return
        toast(r.servers === 0 ? 'Đã nhận nhưng chưa có VPS nào đang hoạt động để giao' : 'Đã gửi thử tới ' + r.servers + ' VPS. Xem kết quả ở tab Tín hiệu', r.servers === 0)
        refresh()
        // Worker đẩy ở nền (có thể thử lại tới ~25 giây): làm mới thêm vài lần để dòng “Lần đẩy gần nhất” của VPS hiện ra mà không cần F5.
        ;[2000, 8000, 20000].forEach(function (ms) { setTimeout(function () { if (S.user) refresh() }, ms) })
      })
    },
    rotateHook: function (t) {
      if (!window.confirm('Đổi khóa? URL cũ ngừng hoạt động ngay, bạn phải dán URL mới vào alert TradingView.')) return
      call('POST', '/api/hooks/' + t.getAttribute('data-id') + '/rotate', null, 'Đã đổi khóa, hãy cập nhật alert trên TradingView').then(function (r) { if (r) refresh() })
    },
    delHook: function (t) {
      if (!window.confirm('Xóa Webhook URL này? Alert TradingView đang dùng nó sẽ báo lỗi.')) return
      call('DELETE', '/api/hooks/' + t.getAttribute('data-id'), null, 'Đã xóa Webhook').then(function (r) { if (r) refresh() })
    },
    lockHook: function (t) {
      var lock = t.getAttribute('data-v') === '1'
      call('PATCH', '/api/hooks/' + t.getAttribute('data-id'), { locked: lock }, lock ? 'Đã khóa Webhook' : 'Đã mở khóa Webhook').then(function (r) { if (r) refresh() })
    },
    userFlag: function (t) {
      var body = {}
      body[t.getAttribute('data-k')] = t.getAttribute('data-v') === '1'
      call('PATCH', '/api/users/' + t.getAttribute('data-id'), body, 'Đã cập nhật').then(function (r) { if (r) refresh() })
    },
    resetPw: function (t) {
      if (!window.confirm('Đặt lại mật khẩu? Người dùng bị đăng xuất và phải đổi mật khẩu khi vào lại.')) return
      call('PATCH', '/api/users/' + t.getAttribute('data-id'), { reset_password: true }).then(function (r) {
        if (!r) return
        S.secret = { title: 'Mật khẩu tạm mới', lines: [['Mật khẩu tạm', r.password]], note: 'Chỉ hiện một lần. Gửi riêng cho người dùng; họ phải đổi ngay khi đăng nhập.' }
        refresh()
      })
    },
    delUser: function (t) {
      if (!window.confirm('Xóa tài khoản này cùng toàn bộ VPS, Webhook và tín hiệu của họ? Không hoàn tác được.')) return
      call('DELETE', '/api/users/' + t.getAttribute('data-id'), null, 'Đã xóa tài khoản').then(function (r) { if (r) refresh() })
    },
    addServerFor: function (t) {
      call('POST', '/api/servers', { user_id: Number(t.getAttribute('data-id')) }).then(function (r) {
        if (!r) return
        showServerSecret(r, 'Đã tạo VPS “' + r.name + '”')
        refresh()
      })
    },
    addHookFor: function (t) {
      call('POST', '/api/hooks', { user_id: Number(t.getAttribute('data-id')) }, 'Đã tạo Webhook cho người dùng').then(function (r) { if (r) refresh() })
    }
  }
  var forms = {
    retention: function (f) {
      var p = val(f, 'preset')
      var days = p === 'off' ? 0 : p === 'custom' ? Number(val(f, 'custom')) : Number(p)
      if (!Number.isInteger(days) || days < 0 || days > 3650 || (p === 'custom' && days < 1)) return toast('Số ngày tùy chọn phải từ 1 đến 3650', true)
      call('PUT', '/api/signals/retention', { days: days }, days === 0 ? 'Đã tắt tự xóa' : 'Đã lưu: tự giữ ' + days + ' ngày gần nhất').then(function (r) { if (r) return loadSigs().then(render) })
    },
    purgeRange: function (f) {
      var a = val(f, 'from')
      var b = val(f, 'to')
      if (!a || !b) return toast('Chọn đủ ngày bắt đầu và ngày kết thúc', true)
      var from = Math.floor(new Date(a + 'T00:00:00').getTime() / 1000)
      var to = Math.floor(new Date(b + 'T23:59:59').getTime() / 1000)
      if (!(from <= to)) return toast('Ngày bắt đầu phải trước ngày kết thúc', true)
      if (!window.confirm('Xóa các tín hiệu từ ' + a + ' đến hết ' + b + '? Không hoàn tác được.')) return
      doPurge({ mode: 'range', from: from, to: to })
    },
    login: function (f) {
      api('POST', '/api/login', { username: val(f, 'username'), password: val(f, 'password') }).then(function (r) {
        S.notice = ''
        S.user = r.user
        if (r.user.must_change) render()
        else refresh()
      }).catch(function (e) { S.notice = e.message; render() })
    },
    password: function (f) {
      if (val(f, 'next') !== val(f, 'again')) return toast('Hai ô mật khẩu mới không giống nhau', true)
      call('POST', '/api/password', { current: val(f, 'current'), next: val(f, 'next') }, 'Đã đổi mật khẩu').then(function (r) {
        if (!r) return
        S.user.must_change = false
        S.tab = 'conn'
        refresh()
      })
    },
    addServer: function (f) {
      call('POST', '/api/servers', { name: val(f, 'name') }).then(function (r) {
        if (!r) return
        S.codes[r.id] = r.code
        showServerSecret(r, 'Đã tạo VPS “' + r.name + '”')
        refresh()
      })
    },
    addHook: function (f) {
      call('POST', '/api/hooks', { name: val(f, 'name'), server: val(f, 'server') || null }, 'Đã tạo Webhook URL: bấm Sao chép rồi dán vào TradingView').then(function (r) { if (r) refresh() })
    },
    addUser: function (f) {
      call('POST', '/api/users', { username: val(f, 'username'), role: val(f, 'role'), max_servers: Number(val(f, 'max_servers')), max_hooks: Number(val(f, 'max_hooks')) }).then(function (r) {
        if (!r) return
        S.secret = { title: 'Đã tạo tài khoản ' + r.username, lines: [['Tên đăng nhập', r.username], ['Mật khẩu tạm', r.password]], note: 'Mật khẩu chỉ hiện một lần. Gửi riêng cho người dùng; họ phải tự đổi ở lần đăng nhập đầu.' }
        refresh()
      })
    },
    limits: function (f) {
      call('PATCH', '/api/users/' + f.getAttribute('data-id'), { max_servers: Number(val(f, 'max_servers')), max_hooks: Number(val(f, 'max_hooks')) }, 'Đã lưu hạn mức').then(function (r) { if (r) refresh() })
    }
  }

  root.addEventListener('click', function (ev) {
    var el = ev.target
    if (el.hasAttribute && el.hasAttribute('data-sel') && el.select) el.select()
    var t = el.closest ? el.closest('[data-act]') : null
    if (t && acts[t.getAttribute('data-act')]) acts[t.getAttribute('data-act')](t)
  })
  root.addEventListener('submit', function (ev) {
    ev.preventDefault()
    var f = ev.target
    var fn = forms[f.getAttribute('data-form')]
    if (fn) fn(f)
  })
  root.addEventListener('change', function (ev) {
    var el = ev.target
    if (el.getAttribute && el.getAttribute('data-change') === 'hookTarget') {
      call('PATCH', '/api/hooks/' + el.getAttribute('data-id'), { server: el.value || null }, 'Đã đổi nơi giao').then(function () { refresh() })
    }
  })

  api('GET', '/api/session').then(function (r) {
    S.loaded = true
    S.setup = r.setup
    S.user = r.user
    if (r.user && !r.user.must_change) refresh()
    else render()
  }).catch(function () { S.loaded = true; S.notice = 'Không gọi được Worker, hãy tải lại trang'; render() })
})()
`

/** Trang quản lý: HTML gần như trống, mọi thứ do CLIENT_JS dựng. Mỗi lần phản hồi một nonce mới cho script. */
export function appPage(): Response {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    const page = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>OCEAN Relay · Quản lý</title><style>${CSS}</style></head>
<body><main><div id="root"></div><p class="muted" style="margin-top:28px"><a href="/help">Hướng dẫn vận hành Worker</a></p></main><div id="toast" role="status"></div>
<script nonce="${nonce}">${CLIENT_JS}</script></body></html>`
    return new Response(page, {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            ...SECURITY,
            'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        },
    })
}

/** Trang hướng dẫn vận hành Worker (công khai, KHÔNG chứa khóa nào). Phần đầu chỉ dùng trình duyệt; dòng lệnh nằm riêng ở mục "Nâng cao". */
export function helpPage(): Response {
  return html(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCEAN Relay · Hướng dẫn Worker</title>
<style>${CSS}</style></head>
<body><main><h1>OCEAN<span style="color:#19c3b1"> RELAY</span> · Hướng dẫn Worker (dành cho Admin)</h1>
<p>Mọi thao tác hằng ngày đều làm ngay trên <a href="/">trang quản lý</a>. Người dùng cuối <b>không</b> cần cài công cụ hay gõ lệnh: họ chỉ đăng nhập, bấm nút và sao chép/dán.</p>

<h2>1 · Thiết lập Worker bằng trình duyệt (không cần gõ lệnh)</h2>
<pre>1. Cloudflare Dashboard: tạo D1 database tên ocean-relay, ghi lại Database ID.
   Tạo API Token (quyền Workers Scripts: Edit, D1: Edit) và ghi lại Account ID.
2. GitHub repo → Settings → Secrets and variables → Actions → thêm:
     CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID
     ADMIN_PASSWORD   (mật khẩu ban đầu của Admin, từ 8 ký tự)
     SYNC_KEY         (chuỗi ngẫu nhiên từ 32 ký tự: khóa gốc, không đưa cho ai)
     WEBHOOK_KEY      (tùy chọn, từ 16 ký tự: chỉ cần nếu muốn dùng Webhook URL chung đời cũ)
3. GitHub → Actions → Deploy Worker → Run workflow.
   Workflow tự kiểm tra, áp migration D1, deploy và nạp các secret ở trên vào Worker.
4. Mở địa chỉ Worker (https://ocean-relay.&lt;tài-khoản&gt;.workers.dev), đăng nhập admin, đổi mật khẩu.</pre>
<p>Các lần sau chỉ cần commit có <code>[deploy]</code> hoặc bấm Run workflow lại: migration được áp tự động. Đổi <code>SYNC_KEY</code> làm mọi mã kết nối cũ mất hiệu lực (người dùng lấy mã mới ở trang quản lý).</p>

<h2>2 · Cấp tài khoản cho người dùng</h2>
<pre>Trang quản lý → tab "Người dùng" → "+ Tạo"
  - đặt hạn mức VPS / Webhook
  - gửi RIÊNG cho người dùng: địa chỉ trang + tên đăng nhập + mật khẩu tạm (chỉ hiện một lần)
Người dùng tự đổi mật khẩu, rồi tự bấm "+ Thêm VPS" và "+ Tạo Webhook URL" trong hạn mức.
Hết hạn mức hoặc bị khóa: Admin tăng hạn mức / "Mở khóa thêm VPS mới" / "Mở khóa tạo Webhook mới".</pre>
<p>Admin khóa được: tài khoản (mọi VPS + Webhook của người đó ngừng chạy ngay), từng VPS, từng Webhook, và riêng việc thêm mới. Người dùng chỉ thấy VPS, Webhook, tín hiệu của chính mình.</p>

<h2>3 · Theo dõi và gỡ lỗi (trên trang quản lý)</h2>
<pre>Tab "Kết nối"   : VPS nào đang kết nối / mất liên lạc / bị khóa, chủ sở hữu, lần liên lạc cuối, số tín hiệu đang chờ.
                  Mỗi VPS có gợi ý cách xử lý ngay trên thẻ.
Webhook         : nút "Gửi thử" (tạo tín hiệu OCEAN TEST), "Đổi khóa", "Xóa"; Admin thấy cả Webhook URL chung đời cũ.
Tab "Tín hiệu"  : từng tín hiệu đã giao cho bao nhiêu VPS.
Tab "Hướng dẫn" : thiết lập 3 bước + bảng sự cố thường gặp cho người dùng.</pre>

<h2>4 · Sự cố thường gặp (Admin)</h2>
<pre>Trang đăng nhập báo "chưa có Admin"      -> thêm secret ADMIN_PASSWORD (Cloudflare Dashboard → Workers &amp; Pages → ocean-relay → Settings →
                                            Variables and Secrets, hoặc GitHub Secrets rồi Run workflow), tải lại trang
Báo db_not_migrated / no such table      -> GitHub → Actions → Deploy Worker → Run workflow (tự áp migration)
Báo "chưa có SYNC_KEY"                   -> thêm secret SYNC_KEY (xem mục 1)
Người dùng quên mật khẩu                 -> Admin: tab "Người dùng" → "Đặt lại mật khẩu", gửi mật khẩu tạm mới
Admin duy nhất quên mật khẩu             -> Cloudflare Dashboard → Storage &amp; Databases → D1 → ocean-relay → Console, chạy:
                                            DELETE FROM users WHERE role = 'admin';
                                            rồi đặt lại secret ADMIN_PASSWORD (mật khẩu mới) và mở lại trang: Admin được tạo lại, phải đổi mật khẩu
Webhook trả 401 bad_key                  -> URL sai/đã đổi khóa: lấy lại URL ở trang quản lý
Webhook trả 403 hook_locked / user_locked-> Admin đang khóa
VPS báo HTTP 403 (server_locked)         -> Admin đang khóa VPS hoặc chủ; server_revoked = VPS đã bị xóa, cần tạo VPS mới
VPS báo HTTP 401                         -> mã kết nối sai hoặc đã đổi SYNC_KEY: lấy mã mới ở trang quản lý</pre>

<h2>5 · Nâng cao (tùy chọn, dùng dòng lệnh trên máy dev)</h2>
<p>Không bắt buộc. Chỉ dùng nếu bạn muốn cài nhanh từ máy dev thay cho các bước trình duyệt ở mục 1.</p>
<pre>npm install
cd worker
npm install
npx wrangler login
npm run setup            # tạo D1, áp migration, sinh khóa + mật khẩu Admin, đặt secret, deploy, in địa chỉ + tài khoản Admin
npm run issue -- --list  # liệt kê VPS (cách cũ cấp mã: npm run issue -- "Tên VPS")</pre>
<p class="warn">Không nạp <code>schema.sql</code> lên D1 thật (chỉ dùng cho test/dev): migration có <code>ALTER TABLE</code> nên phải đi qua <code>migrations apply</code> hoặc workflow Deploy Worker. Khóa gốc do <code>setup</code> sinh ghi ở <code>worker/.ocean-master.json</code>: không commit, không gửi cho ai.</p>
</main></body></html>`)
}
