import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decodeConnectCode } from '../shared/connect'

/**
 * Cài đặt do người dùng chỉnh trên giao diện web (trang Cài đặt), lưu ở <thư mục dữ liệu>/settings.json.
 * Trường nào có trong tệp này thì thắng server.env; không có thì dùng server.env như trước. Nhờ vậy:
 *  - cài xong chưa cần nhập gì, mở trang Cài đặt dán mã là chạy, không phải sửa tệp hay cài lại;
 *  - nâng cấp bộ cài không đụng tới cài đặt của người dùng (settings.json nằm ngoài thư mục chương trình).
 */
export type Settings = {
  /** Mã kết nối ocean1.… ('' = chủ động ngắt Worker, bỏ qua cả OCEAN_CONNECT_CODE trong server.env). */
  connectCode?: string
  accounts?: string[]
  /** Ánh xạ symbol TradingView → symbol sàn (Gateway áp dụng ngay, không cần chạy lại). */
  symbolMap?: Record<string, string>
  /** Khung giờ được phép; [] = mọi khung giờ. */
  tfs?: string[]
}

export const SETTING_KEYS = ['connectCode', 'accounts', 'symbolMap', 'tfs'] as const

export const settingsPath = (dataDir: string): string => path.join(dataDir, 'settings.json')

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const SYMBOL_RE = /^[A-Za-z0-9._#@-]{1,32}$/
const TF_RE = /^(M(1|2|3|4|5|6|10|12|15|20|30)|H(1|2|3|4|6|8|12)|D1|W1|MN1)$/

/** Đọc tệp cài đặt. Không có hoặc hỏng thì coi như chưa cài đặt gì (không làm Server không lên được). */
export function readSettings(file: string): Settings {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
  if (!isObj(raw)) return {}
  const r = normalizeSettings(raw)
  return r.ok ? r.value : {}
}

/** Ghi nguyên tử (ghi tệp tạm rồi đổi tên) để mất điện giữa chừng không để lại tệp dở dang. */
export function writeSettings(file: string, s: Settings): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

const list = (v: unknown): string[] | null => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,\s;]+/).filter(Boolean)
  return null
}

export type Normalized = { ok: true; value: Settings; remove: (typeof SETTING_KEYS)[number][] } | { ok: false; error: string }

/**
 * Kiểm tra dữ liệu người dùng gửi lên. Trường vắng mặt = giữ nguyên; `null` = xóa cài đặt đó (quay về server.env / mặc định).
 * Trả về lỗi bằng tiếng Việt, đủ rõ để hiện thẳng cho người dùng.
 */
export function normalizeSettings(input: unknown): Normalized {
  if (!isObj(input)) return { ok: false, error: 'Dữ liệu cài đặt không hợp lệ.' }
  const value: Settings = {}
  const remove: (typeof SETTING_KEYS)[number][] = []

  if ('connectCode' in input) {
    const v = input.connectCode
    if (v === null) remove.push('connectCode')
    else if (typeof v !== 'string') return { ok: false, error: 'Mã kết nối phải là chuỗi ký tự.' }
    else if (v.trim() === '') value.connectCode = ''
    else {
      const c = v.replace(/[\s"'`]/g, '')
      if (!decodeConnectCode(c)) return { ok: false, error: 'Mã kết nối không đúng. Mã phải bắt đầu bằng ocean1. và dán đủ, không thiếu ký tự. Nếu vẫn lỗi, xin người quản trị cấp lại mã.' }
      value.connectCode = c
    }
  }

  if ('accounts' in input) {
    if (input.accounts === null) remove.push('accounts')
    else {
      const a = list(input.accounts)
      if (a === null) return { ok: false, error: 'Số tài khoản MT5 không hợp lệ.' }
      const bad = a.find((x) => !/^\d{3,12}$/.test(x))
      if (bad !== undefined) return { ok: false, error: `Số tài khoản MT5 chỉ gồm chữ số (3-12 số), cách nhau bằng dấu phẩy. "${bad.slice(0, 20)}" không hợp lệ.` }
      if (a.length > 50) return { ok: false, error: 'Tối đa 50 tài khoản MT5.' }
      value.accounts = [...new Set(a)]
    }
  }

  if ('symbolMap' in input) {
    if (input.symbolMap === null) remove.push('symbolMap')
    else {
      const map: Record<string, string> = {}
      const pairs: [string, string][] = []
      if (isObj(input.symbolMap)) for (const [k, v] of Object.entries(input.symbolMap)) pairs.push([k, String(v)])
      else if (typeof input.symbolMap === 'string') {
        for (const part of input.symbolMap.split(/[,;\n]+/)) {
          if (part.trim() === '') continue
          const i = part.indexOf('=')
          if (i < 0) return { ok: false, error: `Ánh xạ symbol phải có dạng TRADINGVIEW=SÀN (ví dụ XAUUSD=GOLD), "${part.trim().slice(0, 30)}" thiếu dấu =.` }
          pairs.push([part.slice(0, i), part.slice(i + 1)])
        }
      } else return { ok: false, error: 'Ánh xạ symbol không hợp lệ.' }
      for (const [a0, b0] of pairs) {
        const a = a0.trim()
        const b = b0.trim()
        if (!SYMBOL_RE.test(a) || !SYMBOL_RE.test(b)) return { ok: false, error: `Ánh xạ symbol "${a.slice(0, 20)}=${b.slice(0, 20)}" không hợp lệ (chỉ chữ, số, . _ # @ -).` }
        map[a.toUpperCase()] = b
      }
      if (Object.keys(map).length > 100) return { ok: false, error: 'Tối đa 100 ánh xạ symbol.' }
      value.symbolMap = map
    }
  }

  if ('tfs' in input) {
    if (input.tfs === null) remove.push('tfs')
    else {
      const raw = list(input.tfs)
      if (raw === null) return { ok: false, error: 'Khung giờ không hợp lệ.' }
      const t = raw.map((x) => x.toUpperCase())
      if (t.length === 1 && (t[0] === 'ALL' || t[0] === '*')) value.tfs = []
      else {
        const bad = t.find((x) => !TF_RE.test(x))
        if (bad !== undefined) return { ok: false, error: `Khung giờ "${bad.slice(0, 10)}" không hợp lệ (ví dụ M3, M5, M15, H1, H4, D1).` }
        value.tfs = [...new Set(t)]
      }
    }
  }
  return { ok: true, value, remove }
}

/** Gộp cài đặt mới vào cài đặt hiện có: giá trị mới ghi đè, `remove` xóa. */
export function mergeSettings(cur: Settings, add: Settings, remove: readonly (keyof Settings)[]): Settings {
  const out: Settings = { ...cur, ...add }
  for (const k of remove) delete out[k]
  return out
}

/** Biến môi trường sau khi áp cài đặt: mã kết nối từ giao diện thắng cả OCEAN_WORKER_URL/SYNC_KEY/SERVER_ID đặt tay. */
export function overlayEnv(env: NodeJS.ProcessEnv, s: Settings): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  if (s.connectCode !== undefined) {
    delete out.OCEAN_WORKER_URL
    delete out.OCEAN_SYNC_KEY
    delete out.OCEAN_SERVER_ID
    out.OCEAN_CONNECT_CODE = s.connectCode
  }
  if (s.accounts !== undefined) out.OCEAN_ACCOUNTS = s.accounts.join(',')
  return out
}
