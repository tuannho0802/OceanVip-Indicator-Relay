import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import type { Parsed } from '../shared/parse'

// Vite (Vitest) bỏ tiền tố `node:` của sqlite nên nạp qua require.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export type SignalRow = {
  id: number
  received_at: number
  dedupe: string
  kind: string
  side: string | null
  symbol: string | null
  tf: string | null
  entry: number | null
  sl: number | null
  tp1: number | null
  tp2: number | null
  tp3: number | null
  tp: number | null
  status: string | null
  raw: string
  note: string | null
  wid: number | null
  src: string
}

export type TerminalRow = {
  tid: string
  first_seen: number
  last_seen: number
  cursor: number
  login: string | null
  server: string | null
  balance: number | null
  equity: number | null
  margin: number | null
  free_margin: number | null
  ea_ver: string | null
  positions: string
}

export type DeliveryRow = { signal_id: number; tid: string; result: string; at: number }

/** Yêu cầu xóa tín hiệu: cũ hơn N ngày, hoặc tất cả tín hiệu đã xong. */
export type PurgeSpec = { kind: 'older'; days: number } | { kind: 'all' }
export type PurgeResult = { deleted: number; kept_fresh: number }

const MIGRATIONS: string[] = [
  `CREATE TABLE signals (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     received_at INTEGER NOT NULL,
     dedupe TEXT NOT NULL,
     kind TEXT NOT NULL,
     side TEXT, symbol TEXT, tf TEXT,
     entry REAL, sl REAL, tp1 REAL, tp2 REAL, tp3 REAL, tp REAL,
     status TEXT,
     raw TEXT NOT NULL,
     note TEXT
   );
   CREATE INDEX signals_dedupe ON signals (dedupe, received_at);
   CREATE TABLE terminals (
     tid TEXT PRIMARY KEY,
     first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
     cursor INTEGER NOT NULL DEFAULT 0,
     login TEXT, server TEXT, balance REAL, equity REAL, margin REAL, free_margin REAL,
     ea_ver TEXT, positions TEXT NOT NULL DEFAULT '[]'
   );
   CREATE TABLE deliveries (
     signal_id INTEGER NOT NULL, tid TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (signal_id, tid)
   );`,
  // 2: tín hiệu từ Worker mang mã wid (chống nhận hai lần khi push và kéo bù cùng chuyển) + bảng meta
  `ALTER TABLE signals ADD COLUMN wid INTEGER;
   ALTER TABLE signals ADD COLUMN src TEXT NOT NULL DEFAULT 'hook';
   CREATE UNIQUE INDEX signals_wid ON signals (wid) WHERE wid IS NOT NULL;
   CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
]

export class Store {
  readonly db: DatabaseSyncType
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v] as string)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    }
  }

  getMeta(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
    return r?.v ?? null
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
  }

  maxSignalId(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM signals').get() as { m: number }
    return r.m
  }

  /** Trả về id mới, hoặc null nếu trùng một tín hiệu cùng khóa trong cửa sổ `dedupeSec`. */
  insertSignal(
    p: Parsed,
    raw: string,
    dedupe: string | null,
    now: number,
    dedupeSec: number,
    ext?: { wid: number; receivedAt: number },
  ): { id: number } | { duplicateOf: number } {
    if (ext) {
      const same = this.db.prepare('SELECT id FROM signals WHERE wid = ?').get(ext.wid) as { id: number } | undefined
      if (same) return { duplicateOf: same.id }
    }
    if (dedupe) {
      const dup = this.db
        .prepare('SELECT id FROM signals WHERE dedupe = ? AND received_at >= ? ORDER BY id DESC LIMIT 1')
        .get(dedupe, now - dedupeSec) as { id: number } | undefined
      if (dup) return { duplicateOf: dup.id }
    }
    const q = p.kind === 'entry' ? p : null
    const u = p.kind === 'update' ? p : null
    const r = this.db
      .prepare(
        `INSERT INTO signals (received_at, dedupe, kind, side, symbol, tf, entry, sl, tp1, tp2, tp3, tp, status, raw, note, wid, src)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ext ? ext.receivedAt : now,
        dedupe ?? '',
        p.kind,
        q?.side ?? u?.side ?? null,
        q?.symbol ?? u?.symbol ?? null,
        q?.tf ?? u?.tf ?? null,
        q?.entry ?? u?.entry ?? null,
        q?.sl ?? u?.sl ?? null,
        q?.tp1 ?? null,
        q?.tp2 ?? null,
        q?.tp3 ?? null,
        u?.tp ?? null,
        u?.status ?? null,
        raw.slice(0, 2000),
        p.kind === 'unknown' ? p.reason : null,
        ext?.wid ?? null,
        ext ? 'worker' : 'hook',
      )
    return { id: Number(r.lastInsertRowid) }
  }

  recentSignals(limit: number): SignalRow[] {
    return this.db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT ?').all(limit) as SignalRow[]
  }

  upsertTerminal(t: {
    tid: string
    now: number
    login?: string
    server?: string
    balance?: number
    equity?: number
    margin?: number
    free_margin?: number
    ea_ver?: string
    positions?: string
  }): TerminalRow {
    const ex = this.db.prepare('SELECT * FROM terminals WHERE tid = ?').get(t.tid) as TerminalRow | undefined
    if (!ex) {
      // Terminal mới: không phát lại tín hiệu cũ, chỉ nhận từ bây giờ.
      this.db
        .prepare('INSERT INTO terminals (tid, first_seen, last_seen, cursor) VALUES (?,?,?,?)')
        .run(t.tid, t.now, t.now, this.maxSignalId())
    }
    this.db
      .prepare(
        `UPDATE terminals SET last_seen=?, login=COALESCE(?,login), server=COALESCE(?,server),
         balance=COALESCE(?,balance), equity=COALESCE(?,equity), margin=COALESCE(?,margin),
         free_margin=COALESCE(?,free_margin), ea_ver=COALESCE(?,ea_ver), positions=COALESCE(?,positions) WHERE tid=?`,
      )
      .run(
        t.now,
        t.login ?? null,
        t.server ?? null,
        t.balance ?? null,
        t.equity ?? null,
        t.margin ?? null,
        t.free_margin ?? null,
        t.ea_ver ?? null,
        t.positions ?? null,
        t.tid,
      )
    return this.db.prepare('SELECT * FROM terminals WHERE tid = ?').get(t.tid) as TerminalRow
  }

  terminals(): TerminalRow[] {
    return this.db.prepare('SELECT * FROM terminals ORDER BY last_seen DESC').all() as TerminalRow[]
  }

  /** Tín hiệu chưa giao cho terminal, còn trong hạn, theo thứ tự cũ → mới. */
  pending(tid: string, cursor: number, minReceivedAt: number, limit: number): SignalRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM signals s
         WHERE s.id > ? AND s.received_at >= ? AND s.kind IN ('entry','update')
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.signal_id = s.id AND d.tid = ?)
         ORDER BY s.id ASC LIMIT ?`,
      )
      .all(cursor, minReceivedAt, tid, limit) as SignalRow[]
  }

  ack(tid: string, signalId: number, result: string, now: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO deliveries (signal_id, tid, result, at) VALUES (?,?,?,?)')
      .run(signalId, tid, result.slice(0, 40), now)
  }

  deliveriesFor(signalIds: number[]): DeliveryRow[] {
    if (signalIds.length === 0) return []
    const q = signalIds.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM deliveries WHERE signal_id IN (${q})`).all(...signalIds) as DeliveryRow[]
  }

  /** Số tín hiệu đang lưu và thời điểm (giây) của tín hiệu cũ nhất (null nếu trống). */
  signalStats(): { count: number; oldest: number | null } {
    const r = this.db.prepare('SELECT COUNT(*) AS c, MIN(received_at) AS o FROM signals').get() as { c: number; o: number | null }
    return { count: r.c, oldest: r.o }
  }

  /**
   * Xóa tín hiệu ĐÃ XONG (kèm bản ghi giao nhận của chúng). Tín hiệu mới hơn `protectSec` giây được giữ lại vì EA còn có thể
   * đang nhận/xử lý chúng (xóa nhầm sẽ làm mất ack và lệnh đang mở dở).
   */
  purgeSignals(spec: PurgeSpec, now: number, protectSec: number): PurgeResult {
    const fresh = now - Math.max(0, protectSec)
    const cut = spec.kind === 'older' ? Math.min(fresh, now - spec.days * 86400) : fresh
    // Khoảng chọn: received_at < cut (tức đã xong và đủ cũ). Phần còn lại trong cửa sổ bảo vệ chỉ để báo số lượng giữ lại.
    const where = 'received_at < ?'
    this.db.exec('BEGIN')
    try {
      const del = (this.db.prepare(`SELECT COUNT(*) AS c FROM signals WHERE ${where}`).get(cut) as { c: number }).c
      this.db.prepare(`DELETE FROM deliveries WHERE signal_id IN (SELECT id FROM signals WHERE ${where})`).run(cut)
      this.db.prepare(`DELETE FROM signals WHERE ${where}`).run(cut)
      const kept = (this.db.prepare('SELECT COUNT(*) AS c FROM signals WHERE received_at >= ?').get(fresh) as { c: number }).c
      this.db.exec('COMMIT')
      return { deleted: del, kept_fresh: kept }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  prune(olderThan: number): void {
    this.db.prepare('DELETE FROM signals WHERE received_at < ?').run(olderThan)
    this.db.prepare('DELETE FROM deliveries WHERE at < ?').run(olderThan)
  }
}
