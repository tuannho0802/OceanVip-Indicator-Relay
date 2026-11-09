import path from 'node:path'
import { loadEnvIfPresent } from '../shared/env'
loadEnvIfPresent('server.env')
import { createApp } from './app'
import { APP_VERSION, ConfigError, ensureDataDir, loadConfig, type ServerConfig } from './config'
import { createLogger } from './log'
import { QuickTunnel } from './tunnel'
import { WorkerSync } from './worker-sync'

const fatal = (msg: string): never => {
  // Chạy nền không có cửa sổ: ghi cả vào tệp log để check-server.ps1 và người vận hành thấy lý do.
  try {
    const dir = process.env.OCEAN_LOG_DIR ?? path.join(process.env.OCEAN_DATA ?? (process.platform === 'win32' ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'OceanRelay') : path.resolve('data')), 'logs')
    createLogger('error', dir).error(msg)
  } catch {
    console.error(msg)
  }
  return process.exit(2)
}

let cfg: ServerConfig
try {
  cfg = loadConfig()
} catch (e) {
  fatal(e instanceof ConfigError ? `Cấu hình không hợp lệ: ${e.message}` : `Không đọc được cấu hình: ${String(e)}`)
  throw e
}

const mask = (s: string) => (s ? `${s.slice(0, 4)}…(${s.length} ký tự)` : '(trống)')

// `node server.mjs info`: in địa chỉ và cấu hình để dán vào TradingView / cài Gateway ở máy khác.
if (process.argv[2] === 'info') {
  const show = process.argv.includes('--show-keys')
  const k = (s: string) => (show ? s || '(trống)' : mask(s))
  console.log(`OCEAN Relay Server ${APP_VERSION}`)
  console.log(`  Giao diện         : http://127.0.0.1:${cfg.port}/${cfg.publicUrl ? `   |   ${cfg.publicUrl}/` : ''}`)
  console.log(`  EA key            : ${k(cfg.eaKey)}   (dán vào Gateway ở máy khác)`)
  console.log(`  Webhook trực tiếp : ${cfg.webhookKey ? `${cfg.publicUrl || '<địa chỉ công khai>'}/webhook?key=${show ? cfg.webhookKey : mask(cfg.webhookKey)}` : 'tắt (không có OCEAN_WEBHOOK_KEY)'}`)
  console.log(`  Worker            : ${cfg.workerUrl || '(không dùng)'}   SYNC_KEY ${k(cfg.syncKey)}   kéo bù mỗi ${cfg.pollSec}s`)
  console.log(`  Quick Tunnel      : ${cfg.quickTunnel ? 'bật' : 'tắt'}   Dữ liệu: ${cfg.dataDir}`)
  if (!show) console.log('  (thêm --show-keys để hiện đủ khóa)')
  process.exit(0)
}

ensureDataDir(cfg)
const log = createLogger(cfg.logLevel, cfg.logDir)
process.on('uncaughtException', (e) => {
  log.error(`uncaughtException: ${String(e.stack ?? e).slice(0, 500)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => log.error(`unhandledRejection: ${String(e).slice(0, 300)}`))

let tunnel: QuickTunnel | null = null
let sync: WorkerSync | null = null

const app = createApp(cfg, {
  log,
  tunnelUrl: () => tunnel?.url() ?? null,
  workerStatus: () => ({ lastPollOk: sync?.lastPollOk ?? 0, lastError: sync?.lastError ?? '', pulled: sync?.pulled ?? 0 }),
})

app.server.on('error', (e: NodeJS.ErrnoException) => {
  fatal(e.code === 'EADDRINUSE' ? `Cổng ${cfg.port} đang bị chương trình khác chiếm (đổi OCEAN_PORT hoặc tắt chương trình đó)` : `Server lỗi: ${e.message}`)
})

app.server.listen(cfg.port, cfg.host, () => {
  log.info(`OCEAN Relay Server ${APP_VERSION} http://${cfg.host}:${cfg.port} db=${cfg.dbFile} maxAge=${cfg.maxAgeSec}s worker=${cfg.workerUrl || 'không'} webhookTrựcTiếp=${cfg.webhookKey ? 'bật' : 'tắt'}`)

  if (cfg.workerUrl) {
    sync = new WorkerSync({ workerUrl: cfg.workerUrl, syncKey: cfg.syncKey, pollSec: cfg.pollSec, log, ingest: app.ingestFromWorker })
    if (cfg.publicUrl) sync.setPublicUrl(cfg.publicUrl)
    sync.start()
  }
  if (cfg.quickTunnel && !cfg.publicUrl) {
    const bin = cfg.cloudflared || path.join(cfg.dataDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
    tunnel = new QuickTunnel({
      port: cfg.port,
      binPath: bin,
      urlFile: path.join(cfg.dataDir, 'tunnel-url.txt'),
      log,
      managedBin: cfg.cloudflared === '',
      // Địa chỉ Quick Tunnel đổi mỗi lần cloudflared chạy lại: báo Worker để nó đẩy tín hiệu đúng chỗ.
      onChange: (url) => sync?.setPublicUrl(url),
    })
    tunnel.start()
  }
})

setInterval(() => app.store.prune(Math.floor(Date.now() / 1000) - 30 * 86400), 6 * 3600 * 1000).unref()

const shutdown = () => {
  tunnel?.stop()
  sync?.stop()
  app.close()
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown)