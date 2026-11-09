import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_ID_RE, decodeConnectCode } from '../shared/connect'
import { DEFAULT_GW_PORT, MAX_PORT, MIN_GW_PORT } from '../shared/defaults'
import type { LogLevel } from './log'
import { type Settings, overlayEnv, settingsPath } from './settings'

export const APP_VERSION = process.env.OCEAN_VERSION ?? '0.1.0'

export type ServerConfig = {
  port: number
  host: string
  /** Tên hiện trên giao diện. */
  name: string
  dataDir: string
  dbFile: string
  logDir: string | null
  logLevel: LogLevel
  /** Khóa EA/Gateway: Gateway gửi lên, Server dùng để biết đúng là EA của mình và ký tín hiệu giao xuống. Bắt buộc. */
  eaKey: string
  /** Khóa trong URL webhook gọi thẳng vào Server (không qua Worker). Rỗng = tắt đường webhook trực tiếp. */
  webhookKey: string
  /** Khóa RIÊNG của Server này với Worker (suy ra từ khóa gốc; nằm trong mã kết nối). Rỗng = không dùng Worker. */
  syncKey: string
  /** Server ID trong mã kết nối. Bắt buộc khi dùng Worker; Worker dựa vào đây để giao đúng tín hiệu cho Server này. */
  serverId: string
  /** Số tài khoản MT5 được phép nhận tín hiệu từ Server này (rỗng = mọi tài khoản dùng đúng OCEAN_EA_KEY). */
  accounts: string[]
  /** Địa chỉ Worker, ví dụ https://ocean-relay.<tên>.workers.dev. */
  workerUrl: string
  /** Chu kỳ Server kéo bù tín hiệu từ Worker (giây). */
  pollSec: number
  /** Địa chỉ HTTPS công khai của VPS (Cloudflare Tunnel có tên). Rỗng nếu dùng Quick Tunnel hoặc chưa có. */
  publicUrl: string
  quickTunnel: boolean
  /** Đường dẫn cloudflared do người dùng chỉ định (rỗng = tự tải về thư mục dữ liệu). */
  cloudflared: string
  /** Tín hiệu cũ hơn ngưỡng này (giây) không giao cho EA nữa. */
  maxAgeSec: number
  dedupeSec: number
  uiDir: string
  /** Tệp cài đặt do giao diện web ghi (settings.json). */
  settingsFile: string
  /** Ánh xạ symbol đặt trên giao diện; Server gửi xuống Gateway. null = để Gateway dùng cấu hình của nó. */
  symbolMap: Record<string, string> | null
  /** Khung giờ đặt trên giao diện ([] = tất cả); null = để Gateway dùng cấu hình của nó. */
  tfs: string[] | null
  /** Cổng cục bộ Gateway phải nghe (EA nối tới): trang Cài đặt thắng OCEAN_GW_PORT, mặc định 47860. Gateway hỏi Server và tự đổi theo. */
  gatewayPort: number
  /** Cổng Gateway đã được đặt rõ (trang Cài đặt hoặc OCEAN_GW_PORT). Chưa đặt thì Server KHÔNG ép cổng lên Gateway (Gateway ở máy khác giữ cổng riêng). */
  gatewayPortSet: boolean
}

export class ConfigError extends Error { }

const int = (env: NodeJS.ProcessEnv, k: string, def: number, min: number, max: number): number => {
  const raw = env[k]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${k} phải là số nguyên từ ${min} đến ${max} (đang là "${raw}")`)
  return n
}

const secret = (env: NodeJS.ProcessEnv, k: string, minLen: number, required: boolean): string => {
  const v = (env[k] ?? '').trim()
  if (!v) {
    if (required) throw new ConfigError(`${k} chưa đặt (khóa ngẫu nhiên từ ${minLen} ký tự, chỉ gồm chữ, số, _ và -)`)
    return ''
  }
  if (v.length < minLen || v.length > 128 || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new ConfigError(`${k} phải dài ${minLen}-128 ký tự, chỉ gồm chữ, số, _ và -`)
  }
  return v
}

const url = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = (env[k] ?? '').trim().replace(/\/+$/, '')
  if (v && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(v)) throw new ConfigError(`${k} phải có dạng https://ten-mien (không có đường dẫn, không có / ở cuối)`)
  return v
}

export const defaultDataDir = (env: NodeJS.ProcessEnv): string =>
  env.OCEAN_DATA ?? (process.platform === 'win32' ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'OceanRelay') : path.resolve('data'))

/** Thư mục giao diện: cạnh server.mjs (gói phát hành: `web/`), hoặc `ui/` khi chạy từ mã nguồn. */
function defaultUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const c of [path.join(here, 'web'), path.resolve('web'), path.resolve('ui')]) if (existsSync(path.join(c, 'index.html'))) return c
  return path.resolve('ui')
}

/**
 * Đọc cấu hình từ biến môi trường (server.env) rồi áp cài đặt từ giao diện web (settings.json) lên trên.
 * Gọi lại với cài đặt mới để áp dụng ngay không cần chạy lại Server.
 */
