import { SERVER_ID_RE } from '../../src/shared/connect'
import { PARAM_KEYS, REMOTE_PARAMS, parseValuesJson, sanitizePatch } from '../../src/shared/params'
import { LOGIN_RE, MAX_ACCOUNTS, sanitizeAccountReports } from '../../src/shared/switch'
import { pushParams, pushSwitch } from './deliver'
import type { Env } from './handler'
import { json } from './http'

/**
 * Bật/tắt EA từ xa theo từng tài khoản MT + cấp quyền cho người dùng khác (không theo dõi tài khoản: chỉ số tài khoản, tên sàn, công tắc).
 *
 *  - Admin: thấy mọi VPS + mọi tài khoản MT, bật/tắt tất cả, và là người DUY NHẤT cấp quyền.
 *  - Chủ VPS: thấy và bật/tắt mọi tài khoản MT trên VPS của mình.
 *  - Người được cấp quyền: chỉ thấy VPS được cấp, và trong đó chỉ đúng những tài khoản được chọn. Tài khoản khác trên cùng VPS
 *    không xuất hiện trong bất kỳ phản hồi nào (không phân biệt được "không có" với "không được phép").
 *
 * Worker (D1) giữ trạng thái mong muốn. Đổi công tắc = `rev + 1` rồi đẩy ngay xuống VPS (`/api/switch`); hụt thì VPS nhận ở lần kéo kế tiếp
 * (`/api/pull` kèm `switches`) và báo lại qua `/api/accounts` (`applied_rev`).
 */
export type Actor = { id: number; role: 'admin' | 'user'; username: string }
type Deps = { now: number; fetchFn: typeof fetch }

const err = (code: number, error: string, message: string): Response => json(code, { error, message })
const flag = (v: unknown): 0 | 1 | null => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null)

type ServerRow = { id: string; name: string | null; owner: number | null; locked: number; owner_name: string | null; owner_locked: number | null }
type AccountRow = { server: string; login: string; broker: string | null; seen: number; enabled: number; rev: number; applied_rev: number; changed: number }

/** Quyền với một tài khoản: Admin, chủ VPS, hoặc được cấp đúng tài khoản đó (và còn được cấp VPS). */
async function canSwitch(env: Env, actor: Actor, s: { id: string; owner: number | null }, login: string): Promise<boolean> {
  if (actor.role === 'admin' || s.owner === actor.id) return true
  const g = await env.DB.prepare('SELECT 1 AS x FROM account_grants g JOIN server_access a ON a.user_id = g.user_id AND a.server = g.server WHERE g.user_id = ? AND g.server = ? AND g.login = ?')
    .bind(actor.id, s.id, login)
    .first()
  return g !== null
}

/** Toàn cảnh cho trang "Bật/tắt EA", đã lọc theo quyền của người xem. */
async function overview(env: Env, actor: Actor, now: number): Promise<Response> {
  const admin = actor.role === 'admin'
  const sBase = "SELECT s.id, s.name, s.owner, s.locked, us.username AS owner_name, us.locked AS owner_locked FROM servers s LEFT JOIN users us ON us.id = s.owner WHERE s.id <> ''"
  const sSql = admin ? `${sBase} ORDER BY s.created DESC, s.seen DESC LIMIT 200` : `${sBase} AND (s.owner = ? OR s.id IN (SELECT server FROM server_access WHERE user_id = ?)) ORDER BY s.created DESC, s.seen DESC LIMIT 200`
  const aBase = 'SELECT a.server, a.login, a.broker, a.seen, a.enabled, a.rev, a.applied_rev, a.changed FROM accounts a'
  const aSql = admin
    ? `${aBase} ORDER BY a.server, a.login LIMIT 2000`
    : `${aBase} WHERE a.server IN (SELECT id FROM servers WHERE owner = ?) OR EXISTS (SELECT 1 FROM account_grants g JOIN server_access x ON x.user_id = g.user_id AND x.server = g.server WHERE g.user_id = ? AND g.server = a.server AND g.login = a.login) ORDER BY a.server, a.login LIMIT 2000`
  const sSt = env.DB.prepare(sSql)
  const aSt = env.DB.prepare(aSql)
  const servers = (await (admin ? sSt : sSt.bind(actor.id, actor.id)).all<ServerRow>()).results
  const accounts = (await (admin ? aSt : aSt.bind(actor.id, actor.id)).all<AccountRow>()).results

  type Access = { user_id: number; username: string; locked: boolean; logins: string[] }
  const access = new Map<string, Map<number, Access>>()
  let users: { id: number; username: string }[] = []
  if (admin) {
    const acc = (await env.DB.prepare('SELECT x.server, x.user_id, u.username, u.locked FROM server_access x JOIN users u ON u.id = x.user_id ORDER BY u.username').all<{ server: string; user_id: number; username: string; locked: number }>()).results
    for (const r of acc) {
      const m = access.get(r.server) ?? new Map<number, Access>()
      m.set(r.user_id, { user_id: r.user_id, username: r.username, locked: r.locked === 1, logins: [] })
      access.set(r.server, m)
    }
    const gr = (await env.DB.prepare('SELECT server, user_id, login FROM account_grants ORDER BY login').all<{ server: string; user_id: number; login: string }>()).results
    for (const g of gr) access.get(g.server)?.get(g.user_id)?.logins.push(g.login)
    users = (await env.DB.prepare("SELECT id, username FROM users WHERE role = 'user' ORDER BY username").all<{ id: number; username: string }>()).results
  }

  type PRow = { server: string; login: string; rev: number; applied_rev: number; ea_rev: number; vals: string }
  const prm = new Map<string, PRow>()
  for (const r of (await env.DB.prepare('SELECT server, login, rev, applied_rev, ea_rev, vals FROM account_params WHERE rev > 0 LIMIT 2000').all<PRow>()).results) prm.set(`${r.server}/${r.login}`, r)

  const out = servers.map((s) => {
    const mine = s.owner === actor.id
    return {
      id: s.id,
      name: s.name || s.id,
      mine,
      manage: admin || mine,
      owner_name: admin ? s.owner_name : null,
      locked: s.locked === 1 || s.owner_locked === 1,
      accounts: accounts
        .filter((a) => a.server === s.id)
        .map((a) => {
          const pr = prm.get(`${a.server}/${a.login}`)
          return {
            login: a.login, broker: a.broker, enabled: a.enabled === 1, applied: a.applied_rev >= a.rev, changed_ago: a.changed === 0 ? null : Math.max(0, now - a.changed),
            // Input EA ghi đè từ xa: số khóa đang ghi đè, VPS đã giữ chưa, EA đã áp chưa (null = chưa từng chỉnh).
            params: pr ? { overrides: Object.keys(parseValuesJson(pr.vals)).length, vps_applied: pr.applied_rev >= pr.rev, ea_applied: pr.ea_rev >= pr.rev } : null,
          }
        }),
      ...(admin ? { access: [...(access.get(s.id)?.values() ?? [])] } : {}),
    }
  })
  return json(200, { now, servers: out, ...(admin ? { users } : {}) })
}

