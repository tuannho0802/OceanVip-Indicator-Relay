import path from 'node:path'
import { createLogger } from '../server/log'
import { loadEnvIfPresent } from '../shared/env'
import { Gateway, loadGatewayConfig } from './gateway'

loadEnvIfPresent('gateway.env')

const dir =
  process.env.OCEAN_LOG_DIR ??
  path.join(process.env.OCEAN_DATA ?? (process.platform === 'win32' ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'OceanRelayGateway') : path.resolve('data-gateway')), 'logs')
const log = createLogger('info', dir, 'gateway')

/** Nhịp hỏi Server cấu hình (đổi cổng ở trang Cài đặt có hiệu lực trong chừng này giây). */
const SYNC_MS = 5000

try {
  const cfg = loadGatewayConfig()
  const gw = new Gateway(cfg, fetch, () => Math.floor(Date.now() / 1000), log)
  log.info(`Gateway -> ${cfg.serverUrl} tfs=${cfg.tfs.join(',') || 'tất cả'} (cổng theo Server, mặc định ${cfg.port})`)

  // Một vòng: hỏi Server cổng mong muốn (trang Cài đặt) rồi mở/đổi cổng cho khớp. Không mở được cổng (đang bị chương trình khác
  // chiếm) thì KHÔNG thoát: giữ tiến trình sống, báo lý do lên Server để trang Cài đặt hiện lỗi, và thử lại ở vòng sau
  // (người dùng đổi sang cổng khác trên trang Cài đặt là chạy ngay).
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await gw.syncConfig()
      const before = `${gw.listeningPort}|${gw.portError}`
      await gw.ensureListening()
      // Vừa mở/đổi cổng xong hoặc vừa lỗi: báo Server ngay để giao diện không phải chờ vòng sau.
      if (`${gw.listeningPort}|${gw.portError}` !== before) await gw.syncConfig()
    } catch (e) {
      log.error(`vòng đồng bộ lỗi: ${String((e as Error).message ?? e).slice(0, 200)}`)
    } finally {
      busy = false
    }
  }
  void tick()
  setInterval(() => void tick(), SYNC_MS)
} catch (e) {
  log.error(`Cấu hình không hợp lệ: ${String((e as Error).message ?? e)}`)
  process.exit(2)
}
process.on('uncaughtException', (e) => {
  log.error(`uncaughtException: ${String(e.stack ?? e).slice(0, 500)}`)
  process.exit(1)
})
