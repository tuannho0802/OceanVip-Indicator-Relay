import path from 'node:path'
import { createLogger } from '../server/log'
import { loadEnvIfPresent } from '../shared/env'
import { Gateway, loadGatewayConfig } from './gateway'

loadEnvIfPresent('gateway.env')

const dir =
  process.env.OCEAN_LOG_DIR ??
  path.join(process.env.OCEAN_DATA ?? (process.platform === 'win32' ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'OceanRelayGateway') : path.resolve('data-gateway')), 'logs')
const log = createLogger('info', dir, 'gateway')

try {
  const cfg = loadGatewayConfig()
  const gw = new Gateway(cfg, fetch, () => Math.floor(Date.now() / 1000), log)
  const srv = gw.listen()
  srv.on('error', (e: NodeJS.ErrnoException) => {
    log.error(e.code === 'EADDRINUSE' ? `Cổng ${cfg.port} đang bị chiếm (OCEAN_GW_PORT)` : `Gateway lỗi: ${e.message}`)
    process.exit(2)
  })
  log.info(`Gateway 127.0.0.1:${cfg.port} -> ${cfg.serverUrl} tfs=${cfg.tfs.join(',') || 'tất cả'}`)
} catch (e) {
  log.error(`Cấu hình không hợp lệ: ${String((e as Error).message ?? e)}`)
  process.exit(2)
}
process.on('uncaughtException', (e) => {
  log.error(`uncaughtException: ${String(e.stack ?? e).slice(0, 500)}`)
  process.exit(1)
})
