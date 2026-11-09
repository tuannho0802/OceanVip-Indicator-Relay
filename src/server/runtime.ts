import path from 'node:path'
import type { ServerConfig } from './config'
import type { Logger } from './log'
import { QuickTunnel } from './tunnel'
import { WorkerSync, type WorkerItem, type IngestResult } from './worker-sync'

export type WorkerCheck = { ok: boolean; error: string }

export type RuntimeDeps = {
  log: Logger
  ingest: (item: WorkerItem) => IngestResult
  /** Chỉ để test: thay bộ gọi Worker / bộ tạo tunnel thật. */
  makeSync?: (o: ConstructorParameters<typeof WorkerSync>[0]) => WorkerSync
  makeTunnel?: (o: ConstructorParameters<typeof QuickTunnel>[0]) => QuickTunnel
  fetchFn?: typeof fetch
}

/**
 * Giữ các phần "sống" của Server (đồng bộ với Worker, Quick Tunnel) và dựng lại chúng theo cấu hình hiện hành.
 * apply() được gọi lúc khởi động và mỗi khi người dùng lưu cài đặt trên giao diện, nên đổi mã kết nối / tài khoản
 * có hiệu lực ngay, không phải chạy lại Server hay bộ cài.
 */
export class Runtime {
  sync: WorkerSync | null = null
  tunnel: QuickTunnel | null = null

  constructor(
    private readonly cfg: ServerConfig,
    private readonly d: RuntimeDeps,
  ) {}

  /** Dựng lại theo `cfg`. Có Worker thì thử liên lạc ngay một lần và báo kết quả (để giao diện hiện "đã kết nối" hoặc lý do lỗi). */
  async apply(): Promise<WorkerCheck | null> {
    const { cfg, d } = this
    this.sync?.stop()
    this.sync = null

    const needTunnel = cfg.quickTunnel && !cfg.publicUrl
    if (!needTunnel && this.tunnel) {
      this.tunnel.stop()
      this.tunnel = null
    }

    let check: WorkerCheck | null = null
    if (cfg.workerUrl) {
      const opts = { workerUrl: cfg.workerUrl, syncKey: cfg.syncKey, serverId: cfg.serverId, pollSec: cfg.pollSec, log: d.log, ingest: d.ingest, fetchFn: d.fetchFn }
      const sync = d.makeSync ? d.makeSync(opts) : new WorkerSync(opts)
      this.sync = sync
      if (cfg.publicUrl) sync.setPublicUrl(cfg.publicUrl)
      // Tunnel đang chạy từ trước: báo ngay địa chỉ hiện tại cho Server/Worker mới dựng.
      else if (this.tunnel) sync.setPublicUrl(this.tunnel.url())
    }

    if (needTunnel && !this.tunnel) {
      const bin = cfg.cloudflared || path.join(cfg.dataDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
      // Địa chỉ Quick Tunnel của lần chạy trước đã chết: báo "chưa có" tới khi tunnel mới lên.
      this.sync?.setPublicUrl(null)
      const opts = {
        port: cfg.port,
        binPath: bin,
        urlFile: path.join(cfg.dataDir, 'tunnel-url.txt'),
        log: d.log,
        managedBin: cfg.cloudflared === '',
        // Địa chỉ Quick Tunnel đổi mỗi lần cloudflared chạy lại: báo Worker để nó đẩy tín hiệu đúng chỗ.
        onChange: (url: string | null) => this.sync?.setPublicUrl(url),
      }
      this.tunnel = d.makeTunnel ? d.makeTunnel(opts) : new QuickTunnel(opts)
      this.tunnel.start()
    }

    if (this.sync) {
      const sync = this.sync
      // Liên lạc thử một lần (tối đa ~20 giây) rồi mới chạy vòng định kỳ.
      await Promise.race([sync.tick().catch(() => false), new Promise((r) => setTimeout(r, 20_000).unref())])
      check = { ok: sync.lastPollOk > 0 && sync.lastError === '', error: sync.lastError || (sync.lastPollOk > 0 ? '' : 'Worker chưa trả lời') }
      sync.start(false)
    }
    return check
  }

  stop(): void {
    this.tunnel?.stop()
    this.sync?.stop()
  }
}
