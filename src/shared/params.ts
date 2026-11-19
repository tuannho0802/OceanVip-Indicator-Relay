/**
 * Tuỳ chỉnh input EA từ xa theo từng tài khoản MT (login). Dùng chung cho Worker, Server (VPS) và Gateway.
 *
 *  - Worker (D1) giữ bộ giá trị mong muốn ("ghi đè") của từng tài khoản; mỗi lần đổi `rev` tăng 1.
 *  - Server lưu bộ ghi đè khi `rev` mới hơn bản đang có, rồi kèm vào phản hồi ping cho EA của tài khoản đó
 *    (chỉ khi `rev` Server > `prev` mà EA báo đã áp) qua Gateway (dòng `P|rev=N;InpX=giá trị;...`).
 *  - EA áp giá trị vào các biến chạy (không sửa được `input` của MQL), kẹp lại theo khoảng của chính nó, và báo `prev=N`.
 *  - Khóa không nằm trong REMOTE_PARAMS KHÔNG BAO GIỜ đi qua đường này (địa chỉ Gateway, magic, comment, Terminal ID,
 *    và công tắc tổng InpAllowTrading chỉ đổi được ngay trên EA).
 *  - Ghi đè là tập con: khóa không có trong bộ ghi đè thì EA dùng đúng input người dùng đặt trên EA.
 */

export type ParamType = 'bool' | 'int' | 'num'
export type ParamSpec = {
  key: string
  type: ParamType
  min: number
  max: number
  group: string
  label: string
  /** Số chữ số thập phân khi ghi ra (chỉ với 'num'). */
  dp?: number
  /** Tập giá trị rời rạc (liệt kê) — ngoài ra bắt buộc là số nguyên trong [min, max]. */
  options?: { value: number; label: string }[]
}

const b = (key: string, group: string, label: string): ParamSpec => ({ key, type: 'bool', min: 0, max: 1, group, label })
const i = (key: string, min: number, max: number, group: string, label: string, options?: ParamSpec['options']): ParamSpec => ({ key, type: 'int', min, max, group, label, ...(options ? { options } : {}) })
const n = (key: string, min: number, max: number, group: string, label: string, dp = 2): ParamSpec => ({ key, type: 'num', min, max, group, label, dp })

export const G_ORDER = 'Đặt lệnh'
export const G_EXT = 'SL/TP mở rộng'
export const G_BE = 'BreakEven'
export const G_MAKEUP = 'Bù lệnh'
export const G_TIME = 'Lọc giờ'
export const G_NEWS = 'Lọc tin'

