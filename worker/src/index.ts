// Điểm vào của Worker. Chỉ được `export default`: Cloudflare coi mọi export có tên là một entrypoint, nên
// logic (và các hằng số) nằm ở handler.ts / retention.ts.
import { type Ctx, type Env, handle } from './handler'
import { runRetention } from './retention'

export default {
  fetch: (req: Request, env: Env, ctx: Ctx): Promise<Response> => handle(req, env, ctx),
  /** Cron Trigger (wrangler.jsonc → triggers.crons): mỗi ngày dọn tín hiệu cũ theo cấu hình retention. */
  scheduled: async (event: { scheduledTime?: number }, env: Env): Promise<void> => {
    await runRetention(env, Math.floor((event.scheduledTime ?? Date.now()) / 1000))
  },
}
