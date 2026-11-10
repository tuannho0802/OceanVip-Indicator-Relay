import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>

const migrations = readdirSync('worker/migrations').filter((f) => f.endsWith('.sql')).sort()
const sql = (f: string) => readFileSync(`worker/migrations/${f}`, 'utf8')

/** Bảng -> danh sách cột (thứ tự theo cid) + tên chỉ mục, để so hai cách dựng DB. */
function shape(db: DatabaseSync): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  for (const t of tables) out[t.name] = (db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name)
  out['#indexes'] = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((i) => i.name)
  return out
}

describe('schema.sql và migrations phải dựng ra cùng một cơ sở dữ liệu', () => {
  it('áp lần lượt mọi migration == schema.sql (cùng bảng, cột, thứ tự cột, chỉ mục)', () => {
    const a = new DatabaseSync(':memory:')
    for (const f of migrations) a.exec(sql(f))
    const b = new DatabaseSync(':memory:')
    b.exec(readFileSync('worker/schema.sql', 'utf8'))
    expect(shape(a)).toEqual(shape(b))
  })

  it('nâng cấp D1 cũ (chỉ có 0001+0002, đã có dữ liệu) lên 0003: dữ liệu giữ nguyên, VPS cũ không có chủ', () => {
    const db = new DatabaseSync(':memory:')
    for (const f of migrations.filter((m) => !m.startsWith('0003'))) db.exec(sql(f))
    db.exec("INSERT INTO servers (id, url, seen) VALUES ('nam-1', 'https://x.trycloudflare.com', 100)")
    db.exec("INSERT INTO signals (created, raw) VALUES (100, 'BUY XAUUSD')")
    db.exec(sql(migrations.find((m) => m.startsWith('0003')) as string))
    expect(db.prepare('SELECT id, url, owner, locked FROM servers').get()).toEqual({ id: 'nam-1', url: 'https://x.trycloudflare.com', owner: null, locked: 0 })
    expect(db.prepare('SELECT raw, owner, hook FROM signals').get()).toEqual({ raw: 'BUY XAUUSD', owner: null, hook: null })
  })

  it('0001 và 0002 chạy lại nhiều lần vẫn an toàn (D1 tạo bằng cách cũ nạp schema.sql chưa có bảng theo dõi migration)', () => {
    const db = new DatabaseSync(':memory:')
    for (const f of migrations.filter((m) => !m.startsWith('0003'))) db.exec(sql(f))
    for (const f of migrations.filter((m) => !m.startsWith('0003'))) expect(() => db.exec(sql(f))).not.toThrow()
  })
})
