import type { Logger } from './log'

export type WorkerItem = { wid: number; age: number; raw: string }
export type IngestResult = 'new' | 'dup' | 'bad'

export type WorkerSyncOptions = {
    workerUrl: string
    /** Khóa riêng của Server này (không phải khóa gốc của Worker). */
    syncKey: string
    /** Server ID: Worker chỉ giao và cho kéo đúng tín hiệu của ID này. */
    serverId?: string
    pollSec: number
    log: Logger
    /** Đưa một tín hiệu vào Server (đồng bộ). 'dup' = đã có (push đã tới trước), 'bad' = hỏng nhưng đã xử lý xong. */
    ingest: (item: WorkerItem) => IngestResult
    fetchFn?: typeof fetch
    clock?: () => number
    /** Chỉ để kiểm thử: các mốc thử lại báo địa chỉ (giây). */
    reportRetrySec?: number[]
}

const MAX_RAW = 16 * 1024
/** Chu kỳ kéo (giây) khi Worker không có địa chỉ để đẩy tới. 30 giây vẫn dư nhiều lần trong hạn tín hiệu (mặc định 120 giây) mà chỉ bằng 1/3 số request so với 10 giây. */
const NO_PUSH_POLL_SEC = 30
/** Mạng từ VPS tới workers.dev đôi khi chậm; 8 giây thì hay hụt oan. */
const REQ_TIMEOUT_MS = 15_000
/** Báo địa chỉ lỗi thì thử lại sau 5, 10, 20, 40, 60 giây (không phải đợi tới nhịp kéo kế tiếp, có thể là 300 giây). */
const REPORT_RETRY_SEC = [5, 10, 20, 40, 60]

/**
 * Server (VPS) là bên chủ động gọi Worker, không phải EA: EA chỉ nói chuyện với Gateway/Server nên không tốn
 * request Worker. Việc Server làm với Worker chỉ có ba thứ, đều nhẹ:
 *  1. kéo bù các tín hiệu mà Worker chưa đẩy được (VPS/tunnel sập đúng lúc alert bắn);
 *  2. báo cho Worker biết địa chỉ Quick Tunnel hiện tại (đổi mỗi lần cloudflared chạy lại);
 *  3. xác nhận (ack) những tín hiệu đã nhận để lần sau không kéo lại.
 * Worker đã tự thử đẩy lại khi lỗi nên kéo bù chỉ là lưới an toàn, mặc định 300 giây ≈ 288 request/ngày trong tổng 100 nghìn của gói free.
 * Ngoài nhịp định kỳ, Server kéo bù NGAY sau khi báo địa chỉ tunnel mới (lúc dễ hụt tín hiệu nhất).
 */
export class WorkerSync {
    lastPollOk = 0
    lastError = ''
    pulled = 0
    private stopped = true
    private timer: NodeJS.Timeout | null = null
    /** undefined = chưa có gì để báo; null = báo "không có tunnel" để Worker bỏ địa chỉ cũ. */
  private desiredUrl: string | null | undefined = undefined
    private reportedUrl: string | null | undefined = undefined
    private running = false
    /** Worker gợi ý kéo dày hơn (giây) khi đường đẩy đang hụt; null = theo cấu hình. */
    private hintSec: number | null = null
    /** Chạy một nhịp ngay (đặt khi start): dùng để kéo liền khi vừa mất địa chỉ công khai. */
    private runTick: (() => Promise<void>) | null = null
    /** Các lần báo địa chỉ chạy nối đuôi nhau, không bao giờ hai request báo chồng nhau. */
    private chain: Promise<unknown> = Promise.resolve()
    private retryTimer: NodeJS.Timeout | null = null
    private retryN = 0

    constructor(private readonly o: WorkerSyncOptions) { }

    private get f(): typeof fetch {
        return this.o.fetchFn ?? fetch
    }

    private get now(): number {
        return (this.o.clock ?? (() => Math.floor(Date.now() / 1000)))()
    }

    private headers(): Record<string, string> {
        return { authorization: `Bearer ${this.o.syncKey}`, 'content-type': 'application/json', ...(this.o.serverId ? { 'x-ocean-server': this.o.serverId } : {}) }
    }

