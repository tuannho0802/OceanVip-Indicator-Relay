import { decodeConnectCode } from '../shared/connect'
import { DEFAULT_GW_PORT } from '../shared/defaults'
import { ConfigError, type ServerConfig, loadConfig } from './config'
import type { Logger } from './log'
import { DEFAULT_RETENTION_DAYS } from './retention'
import type { WorkerCheck } from './runtime'
import { type Settings, mergeSettings, normalizeSettings, readSettings, writeSettings } from './settings'

/** Trạng thái cài đặt hiện hành để trang Cài đặt hiển thị (chỉ trả cho máy chủ cục bộ, xem app.ts). */
export type SetupView = {
  /** Đã có Worker (mã kết nối hoặc cấu hình tay). */
  connected: boolean
  workerUrl: string
  serverId: string
  /** Dạng rút gọn của mã (không bao giờ trả cả mã/khóa ra ngoài). */
  codeHint: string
  accounts: string[]
  symbolMap: Record<string, string> | null
  tfs: string[] | null
  /** Cổng Gateway hiện hành (EA nối tới) và cổng mặc định, để trang Cài đặt ghi đúng địa chỉ cho Allow WebRequest. */
  gatewayPort: number
  defaultGatewayPort: number
  /** Tự xóa tín hiệu đã xong sau số ngày này (0 = không tự xóa) và mức mặc định. */
  retentionDays: number
  defaultRetentionDays: number
  /** 'ui' = đặt trên giao diện; 'env' = từ server.env; 'none' = chưa cài đặt. */
  source: 'ui' | 'env' | 'none'
  mode: 'quick' | 'public' | 'none'
}

export type SaveResult = { ok: true; view: SetupView; worker: WorkerCheck | null } | { ok: false; error: string }

export type SetupDeps = {
  cfg: ServerConfig
  env: NodeJS.ProcessEnv
  log: Logger
  /** Dựng lại các phần sống (Worker, tunnel) theo cfg mới; trả kết quả liên lạc thử với Worker. */
  apply: () => Promise<WorkerCheck | null>
}

/**
 * Lưu cài đặt từ giao diện và áp dụng ngay. Trình tự an toàn: kiểm tra → thử dựng cấu hình (lỗi thì chưa ghi gì)
 * → ghi tệp → áp vào cfg đang chạy → dựng lại Worker/tunnel. Cấu hình hỏng không bao giờ được ghi xuống đĩa,
 * nên lần khởi động sau không thể hỏng vì cài đặt.
 */
export class SetupController {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: SetupDeps) {}

  view(): SetupView {
    const { cfg } = this.d
    const s = readSettings(cfg.settingsFile)
    const code = decodeConnectCode(s.connectCode ?? this.d.env.OCEAN_CONNECT_CODE ?? '')
    return {
      connected: cfg.workerUrl !== '',
      workerUrl: cfg.workerUrl,
      serverId: cfg.serverId,
      codeHint: code ? `${code.serverId} @ ${code.workerUrl.replace(/^https:\/\//, '')}` : '',
      accounts: [...cfg.accounts],
      symbolMap: cfg.symbolMap,
      tfs: cfg.tfs,
      gatewayPort: cfg.gatewayPort,
      defaultGatewayPort: DEFAULT_GW_PORT,
      retentionDays: cfg.retentionDays,
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
      source: Object.keys(s).length > 0 ? 'ui' : cfg.workerUrl ? 'env' : 'none',
      mode: cfg.publicUrl ? 'public' : cfg.quickTunnel ? 'quick' : 'none',
    }
  }

  /** Lưu lần lượt từng yêu cầu (hai người bấm Lưu cùng lúc không đè nhau). */
  save(input: unknown): Promise<SaveResult> {
    const run = this.chain.then(() => this.doSave(input))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async doSave(input: unknown): Promise<SaveResult> {
    const { cfg, env, log } = this.d
    const n = normalizeSettings(input)
    if (!n.ok) return n
    const merged: Settings = mergeSettings(readSettings(cfg.settingsFile), n.value, n.remove)
    let next: ServerConfig
    try {
      next = loadConfig(env, merged)
    } catch (e) {
      return { ok: false, error: e instanceof ConfigError ? e.message : `Không áp dụng được cài đặt: ${String(e).slice(0, 200)}` }
    }
    try {
      writeSettings(cfg.settingsFile, merged)
    } catch (e) {
      log.error(`không ghi được ${cfg.settingsFile}: ${String(e).slice(0, 200)}`)
      return { ok: false, error: 'Không ghi được tệp cài đặt (kiểm tra quyền ghi thư mục dữ liệu).' }
    }
    // Những thứ không đổi lúc đang chạy (cổng, đường dẫn dữ liệu, khóa EA) giữ nguyên.
    const { port, host, dataDir, dbFile, logDir, logLevel, eaKey, uiDir, ...live } = next
    Object.assign(cfg, live)
    log.info(`đã lưu cài đặt từ giao diện: worker=${cfg.workerUrl ? 'có' : 'không'} id=${cfg.serverId || '-'} tàiKhoản=${cfg.accounts.length} symbolMap=${cfg.symbolMap ? Object.keys(cfg.symbolMap).length : 'mặc định'} tfs=${cfg.tfs ? cfg.tfs.join(',') || 'tất cả' : 'mặc định'} cổngGateway=${cfg.gatewayPort} giữTínHiệu=${cfg.retentionDays}ngày`)
    const worker = await this.d.apply()
    return { ok: true, view: this.view(), worker }
  }
}
