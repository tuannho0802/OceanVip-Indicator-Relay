// Điểm vào của Worker. Chỉ được `export default`: Cloudflare coi mọi export có tên là một entrypoint, nên
// logic (và các hằng số) nằm ở handler.ts.
import { type Ctx, type Env, handle } from './handler'

export default {
  fetch: (req: Request, env: Env, ctx: Ctx): Promise<Response> => handle(req, env, ctx),
}