/** Bật/tắt một tài khoản MT. */
async function setSwitch(env: Env, actor: Actor, serverId: string, login: string, body: Record<string, unknown>, deps: Deps): Promise<Response> {
  const enabled = flag(body.enabled)
  if (enabled === null) return err(400, 'bad_request', 'enabled phải là true/false')
  const s = await env.DB.prepare('SELECT s.id, s.owner, s.locked, (SELECT locked FROM users WHERE id = s.owner) AS owner_locked FROM servers s WHERE s.id = ?')
    .bind(serverId)
    .first<{ id: string; owner: number | null; locked: number; owner_locked: number | null }>()
  const a = s ? await env.DB.prepare('SELECT enabled, rev, applied_rev FROM accounts WHERE server = ? AND login = ?').bind(serverId, login).first<{ enabled: number; rev: number; applied_rev: number }>() : null
  if (!s || !a || !(await canSwitch(env, actor, s, login))) return err(404, 'no_account', 'Không có tài khoản này')
  if (s.locked === 1 || s.owner_locked === 1) return err(403, 'server_locked', 'VPS hoặc tài khoản chủ VPS đang bị Admin khóa')

  const { now } = deps
  let rev = a.rev
  let at = now
  if (a.enabled !== enabled) {
    const r = await env.DB.prepare('UPDATE accounts SET enabled = ?, rev = rev + 1, changed = ?, changed_by = ? WHERE server = ? AND login = ? RETURNING rev')
      .bind(enabled, now, actor.id, serverId, login)
      .first<{ rev: number }>()
    if (!r) return err(500, 'store_failed', 'Không lưu được công tắc, thử lại')
    rev = r.rev
  } else {
    const c = await env.DB.prepare('SELECT changed FROM accounts WHERE server = ? AND login = ?').bind(serverId, login).first<{ changed: number }>()
    at = c?.changed ?? now
  }
  let applied = a.applied_rev >= rev
  let pushError: string | null = null
  if (!applied) {
    const p = await pushSwitch(env, serverId, { login, enabled: enabled === 1, rev, at }, now, deps.fetchFn)
    if (p.ok) {
      applied = true
      await env.DB.prepare('UPDATE accounts SET applied_rev = MAX(applied_rev, ?) WHERE server = ? AND login = ?').bind(rev, serverId, login).run()
    } else pushError = p.error
  }
  return json(200, { ok: true, login, enabled: enabled === 1, rev, applied, push_error: pushError })
}

type ParamsRow = { vals: string; rev: number; applied_rev: number; ea_rev: number; setup: string; changed: number }
type SrvRow = { id: string; owner: number | null; locked: number; owner_locked: number | null }

/** Tìm VPS + tài khoản và kiểm quyền (cùng quy tắc với công tắc). Trả Response lỗi nếu không được. */
async function accountFor(env: Env, actor: Actor, serverId: string, login: string): Promise<{ s: SrvRow } | Response> {
  const s = await env.DB.prepare('SELECT s.id, s.owner, s.locked, (SELECT locked FROM users WHERE id = s.owner) AS owner_locked FROM servers s WHERE s.id = ?').bind(serverId).first<SrvRow>()
  const a = s ? await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE server = ? AND login = ?').bind(serverId, login).first() : null
  if (!s || !a || !(await canSwitch(env, actor, s, login))) return err(404, 'no_account', 'Không có tài khoản này')
  return { s }
}

const paramsBody = (r: ParamsRow | null, now: number) => ({
  rev: r?.rev ?? 0,
  vps_applied: (r?.applied_rev ?? 0) >= (r?.rev ?? 0),
  ea_applied: (r?.ea_rev ?? 0) >= (r?.rev ?? 0),
  changed_ago: !r || r.changed === 0 ? null : Math.max(0, now - r.changed),
  // Giá trị Admin/chủ đặt (ghi đè) và input hiện tại EA báo lên (rỗng nếu EA đời cũ chưa báo hoặc chưa chạy lần nào).
  overrides: parseValuesJson(r?.vals),
  current: ((): Record<string, string> => {
    try {
      const o = JSON.parse(r?.setup ?? '{}') as Record<string, unknown>
      return Object.fromEntries(PARAM_KEYS.filter((k) => typeof o[k] === 'string').map((k) => [k, o[k] as string]))
    } catch {
      return {}
    }
  })(),
})

/** Xem bộ input EA của một tài khoản: danh sách cho phép (để vẽ form), giá trị ghi đè, input hiện tại, trạng thái áp. */
async function getParams(env: Env, actor: Actor, serverId: string, login: string, now: number): Promise<Response> {
  const f = await accountFor(env, actor, serverId, login)
  if (f instanceof Response) return f
  const r = await env.DB.prepare('SELECT vals, rev, applied_rev, ea_rev, setup, changed FROM account_params WHERE server = ? AND login = ?').bind(serverId, login).first<ParamsRow>()
  return json(200, { login, spec: REMOTE_PARAMS, ...paramsBody(r, now) })
}

/**
 * Đổi một phần bộ input: `values` = { khóa: giá trị } để đặt, { khóa: null } để bỏ ghi đè. Sai một khóa/giá trị là từ chối cả bản vá.
 * Đổi thật sự thì `rev + 1` rồi đẩy ngay xuống VPS; hụt thì VPS nhận ở lần kéo kế tiếp.
 */
