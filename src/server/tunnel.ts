import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Logger } from './log'

const URL_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi

/** Lấy địa chỉ Quick Tunnel từ log của cloudflared (bỏ `api.trycloudflare.com` là máy chủ cấp tunnel). */
export function extractTunnelUrl(text: string): string | null {
  for (const m of text.matchAll(URL_RE)) {
    if (m[1]?.toLowerCase() !== 'api') return m[0].toLowerCase()
  }
  return null
}

const RELEASE_LATEST = 'https://github.com/cloudflare/cloudflared/releases/latest/download'

/**
 * Bản cloudflared cuối cùng còn chạy được trên Windows 8.1 / Server 2012 R2 (build bằng Go 1.20; Go 1.21 trở đi
 * bỏ hỗ trợ các Windows này nên bản `latest` báo "not a valid application for this OS platform", Node báo spawn EFTYPE).
 */
export const LEGACY_WINDOWS_VERSION = '2023.10.0'

/** Windows trước 10 (Windows 7/8/8.1, Server 2008 R2/2012/2012 R2) có `os.release()` bắt đầu bằng 6. */
export function isLegacyWindows(
  platform: string = process.platform,
  release: string = os.release(),
): boolean {
  if (platform !== 'win32') return false
  const major = Number.parseInt(release.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major < 10
}

/** Thư mục tải cloudflared: bản mới nhất, hoặc bản ghim cho Windows cũ. */
export function cloudflaredReleaseBase(legacy: boolean = isLegacyWindows()): string {
  return legacy
    ? `https://github.com/cloudflare/cloudflared/releases/download/${LEGACY_WINDOWS_VERSION}`
    : RELEASE_LATEST
}

/** Tên tệp cloudflared trên trang phát hành; null nếu hệ điều hành này phải tự đặt `OCEAN_CLOUDFLARED`. */
export function cloudflaredAsset(platform: string = process.platform, arch: string = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'cloudflared-windows-amd64.exe'
  if (platform === 'linux' && arch === 'x64') return 'cloudflared-linux-amd64'
  if (platform === 'linux' && arch === 'arm64') return 'cloudflared-linux-arm64'
  return null
}

/** Tệp cloudflared có chạy được trên máy này không (`--version` thoát mã 0). Hệ điều hành không hợp thì spawn lỗi. */
export function cloudflaredRuns(file: string): boolean {
  try {
    const res = spawnSync(file, ['--version'], { timeout: 15_000, windowsHide: true })
    return !res.error && res.status === 0
  } catch {
    return false
  }
}

export type EnsureCloudflaredOptions = {
  /** Thư mục tải (mặc định theo hệ điều hành, xem `cloudflaredReleaseBase`). */
  base?: string
  /** Kiểm tệp chạy được; chỉ để kiểm thử. */
  verify?: (file: string) => boolean
  /** true: tệp do Server tự quản (tải về cạnh dữ liệu) nên hỏng thì xóa và tải lại; false: tệp người dùng chỉ định, không đụng tới. */
  managed?: boolean
}

// Tệp đã kiểm một lần trong tiến trình này thì khỏi kiểm lại mỗi lần chạy lại tunnel; tệp vừa tải mà vẫn hỏng
// thì không tải đi tải lại (55 MB mỗi 30 giây), chỉ báo lỗi rõ ràng.
const verifiedOk = new Set<string>()
const knownBad = new Set<string>()

/**
 * Có tệp rồi và chạy được thì dùng luôn. Tệp hỏng/không hợp hệ điều hành (ví dụ bản mới nhất trên Server 2012 R2)
 * thì xóa và tải lại đúng bản. Chưa có thì tải về cạnh dữ liệu (ghi tạm rồi đổi tên để không để lại tệp dở).
 */
export async function ensureCloudflared(
  file: string,
  fetchFn: typeof fetch = fetch,
  asset: string | null = cloudflaredAsset(),
  opts: EnsureCloudflaredOptions = {},
): Promise<void> {
  const verify = opts.verify ?? cloudflaredRuns
  const managed = opts.managed ?? true
  if (existsSync(file)) {
    if (verifiedOk.has(file) || verify(file)) {
      verifiedOk.add(file)
      return
    }
    if (!managed || knownBad.has(file))
      throw new Error(
        `cloudflared không chạy được trên máy này (${file}): đặt OCEAN_CLOUDFLARED trỏ tới bản tương thích` +
          (isLegacyWindows() ? ` (Windows cũ cần bản ${LEGACY_WINDOWS_VERSION})` : ''),
      )
    rmSync(file, { force: true })
  }
  if (!asset)
    throw new Error('hệ điều hành này không có bản cloudflared tự tải: đặt OCEAN_CLOUDFLARED')
  mkdirSync(path.dirname(file), { recursive: true })
  const res = await fetchFn(`${opts.base ?? cloudflaredReleaseBase()}/${asset}`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`tải cloudflared lỗi HTTP ${res.status}`)
  const tmp = `${file}.part`
  try {
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
    if (process.platform !== 'win32') chmodSync(tmp, 0o755)
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
  if (verify(file)) {
    verifiedOk.add(file)
    return
  }
  knownBad.add(file)
  throw new Error(`cloudflared vừa tải về không chạy được trên máy này (${file})`)
}

/**
 * Tắt các cloudflared còn sót từ lần chạy trước (Server bị tắt cưỡng bức hoặc VPS reset giữa chừng thì tiến trình
 * con không tự chết). Chỉ tắt đúng tệp `binPath` của mình, không đụng cloudflared dịch vụ Tunnel có tên khác.
 */
export function killStaleCloudflared(binPath: string): void {
  try {
    if (process.platform === 'win32') {
      const esc = binPath.replace(/'/g, "''")
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.ExecutablePath -eq '${esc}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        ],
        { windowsHide: true, timeout: 20_000 },
      )
    } else {
      spawnSync('pkill', ['-f', `${binPath} tunnel`], { timeout: 5_000 })
    }
  } catch {
    // không dọn được thì thôi: tiến trình sót chỉ tốn chút tài nguyên
  }
}

export type QuickTunnelOptions = {
  /** Cổng HTTP của chính Server (tunnel trỏ vào 127.0.0.1:cổng này). */
  port: number
  /** Đường dẫn cloudflared; chưa có thì tải về. */
  binPath: string
  /** Tệp ghi địa chỉ tunnel hiện tại (để người vận hành xem). */
  urlFile: string
  log: Logger
  /** Gọi mỗi khi địa chỉ đổi: chuỗi (địa chỉ mới, đã báo được) hoặc null (cloudflared vừa thoát / bị chạy lại). */
  onChange: (url: string | null) => void
  /** Chỉ để kiểm thử. */
  spawnFn?: typeof spawn
  fetchFn?: typeof fetch
  ensureBin?: (file: string) => Promise<void>
  /** false khi `binPath` là tệp người dùng tự chỉ định (OCEAN_CLOUDFLARED): hỏng thì báo lỗi, không xóa. Mặc định true. */
  managedBin?: boolean
  /** Dọn cloudflared sót từ lần trước, gọi một lần khi bắt đầu. Mặc định `killStaleCloudflared`. */
  killStale?: (binPath: string) => void
  /** Chu kỳ tự kiểm tra tunnel còn thông (ms). Mặc định 60 giây. */
  healthEveryMs?: number
  /** Sau khi báo địa chỉ, chờ chừng này mới bắt đầu kiểm (ms). Mặc định 30 giây. */
  graceMs?: number
  /** Có địa chỉ mà chưa thấy cloudflared báo "Registered tunnel connection" thì vẫn báo cho Worker sau chừng này (ms). Mặc định 15 giây. */
  announceAfterMs?: number
  /** Số lần kiểm hỏng LIÊN TIẾP thì khởi động lại cloudflared. Mặc định 3. */
  maxFails?: number
  /** Thời gian chờ trước lần chạy lại (ms), tăng dần rồi giữ ở mức cuối. */
  backoffMs?: number[]
}

/**
 * starting   : chưa có địa chỉ (mới khởi động).
 * connecting : cloudflared đã in địa chỉ, đang đợi nó nối tới Cloudflare (chưa báo Worker).
 * ok         : đã báo địa chỉ cho Worker.
 * down       : cloudflared vừa thoát/bị chạy lại, đang chờ địa chỉ mới (`lastUrl` là địa chỉ cũ đã chết).
 */
export type TunnelState = 'starting' | 'connecting' | 'ok' | 'down'
export type TunnelStatus = {
  state: TunnelState
  /** Địa chỉ đang dùng (đã báo Worker); null khi chưa có hoặc đã rớt. */
  url: string | null
  /** Địa chỉ gần nhất cloudflared cấp (kể cả đã chết), để giao diện hiện được. */
  lastUrl: string | null
  /** Thời điểm (ms) vào trạng thái hiện tại. */
  since: number
  /** Số lần phải chạy lại cloudflared kể từ khi Server khởi động. */
  restarts: number
  error: string
  /** Lần kiểm tra /api/health qua tunnel gần nhất (ms Unix; 0 = chưa) và độ trễ của nó (null nếu lần đó hỏng). */
  checkedAt: number
  rttMs: number | null
  /** Số kết nối cloudflared → Cloudflare đọc từ log. Chỉ để HIỂN THỊ, không dùng để quyết định chạy lại. */
  connections: number
}

/**
 * Plan 3G: giữ một Quick Tunnel (`*.trycloudflare.com`) luôn chạy cho VPS. Địa chỉ đổi mỗi lần cloudflared chạy lại,
 * nên mỗi khi đổi, `onChange` được gọi để báo cho Worker (cửa trước cố định) biết chuyển tiếp tới đâu.
 *
 * Chính sách (theo AZ-Sentinel, đã chạy ổn): MỖI LẦN CHẠY LẠI LÀ MỘT ĐỊA CHỈ MỚI nên chỉ chạy lại khi thật sự cần:
 *  - cloudflared tự thoát; hoặc
 *  - `maxFails` lần kiểm LIÊN TIẾP (mỗi `healthEveryMs`) đều hỏng HẲN (Cloudflare trả 530/1033...).
 * Không làm những việc từng khiến tunnel đổi liên tục:
 *  - KHÔNG gọi thử địa chỉ vừa cấp: DNS của VPS nhớ "không tồn tại" cho tên mới, các lần gọi sau cũng hỏng mãi.
 *  - KHÔNG suy diễn "rớt" từ log (Unregistered...) và KHÔNG báo null chỉ vì một lần kiểm hỏng: cloudflared tự nối lại từng kết nối.
 *  - Gọi không ra phản hồi (DNS/mạng của chính VPS) mà cloudflared vẫn còn kết nối thì không tính là hỏng.
 */
export class QuickTunnel {
  private current: string | null = null
  private proc: ChildProcess | null = null
  private stopped = true
  private timers = new Set<NodeJS.Timeout>()
  private announceTimer: NodeJS.Timeout | null = null
  private wake: (() => void) | null = null
  private fails = 0
  private urlAt = 0
  private state: TunnelState = 'starting'
  private stateAt = Date.now()
  private seenUrl: string | null = null
  private lastUrl: string | null = null
  private conns = 0
  private buf = ''
  private checking = false
  private restarts = 0
  private lastError = ''
  private checkedAt = 0
  private rttMs: number | null = null

  constructor(private readonly opts: QuickTunnelOptions) {}

  /** Địa chỉ đang dùng (đã báo Worker); null khi chưa có hoặc đã rớt. */
  url(): string | null {
    return this.current
  }

  status(): TunnelStatus {
    return {
      state: this.state,
      url: this.current,
      lastUrl: this.lastUrl,
      since: this.stateAt,
      restarts: this.restarts,
      error: this.lastError,
      checkedAt: this.checkedAt,
      rttMs: this.rttMs,
      connections: this.conns,
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
    const t = setInterval(() => void this.check(), this.opts.healthEveryMs ?? 60_000)
    t.unref()
    this.timers.add(t)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers.clear()
    this.clearAnnounce()
    this.wake?.()
    this.proc?.kill()
  }

  private setState(s: TunnelState): void {
    if (s === this.state) return
    this.state = s
    this.stateAt = Date.now()
  }

  private clearAnnounce(): void {
    if (this.announceTimer) clearTimeout(this.announceTimer)
    this.announceTimer = null
  }

  private async loop(): Promise<void> {
    const delays = this.opts.backoffMs ?? [2_000, 5_000, 15_000, 30_000]
    let attempt = 0
    try {
      ;(this.opts.killStale ?? killStaleCloudflared)(this.opts.binPath)
    } catch {
      // bỏ qua
    }
    while (!this.stopped) {
      const startedAt = Date.now()
      this.resetRun()
      try {
        await (
          this.opts.ensureBin ??
          ((f) =>
            ensureCloudflared(f, this.opts.fetchFn, undefined, {
              managed: this.opts.managedBin ?? true,
            }))
        )(this.opts.binPath)
        await this.runOnce()
      } catch (error) {
        this.lastError = String(error).slice(0, 200)
        this.opts.log.error(`tunnel: ${this.lastError}`)
      }
      this.clearAnnounce()
      this.setUrl(null)
      this.seenUrl = null
      this.conns = 0
      this.fails = 0
      this.buf = ''
      if (this.stopped) return
      this.restarts += 1
      this.setState('down')
      // Chạy ổn được một lúc thì coi như lỗi mới, không phạt tiếp lần chờ cũ.
      attempt = Date.now() - startedAt > 60_000 ? 0 : attempt + 1
      const wait = delays[Math.min(attempt, delays.length - 1)] ?? 30_000
      this.opts.log.warn(`tunnel: sẽ chạy lại sau ${Math.round(wait / 1000)} giây`)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait)
        this.wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      this.wake = null
    }
  }

  /** Quên trạng thái của lần chạy cloudflared trước (giữ `lastUrl` để giao diện còn nói được "địa chỉ cũ đã chết"). */
  private resetRun(): void {
    this.clearAnnounce()
    this.seenUrl = null
    this.conns = 0
    this.fails = 0
    this.buf = ''
    if (this.restarts === 0) this.setState('starting')
  }

  private runOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const run = this.opts.spawnFn ?? spawn
      const proc = run(
        this.opts.binPath,
        ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.opts.port}`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      this.proc = proc
      proc.stdout?.on('data', (b: Buffer) => this.onData(b))
      proc.stderr?.on('data', (b: Buffer) => this.onData(b))
      proc.on('error', (e) => reject(e))
      proc.on('exit', (code) => {
        this.proc = null
        this.opts.log.warn(`tunnel: cloudflared thoát (mã ${code ?? '?'})`)
        resolve()
      })
    })
  }

  /** Đọc log cloudflared theo từng dòng: lấy địa chỉ và đếm kết nối (chỉ để hiển thị + biết cloudflared đã nối). */
  private onData(chunk: Buffer): void {
    this.buf += chunk.toString()
    if (this.buf.length > 16_384) this.buf = this.buf.slice(-8_192)
    const lines = this.buf.split(/\r?\n/)
    this.buf = lines.pop() ?? ''
    for (const line of lines) this.onLine(line)
  }

  private onLine(line: string): void {
    if (!this.seenUrl) {
      const found = extractTunnelUrl(line)
      if (found) {
        this.seenUrl = found
        this.lastUrl = found
        this.setState('connecting')
        this.opts.log.info(`tunnel: cloudflared cấp địa chỉ ${found}, đợi nó nối tới Cloudflare rồi báo cho Worker`)
        // Phòng khi log không có dòng "Registered" (bản cloudflared khác định dạng): vẫn báo sau một lúc, không gọi thử địa chỉ.
        this.clearAnnounce()
        this.announceTimer = setTimeout(() => this.announce(found), this.opts.announceAfterMs ?? 15_000)
        this.announceTimer.unref()
      }
    }
    if (/Unregistered tunnel connection/.test(line)) {
      this.conns = Math.max(0, this.conns - 1)
    } else if (/(?<![A-Za-z])Registered tunnel connection/.test(line)) {
      this.conns += 1
      if (this.seenUrl) this.announce(this.seenUrl)
    }
  }

  /** Báo địa chỉ cho Worker (một lần cho mỗi địa chỉ). Không gọi thử địa chỉ ở đây. */
  private announce(url: string): void {
    if (this.seenUrl !== url || this.current === url) return
    this.clearAnnounce()
    this.fails = 0
    this.lastError = ''
    this.checkedAt = 0
    this.rttMs = null
    this.setState('ok')
    this.setUrl(url)
  }

  private setUrl(url: string | null): void {
    if (url === this.current) return
    this.current = url
    this.urlAt = url ? Date.now() : 0
    try {
      if (url) writeFileSync(this.opts.urlFile, `${url}\n`)
      else rmSync(this.opts.urlFile, { force: true })
    } catch {
      // ghi tệp phụ lỗi không được làm hỏng tunnel
    }
    this.opts.log.info(url ? `tunnel: địa chỉ hiện tại ${url}` : 'tunnel: đã rớt')
    try {
      this.opts.onChange(url)
    } catch (error) {
      this.opts.log.error(`tunnel: onChange lỗi ${String(error).slice(0, 120)}`)
    }
  }

  /** Địa chỉ phải trả lời `/api/health` của VPS; hỏng HẲN `maxFails` lần LIÊN TIẾP mới giết cloudflared để xin địa chỉ mới. */
  private async check(): Promise<void> {
    const url = this.current
    if (!url || !this.proc || this.checking || this.state !== 'ok') return
    if (Date.now() - this.urlAt < (this.opts.graceMs ?? 30_000)) return
    this.checking = true
    const t0 = Date.now()
    let ok = false
    let definitive = false
    let error = ''
    try {
      const res = await (this.opts.fetchFn ?? fetch)(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) })
      ok = res.ok
      // Có phản hồi mà không phải của Server mình (530/1033/502...) = Cloudflare nói tunnel này không có ai trả lời.
      definitive = !res.ok
      if (!ok) error = `HTTP ${res.status} từ Cloudflare (tunnel không có cloudflared trả lời)`
      await res.body?.cancel()
    } catch (e) {
      // Không có phản hồi (DNS/mạng của chính VPS, timeout): chưa kết luận được.
      error = `không gọi được tunnel: ${String((e as Error)?.message ?? e).slice(0, 80)}`
    }
    try {
      if (this.current !== url || !this.proc) return // trong lúc chờ đã đổi địa chỉ / chạy lại
      this.checkedAt = Date.now()
      if (ok) {
        this.fails = 0
        this.lastError = ''
        this.rttMs = Date.now() - t0
        return
      }
      this.rttMs = null
      this.lastError = error
      if (!definitive && this.conns > 0) return // cloudflared vẫn còn kết nối: lỗi nằm ở phía VPS tự gọi, không phải tunnel
      this.fails += 1
      this.opts.log.warn(`tunnel: kiểm tra hỏng (${this.fails}/${this.opts.maxFails ?? 3}): ${error}`)
      if (this.fails >= (this.opts.maxFails ?? 3)) {
        this.fails = 0
        this.opts.log.warn('tunnel: hỏng liên tiếp, chạy lại cloudflared để xin địa chỉ mới')
        this.proc?.kill()
      }
    } finally {
      this.checking = false
    }
  }
}
