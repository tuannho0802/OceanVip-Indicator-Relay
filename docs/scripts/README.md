# `scripts/` — Build và cài đặt

| Tệp | Vai trò |
|---|---|
| `build.mjs` | esbuild → `dist/server.mjs`, `dist/gateway.mjs` (Node 22, `node:sqlite` để ngoài) |
| `pack.mjs` | Tạo `release/ocean-relay` (dist, web, ea, scripts, docs, node.exe nếu chạy trên Windows) |
| `install-server.ps1` | Cài Server thành tác vụ SYSTEM lúc khởi động, sinh khóa, chờ health |
| `install-gateway.ps1` | Cài Gateway, chép EA vào các thư mục MT5 |
| `init-env.ps1` | Sinh `server.env` với khóa ngẫu nhiên, đặt ACL |
| `uninstall.ps1` | Gỡ tác vụ, giữ dữ liệu |
| `*.env.example` | Mẫu cấu hình |
| `fake-ea.ts` | Giả lập EA khi chưa có MT5 (`npm run fake-ea`) |

Script PowerShell **chưa chạy thử trên Windows thật**. Chưa có bộ cài `.exe` (Inno Setup).
