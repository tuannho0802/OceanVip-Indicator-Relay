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
  /** Gọi mỗi khi địa chỉ đổi: chuỗi (tunnel ĐÃ thông, dùng được) hoặc null (tunnel vừa rớt/đang tạo lại). */
  onChange: (url: string | null) => void
  /** Chỉ để kiểm thử. */
  spawnFn?: typeof spawn
  fetchFn?: typeof fetch
  ensureBin?: (file: string) => Promise<void>
  /** false khi `binPath` là tệp người dùng tự chỉ định (OCEAN_CLOUDFLARED): hỏng thì báo lỗi, không xóa. Mặc định true. */
  managedBin?: boolean
  /** Dọn cloudflared sót từ lần trước, gọi một lần khi bắt đầu. Mặc định `killStaleCloudflared`. */
  killStale?: (binPath: string) => void
  /** Chu kỳ kiểm tra tunnel còn thông khi đang chạy ổn (ms). Mặc định 20 giây. */
  healthEveryMs?: number
  /** Chu kỳ thử kết nối khi tunnel mới có địa chỉ mà chưa thông (ms). Mặc định 2 giây. */
  connectEveryMs?: number
  /** Chờ chừng này sau khi tunnel đã báo thông (ok) mới bắt đầu tính lần kiểm hỏng. */
  graceMs?: number
  /** Số lần kiểm hỏng liên tiếp thì khởi động lại cloudflared. */
  maxFails?: number
  /** Địa chỉ mới có mà quá chừng này (ms) vẫn chưa thông thì bỏ, chạy lại để xin địa chỉ khác. Mặc định 90 giây. */
  connectTimeoutMs?: number
  /** Tunnel đã rớt quá chừng này (ms) mà chưa tự thông lại thì chạy lại để xin địa chỉ mới. Mặc định 45 giây. */
  downRestartMs?: number
  /** Thời gian chờ trước lần chạy lại (ms), tăng dần rồi giữ ở mức cuối. */
  backoffMs?: number[]
}

/**
 * starting   : cloudflared đang chạy, chưa có địa chỉ.
 * connecting : đã có địa chỉ nhưng CHƯA chứng minh được là thông (chưa báo cho Worker).
 * ok         : thông (đã báo địa chỉ cho Worker).
 * down       : từng thông nhưng vừa rớt (đã báo "không có" cho Worker); đang chờ tự thông lại hoặc chạy lại.
 */
export type TunnelState = 'starting' | 'connecting' | 'ok' | 'down'
export type TunnelStatus = {
  state: TunnelState
  /** Địa chỉ đang dùng được (đã báo Worker); null khi chưa thông hoặc đã rớt. */
  url: string | null
  /** Địa chỉ gần nhất cloudflared cấp (kể cả khi đã rớt), để hiện trên giao diện. */
  lastUrl: string | null
  /** Thời điểm (ms) vào trạng thái hiện tại. */
  since: number
  /** Số lần phải chạy lại cloudflared kể từ khi Server khởi động. */
  restarts: number
  error: string
  /** Lần kiểm tra /api/health qua tunnel gần nhất (ms Unix; 0 = chưa) và độ trễ của nó. */
  checkedAt: number
  rttMs: number | null
  /** Số kết nối đang mở từ cloudflared tới Cloudflare (đọc từ log; 0 khi chưa có). */
  connections: number
}

/**
 * Plan 3G: giữ một Quick Tunnel (`*.trycloudflare.com`) luôn chạy cho VPS. Địa chỉ đổi mỗi lần cloudflared chạy lại,
 * nên mỗi khi đổi, `onChange` được gọi để báo cho Worker (cửa trước cố định) biết chuyển tiếp tới đâu.
 *
 * Quan trọng: địa chỉ chỉ được báo (và hiện trên giao diện) SAU KHI tunnel thật sự thông. cloudflared in địa chỉ ngay khi xin được,
 * trước cả lúc nối tới Cloudflare; nếu báo sớm hoặc để địa chỉ chết nằm lại thì Worker đẩy vào đó và nhận HTTP 530 / lỗi 1033.
 * Tunnel rớt thì báo ngay "không có" cho Worker (Worker chuyển sang chờ VPS kéo) rồi tự tạo tunnel mới.
 */
export class QuickTunnel {
  private current: string | null = null
  private proc: ChildProcess | null = null
  private stopped = true
  private timers = new Set<NodeJS.Timeout>()
  private wake: (() => void) | null = null
  private fails = 0
  private urlAt = 0
  // --- trạng thái của lần chạy cloudflared hiện tại ---
  private state: TunnelState = 'starting'
  private stateAt = Date.now()
  private seenUrl: string | null = null
  private lastUrl: string | null = null
  private seenAt = 0
  private conns = 0
  private registered = false
  private downAt = 0
  private buf = ''
  private checking = false
  private restarts = 0
  private lastError = ''
  private checkedAt = 0
  private rttMs: number | null = null

  constructor(private readonly opts: QuickTunnelOptions) {}