export const REMOTE_PARAMS: readonly ParamSpec[] = [
  n('InpLotPerOrder', 0.01, 100, G_ORDER, 'Lot mỗi lệnh'),
  n('InpMaxTotalLots', 0.01, 1000, G_ORDER, 'Tổng lot tối đa'),
  i('InpMaxAgeSec', 1, 3600, G_ORDER, 'Bỏ tín hiệu cũ hơn (giây)'),
  n('InpMaxDevPips', 0, 1000, G_ORDER, 'Sai số giá cho phép (pip, 0 = không kiểm)', 1),
  i('InpSlippagePts', 0, 1000, G_ORDER, 'Trượt giá tối đa (point)'),
  b('InpCloseBadFill', G_ORDER, 'Đóng lệnh khớp lệch Entry'),
  i('InpRetrySec', 1, 60, G_ORDER, 'Thử lại mỗi (giây)'),
  i('InpRetryMaxSec', 1, 600, G_ORDER, 'Thử lại tối đa (giây)'),
  b('InpTP3Only', G_ORDER, 'Chỉ 1 lệnh TP3 (lot x3)'),
  n('InpSLExtend', -1000, 1000, G_EXT, 'SL xa hơn (giá, âm = gần lại)'),
  n('InpTP1Extend', -1000, 1000, G_EXT, 'TP1 xa hơn (giá, âm = gần lại)'),
  n('InpTP2Extend', -1000, 1000, G_EXT, 'TP2 xa hơn (giá, âm = gần lại)'),
  n('InpTP3Extend', -1000, 1000, G_EXT, 'TP3 xa hơn (giá, âm = gần lại)'),
  b('InpBEEnable', G_BE, 'Bật BreakEven'),
  i('InpBETrigger', 1, 2, G_BE, 'Kích hoạt sau', [{ value: 1, label: 'TP1 chốt' }, { value: 2, label: 'TP2 chốt' }]),
  n('InpBEOffset', 0, 1000, G_BE, 'Khoảng cách N từ giá vào'),
  i('InpBEUnit', 0, 1, G_BE, 'Đơn vị N', [{ value: 0, label: 'Giá' }, { value: 1, label: 'Pip' }]),
  b('InpBELockProfit', G_BE, 'Khóa lãi (SL phía lãi)'),
  b('InpMakeupEnable', G_MAKEUP, 'Bật bù lệnh'),
  i('InpMakeupExpirySec', 30, 1800, G_MAKEUP, 'Hạn lệnh bù (giây)'),
  b('InpUsePauseFilter', G_TIME, 'Bật lọc giờ ngừng vào lệnh'),
  i('InpFilterTimeSource', 0, 2, G_TIME, 'Nguồn giờ', [{ value: 0, label: 'Giờ VPS (Local)' }, { value: 1, label: 'Giờ sàn' }, { value: 2, label: 'UTC' }]),
  b('InpPause1On', G_TIME, 'Khung 1: bật'),
  i('InpPause1StartH', 0, 23, G_TIME, 'Khung 1: giờ bắt đầu'),
  i('InpPause1StartM', 0, 59, G_TIME, 'Khung 1: phút bắt đầu'),
  i('InpPause1EndH', 0, 23, G_TIME, 'Khung 1: giờ kết thúc'),
  i('InpPause1EndM', 0, 59, G_TIME, 'Khung 1: phút kết thúc'),
  b('InpPause2On', G_TIME, 'Khung 2: bật'),
  i('InpPause2StartH', 0, 23, G_TIME, 'Khung 2: giờ bắt đầu'),
  i('InpPause2StartM', 0, 59, G_TIME, 'Khung 2: phút bắt đầu'),
  i('InpPause2EndH', 0, 23, G_TIME, 'Khung 2: giờ kết thúc'),
  i('InpPause2EndM', 0, 59, G_TIME, 'Khung 2: phút kết thúc'),
  b('InpUseNewsFilter', G_NEWS, 'Bật lọc tin mạnh'),
  i('InpNewsBeforeMin', 0, 720, G_NEWS, 'Ngừng trước tin (phút)'),
  i('InpNewsAfterMin', 0, 720, G_NEWS, 'Ngừng sau tin (phút)'),
  b('InpNewsCPI', G_NEWS, 'Tin CPI'),
  b('InpNewsFed', G_NEWS, 'Tin Fed'),
  b('InpNewsNFP', G_NEWS, 'Tin NFP'),
  b('InpNewsAllHigh', G_NEWS, 'Mọi tin ảnh hưởng cao'),
]

const SPEC = new Map<string, ParamSpec>(REMOTE_PARAMS.map((p) => [p.key, p]))
export const PARAM_KEYS: readonly string[] = REMOTE_PARAMS.map((p) => p.key)
export const isParamKey = (k: string): boolean => SPEC.has(k)
export const MAX_PARAM_REV = 2_000_000_000

/** Giá trị đã kiểm: bool -> 0/1, int -> số nguyên, num -> số làm tròn theo `dp`. Trả null nếu sai kiểu/ngoài khoảng. */
export function checkParam(spec: ParamSpec, raw: unknown): number | null {
  let v: number
  if (spec.type === 'bool') {
    if (raw === true || raw === 1 || raw === '1') v = 1
    else if (raw === false || raw === 0 || raw === '0') v = 0
    else return null
  } else if (typeof raw === 'number') v = raw
  else if (typeof raw === 'string' && /^-?\d{1,9}(\.\d{1,6})?$/.test(raw.trim())) v = Number(raw)
  else return null
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) return null
  if (spec.type !== 'num') {
    if (!Number.isInteger(v)) return null
    if (spec.options && !spec.options.some((o) => o.value === v)) return null
    return v
  }
  const f = 10 ** (spec.dp ?? 2)
  return Math.round(v * f) / f
}

/** Ghi giá trị theo đúng cách EA đọc (`StringToDouble`/`StringToInteger`): không dùng ký hiệu khoa học. */
export function formatParam(spec: ParamSpec, v: number): string {
  return spec.type === 'num' ? v.toFixed(spec.dp ?? 2) : String(v)
}

/** Bộ ghi đè = { khóa: giá trị đã kiểm }. */
export type ParamValues = Record<string, number>

export type ParamsPatchResult = { ok: true; set: ParamValues; unset: string[] } | { ok: false; error: string }

