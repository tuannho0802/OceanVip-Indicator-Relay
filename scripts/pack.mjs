// Tạo gói phát hành release/ocean-relay (chạy TRÊN WINDOWS để node.exe đúng nền tảng):
//   npm run build && node scripts/pack.mjs   rồi nén thư mục release/ocean-relay thành .zip
import { cpSync, mkdirSync, rmSync } from 'node:fs'
const out = 'release/ocean-relay'
rmSync('release', { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const d of ['dist', 'ui', 'ea', 'scripts']) cpSync(d, `${out}/${d}`, { recursive: true })
if (process.platform === 'win32') cpSync(process.execPath, `${out}/node.exe`)
else console.warn('Cảnh báo: không phải Windows nên không đính kèm node.exe; máy đích cần cài Node 22.13+.')
console.log('Gói ở', out)
