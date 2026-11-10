// Cài Worker MỘT LẦN (chạy trên máy dev đã `wrangler login`):  cd worker && npm install && npm run setup
// Làm: tạo D1 `ocean-relay`, ghi database_id vào wrangler.jsonc, áp migration, sinh WEBHOOK_KEY + SYNC_KEY + mật khẩu Admin ngẫu nhiên,
// đặt chúng làm secret, deploy, rồi IN RA địa chỉ trang quản lý + tài khoản Admin (phải đổi mật khẩu ở lần đăng nhập đầu).
// SYNC_KEY là khóa GỐC: chỉ lưu ở máy chủ Worker (worker/.ocean-master.json, đã .gitignore); mọi mã kết nối VPS suy ra từ nó.
// Chạy lại setup KHÔNG đổi khóa (đã lưu trong .ocean-master.json) nên mã kết nối của người dùng vẫn sống. Muốn đổi khóa:
//   node setup.mjs --new-keys                                       (mọi mã kết nối cũ mất hiệu lực)
//   node setup.mjs --webhook-key <chuỗi> --sync-key <chuỗi>         (dùng đúng khóa này)
//   node setup.mjs --admin-user <tên> --admin-password <mật khẩu>   (Admin ban đầu; chỉ có tác dụng khi CHƯA có tài khoản nào)
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : ''
}
const rand = (n) => randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x')
const run = (args, input) => {
  const r = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', input, shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} lỗi:\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

const masterPath = new URL('./.ocean-master.json', import.meta.url)
let prev = {}
try {
  prev = JSON.parse(readFileSync(masterPath, 'utf8'))
} catch {
  /* chạy lần đầu */
}
const keep = !process.argv.includes('--new-keys')
const webhookKey = arg('webhook-key') || (keep && prev.webhookKey) || rand(24)
const syncKey = arg('sync-key') || (keep && prev.syncKey) || rand(36)
const adminUser = (arg('admin-user') || 'admin').trim().toLowerCase()
const adminPassword = arg('admin-password') || rand(12)
if (webhookKey.length < 16 || syncKey.length < 32) throw new Error('WEBHOOK_KEY >= 16 ký tự, SYNC_KEY >= 32 ký tự')
if (adminPassword.length < 8) throw new Error('Mật khẩu Admin tối thiểu 8 ký tự')
if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(adminUser)) throw new Error('Tên Admin: chữ thường, số, . _ - (3-32 ký tự)')

const cfgPath = new URL('./wrangler.jsonc', import.meta.url)
let cfg = readFileSync(cfgPath, 'utf8')
if (cfg.includes('00000000-0000-0000-0000-000000000000')) {
  let id = ''
  try {
    const out = run(['d1', 'create', 'ocean-relay'])
    id = /database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i.exec(out)?.[1] ?? ''
    if (!id) throw new Error(`Không đọc được database_id từ:\n${out}`)
    console.log('Đã tạo D1', id)
  } catch (e) {
    // Chạy lại setup (hoặc D1 tạo từ lần trước nhưng wrangler.jsonc chưa ghi ID): dùng lại D1 đã có thay vì dừng.
    if (!/already exists/i.test(String(e?.message))) throw e
    try {
      const list = JSON.parse(run(['d1', 'list', '--json']))
      id = list.find((d) => d.name === 'ocean-relay')?.uuid ?? ''
    } catch {
      /* rơi xuống thông báo lỗi bên dưới */
    }
    if (!id) throw new Error('D1 "ocean-relay" đã tồn tại nhưng không đọc được ID. Chạy `npx wrangler d1 list`, rồi dán uuid vào database_id trong worker/wrangler.jsonc và chạy lại `npm run setup`.')
    console.log('D1 ocean-relay đã có sẵn, dùng lại:', id)
  }
  cfg = cfg.replace('00000000-0000-0000-0000-000000000000', id)
  writeFileSync(cfgPath, cfg)
}
// Áp migration (theo dõi từng tệp đã chạy) chứ KHÔNG nạp schema.sql: migration 0003 có ALTER TABLE nên chỉ được chạy đúng một lần.
run(['d1', 'migrations', 'apply', 'ocean-relay', '--remote'])
run(['secret', 'put', 'WEBHOOK_KEY'], webhookKey)
run(['secret', 'put', 'SYNC_KEY'], syncKey)
run(['secret', 'put', 'ADMIN_PASSWORD'], adminPassword)
if (adminUser !== 'admin') run(['secret', 'put', 'ADMIN_USER'], adminUser)
const dep = run(['deploy'])
const url = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev/.exec(dep)?.[0] ?? 'https://ocean-relay.<tài-khoản>.workers.dev'

writeFileSync(masterPath, JSON.stringify({ url, syncKey, webhookKey }, null, 2))
console.log('\nXong. Lưu các giá trị sau (KHÔNG commit):')
console.log(`  Trang quản lý : ${url}/`)
console.log(`  Admin         : ${adminUser}  /  mật khẩu tạm: ${adminPassword}`)
console.log('                  (đổi mật khẩu ngay ở lần đăng nhập đầu. Mật khẩu này chỉ dùng để TẠO Admin khi chưa có tài khoản nào;')
console.log('                   nếu Admin đã tồn tại từ trước thì nó không đổi gì, hãy đăng nhập bằng mật khẩu hiện tại.)')
console.log('  Cấp tài khoản cho người dùng: đăng nhập trang quản lý → tab "Người dùng" → "+ Tạo" (không cần dòng lệnh).')
console.log('  Người dùng tự bấm "+ Thêm VPS" và "+ Tạo Webhook URL" trong hạn mức bạn cấp; trang tự sinh mã kết nối + URL để họ chỉ copy/dán.')
console.log(`  Webhook URL chung (đời cũ, tùy chọn): ${url}/webhook?key=${webhookKey}`)
console.log('  Alert TradingView: chọn "Any alert() function call"')
console.log('  Khóa gốc SYNC_KEY + WEBHOOK_KEY đã ghi vào worker/.ocean-master.json (không đưa cho người dùng).')
