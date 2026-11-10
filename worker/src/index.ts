// Điểm vào của Worker. Chỉ được `export default`: Cloudflare coi mọi export có tên là một entrypoint, nên
// logic (và các hằng số) nằm ở handler.ts / retention.ts / deliver.ts.
import { flushPending } from './deliver'
import { type Ctx, type Env, handle } from './handler'
import { RETENTION_CRON, runRetention } from './retention'

export default {
  fetch: (req: Request, env: Env, ctx: Ctx): Promise<Response> => handle(req, env, ctx),
  /**
   * Cron Trigger (wrangler.jsonc → triggers.crons):
   *  - `0 20 * * *`: mỗi ngày dọn tín hiệu cũ theo cấu hình retention.
   *  - `* * * * *` : mỗi phút Worker chủ động đẩy lại các tín hiệu chưa giao được cho VPS (không đợi VPS kéo bù).
   */
  scheduled: async (event: { scheduledTime?: number; cron?: string }, env: Env): Promise<void> => {
    const now = Math.floor((event.scheduledTime ?? Date.now()) / 1000)
    if (event.cron !== RETENTION_CRON) await flushPending(env, fetch, now)
    if (event.cron === undefined || event.cron === RETENTION_CRON) await runRetention(env, now)
  },
}
