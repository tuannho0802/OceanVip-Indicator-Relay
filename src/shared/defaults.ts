/**
 * Cổng cục bộ mặc định của Gateway (EA nối tới). Cố ý KHÔNG dùng 47800 để không đụng các Gateway khác cùng VPS
 * (ví dụ AZ Sentinel). Đổi được ở trang Cài đặt (mục Nâng cao) mà không phải cài lại.
 */
export const DEFAULT_GW_PORT = 47860
/** Cổng Gateway hợp lệ: bỏ các cổng hệ thống (< 1024). */
export const MIN_GW_PORT = 1024
export const MAX_PORT = 65535

export const isGwPort = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= MIN_GW_PORT && n <= MAX_PORT