async function setParams(env: Env, actor: Actor, serverId: string, login: string, body: Record<string, unknown>, deps: Deps): Promise<Response> {
  const f = await accountFor(env, actor, serverId, login)
  if (f instanceof Response) return f
  const { s } = f
  if (s.locked === 1 || s.owner_locked === 1) return err(403, 'server_locked', 'VPS hoặc tài khoản chủ VPS đang bị Admin khóa')
  const patch = sanitizePatch(body.values)
  if (!patch.ok) return err(400, 'bad_params', patch.error)

  const { now } = deps
  const cur = await env.DB.prepare('SELECT vals, rev, applied_rev, ea_rev, setup, changed FROM account_params WHERE server = ? AND login = ?').bind(serverId, login).first<ParamsRow>()
  const next = { ...parseValuesJson(cur?.vals), ...patch.set }
  for (const k of patch.unset) delete next[k]
  const nextJson = JSON.stringify(next)
  const same = nextJson === JSON.stringify(parseValuesJson(cur?.vals))

  let rev = cur?.rev ?? 0
  if (!same) {
    const r = await env.DB.prepare(
      'INSERT INTO account_params (server, login, vals, rev, changed, changed_by) VALUES (?, ?, ?, 1, ?, ?) ' +
        'ON CONFLICT(server, login) DO UPDATE SET vals = excluded.vals, rev = account_params.rev + 1, changed = excluded.changed, changed_by = excluded.changed_by RETURNING rev',
    )
      .bind(serverId, login, nextJson, now, actor.id)
      .first<{ rev: number }>()
    if (!r) return err(500, 'store_failed', 'Không lưu được input, thử lại')
    rev = r.rev
  }
  let vpsApplied = (cur?.applied_rev ?? 0) >= rev
  let pushError: string | null = null
  if (!vpsApplied && rev > 0) {
    const p = await pushParams(env, serverId, { login, rev, values: next, at: now }, now, deps.fetchFn)
    if (p.ok) {
      vpsApplied = true
      await env.DB.prepare('UPDATE account_params SET applied_rev = MAX(applied_rev, ?) WHERE server = ? AND login = ?').bind(rev, serverId, login).run()
    } else pushError = p.error
  }
  return json(200, { ok: true, login, rev, changed: !same, vps_applied: vpsApplied, ea_applied: (cur?.ea_rev ?? 0) >= rev && rev > 0, overrides: next, push_error: pushError })
}

/** Admin cấp VPS + chọn các tài khoản MT cho một User (thay toàn bộ danh sách tài khoản của người đó trên VPS này). */
async function putAccess(env: Env, actor: Actor, serverId: string, userId: number, body: Record<string, unknown>, now: number): Promise<Response> {
  if (actor.role !== 'admin') return err(403, 'admin_only', 'Chỉ Admin được cấp quyền')
  const s = await env.DB.prepare("SELECT id, owner FROM servers WHERE id = ? AND id <> ''").bind(serverId).first<{ id: string; owner: number | null }>()
  if (!s) return err(404, 'no_server', 'Không có VPS này')
  const t = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(userId).first<{ id: number; role: string }>()
  if (!t) return err(404, 'no_user', 'Không có người dùng này')
  if (t.role === 'admin') return err(400, 'admin_has_all', 'Admin đã có toàn quyền, không cần cấp')
  if (s.owner === t.id) return err(400, 'owner_has_all', 'Người này là chủ VPS nên đã có toàn quyền trên VPS của mình')
  const raw = body.logins === undefined ? [] : body.logins
  if (!Array.isArray(raw) || raw.length > MAX_ACCOUNTS || raw.some((x) => typeof x !== 'string' || !LOGIN_RE.test(x))) return err(400, 'bad_logins', `logins phải là danh sách tối đa ${MAX_ACCOUNTS} số tài khoản MT (chỉ chữ số)`)
  const logins = [...new Set(raw as string[])]
  if (logins.length > 0) {
    const known = new Set((await env.DB.prepare('SELECT login FROM accounts WHERE server = ?').bind(serverId).all<{ login: string }>()).results.map((r) => r.login))
    const missing = logins.filter((l) => !known.has(l))
    if (missing.length > 0) return err(400, 'unknown_account', 'Có tài khoản MT chưa được VPS này báo lên (EA cần chạy ít nhất một lần): ' + missing.join(', '))
  }
  await env.DB.prepare('INSERT INTO server_access (user_id, server, created, granted_by) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, server) DO NOTHING').bind(t.id, serverId, now, actor.id).run()
  await env.DB.prepare('DELETE FROM account_grants WHERE user_id = ? AND server = ?').bind(t.id, serverId).run()
  for (const l of logins) await env.DB.prepare('INSERT OR IGNORE INTO account_grants (user_id, server, login) VALUES (?, ?, ?)').bind(t.id, serverId, l).run()
  return json(200, { ok: true, user_id: t.id, server: serverId, logins })
}

