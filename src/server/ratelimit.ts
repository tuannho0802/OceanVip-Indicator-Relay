/** Giới hạn số lần sai khóa theo khóa (thường là IP) trong một cửa sổ thời gian. Trong bộ nhớ: khởi động lại thì xóa. */
export class FailLimiter {
    private hits = new Map<string, number[]>()
    constructor(
        private readonly max: number,
        private readonly windowSec: number,
    ) { }

    private live(key: string, now: number): number[] {
        const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowSec)
        if (arr.length > 0) this.hits.set(key, arr)
        else this.hits.delete(key)
        return arr
    }

    blocked(key: string, now: number): boolean {
        return this.live(key, now).length >= this.max
    }

    fail(key: string, now: number): void {
        const arr = this.live(key, now)
        arr.push(now)
        this.hits.set(key, arr)
        if (this.hits.size > 5000) this.hits.clear() // chặn phình bộ nhớ khi bị quét
    }
}