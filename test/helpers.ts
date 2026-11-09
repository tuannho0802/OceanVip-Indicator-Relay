import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { ServerConfig } from '../src/server/config'
import type { D1Like, D1Stmt } from '../worker/src/handler'

export const EA_KEY = 'ea-key-0123456789abcdefghij'
export const WEBHOOK_KEY = 'webhook-key-1234567890'
export const SYNC_KEY = 'sync-key-0123456789abcdef0123456789'

export const baseCfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({
    port: 0, host: '127.0.0.1', name: 'test', dataDir: '.', dbFile: ':memory:', logDir: null, logLevel: 'error',
    eaKey: EA_KEY, webhookKey: WEBHOOK_KEY, syncKey: '', serverId: '', accounts: [], workerUrl: '', pollSec: 30,
    publicUrl: '', quickTunnel: false, cloudflared: '', maxAgeSec: 120, dedupeSec: 300, uiDir: 'ui',
    settingsFile: path.join(os.tmpdir(), 'ocean-test-never-written.json'), symbolMap: null, tfs: null, gatewayPort: 47860, gatewayPortSet: false,
    ...over,
})

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

/** D1 giả trên node:sqlite (đủ prepare/bind/run/first/all như Worker dùng) để chạy mã Worker thật trong test. */
export function fakeD1(schemaSql: string): D1Like & { raw: InstanceType<typeof DatabaseSync> } {
    const db = new DatabaseSync(':memory:')
    db.exec(schemaSql)
    const stmt = (sql: string, params: unknown[]): D1Stmt => ({
        bind: (...v) => stmt(sql, v),
        run: async () => {
            db.prepare(sql).run(...(params as never[]))
            return {}
        },
        first: async <T>() => ((db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null),
        all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
    })
    return { prepare: (sql) => stmt(sql, []), raw: db }
}