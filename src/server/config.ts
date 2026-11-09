import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LogLevel } from './log'

export const APP_VERSION = '0.2.0'

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
  /** Khóa dùng chung với Worker (chữ ký push, kéo bù, báo địa chỉ tunnel). Rỗng = không dùng Worker. */
  syncKey: string
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

const defaultDataDir = (env: NodeJS.ProcessEnv): string =>
  env.OCEAN_DATA ?? (process.platform === 'win32' ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'OceanRelay') : path.resolve('data'))

/** Thư mục giao diện: cạnh server.mjs (gói phát hành: `web/`), hoặc `ui/` khi chạy từ mã nguồn. */
function defaultUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const c of [path.join(here, 'web'), path.resolve('web'), path.resolve('ui')]) if (existsSync(path.join(c, 'index.html'))) return c
  return path.resolve('ui')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = defaultDataDir(env)
  const level = (env.OCEAN_LOG_LEVEL ?? 'info') as LogLevel
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError('OCEAN_LOG_LEVEL phải là debug|info|warn|error')
  const syncKey = secret(env, 'OCEAN_SYNC_KEY', 32, false)
  const workerUrl = url(env, 'OCEAN_WORKER_URL')
  if (workerUrl && !syncKey) throw new ConfigError('Có OCEAN_WORKER_URL thì phải có OCEAN_SYNC_KEY (trùng SYNC_KEY của Worker)')
  if (syncKey && !workerUrl) throw new ConfigError('Có OCEAN_SYNC_KEY thì phải có OCEAN_WORKER_URL')
  const publicUrl = url(env, 'OCEAN_PUBLIC_URL')
  const quickTunnel = env.OCEAN_QUICK_TUNNEL === '1'
  // Worker đẩy được về VPS khi có địa chỉ công khai; không có thì chỉ còn cách Server tự kéo nên kéo dày hơn.
  const pushable = publicUrl !== '' || quickTunnel
  return {
    port: int(env, 'OCEAN_PORT', 8090, 1, 65535),
    host: env.OCEAN_HOST ?? '127.0.0.1',
    name: (env.OCEAN_SRV_NAME ?? 'OCEAN Relay').slice(0, 60),
    dataDir,
    dbFile: env.OCEAN_DB ?? path.join(dataDir, 'ocean.db'),
    logDir: env.OCEAN_LOG_DIR === '' ? null : (env.OCEAN_LOG_DIR ?? path.join(dataDir, 'logs')),
    logLevel: level,
    eaKey: secret(env, 'OCEAN_EA_KEY', 24, true),
    webhookKey: secret(env, 'OCEAN_WEBHOOK_KEY', 16, false),
    syncKey,
    workerUrl,
    pollSec: int(env, 'OCEAN_POLL_SEC', pushable ? 30 : 5, 2, 600),
    publicUrl,
    quickTunnel,
    cloudflared: (env.OCEAN_CLOUDFLARED ?? '').trim(),
    maxAgeSec: int(env, 'OCEAN_MAX_AGE_SEC', 120, 5, 3600),
    dedupeSec: int(env, 'OCEAN_DEDUPE_SEC', 300, 0, 86400),
    uiDir: env.OCEAN_UI_DIR ?? defaultUiDir(),
  }
}

export function ensureDataDir(cfg: ServerConfig): void {
  mkdirSync(cfg.dataDir, { recursive: true })
  if (cfg.dbFile !== ':memory:') mkdirSync(path.dirname(cfg.dbFile), { recursive: true })
}