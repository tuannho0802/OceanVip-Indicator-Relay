# CI/CD (GitHub Actions)

Hai workflow trong `.github/workflows/`, cùng cách kích hoạt với repo AZ-Sentinel: **chỉ chạy khi commit mới nhất của lần push lên `main` có từ khóa trong message**.

| Từ khóa trong commit | Workflow | Làm gì |
|---|---|---|
| `[deploy]` | `deploy.yml` | Deploy **Worker** Cloudflare |
| `[release-server]` | `release-server.yml` | Build **bộ cài Server** Windows và tạo GitHub Release |

Không có từ khóa thì cả hai bị bỏ qua (job `skipped`, không tốn phút build). Chạy tay: Actions → chọn workflow → **Run workflow** (`deploy` luôn deploy; `release-server` chỉ build và để file ở Artifacts, không tạo Release).

```bash
git commit -m "fix(worker): giu body goc [deploy]"
git commit -m "feat(server): doc khuon moi [release-server]"
git commit -m "feat: doi khuon alert [deploy][release-server]"   # cả hai
```

## `deploy.yml` — Worker
Thứ tự: `typecheck` + `npm test` → điền `database_id` (nếu còn ID giả) → `wrangler d1 migrations apply ocean-relay --remote` → `wrangler deploy` (thử lại tối đa 3 lần khi Cloudflare báo lỗi tạm thời). Kiểm tra hỏng thì dừng, không deploy.

Secret cần đặt trong **Settings → Secrets and variables → Actions**:

| Secret | Nội dung |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token quyền *Workers Scripts: Edit* và *D1: Edit* |
| `CLOUDFLARE_ACCOUNT_ID` | ID tài khoản Cloudflare |
| `D1_DATABASE_ID` | `database_id` của D1 `ocean-relay`. Chỉ cần khi `worker/wrangler.jsonc` trong repo còn ID giả `0000…` |

`WEBHOOK_KEY` và `SYNC_KEY` là secret của Worker, đặt **một lần** bằng `cd worker && npm run setup`; workflow không đụng tới chúng nên deploy không làm đổi khóa.

## `release-server.yml` — bộ cài Server
Chạy trên `windows-latest`: `typecheck` + test → đọc `version` từ `package.json` → dừng nếu release `server-v<version>` đã có → `npm run pack` (esbuild + gói `release/ocean-relay` kèm `node.exe`) → **smoke test** (chạy gói thật, gửi đúng alert mẫu một dòng text qua webhook, yêu cầu Server đọc ra `kind=entry`) → Inno Setup (`Installer/ocean-relay.iss`) → SHA256 → Artifacts + GitHub Release `server-v<version>`.

Đầu ra:
- `OceanRelay-Server-Setup.exe`: bộ cài (hỏi Worker URL + SYNC_KEY, hoặc cài im lặng).
- `OceanRelay-Server-<version>.zip`: bản portable (chạy `scripts\install-server.ps1` thủ công).
- `SHA256SUMS.txt`.

**Trước khi release phải tăng `"version"` trong `package.json`** (và `worker/package.json` cho khớp nếu muốn), nếu không workflow dừng vì release đã tồn tại. Không cần secret nào ngoài `GITHUB_TOKEN` mặc định.

Cài im lặng:
```powershell
.\OceanRelay-Server-Setup.exe /VERYSILENT /WORKERURL=https://ocean-relay.<tên>.workers.dev /SYNCKEY=<SYNC_KEY> [/PORT=8090] [/WEBHOOKKEY=<>=16 ký tự>]
```
Không có `/WORKERURL` + `/SYNCKEY` thì Server chạy không có Worker (chỉ nhận webhook trực tiếp nếu có `/WEBHOOKKEY`).

## Khác biệt so với AZ-Sentinel
- npm thay cho pnpm (repo này không dùng workspace).
- Không có Web/API tách rời: Worker chỉ có một bước deploy; giao diện nằm trong gói Server (`web/`).
- Không có bộ cài Gateway riêng: `dist\gateway.mjs` và `scripts\install-gateway.ps1` đi cùng gói Server (Gateway chạy cùng máy MT5).
- Không có tài khoản quản trị/token cá nhân: không đăng nhập, bảo mật bằng khóa + chữ ký HMAC.
