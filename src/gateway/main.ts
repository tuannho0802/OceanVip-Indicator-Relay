import { loadEnvIfPresent } from '../shared/env'
loadEnvIfPresent('gateway.env')
import { Gateway, loadGatewayConfig } from './gateway'

const cfg = loadGatewayConfig()
new Gateway(cfg).listen()
console.log(`[ocean-gateway] 127.0.0.1:${cfg.port} -> ${cfg.serverUrl}  tfs=${cfg.tfs.join(',') || 'all'}`)