async function delAccess(env: Env, actor: Actor, serverId: string, userId: number): Promise<Response> {
  if (actor.role !== 'admin') return err(403, 'admin_only', 'Chỉ Admin được thu hồi quyền')
  await env.DB.prepare('DELETE FROM account_grants WHERE user_id = ? AND server = ?').bind(userId, serverId).run()
  await env.DB.prepare('DELETE FROM server_access WHERE user_id = ? AND server = ?').bind(userId, serverId).run()
  return json(200, { ok: true })
}

/** Xóa mọi dữ liệu bật/tắt + quyền của một VPS (khi VPS bị xóa). */
export async function dropServerEa(env: Env, serverId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM accounts WHERE server = ?').bind(serverId).run()
  await env.DB.prepare('DELETE FROM account_params WHERE server = ?').bind(serverId).run()
  await env.DB.prepare('DELETE FROM server_access WHERE server = ?').bind(serverId).run()
  await env.DB.prepare('DELETE FROM account_grants WHERE server = ?').bind(serverId).run()
}

/** Xóa quyền được cấp của một User (khi User bị xóa). VPS của User thì xóa bằng dropServerEa. */
export async function dropUserEa(env: Env, userId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM server_access WHERE user_id = ?').bind(userId).run()
  await env.DB.prepare('DELETE FROM account_grants WHERE user_id = ?').bind(userId).run()
}

/** `/api/ea...` cho người đã đăng nhập (xem appRoute). parts = ['api','ea', server?, 'accounts'|'access', id?]. */
export async function eaRoute(req: Request, env: Env, parts: string[], actor: Actor, body: () => Promise<Record<string, unknown> | null>, deps: Deps): Promise<Response> {
  const m = req.method
  const serverId = parts[2] ?? ''
  if (serverId === '') return m === 'GET' ? overview(env, actor, deps.now) : err(405, 'method_not_allowed', 'Sai phương thức')
  if (!SERVER_ID_RE.test(serverId)) return err(404, 'not_found', 'Không có đường dẫn này')
  const sub = parts[3] ?? ''
  const id = parts[4] ?? ''
  // Input EA của một tài khoản: phải đứng TRƯỚC route công tắc (cùng PUT .../accounts/:login nhưng có thêm /params).
  if (sub === 'accounts' && LOGIN_RE.test(id) && parts[5] === 'params') {
    if (m === 'GET') return getParams(env, actor, serverId, id, deps.now)
    if (m === 'PUT') {
      const b = await body()
      if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
      return setParams(env, actor, serverId, id, b, deps)
    }
    return err(405, 'method_not_allowed', 'Sai phương thức')
  }
  if (sub === 'accounts' && LOGIN_RE.test(id) && m === 'PUT') {
    const b = await body()
    if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
    return setSwitch(env, actor, serverId, id, b, deps)
  }
  if (sub === 'access' && /^\d{1,9}$/.test(id)) {
    if (m === 'PUT') {
      const b = await body()
      if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
      return putAccess(env, actor, serverId, Number(id), b, deps.now)
    }
    if (m === 'DELETE') return delAccess(env, actor, serverId, Number(id))
  }
  return err(404, 'not_found', 'Không có đường dẫn này')
}