/**
 * Bản vá từ người dùng (Worker): `{ khóa: giá trị }` để đặt, `{ khóa: null }` để bỏ ghi đè (EA quay về input của chính nó).
 * Khóa lạ/giá trị sai => từ chối cả bản vá (không áp nửa chừng).
 */
export function sanitizePatch(v: unknown): ParamsPatchResult {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'values phải là một object { khóa: giá trị }' }
  const set: ParamValues = {}
  const unset: string[] = []
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: 'Không có thay đổi nào' }
  if (entries.length > REMOTE_PARAMS.length) return { ok: false, error: 'Quá nhiều khóa' }
  for (const [k, raw] of entries) {
    const spec = SPEC.get(k)
    if (!spec) return { ok: false, error: `Không được chỉnh từ xa: ${k.slice(0, 40)}` }
    if (raw === null) {
      unset.push(k)
      continue
    }
    const c = checkParam(spec, raw)
    if (c === null) return { ok: false, error: `Giá trị không hợp lệ cho ${k} (${spec.type === 'bool' ? 'true/false' : `${spec.min}..${spec.max}`})` }
    set[k] = c
  }
  return { ok: true, set, unset }
}

/** Bộ ghi đè đã lưu (JSON) -> bản sạch; bỏ khóa lạ/giá trị hỏng (an toàn khi đọc lại từ D1/SQLite). */
export function sanitizeValues(v: unknown): ParamValues {
  const out: ParamValues = {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const spec = SPEC.get(k)
    if (!spec) continue
    const c = checkParam(spec, raw)
    if (c !== null) out[k] = c
  }
  return out
}

export function parseValuesJson(j: string | null | undefined): ParamValues {
  if (!j) return {}
  try {
    return sanitizeValues(JSON.parse(j))
  } catch {
    return {}
  }
}

/** Một lệnh tham số: Worker → Server (đẩy `/api/params` hoặc kèm trong `/api/pull`). */
export type ParamsItem = { login: string; rev: number; values: ParamValues; at: number }

/** Trùng LOGIN_RE của switch.ts (không import để tránh vòng phụ thuộc: switch.ts dùng pickSetup của file này). */
const LOGIN_RE = /^\d{1,20}$/
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export function sanitizeParamsItem(v: unknown): ParamsItem | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.login !== 'string' || !LOGIN_RE.test(o.login)) return null
  if (!isInt(o.rev, 1, MAX_PARAM_REV) || !isInt(o.at, 0, 4_102_444_800)) return null
  return { login: o.login, rev: o.rev, values: sanitizeValues(o.values), at: o.at }
}

export function sanitizeParamsItems(v: unknown, max = 40): ParamsItem[] {
  if (!Array.isArray(v)) return []
  const out: ParamsItem[] = []
  for (const x of v.slice(0, max)) {
    const it = sanitizeParamsItem(x)
    if (it) out.push(it)
  }
  return out
}

/** Bộ ghi đè -> dòng `P|rev=N;khóa=giá trị;...` (Gateway → EA). Gateway tự kiểm lại theo định dạng này. */
export function paramsLine(rev: number, values: ParamValues): string {
  const parts = [`rev=${rev}`]
  for (const p of REMOTE_PARAMS) {
    const v = values[p.key]
    if (v !== undefined) parts.push(`${p.key}=${formatParam(p, v)}`)
  }
  return `P|${parts.join(';')}`
}

const LINE_RE = /^P\|rev=(\d{1,10})((?:;Inp[A-Za-z0-9]{1,40}=-?\d{1,9}(?:\.\d{1,6})?)*)$/

/** Kiểm dòng `P|...` đã nhận từ Server trước khi chuyển cho EA: sai định dạng/khóa lạ thì null. */
export function validateParamsLine(line: string): string | null {
  const m = LINE_RE.exec(line)
  if (!m) return null
  for (const kv of (m[2] ?? '').split(';').filter(Boolean)) {
    const eq = kv.indexOf('=')
    const spec = SPEC.get(kv.slice(0, eq))
    if (!spec || checkParam(spec, kv.slice(eq + 1)) === null) return null
  }
  return line
}

/** Tập con khóa tuỳ chỉnh được từ bản setup mà EA báo (để gửi lên Worker: không lộ khóa khác). */
export function pickSetup(setup: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!setup) return out
  for (const p of REMOTE_PARAMS) {
    const raw = setup[p.key]
    if (raw === undefined) continue
    const c = checkParam(p, raw)
    if (c !== null) out[p.key] = formatParam(p, c)
  }
  return out
}