export function loadConfig(baseEnv: NodeJS.ProcessEnv = process.env, settings: Settings = {}): ServerConfig {
  const env = overlayEnv(baseEnv, settings)
  const dataDir = defaultDataDir(env)
  const level = (env.OCEAN_LOG_LEVEL ?? 'info') as LogLevel
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError('OCEAN_LOG_LEVEL phải là debug|info|warn|error')
  // Mã kết nối điền sẵn Worker + Server ID + khóa riêng; biến lẻ (nếu đặt) thắng mã.
  let code: ReturnType<typeof decodeConnectCode> = null
  if ((env.OCEAN_CONNECT_CODE ?? '').trim()) {
    code = decodeConnectCode(env.OCEAN_CONNECT_CODE ?? '')
    if (!code) throw new ConfigError('OCEAN_CONNECT_CODE không hợp lệ (mã phải bắt đầu bằng ocean1. và còn nguyên vẹn; xin chủ Worker cấp lại)')
  }
  const syncKey = (env.OCEAN_SYNC_KEY ?? '').trim() ? secret(env, 'OCEAN_SYNC_KEY', 32, false) : (code?.key ?? '')
  const workerUrl = (env.OCEAN_WORKER_URL ?? '').trim() ? url(env, 'OCEAN_WORKER_URL') : (code?.workerUrl ?? '')
  const serverId = (env.OCEAN_SERVER_ID ?? '').trim() || (code?.serverId ?? '')
  if (workerUrl && !syncKey) throw new ConfigError('Có OCEAN_WORKER_URL thì phải có OCEAN_SYNC_KEY (khóa riêng trong mã kết nối)')
  if (syncKey && !workerUrl) throw new ConfigError('Có OCEAN_SYNC_KEY thì phải có OCEAN_WORKER_URL')
  // serverId rỗng = Server đời cũ dùng thẳng khóa gốc (Worker vẫn nhận). Có thì phải đúng dạng.
  if (workerUrl && serverId !== '' && !SERVER_ID_RE.test(serverId)) throw new ConfigError('OCEAN_SERVER_ID không hợp lệ (chữ thường, số, gạch ngang, 3-40 ký tự); hoặc dùng OCEAN_CONNECT_CODE thay cho nó')
  const accounts = (env.OCEAN_ACCOUNTS ?? '').split(/[,\s;]+/).filter(Boolean)
  if (accounts.some((a) => !/^\d{3,12}$/.test(a))) throw new ConfigError('OCEAN_ACCOUNTS chỉ gồm số tài khoản MT5, cách nhau bằng dấu phẩy (ví dụ 900001,900002)')
  const publicUrl = url(env, 'OCEAN_PUBLIC_URL')
  const quickTunnel = env.OCEAN_QUICK_TUNNEL === '1'
  const port = int(env, 'OCEAN_PORT', 8090, 1, 65535)
  const gatewayPort = int(env, 'OCEAN_GW_PORT', DEFAULT_GW_PORT, MIN_GW_PORT, MAX_PORT)
  if (gatewayPort === port) throw new ConfigError(`Cổng Gateway (${gatewayPort}) không được trùng cổng Server (${port}). Chọn một cổng khác.`)
  // Worker đẩy được về VPS khi có địa chỉ công khai; không có thì chỉ còn cách Server tự kéo nên kéo dày hơn.
  const pushable = publicUrl !== '' || quickTunnel
  return {
    port,
    host: env.OCEAN_HOST ?? '127.0.0.1',
    name: (env.OCEAN_SRV_NAME ?? 'OCEAN Relay').slice(0, 60),
    dataDir,
    dbFile: env.OCEAN_DB ?? path.join(dataDir, 'ocean.db'),
    logDir: env.OCEAN_LOG_DIR === '' ? null : (env.OCEAN_LOG_DIR ?? path.join(dataDir, 'logs')),
    logLevel: level,
    eaKey: secret(env, 'OCEAN_EA_KEY', 24, true),
    webhookKey: secret(env, 'OCEAN_WEBHOOK_KEY', 16, false),
    syncKey,
    serverId,
    accounts: [...new Set(accounts)],
    workerUrl,
    pollSec: int(env, 'OCEAN_POLL_SEC', pushable ? 30 : 5, 2, 600),
    publicUrl,
    quickTunnel,
    cloudflared: (env.OCEAN_CLOUDFLARED ?? '').trim(),
    maxAgeSec: int(env, 'OCEAN_MAX_AGE_SEC', 120, 5, 3600),
    dedupeSec: int(env, 'OCEAN_DEDUPE_SEC', 300, 0, 86400),
    uiDir: env.OCEAN_UI_DIR ?? defaultUiDir(),
    settingsFile: settingsPath(dataDir),
    symbolMap: settings.symbolMap ?? null,
    tfs: settings.tfs ?? null,
    gatewayPort,
    gatewayPortSet: (env.OCEAN_GW_PORT ?? '').trim() !== '',
  }
}

export function ensureDataDir(cfg: ServerConfig): void {
  mkdirSync(cfg.dataDir, { recursive: true })
  if (cfg.dbFile !== ':memory:') mkdirSync(path.dirname(cfg.dbFile), { recursive: true })
}