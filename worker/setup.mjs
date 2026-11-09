// Cài Worker MỘT LẦN (chạy trên máy dev đã `wrangler login`):  cd worker && npm install && npm run setup
// Làm: tạo D1 `ocean-relay`, ghi database_id vào wrangler.jsonc, nạp schema, sinh WEBHOOK_KEY + SYNC_KEY ngẫu nhiên,
// đặt cả hai làm secret, deploy, rồi IN RA Webhook URL cho TradingView. SYNC_KEY là khóa GỐC: chỉ lưu ở máy chủ Worker
// (worker/.ocean-master.json, đã .gitignore) và dùng cho `npm run issue` để phát mã kết nối cho từng người dùng. Dùng lại khóa cũ:
//   node setup.mjs --webhook-key <chuỗi> --sync-key <chuỗi>
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

const webhookKey = arg('webhook-key') || rand(24)
const syncKey = arg('sync-key') || rand(36)
if (webhookKey.length < 16 || syncKey.length < 32) throw new Error('WEBHOOK_KEY >= 16 ký tự, SYNC_KEY >= 32 ký tự')

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
run(['d1', 'execute', 'ocean-relay', '--remote', '--file', 'schema.sql'])
run(['secret', 'put', 'WEBHOOK_KEY'], webhookKey)
run(['secret', 'put', 'SYNC_KEY'], syncKey)
const dep = run(['deploy'])
const url = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev/.exec(dep)?.[0] ?? 'https://ocean-relay.<tài-khoản>.workers.dev'

writeFileSync(new URL('./.ocean-master.json', import.meta.url), JSON.stringify({ url, syncKey }, null, 2))
console.log('\nXong. Lưu các giá trị sau (KHÔNG commit):')
console.log('  (Setup sinh khóa MỚI: mã ocean1.… đã phát từ trước không còn dùng được, hãy cấp lại bằng npm run issue.)')
console.log(`  Webhook URL (dán vào TradingView): ${url}/webhook?key=${webhookKey}`)
console.log('  Alert TradingView: chọn "Any alert() function call"')
console.log('  Khóa gốc SYNC_KEY đã ghi vào worker/.ocean-master.json (không đưa cho người dùng).')
console.log('  Phát mã kết nối cho từng người dùng:  npm run issue -- "Tên người dùng"')
