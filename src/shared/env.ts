import { existsSync } from 'node:fs'

/** Nạp file env (OCEAN_ENV_FILE hoặc ./<tên mặc định>) nếu có; biến đã đặt sẵn trong môi trường được ưu tiên. */
export function loadEnvIfPresent(defaultName: string): void {
  const file = process.env.OCEAN_ENV_FILE ?? defaultName
  if (existsSync(file)) process.loadEnvFile(file)
}
