export type ServerConfig = {
  port: number
  host: string
  dbFile: string
  webhookKey: string
  gatewayToken: string
  adminToken: string
  /** Tín hiệu cũ hơn ngưỡng này (giây) không giao cho EA nữa. */
  maxAgeSec: number
  dedupeSec: number
  uiDir: string
}

const need = (env: NodeJS.ProcessEnv, k: string, min = 16): string => {
  const v = env[k]
  if (!v || v.length < min) throw new Error(`${k} chưa đặt hoặc quá ngắn (tối thiểu ${min} ký tự)`)
  return v
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.OCEAN_PORT ?? 8090),
    host: env.OCEAN_HOST ?? '127.0.0.1',
    dbFile: env.OCEAN_DB ?? 'ocean.db',
    webhookKey: need(env, 'OCEAN_WEBHOOK_KEY'),
    gatewayToken: need(env, 'OCEAN_GATEWAY_TOKEN'),
    adminToken: need(env, 'OCEAN_ADMIN_TOKEN', 12),
    maxAgeSec: Number(env.OCEAN_MAX_AGE_SEC ?? 120),
    dedupeSec: Number(env.OCEAN_DEDUPE_SEC ?? 300),
    uiDir: env.OCEAN_UI_DIR ?? 'ui',
  }
}
