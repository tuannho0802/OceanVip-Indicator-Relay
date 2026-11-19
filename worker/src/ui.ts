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
.pp{margin-top:8px;padding:10px 12px;background:#0b1d29;border:1px solid #17394d;border-radius:12px}
.pp-note{font-size:12px;color:#7fa3b3;line-height:1.5}.pp-warn{font-size:12px;color:#f0c060;margin-top:4px}
.pg{border:1px solid #17394d;border-radius:10px;margin:8px 0;background:#0d2230}
.pg>summary{cursor:pointer;padding:10px 12px;font-weight:600;color:#19c3b1;list-style:none;display:flex;gap:8px;align-items:center;user-select:none}
.pg>summary::-webkit-details-marker{display:none}
.pg>summary::before{content:"\25B8";font-size:11px;color:#7fa3b3}.pg[open]>summary::before{content:"\25BE"}
.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:0 22px;padding:0 12px 8px}
.pi{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;min-height:46px;border-bottom:1px solid #12293a;border-left:3px solid transparent}
.pi.ov{border-left-color:#19c3b1;background:#0f2b34}.pi.tc{border-left-color:#e0a43a;background:#1c1a0f}
.pi .lb{flex:1;min-width:0;display:block;font-size:13px;line-height:1.3;color:#e6f4f8;cursor:pointer}
.pi .lb small{display:block;color:#7fa3b3;font-size:11px;margin-top:2px}
.pi .ct{display:flex;align-items:center;gap:6px;flex:none}
.pi input.num,.pi select{width:108px;height:34px;padding:4px 8px}.pi select{width:auto;min-width:124px;max-width:190px}
.pi button.rs{padding:0 8px;height:30px}

.pfw{padding:2px 12px 12px}.pfw.off{opacity:.5}
.tl{margin:4px 0 12px}
.tl-row{display:flex;align-items:center;gap:10px;margin:4px 0}
.tl-n{width:60px;flex:none;font-size:12px;color:#9fc3d1}
.tl-bar{position:relative;flex:1;height:14px;overflow:hidden;background:#07131c linear-gradient(to right,#1f4d6b 1px,transparent 1px) 0 0/25% 100%;border:1px solid #17394d;border-radius:7px}
.tl-bar i{position:absolute;top:0;bottom:0;background:var(--c);opacity:.85;border-radius:3px}
.tl-ax{display:flex;justify-content:space-between;margin:2px 0 0 70px;font-size:10px;color:#587a8a}
.f1{--c:#19c3b1}.f2{--c:#6aa8ff}
.pfr{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:12px}
.pt{border:1px solid #17394d;border-left:3px solid var(--c,#17394d);border-radius:10px;background:#0b1d29;padding:10px 12px}
.pt.ov{background:#0f2b34}.pt.tc{background:#1c1a0f}
.pt-h{display:flex;align-items:center;gap:8px;min-height:30px}
.pt-t{flex-direction:row;align-items:center;font-size:14px;font-weight:600;color:#e6f4f8;cursor:pointer}
.pt-t::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--c);margin-right:7px}
.pt-b{display:flex;align-items:flex-end;justify-content:center;gap:14px;margin-top:10px}
.pt.off .pt-b{opacity:.4}
.pt-f{display:flex;flex-direction:column;align-items:center;gap:4px}
.pt-l{font-size:11px;color:#7fa3b3}
.pt-clk{display:flex;align-items:center;gap:4px;font-size:18px;font-weight:600;color:#7fa3b3}
.pt input.tn{width:58px;height:40px;padding:4px;text-align:center;font-size:16px;-moz-appearance:textfield}
.pt input.tn::-webkit-outer-spin-button,.pt input.tn::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.pt input.tn.ov{border-color:#19c3b1}.pt input.tn[data-touched]{border-color:#e0a43a}
.pt-ar{padding-bottom:9px;font-size:18px;color:#7fa3b3}
.pt-d{margin-top:10px;font-size:12px;line-height:1.4;color:#9fc3d1;text-align:center}
.pt-r{margin-top:4px;font-size:11px;color:#f0c060;text-align:center}
.pt button.rs{padding:0 8px;height:28px}
.pfn{margin-top:8px}
input.sw{-webkit-appearance:none;appearance:none;width:42px;height:24px;padding:0;border-radius:999px;background:#17394d;border:1px solid #1f4d6b;position:relative;cursor:pointer;flex:none}
input.sw::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#9fc3d1;transition:left .12s}
input.sw:checked{background:#19c3b1;border-color:#19c3b1}input.sw:checked::after{left:20px;background:#04222a}
input.sw:indeterminate::after{left:11px;opacity:.5}
.pbar{position:sticky;bottom:0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;padding:10px 0 2px;background:linear-gradient(rgba(11,29,41,0),#0b1d29 28%);z-index:2}
@media (max-width:520px){body{padding:10px}.pp{padding:8px}.pgrid{padding:0 6px 6px}.pfw{padding:2px 6px 8px}.tl-n{width:52px}.tl-ax{margin-left:62px}.pt input.tn{width:52px}.pi input.num{width:96px}.pi select{min-width:112px}.pbar .pri{flex:1 1 auto}}
pre{background:#0b1d29;border:1px solid #17394d;border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,monospace;color:#cfe8f0;margin:6px 0}
.login{max-width:360px;margin:8vh auto 0}.login form{display:flex;flex-direction:column;gap:10px}
.sig pre{margin:6px 0 0}
`

const CLIENT_JS = String.raw`
(function () {
  'use strict'
  var root = document.getElementById('root')
  var S = { loaded: false, tab: 'conn', user: null, setup: 'ok', notice: '', ov: null, ea: null, pp: null, sigs: null, ret: null, codes: {}, secret: null, probes: {}, probing: {} }
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
  /** Tải trang Bật/tắt EA (đã lọc theo quyền của người xem ở phía Worker). */
  function loadEa() {
    return api('GET', '/api/ea').then(function (d) { S.ea = d })
  }
  function refresh() {
    return api('GET', '/api/overview').then(function (o) {
      S.ov = o
      S.user = o.user
      return S.tab === 'sigs' ? loadSigs() : (S.tab === 'ea' ? loadEa() : null)
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
    var tabs = [['conn', 'Kết nối'], ['ea', 'Bật/tắt EA'], ['sigs', 'Tín hiệu'], ['guide', 'Hướng dẫn']]
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
    else if (S.tab === 'ea') add(wrap, eaView())
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
        admin && s.id ? h('button', { 'data-act': 'shareEa', 'data-id': s.id, text: 'Chia sẻ bật/tắt EA' }) : null,
        admin && s.id ? h('button', { 'data-act': 'lockServer', 'data-id': s.id, 'data-v': s.locked ? '0' : '1', class: s.locked ? '' : 'dng', text: s.locked ? 'Mở khóa' : 'Khóa' }) : null,
        s.id ? h('button', { class: 'dng', 'data-act': 'delServer', 'data-id': s.id, text: 'Xóa' }) : null),
      h('div', { class: 'mono', text: s.id ? 'Server ID: ' + s.id : '' }),
      admin && s.id && s.shared_with ? h('div', { class: 'muted', 'data-role': 'shared', text: s.shared_with.length === 0 ? 'Chưa chia sẻ quyền bật/tắt EA cho ai.' : 'Đã chia sẻ quyền bật/tắt EA: ' + s.shared_with.map(function (x) { return x.username + ' (' + x.accounts + ' tài khoản)' }).join(', ') }) : null,
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

  // ---------- Bật/tắt EA theo tài khoản MT ----------
  function eaParamsBadge(p) {
    if (!p) return null
    var txt = p.overrides > 0 ? 'Ghi đè ' + p.overrides + ' input' : 'Không ghi đè'
    if (!p.vps_applied) return h('span', { class: 'badge warn', text: txt + ' · chờ VPS' })
    if (!p.ea_applied) return h('span', { class: 'badge warn', text: txt + ' · chờ EA nhận' })
    return h('span', { class: 'badge ok', text: txt + ' · EA đã áp' })
  }
  function eaAccountRow(s, a) {
    var open = S.pp && S.pp.server === s.id && S.pp.login === a.login && S.pp.d
    var row = h('div', { class: 'row', style: 'margin-top:6px' },
      h('span', { class: 'mono', text: '#' + a.login }),
      a.broker ? h('span', { class: 'muted', text: a.broker }) : null,
      h('span', { class: 'badge ' + (a.enabled ? 'ok' : 'bad'), text: a.enabled ? 'ĐANG BẬT' : 'ĐANG TẮT' }),
      a.applied ? null : h('span', { class: 'badge warn', text: 'Đang chờ VPS áp dụng' }),
      eaParamsBadge(a.params),
      h('span', { class: 'grow' }),
      h('button', { 'data-act': 'eaParams', 'data-server': s.id, 'data-login': a.login, text: open ? 'Đóng input' : 'Tuỳ chỉnh input' }),
      h('button', { class: a.enabled ? 'dng' : 'pri', 'data-act': 'eaToggle', 'data-server': s.id, 'data-login': a.login, 'data-v': a.enabled ? '0' : '1', disabled: s.locked ? true : null, text: a.enabled ? 'Tắt' : 'Bật' }))
    return h('div', null, row, open ? eaParamsPanel(s, S.pp.d) : null)
  }
  /** Form tuỳ chỉnh input EA của một tài khoản: nhóm gập được, mỗi input một dòng (nhãn trái, ô nhập phải). Chỉ ô bạn đã chạm vào mới được gửi đi. */
  function eaParamsPanel(s, d) {
    var f = h('form', { class: 'pp', 'data-form': 'eaParamsSave', 'data-server': s.id, 'data-login': d.login })
    var keys = Object.keys(d.overrides)
    add(f, h('div', { class: 'pp-note', text: 'Chỉ ô bạn đổi mới được gửi xuống EA (áp ở nhịp ping kế tiếp, vài giây). Nút ↺ hoặc xóa trống ô số = bỏ ghi đè, EA dùng input của chính nó. Không chỉnh từ xa: InpAllowTrading, địa chỉ Gateway, Magic, Comment.' }))
    if (Object.keys(d.current).length === 0) add(f, h('div', { class: 'pp-warn', text: 'EA chưa báo input hiện tại (EA bản cũ hoặc chưa chạy lại): vẫn đặt được, nhưng ô chưa hiện giá trị đang dùng.' }))
    var groups = []
    var byName = {}
    d.spec.forEach(function (p) {
      if (!byName[p.group]) { byName[p.group] = []; groups.push(p.group) }
      byName[p.group].push(p)
    })
    if (!S.pp.open) {
      S.pp.open = {}
      groups.forEach(function (g, i) { S.pp.open[g] = i === 0 || byName[g].some(function (p) { return d.overrides[p.key] !== undefined }) })
    }
    groups.forEach(function (g) {
      var n = byName[g].filter(function (p) { return d.overrides[p.key] !== undefined }).length
      var det = h('details', { class: 'pg', 'data-g': g, open: S.pp.open[g] ? true : null },
        h('summary', null, h('span', { text: g }), n > 0 ? h('span', { class: 'badge ok', text: 'ghi đè ' + n }) : null))
      var grid = h('div', { class: 'pgrid' })
      var fr = pauseFrames(byName[g])
      byName[g].forEach(function (p) {
        if (fr.keys[p.key]) return
        var over = d.overrides[p.key]
        var cur = d.current[p.key]
        var eff = over !== undefined ? over : (cur !== undefined && cur !== '' ? Number(cur) : null)
        var id = 'pp_' + p.key
        var ctl
        if (p.type === 'bool') {
          ctl = h('input', { type: 'checkbox', class: 'sw', id: id, name: p.key, checked: eff === 1 ? true : null })
          if (eff === null) ctl.indeterminate = true
        } else if (p.options) {
          ctl = h('select', { id: id, name: p.key },
            eff === null ? h('option', { value: '', text: '(theo EA)' }) : null,
            p.options.map(function (o) { return h('option', { value: o.value, text: o.label, selected: eff === o.value ? true : null }) }))
        } else ctl = h('input', { type: 'number', id: id, name: p.key, class: 'num', min: p.min, max: p.max, step: p.type === 'int' ? 1 : String(1 / Math.pow(10, p.dp || 2)), value: eff === null ? '' : eff, placeholder: '(theo EA)' })
        var curTxt = null
        if (cur !== undefined && cur !== '') {
          if (p.type === 'bool') curTxt = Number(cur) === 1 ? 'BẬT' : 'TẮT'
          else if (p.options) { var oo = p.options.filter(function (o) { return o.value === Number(cur) })[0]; curTxt = oo ? oo.label : cur }
          else curTxt = cur
        }
        var running = over !== undefined && cur !== undefined && cur !== '' && Number(cur) !== over ? 'EA đang chạy: ' + curTxt : null
        add(grid, h('div', { class: 'pi' + (over !== undefined ? ' ov' : '') },
          h('label', { class: 'lb', for: id }, p.label, running ? h('small', { text: running }) : null),
          h('span', { class: 'ct' }, ctl,
            over !== undefined ? h('button', { type: 'button', class: 'rs', title: 'Bỏ ghi đè: EA dùng input của chính nó', 'aria-label': 'Bỏ ghi đè ' + p.label, 'data-act': 'eaParamReset', 'data-key': p.key, text: '↺' }) : null)))
      })
      add(det, grid)
      if (fr.list.length > 0) add(det, pauseBlock(fr.list, d))
      add(f, det)
    })
    add(f, h('div', { class: 'pbar' },
      h('button', { class: 'pri', type: 'submit', disabled: s.locked ? true : null, text: 'Lưu và gửi xuống EA' }),
      h('span', { class: 'muted', 'data-role': 'ppCount', text: '' })))
    add(f, h('div', { class: 'row', style: 'margin-top:8px' },
      keys.length > 0 ? h('button', { type: 'button', class: 'dng', 'data-act': 'eaParamsClear', text: 'Bỏ hết ghi đè (' + keys.length + ')' }) : null,
      h('span', { class: 'muted', text: d.rev > 0 ? 'Phiên bản ' + d.rev + (d.vps_applied ? (d.ea_applied ? ' · EA đã áp' : ' · VPS đã nhận, chờ EA') : ' · đang chờ VPS') + (d.changed_ago !== null ? ' · đổi ' + ago(d.changed_ago) : '') : 'Chưa ghi đè gì' })))
    syncPause(f)
    return f
  }
  /** Khung giờ ngừng vào lệnh: gom 5 input InpPause<N>{On,StartH,StartM,EndH,EndM} thành một thẻ, kèm thanh 24 giờ. Thiếu một trong 5 khóa thì để về dạng hàng thường. */
  var PAUSE_RE = /^InpPause(\d)(On|StartH|StartM|EndH|EndM)$/
  function p2(n) { return (n < 10 ? '0' : '') + n }
  function pauseFrames(specs) {
    var m = {}
    specs.forEach(function (p) {
      var r = PAUSE_RE.exec(p.key)
      if (r) { if (!m[r[1]]) m[r[1]] = {}; m[r[1]][r[2]] = p }
    })
    var list = []
    var keys = {}
    Object.keys(m).sort().forEach(function (n) {
      var o = m[n]
      if (o.On && o.StartH && o.StartM && o.EndH && o.EndM) {
        list.push({ n: n, f: o })
        Object.keys(o).forEach(function (k) { keys[o[k].key] = true })
      }
    })
    return { list: list, keys: keys }
  }
  function pauseBlock(list, d) {
    var wrap = h('div', { class: 'pfw' })
    var tl = h('div', { class: 'tl', 'aria-hidden': 'true' })
    list.forEach(function (x) {
      add(tl, h('div', { class: 'tl-row' }, h('span', { class: 'tl-n f' + x.n, text: 'Khung ' + x.n }), h('div', { class: 'tl-bar f' + x.n, 'data-n': x.n })))
    })
    add(tl, h('div', { class: 'tl-ax' }, ['00h', '06h', '12h', '18h', '24h'].map(function (t) { return h('span', { text: t }) })))
    add(wrap, tl)
    var cards = h('div', { class: 'pfr' })
    list.forEach(function (x) { add(cards, pauseCard(x, d)) })
    add(wrap, cards)
    add(wrap, h('div', { class: 'muted pfn', text: 'Thanh 24 giờ cho thấy vùng ngừng vào lệnh (theo \u201cNguồn giờ\u201d đã chọn). Giờ bắt đầu lớn hơn giờ kết thúc = khung qua nửa đêm.' }))
    return wrap
  }
  function pauseCard(x, d) {
    var F = x.f
    var eff = function (p) {
      var o = d.overrides[p.key]
      var c = d.current[p.key]
      return o !== undefined ? o : (c !== undefined && c !== '' ? Number(c) : null)
    }
    var keys = ['On', 'StartH', 'StartM', 'EndH', 'EndM'].map(function (k) { return F[k].key })
    var over = keys.filter(function (k) { return d.overrides[k] !== undefined })
    var onEff = eff(F.On)
    var onCtl = h('input', { type: 'checkbox', class: 'sw', id: 'pp_' + F.On.key, name: F.On.key, checked: onEff === 1 ? true : null, 'aria-label': 'Khung ' + x.n + ': bật' })
    if (onEff === null) onCtl.indeterminate = true
    var tin = function (p) {
      var e = eff(p)
      return h('input', { type: 'number', id: 'pp_' + p.key, name: p.key, class: 'num tn' + (d.overrides[p.key] !== undefined ? ' ov' : ''), min: p.min, max: p.max, step: 1, value: e === null ? '' : e, placeholder: '--', 'aria-label': p.label })
    }
    var clock = function (lbl, hp, mp) {
      return h('div', { class: 'pt-f' }, h('span', { class: 'pt-l', text: lbl }), h('span', { class: 'pt-clk' }, tin(hp), ':', tin(mp)))
    }
    var run = null
    var cur = function (k) { var c = d.current[F[k].key]; return c !== undefined && c !== '' ? Number(c) : null }
    var differs = keys.some(function (k) { var c = d.current[k]; return d.overrides[k] !== undefined && c !== undefined && c !== '' && Number(c) !== d.overrides[k] })
    if (differs && cur('StartH') !== null && cur('StartM') !== null && cur('EndH') !== null && cur('EndM') !== null) {
      run = 'EA đang chạy: ' + p2(cur('StartH')) + ':' + p2(cur('StartM')) + ' \u2192 ' + p2(cur('EndH')) + ':' + p2(cur('EndM')) + (cur('On') === 0 ? ' (khung tắt)' : '')
    }
    return h('div', { class: 'pt f' + x.n + (over.length > 0 ? ' ov' : ''), 'data-n': x.n },
      h('div', { class: 'pt-h' },
        h('label', { class: 'pt-t', for: 'pp_' + F.On.key, text: 'Khung ' + x.n }),
        h('span', { class: 'grow' }),
        over.length > 0 ? h('button', { type: 'button', class: 'rs', title: 'Bỏ ghi đè cả khung này: EA dùng input của chính nó', 'aria-label': 'Bỏ ghi đè Khung ' + x.n, 'data-act': 'eaParamReset', 'data-key': over.join(','), text: '\u21BA' }) : null,
        onCtl),
      h('div', { class: 'pt-b' }, clock('Từ', F.StartH, F.StartM), h('span', { class: 'pt-ar', text: '\u2192' }), clock('Đến', F.EndH, F.EndM)),
      h('div', { class: 'pt-d', 'data-role': 'desc' }),
      run ? h('div', { class: 'pt-r', text: run }) : null)
  }
  /** Vẽ lại mô tả từng khung và thanh 24 giờ theo giá trị đang có trong form (gọi khi dựng form và mỗi lần gõ/đổi công tắc). */
  function syncPause(f) {
    var wrap = f ? f.querySelector('.pfw') : null
    if (!wrap) return
    var master = f.elements.namedItem('InpUsePauseFilter')
    wrap.classList.toggle('off', !!master && !master.indeterminate && !master.checked)
    var num = function (n, k, max) {
      var e = f.elements.namedItem('InpPause' + n + k)
      if (!e || e.value === '') return NaN
      return Math.max(0, Math.min(max, Math.floor(Number(e.value))))
    }
    wrap.querySelectorAll('.pt').forEach(function (card) {
      var n = card.getAttribute('data-n')
      var on = f.elements.namedItem('InpPause' + n + 'On')
      var isOn = !!on && on.checked
      card.classList.toggle('off', !isOn)
      var sh = num(n, 'StartH', 23)
      var sm = num(n, 'StartM', 59)
      var eh = num(n, 'EndH', 23)
      var em = num(n, 'EndM', 59)
      var ok = !isNaN(sh) && !isNaN(sm) && !isNaN(eh) && !isNaN(em)
      var a = ok ? sh * 60 + sm : 0
      var b = ok ? eh * 60 + em : 0
      var segs = !ok || !isOn || a === b ? [] : (a < b ? [[a, b]] : [[a, 1440], [0, b]])
      var t = ok ? p2(sh) + ':' + p2(sm) + ' \u2192 ' + p2(eh) + ':' + p2(em) : ''
      var desc = 'Nhập đủ giờ và phút (ô trống = theo EA)'
      if (ok) {
        if (!isOn) desc = 'Khung đang tắt, không có tác dụng'
        else if (a === b) desc = 'Giờ bắt đầu trùng giờ kết thúc: khung không có tác dụng'
        else if (a < b) desc = 'Ngừng ' + t + ' (trong ngày)'
        else desc = 'Ngừng ' + t + ' hôm sau (qua nửa đêm)'
      }
      var de = card.querySelector('[data-role="desc"]')
      if (de) de.textContent = desc
      var bar = wrap.querySelector('.tl-bar[data-n="' + n + '"]')
      if (bar) {
        while (bar.firstChild) bar.removeChild(bar.firstChild)
        segs.forEach(function (sg) {
          var i = document.createElement('i')
          i.style.left = (sg[0] / 14.4) + '%'
          i.style.width = ((sg[1] - sg[0]) / 14.4) + '%'
          bar.appendChild(i)
        })
      }
    })
  }
  function eaAccessBox(s, d) {
    var total = s.accounts.length
    var box = h('div', { style: 'margin-top:12px;border-top:1px solid #17394d;padding-top:10px' },
      h('div', { class: 'muted', text: 'Cấp quyền: người được cấp chỉ thấy và chỉ bật/tắt được những tài khoản MT bạn tick; tài khoản còn lại họ không thấy.' }))
    s.access.forEach(function (x) {
      var n = x.logins.length
      add(box, h('div', { class: 'row', style: 'margin-top:8px' },
        h('b', { text: x.username }),
        x.locked ? h('span', { class: 'badge bad', text: 'Tài khoản bị khóa' }) : null,
        total > 0 ? h('span', { class: 'badge ' + (n > 0 ? 'ok' : 'warn'), 'data-role': 'eaCount', text: n > 0 ? 'Thấy ' + n + '/' + total + ' tài khoản' : 'Chưa được chọn tài khoản nào' }) : null,
        total === 0 ? h('span', { class: 'muted', text: '(VPS chưa báo tài khoản MT nào để chọn)' }) : null,
        s.accounts.map(function (a) {
          return h('label', { style: 'flex-direction:row;align-items:center;gap:5px;color:#e6f4f8' },
            h('input', { type: 'checkbox', 'data-change': 'eaGrant', 'data-server': s.id, 'data-user': x.user_id, 'data-login': a.login, checked: x.logins.indexOf(a.login) >= 0 ? true : null }),
            '#' + a.login)
        }),
        h('span', { class: 'grow' }),
        h('button', { class: 'dng', 'data-act': 'eaRevoke', 'data-server': s.id, 'data-user': x.user_id, 'data-name': x.username, text: 'Thu hồi' })))
    })
    var has = {}
    s.access.forEach(function (x) { has[x.user_id] = true })
    var free = d.users.filter(function (u) { return !has[u.id] && u.username !== s.owner_name })
    if (free.length > 0 && total > 0) {
      // Cấp MỘT BƯỚC: chọn người + tick luôn các tài khoản MT được thấy (phải chọn ít nhất 1).
      add(box, h('form', { 'data-form': 'eaGrantAdd', 'data-server': s.id, class: 'row', style: 'margin-top:10px' },
        h('select', { name: 'user' }, free.map(function (u) { return h('option', { value: u.id, text: u.username }) })),
        s.accounts.map(function (a) {
          return h('label', { style: 'flex-direction:row;align-items:center;gap:5px;color:#e6f4f8' },
            h('input', { type: 'checkbox', name: 'login', value: a.login }), '#' + a.login)
        }),
        total > 1 ? h('button', { type: 'button', 'data-act': 'eaPickAll', text: 'Chọn tất cả' }) : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'pri', type: 'submit', text: '+ Cấp cho người dùng' })))
    } else if (free.length > 0) {
      add(box, h('div', { class: 'muted', style: 'margin-top:6px', text: 'VPS chưa báo tài khoản MT nào nên chưa có gì để cấp. Cần Server bản mới trên VPS và EA đã chạy ít nhất một lần.' }))
    } else if (s.access.length === 0) {
      add(box, h('div', { class: 'muted', style: 'margin-top:6px', text: 'Chưa có người dùng nào để cấp (tạo tài khoản ở tab Người dùng).' }))
    }
    return box
  }
  function eaServerCard(s, d, admin) {
    var card = h('div', { class: 'card' + (s.locked ? ' locked' : ''), 'data-server': s.id },
      h('div', { class: 'row' },
        h('h3', { text: s.name }),
        s.mine ? h('span', { class: 'badge ok', text: 'VPS của tôi' }) : (admin ? null : h('span', { class: 'badge', text: 'Được cấp quyền' })),
        s.locked ? h('span', { class: 'badge bad', text: 'VPS đang bị khóa' }) : null,
        h('span', { class: 'muted grow', text: admin && s.owner_name ? 'Chủ: ' + s.owner_name : '' })))
    if (s.accounts.length === 0) {
      add(card, h('div', { class: 'muted', style: 'margin-top:8px', text: s.manage ? 'VPS chưa báo tài khoản MT nào. Cần Server bản mới trên VPS và EA đã chạy ít nhất một lần thì tài khoản mới hiện ở đây.' : 'Bạn chưa được chọn tài khoản nào trên VPS này. Liên hệ Admin.' }))
    }
    s.accounts.forEach(function (a) { add(card, eaAccountRow(s, a)) })
    if (admin) add(card, eaAccessBox(s, d))
    return card
  }
  function eaView() {
    var d = S.ea
    if (!d) return h('p', { class: 'muted', text: 'Đang tải…' })
    var admin = S.user.role === 'admin'
    var out = h('div', null,
      h('div', { class: 'note', text: 'Bật/tắt nhận tín hiệu cho từng tài khoản MT. TẮT = EA không nhận tín hiệu mới nên không vào lệnh mới (tín hiệu đến lúc tắt bị bỏ, bật lại không bắn bù). Lệnh đang mở vẫn do EA tự quản lý (SL/TP, BreakEven).' }))
    if (d.servers.length === 0) add(out, h('p', { class: 'muted', text: admin ? 'Chưa có VPS nào trong Worker.' : 'Bạn chưa có VPS nào và chưa được cấp quyền tài khoản nào. Liên hệ Admin.' }))
    d.servers.forEach(function (s) { add(out, eaServerCard(s, d, admin)) })
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
      h('h2', { text: 'Bật/tắt EA từ xa và cấp quyền' }),
      sec('Dùng tab “Bật/tắt EA”', ol([
        'Cần Server trên VPS bản mới (có bật/tắt từ xa) và EA đã chạy ít nhất một lần: tài khoản MT sẽ tự hiện trong tab này.',
        'Bấm Tắt: EA ngừng nhận tín hiệu mới nên không vào lệnh mới; lệnh đang mở vẫn do EA tự quản lý. Bấm Bật để nhận lại (tín hiệu đến lúc tắt không bắn bù).',
        'Admin cấp quyền: ở thẻ VPS chọn người dùng, tick đúng các tài khoản MT cho phép (ví dụ 2/3 tài khoản) rồi bấm “+ Cấp cho người dùng”. Người đó chỉ thấy và bật/tắt được các tài khoản được tick; muốn đổi thì tick/bỏ tick ngay ở dòng của họ.',
        'Nếu hiện “Đang chờ VPS áp dụng”: tunnel đang rớt, VPS sẽ tự áp dụng khi liên lạc lại với Worker (thường trong vài chục giây).'
      ])),
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
  /** Tải lại form + trạng thái của tài khoản đang mở (không đè lên ô đang gõ dở). */
  function reloadParams() {
    if (!S.pp || S.tab !== 'ea') return Promise.resolve()
    var pp = S.pp
    return Promise.all([api('GET', '/api/ea/' + pp.server + '/accounts/' + pp.login + '/params'), api('GET', '/api/ea')]).then(function (r) {
      if (!S.pp || S.pp.server !== pp.server || S.pp.login !== pp.login) return
      var editing = root.querySelector('form[data-form="eaParamsSave"] [data-touched]')
      S.ea = r[1]
      if (!editing) S.pp.d = r[0]
      render()
    })
  }
  /** Gửi bản vá input EA của tài khoản đang mở, rồi tải lại và hỏi lại vài lần cho tới khi EA xác nhận đã áp. */
  function sendParams(values, okMsg) {
    if (!S.pp) return
    var pp = S.pp
    call('PUT', '/api/ea/' + pp.server + '/accounts/' + pp.login + '/params', { values: values }).then(function (r) {
      if (!r) return
      if (!r.changed) toast('Không có gì thay đổi so với bộ ghi đè hiện tại')
      else if (r.vps_applied) toast(okMsg + '. VPS đã nhận, EA sẽ áp ở nhịp ping kế tiếp (vài giây)')
      else toast('Đã lưu. VPS chưa nhận ngay (' + (r.push_error || 'chưa rõ lý do') + '): sẽ tự áp dụng khi VPS liên lạc lại với Worker.', true)
      api('GET', '/api/ea/' + pp.server + '/accounts/' + pp.login + '/params').then(function (d) { if (S.pp) { S.pp.d = d; loadEa().then(render).catch(fail) } }).catch(fail)
      ;[3000, 10000, 30000, 90000].forEach(function (ms) { setTimeout(function () { if (S.user) reloadParams().catch(function () {}) }, ms) })
    })
  }
  var acts = {
    tab: function (t) {
      S.tab = t.getAttribute('data-v')
      S.secret = null
      if (S.tab === 'sigs') loadSigs().then(render).catch(fail)
      else if (S.tab === 'ea') loadEa().then(render).catch(fail)
      else if (S.tab === 'conn' || S.tab === 'users') refresh()
      render()
    },
    logout: function () { call('POST', '/api/logout').then(function () { S.user = null; S.ov = null; S.ea = null; S.sigs = null; S.codes = {}; S.secret = null; S.notice = ''; render() }) },
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
    shareEa: function (t) {
      var id = t.getAttribute('data-id')
      S.tab = 'ea'
      S.secret = null
      loadEa().then(function () {
        render()
        var card = root.querySelector('[data-server="' + id + '"]')
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' })
      }).catch(fail)
      render()
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
    eaToggle: function (t) {
      var on = t.getAttribute('data-v') === '1'
      call('PUT', '/api/ea/' + t.getAttribute('data-server') + '/accounts/' + t.getAttribute('data-login'), { enabled: on }).then(function (r) {
        if (!r) return
        if (r.applied) toast(on ? 'Đã BẬT: tài khoản nhận tín hiệu trở lại' : 'Đã TẮT: tài khoản không nhận tín hiệu mới')
        else toast('Đã lưu. VPS chưa nhận ngay (' + (r.push_error || 'chưa rõ lý do') + '): sẽ tự áp dụng khi VPS liên lạc lại với Worker.', true)
        loadEa().then(render).catch(fail)
        if (!r.applied) { [5000, 20000, 60000].forEach(function (ms) { setTimeout(function () { if (S.user && S.tab === 'ea') loadEa().then(render).catch(function () {}) }, ms) }) }
      })
    },
    eaParams: function (t) {
      var sid = t.getAttribute('data-server')
      var login = t.getAttribute('data-login')
      if (S.pp && S.pp.server === sid && S.pp.login === login) { S.pp = null; render(); return }
      api('GET', '/api/ea/' + sid + '/accounts/' + login + '/params').then(function (d) { S.pp = { server: sid, login: login, d: d }; render() }).catch(fail)
    },
    eaParamReset: function (t) { var o = {}; t.getAttribute('data-key').split(',').forEach(function (k) { if (k) o[k] = null }); sendParams(o, 'Đã bỏ ghi đè: EA dùng input của chính nó') },
    eaParamsClear: function () {
      if (!S.pp) return
      if (!window.confirm('Bỏ hết ghi đè của tài khoản #' + S.pp.login + '? EA quay về đúng input đặt trên EA.')) return
      var o = {}
      Object.keys(S.pp.d.overrides).forEach(function (k) { o[k] = null })
      sendParams(o, 'Đã bỏ hết ghi đè')
    },
    eaPickAll: function (t) {
      var f = t.closest('form')
      var boxes = f ? f.querySelectorAll('input[name="login"]') : []
      var all = true
      boxes.forEach(function (c) { if (!c.checked) all = false })
      boxes.forEach(function (c) { c.checked = !all })
      t.textContent = all ? 'Chọn tất cả' : 'Bỏ chọn hết'
    },
    eaRevoke: function (t) {
      if (!window.confirm('Thu hồi mọi quyền của “' + t.getAttribute('data-name') + '” trên VPS này?')) return
      call('DELETE', '/api/ea/' + t.getAttribute('data-server') + '/access/' + t.getAttribute('data-user'), null, 'Đã thu hồi quyền').then(function (r) { if (r) loadEa().then(render).catch(fail) })
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
    eaParamsSave: function (f) {
      var patch = {}
      var n = 0
      f.querySelectorAll('[data-touched]').forEach(function (c) {
        var k = c.getAttribute('name')
        if (!k) return
        if (c.type === 'checkbox') { patch[k] = c.checked; n++ }
        else if (c.value === '') { if (c.tagName === 'INPUT') { patch[k] = null; n++ } }
        else { patch[k] = Number(c.value); n++ }
      })
      if (n === 0) { toast('Bạn chưa đổi ô nào', true); return }
      sendParams(patch, 'Đã lưu ' + n + ' thay đổi')
    },
    eaGrantAdd: function (f) {
      var logins = []
      f.querySelectorAll('input[name="login"]').forEach(function (c) { if (c.checked) logins.push(c.value) })
      if (logins.length === 0) { toast('Hãy tick ít nhất một tài khoản MT để cấp cho người này', true); return }
      call('PUT', '/api/ea/' + f.getAttribute('data-server') + '/access/' + val(f, 'user'), { logins: logins }, 'Đã cấp ' + logins.length + ' tài khoản MT').then(function (r) { if (r) loadEa().then(render).catch(fail) })
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
  function markTouched(ev) {
    var el = ev.target
    if (!el || !el.closest || !el.closest('form[data-form="eaParamsSave"]') || !el.getAttribute || !el.getAttribute('name')) return
    el.setAttribute('data-touched', '1')
    var row = el.closest('.pi, .pt')
    if (row) row.classList.add('tc')
    var n = root.querySelectorAll('form[data-form="eaParamsSave"] [data-touched]').length
    var c = root.querySelector('[data-role="ppCount"]')
    if (c) c.textContent = n + ' thay đổi chưa lưu'
    if (/^(InpPause|InpUsePauseFilter$)/.test(el.getAttribute('name'))) syncPause(el.closest('form[data-form="eaParamsSave"]'))
  }
  // Nhớ nhóm nào đang mở khi trang dựng lại (sự kiện toggle không nổi lên nên bắt ở pha capture).
  root.addEventListener('toggle', function (ev) {
    var el = ev.target
    if (el && el.classList && el.classList.contains('pg') && S.pp && S.pp.open) S.pp.open[el.getAttribute('data-g')] = el.open
  }, true)
  root.addEventListener('input', markTouched)
  root.addEventListener('change', function (ev) {
    markTouched(ev)
    var el = ev.target
    if (el.getAttribute && el.getAttribute('data-change') === 'eaGrant') {
      var sid = el.getAttribute('data-server')
      var uid = el.getAttribute('data-user')
      var logins = []
      var group = []
      root.querySelectorAll('input[data-change="eaGrant"]').forEach(function (c) {
        if (c.getAttribute('data-server') !== sid || c.getAttribute('data-user') !== uid) return
        group.push(c)
        if (c.checked) logins.push(c.getAttribute('data-login'))
      })
      group.forEach(function (c) { c.disabled = true })
      call('PUT', '/api/ea/' + sid + '/access/' + uid, { logins: logins }, 'Đã lưu danh sách tài khoản được cấp').then(function () { loadEa().then(render).catch(fail) })
      return
    }
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
