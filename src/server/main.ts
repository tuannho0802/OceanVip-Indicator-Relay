import { loadEnvIfPresent } from '../shared/env'
loadEnvIfPresent('server.env')
import { createApp } from './app'
import { loadConfig } from './config'

const cfg = loadConfig()
const app = createApp(cfg)
app.server.listen(cfg.port, cfg.host, () => {
  console.log(`[ocean-server] http://${cfg.host}:${cfg.port}  db=${cfg.dbFile}  maxAge=${cfg.maxAgeSec}s`)
})
setInterval(() => app.store.prune(Math.floor(Date.now() / 1000) - 30 * 86400), 6 * 3600 * 1000).unref()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.close(); process.exit(0) })