    /** `immediate = false`: nhịp đầu tiên chờ đủ một chu kỳ (khi người gọi vừa tự gọi tick() xong). */
    start(immediate = true): void {
        if (!this.stopped) return
        this.stopped = false
        const tick = async () => {
            if (this.stopped) return
            let ok = false
            try {
                ok = await this.tick()
            } catch (e) {
                this.o.log.error(`worker: ${String(e).slice(0, 160)}`)
            }
            if (this.stopped) return
            // Lỗi thì thử lại thưa hơn một chút để không dồn request vào Worker đang trục trặc (không bao giờ dày hơn chu kỳ thường).
            const wait = ok ? this.effectivePollSec() : Math.max(this.o.pollSec, Math.min(this.o.pollSec * 2, 120))
            this.timer = setTimeout(() => void tick(), wait * 1000)
            this.timer.unref()
        }
        this.runTick = tick
        if (immediate) void tick()
        else {
            this.timer = setTimeout(() => void tick(), this.effectivePollSec() * 1000)
            this.timer.unref()
        }
    }

    /** Chu kỳ kéo đang dùng: cấu hình, hoặc dày hơn nếu Worker gợi ý (không bao giờ thưa hơn cấu hình). */
    effectivePollSec(): number {
        // Không có địa chỉ công khai (tunnel đang tạo/đã rớt) thì Worker không đẩy được: kéo là đường duy nhất nên kéo dày, không đợi Worker gợi ý.
        const noPush = this.desiredUrl === null ? NO_PUSH_POLL_SEC : null
        return Math.min(this.o.pollSec, this.hintSec ?? this.o.pollSec, noPush ?? this.o.pollSec)
    }

    stop(): void {
        this.stopped = true
        this.runTick = null
        if (this.timer) clearTimeout(this.timer)
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = null
    }

    /** Địa chỉ VPS mà Worker nên đẩy tới (null = chưa có/đã rớt). Gửi ngay, và tự gửi lại ở các nhịp sau nếu lỗi. */
    setPublicUrl(url: string | null): void {
        const lost = url === null && this.desiredUrl !== null && this.desiredUrl !== undefined
        this.desiredUrl = url
        if (this.stopped) return
        // Vừa mất địa chỉ công khai (tunnel rớt): kéo ngay và chuyển sang nhịp dày, đừng đợi nốt chu kỳ 300 giây đang chờ.
        if (lost && this.runTick && !this.running) {
            if (this.timer) clearTimeout(this.timer)
            void this.runTick()
        }
        // Vừa báo xong địa chỉ mới thì kéo bù một lần: tín hiệu bắn trong lúc tunnel đổi địa chỉ đang nằm chờ ở Worker.
        void this.reportUrl().then((changed) => (changed && url !== null ? this.catchUp() : undefined)).catch(() => { /* đã ghi log và hẹn thử lại trong reportUrl */ })
    }

    private async catchUp(): Promise<void> {
        if (this.running) return
        this.running = true
        try {
            await this.pullOnce()
        } finally {
            this.running = false
        }
    }

    /** true = vừa báo một địa chỉ mới lên Worker. Lỗi thì ghi log, hẹn thử lại, rồi ném lỗi cho người gọi. */
    private reportUrl(): Promise<boolean> {
        const p = this.chain.then(() => this.doReport())
        this.chain = p.catch(() => { })
        return p
    }