  /** Địa chỉ đang dùng được (đã thông); null khi chưa thông hoặc đã rớt. */
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
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref()
      this.timers.add(t)
    }
    every(this.opts.healthEveryMs ?? 20_000, () => {
      if (this.state === 'ok' || this.state === 'down') void this.check()
    })
    every(this.opts.connectEveryMs ?? 2_000, () => {
      if (this.state === 'connecting') void this.check()
    })
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers.clear()
    this.wake?.()
    this.proc?.kill()
  }

  private setState(s: TunnelState): void {
    if (s === this.state) return
    this.state = s
    this.stateAt = Date.now()
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
      this.setUrl(null)
      this.resetRun()
      if (this.stopped) return
      this.restarts += 1
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

  /** Quên mọi thứ của lần chạy cloudflared trước (giữ lại lastUrl để giao diện còn nói được "địa chỉ cũ đã chết"). */
  private resetRun(): void {
    this.seenUrl = null
    this.seenAt = 0
    this.conns = 0
    this.registered = false
    this.downAt = 0
    this.fails = 0
    this.buf = ''
    this.setState('starting')
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
      this.fails = 0
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

  /** Đọc log cloudflared theo từng dòng: lấy địa chỉ, và đếm kết nối đang mở (Registered / Unregistered tunnel connection). */
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
        this.seenAt = Date.now()
        this.setState('connecting')
        this.opts.log.info(`tunnel: cloudflared cấp địa chỉ ${found}, đang đợi tunnel thông trước khi báo cho Worker`)
        void this.check()
      }
    }
    if (/Unregistered tunnel connection/.test(line)) {
      this.conns = Math.max(0, this.conns - 1)
      if (this.conns === 0 && this.registered) this.markDown('cloudflared mất hết kết nối tới Cloudflare')
    } else if (/(?<![A-Za-z])Registered tunnel connection/.test(line)) {
      this.conns += 1
      this.registered = true
      if (this.state === 'connecting' || this.state === 'down') void this.check()
    }
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

  /** Tunnel đã thông (đã chứng minh): báo địa chỉ cho Worker. */
  private markOk(url: string): void {
    this.fails = 0
    this.downAt = 0
    this.lastError = ''
    this.setState('ok')
    this.setUrl(url)
  }

  /** Tunnel vừa rớt: báo "không có" cho Worker ngay (đừng để nó đẩy vào địa chỉ chết), giữ tiến trình để chờ tự thông lại. */
  private markDown(reason: string): void {
    if (this.state !== 'ok') return
    this.lastError = reason
    this.downAt = Date.now()
    this.setState('down')
    this.opts.log.warn(`tunnel: ${reason}`)
    this.setUrl(null)
  }

  private kill(why: string): void {
    this.opts.log.warn(`tunnel: ${why} -> chạy lại để xin địa chỉ mới`)
    this.fails = 0
    this.proc?.kill()
  }

  /** Địa chỉ phải trả lời `/api/health` của chính VPS khi gọi từ Internet. */
  private async probe(url: string): Promise<{ ok: boolean; definitive: boolean; ms: number; error: string }> {
    const t0 = Date.now()
    try {
      const res = await (this.opts.fetchFn ?? fetch)(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) })
      await res.body?.cancel()
      // Có phản hồi mà không phải của Server mình (530/1033/502...) = Cloudflare nói tunnel này không có ai trả lời: chắc chắn hỏng.
      return { ok: res.ok, definitive: !res.ok, ms: Date.now() - t0, error: res.ok ? '' : `HTTP ${res.status} từ Cloudflare (tunnel không có cloudflared trả lời)` }
    } catch (e) {
      // Không có phản hồi (DNS chưa nhận, timeout...): chưa kết luận được, có thể do chính mạng của VPS.
      return { ok: false, definitive: false, ms: Date.now() - t0, error: `không gọi được tunnel: ${String((e as Error)?.message ?? e).slice(0, 80)}` }
    }
  }

  private async check(): Promise<void> {
    const url = this.seenUrl
    if (!url || !this.proc || this.checking) return
    const connecting = this.state === 'connecting'
    if (!connecting && this.state === 'ok' && Date.now() - this.urlAt < (this.opts.graceMs ?? 30_000)) return
    this.checking = true
    try {
      const r = await this.probe(url)
      if (this.seenUrl !== url || !this.proc) return // trong lúc chờ đã chạy lại
      this.checkedAt = Date.now()
      if (r.ok) {
        this.rttMs = r.ms
        if (this.state !== 'ok') this.markOk(url)
        else this.fails = 0
        return
      }
      this.rttMs = null
      if (connecting) {
        // Mới xin được địa chỉ: vài giây đầu chưa thông là bình thường. Quá hạn mà vẫn không thông thì bỏ địa chỉ này.
        if (Date.now() - this.seenAt > (this.opts.connectTimeoutMs ?? 90_000)) {
          this.lastError = r.error
          // cloudflared báo đã nối mà VPS không tự gọi được địa chỉ (DNS/mạng của VPS): tin cloudflared thay vì chạy lại vô tận.
          if (this.registered && !r.definitive) this.markOk(url)
          else this.kill(`địa chỉ ${url} không thông sau ${Math.round((this.opts.connectTimeoutMs ?? 90_000) / 1000)} giây (${r.error})`)
        }
        return
      }
      // Không có phản hồi (DNS/mạng của chính VPS) mà cloudflared vẫn còn kết nối tới Cloudflare: chưa chứng minh được tunnel hỏng, không đếm.
      if (!r.definitive && this.conns > 0) {
        this.lastError = r.error
        return
      }
      this.fails += 1
      this.lastError = r.error
      this.opts.log.warn(`tunnel: kiểm tra hỏng (${this.fails}/${this.opts.maxFails ?? 3}): ${r.error}`)
      // Hai lần hỏng liền: báo ngay cho Worker thôi đẩy vào địa chỉ này; chưa chạy lại vội vì có thể chỉ chập chờn.
      if (this.fails >= 2) this.markDown(r.error)
      const downTooLong = this.state === 'down' && this.downAt > 0 && Date.now() - this.downAt > (this.opts.downRestartMs ?? 45_000)
      if (this.fails >= (this.opts.maxFails ?? 3) || downTooLong) this.kill(`tunnel rớt (${r.error})`)
    } finally {
      this.checking = false
    }
  }
}
