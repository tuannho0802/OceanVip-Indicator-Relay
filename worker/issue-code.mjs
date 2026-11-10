// Phát mã kết nối cho một người dùng (một Server). Chạy trên máy chủ Worker, cần worker/.ocean-master.json do `npm run setup` tạo.
//   npm run issue -- "Anh Nam"           -> in Server ID + mã ocean1.… gửi RIÊNG cho người đó
//   npm run issue -- "Anh Nam" --id nam  -> tự chọn Server ID (chữ thường, số, gạch ngang, 3-40 ký tự)
//   npm run issue -- --list              -> mọi VPS: trạng thái, chủ sở hữu, lần cuối thấy, đang chờ bao nhiêu tín hiệu
// (Cách chính để cấp VPS giờ là trang quản lý: User tự bấm "+ Thêm VPS". Lệnh này vẫn dùng được; VPS cấp ở đây thuộc về Admin.)
// Mã chứa khóa RIÊNG của Server = HMAC(SYNC_KEY gốc, "server:<id>"); Worker tính lại được nên không cần lưu danh sách khóa.
// Thu hồi một Server: đổi SYNC_KEY gốc (`node setup.mjs --webhook-key … --sync-key …`) rồi phát lại mã cho những người còn dùng.
import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? (argv[i + 1] ?? '') : null
}

let master
try {
  master = JSON.parse(readFileSync(new URL('./.ocean-master.json', import.meta.url), 'utf8'))
} catch {
  console.error('Chưa có worker/.ocean-master.json. Chạy `npm run setup` trước (hoặc tạo tệp {"url":"https://…workers.dev","syncKey":"…"}).')
  process.exit(1)
}

if (argv.includes('--list')) {
  const sql =
    "SELECT s.id, s.name, s.seen, s.locked, s.url IS NOT NULL AS online, u.username AS owner, u.locked AS owner_locked, " +
    "(SELECT COUNT(*) FROM deliveries d WHERE d.server = s.id AND d.pushed = 0) AS pending " +
    "FROM servers s LEFT JOIN users u ON u.id = s.owner ORDER BY s.seen DESC"
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'ocean-relay', '--remote', '--json', '--command', sql], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    if (/no such column|no such table/i.test(r.stdout + r.stderr)) console.error('\nD1 chưa có bảng mới: chạy `npx wrangler d1 migrations apply ocean-relay --remote` rồi thử lại.')
    process.exit(1)
  }
  const rows = JSON.parse(r.stdout)[0]?.results ?? []
  if (rows.length === 0) console.log('Chưa có Server nào kết nối.')
  const now = Math.floor(Date.now() / 1000)
  for (const x of rows) {
    const state = x.locked || x.owner_locked ? 'KHÓA' : !x.seen ? 'chưa kết nối' : now - x.seen <= 150 ? 'đang kết nối' : 'mất liên lạc'
    console.log(
      `${(x.id || '(đời cũ)').padEnd(28)} ${state.padEnd(13)} thấy ${(x.seen ? `${now - x.seen}s trước` : 'chưa').padEnd(14)}` +
        `chủ: ${(x.owner ?? '(Admin/đời cũ)').padEnd(16)} địa chỉ: ${x.online ? 'có' : 'chưa báo'}   chờ: ${x.pending}`,
    )
  }
  process.exit(0)
}

const name = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
if (!name) {
  console.error('Dùng: npm run issue -- "Tên người dùng" [--id server-id]   |   npm run issue -- --list')
  process.exit(1)
}
const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
const id = flag('id') || `${slug || 'user'}-${randomBytes(2).toString('hex')}`
if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(id)) {
  console.error('Server ID phải là chữ thường, số, gạch ngang, 3-40 ký tự, bắt đầu bằng chữ/số.')
  process.exit(1)
}
const key = createHmac('sha256', master.syncKey).update(`server:${id}`).digest('hex').slice(0, 48)
const code = 'ocean1.' + Buffer.from(JSON.stringify({ u: String(master.url).replace(/\/+$/, ''), i: id, k: key })).toString('base64url')

console.log(`\nServer ID : ${id}   (${name})`)
console.log('Mã kết nối (gửi riêng cho người dùng, dán vào bộ cài):\n')
console.log(code)
console.log('\nVPS cấp bằng lệnh này thuộc về Admin: nhận tín hiệu của Webhook URL chung (WEBHOOK_KEY).')
console.log(`Muốn alert chỉ đi tới Server này: thêm  &to=${id}  vào Webhook URL.`)