    private async doReport(): Promise<boolean> {
        if (this.desiredUrl === undefined || this.desiredUrl === this.reportedUrl) return false
        const want = this.desiredUrl
        try {
            const res = await this.f(`${this.o.workerUrl}/api/tunnel`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ url: want }),
                signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
            })
            await res.body?.cancel()
            if (!res.ok) throw new Error(`báo địa chỉ lên Worker: HTTP ${res.status}`)
        } catch (e) {
            const msg = String((e as Error).message ?? e).slice(0, 160)
            this.lastError = msg.startsWith('báo địa chỉ') ? msg : `báo địa chỉ lên Worker: ${msg}`
            this.o.log.warn(`worker: ${this.lastError}`)
            this.scheduleReportRetry()
            throw e
        }
        this.reportedUrl = want
        this.retryN = 0
        this.o.log.info(want ? `worker: đã báo địa chỉ ${want}` : 'worker: đã báo tunnel rớt')
        // Trong lúc chờ phản hồi địa chỉ có thể đã đổi tiếp: báo nốt cái mới nhất.
        if (this.desiredUrl !== undefined && this.desiredUrl !== this.reportedUrl) void this.reportUrl().catch(() => { })
        return true
    }

    private scheduleReportRetry(): void {
        if (this.stopped || this.retryTimer) return
        const steps = this.o.reportRetrySec ?? REPORT_RETRY_SEC
        const wait = steps[Math.min(this.retryN, steps.length - 1)] ?? 60
        this.retryN += 1
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            if (this.stopped || this.desiredUrl === undefined || this.desiredUrl === this.reportedUrl) return
            void this.reportUrl()
                .then((changed) => (changed && this.desiredUrl !== null ? this.catchUp() : undefined))
                .catch(() => { /* doReport đã hẹn thử lại */ })
        }, wait * 1000)
        this.retryTimer.unref()
    }

    /** Một nhịp: báo địa chỉ (nếu còn chưa báo được) rồi kéo bù. Trả về true nếu Worker trả lời bình thường. */
    async tick(): Promise<boolean> {
        if (this.running) return true
        this.running = true
        try {
            try {
                await this.reportUrl()
            } catch {
                // đã ghi log và hẹn thử lại; vẫn kéo bù ở dưới
            }
            return await this.pullOnce()
        } finally {
            this.running = false
        }
    }

    async pullOnce(): Promise<boolean> {
        let res: Response
        try {
            res = await this.f(`${this.o.workerUrl}/api/pull`, { headers: this.headers(), signal: AbortSignal.timeout(REQ_TIMEOUT_MS) })
        } catch (e) {
            this.lastError = `không gọi được Worker: ${(e as Error).message}`.slice(0, 160)
            this.o.log.warn(`worker: ${this.lastError}`)
            return false
        }
        if (!res.ok) {
            await res.body?.cancel()
            let why = ''
            if (res.status === 401) why = ' (mã kết nối sai hoặc Worker đã đổi khóa gốc?)'
            else if (res.status === 403) why = ' (VPS hoặc tài khoản bị Admin khóa, hoặc VPS đã bị xóa khỏi Worker: hỏi Admin)'
            this.lastError = `Worker trả HTTP ${res.status}${why}`
            this.o.log.warn(`worker: ${this.lastError}`)
            return false
        }
        let data: { items?: unknown; tunnel?: unknown; poll?: unknown }
        try {
            data = (await res.json()) as { items?: unknown; tunnel?: unknown; poll?: unknown }
        } catch {
            this.lastError = 'Worker trả dữ liệu không đọc được'
            return false
        }
        this.lastPollOk = this.now
        this.lastError = ''
        this.hintSec = typeof data.poll === 'number' && Number.isInteger(data.poll) && data.poll >= 2 && data.poll <= 600 ? data.poll : null
        // Worker đang giữ địa chỉ khác địa chỉ thật của VPS (đã đổi, đã chết, hoặc VPS không còn tunnel): báo lại ngay, không đợi nhịp sau.
        if ('tunnel' in data && this.desiredUrl !== undefined) {
            const held = typeof data.tunnel === 'string' ? data.tunnel.toLowerCase() : null
            const want = this.desiredUrl === null ? null : this.desiredUrl.replace(/\/+$/, '').toLowerCase()
            if (held !== want) {
                this.reportedUrl = undefined
                void this.reportUrl().catch(() => { /* đã ghi log và hẹn thử lại */ })
            }
        }
        const items = Array.isArray(data.items) ? data.items : []
        const done: number[] = []
        for (const it of items.slice(0, 100) as Partial<WorkerItem>[]) {
            if (!Number.isInteger(it.wid) || (it.wid as number) <= 0 || typeof it.raw !== 'string' || it.raw.length > MAX_RAW) continue
            const age = typeof it.age === 'number' && Number.isFinite(it.age) ? Math.max(0, it.age) : 0
            const r = this.o.ingest({ wid: it.wid as number, age, raw: it.raw })
            if (r === 'new') {
                this.pulled++
                this.o.log.info(`worker: kéo bù tín hiệu wid=${it.wid} (tuổi ${Math.round(age)}s)`)
            }
            done.push(it.wid as number)
        }
        if (done.length > 0) {
            try {
                const r = await this.f(`${this.o.workerUrl}/api/ack`, {
                    method: 'POST',
                    headers: this.headers(),
                    body: JSON.stringify({ ids: done }),
                    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
                })
                await r.body?.cancel()
            } catch {
                // chưa ack được thì lần kéo sau gặp lại, Server nhận ra 'dup' nên không nhận hai lần
            }
        }
        return true
    }
}