/** VPS báo danh sách tài khoản MT + công tắc đang áp dụng (`POST /api/accounts`, xác thực bằng khóa riêng của VPS). */
export async function reportAccounts(env: Env, server: string, raw: unknown, now: number): Promise<Response> {
  // VPS đời cũ (không có Server ID) không hỗ trợ bật/tắt từ xa: nhận cho êm, không lưu.
  if (server === '') return json(200, { ok: true, accepted: 0 })
  const list = sanitizeAccountReports((raw as { accounts?: unknown } | null)?.accounts)
  for (const a of list) {
    // VPS báo rev CAO hơn Worker (Worker mất dữ liệu) thì nhận trạng thái của VPS; thấp hơn thì `applied_rev` < `rev`
    // và Worker gửi lại công tắc ở lần kéo kế tiếp.
    await env.DB.prepare(
      'INSERT INTO accounts (server, login, broker, seen, enabled, rev, applied_rev, changed) VALUES (?, ?, ?, ?, ?, ?, ?, 0) ' +
        'ON CONFLICT(server, login) DO UPDATE SET broker = excluded.broker, seen = excluded.seen, ' +
        'enabled = CASE WHEN excluded.rev > accounts.rev THEN excluded.enabled ELSE accounts.enabled END, ' +
        'applied_rev = excluded.rev, rev = MAX(accounts.rev, excluded.rev)',
    )
      .bind(server, a.login, a.broker, now, a.enabled ? 1 : 0, a.rev, a.rev)
      .run()
  }
  // Trạng thái input EA từ xa (VPS đời mới): VPS giữ bộ ghi đè rev nào, EA đã áp rev nào, và input hiện tại của EA.
  for (const a of list) {
    if (a.params_rev === undefined && a.setup === undefined) continue
    // VPS báo rev CAO hơn Worker (Worker mất dữ liệu) thì nhận rev đó để lần đổi kế tiếp không đụng rev cũ (bộ giá trị thì không khôi phục được).
    await env.DB.prepare(
      "INSERT INTO account_params (server, login, vals, rev, applied_rev, ea_rev, setup) VALUES (?, ?, '{}', ?, ?, ?, ?) " +
        'ON CONFLICT(server, login) DO UPDATE SET applied_rev = excluded.applied_rev, ea_rev = excluded.ea_rev, ' +
        "rev = MAX(account_params.rev, excluded.rev), setup = CASE WHEN excluded.setup = '{}' THEN account_params.setup ELSE excluded.setup END",
    )
      .bind(server, a.login, a.params_rev ?? 0, a.params_rev ?? 0, a.ea_rev ?? 0, JSON.stringify(a.setup ?? {}))
      .run()
  }
  return json(200, { ok: true, accepted: list.length })
}

/** Bộ input EA mà VPS này chưa xác nhận đã giữ (kèm trong `/api/pull`). */
export async function pendingParams(env: Env, server: string): Promise<{ login: string; rev: number; values: Record<string, number>; at: number }[]> {
  if (server === '') return []
  const rows = (await env.DB.prepare('SELECT login, vals, rev, changed FROM account_params WHERE server = ? AND rev > applied_rev ORDER BY login LIMIT ?').bind(server, MAX_ACCOUNTS).all<{ login: string; vals: string; rev: number; changed: number }>()).results
  return rows.map((r) => ({ login: r.login, rev: r.rev, values: parseValuesJson(r.vals), at: r.changed }))
}

/** Công tắc VPS này chưa xác nhận đã áp (kèm trong `/api/pull`). */
export async function pendingSwitches(env: Env, server: string): Promise<{ login: string; enabled: boolean; rev: number; at: number }[]> {
  if (server === '') return []
  const rows = (await env.DB.prepare('SELECT login, enabled, rev, changed FROM accounts WHERE server = ? AND rev > applied_rev ORDER BY login LIMIT ?').bind(server, MAX_ACCOUNTS).all<{ login: string; enabled: number; rev: number; changed: number }>()).results
  return rows.map((r) => ({ login: r.login, enabled: r.enabled === 1, rev: r.rev, at: r.changed }))
}
