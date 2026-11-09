# `scripts/` — Build và cài đặt

| Tệp | Vai trò |
|---|---|
| `build.mjs` | esbuild → `dist/server.mjs`, `dist/gateway.mjs` (Node 22, `node:sqlite` để ngoài) |
| `pack.mjs` | Tạo `release/ocean-relay` (dist, web, ea, scripts, docs, node.exe nếu chạy trên Windows) |
| `install-server.ps1` | Cài Server thành tác vụ SYSTEM lúc khởi động, sinh khóa, chờ health |
| `install-gateway.ps1` | Cài Gateway, chép EA vào các thư mục MT5 |
| `init-env.ps1` | Sinh `server.env` với khóa ngẫu nhiên, đặt ACL |
| `uninstall.ps1` | Gỡ tác vụ, giữ dữ liệu |
| `check-vps.ps1` | Kiểm tra sau cài: Server, Quick Tunnel, Worker kéo bù, số tín hiệu |
| `test-alert.ps1` | Gửi alert mẫu đúng khuôn text một dòng vào webhook để thử cả chuỗi |
| `*.env.example` | Mẫu cấu hình |
| `fake-ea.ts` | Giả lập EA khi chưa có MT5 (`npm run fake-ea`) |

`../Installer/ocean-relay.iss` (Inno Setup) bọc `install-server.ps1` thành `OceanRelay-Server-Setup.exe`, do `.github/workflows/release-server.yml` build. `install-server.ps1` giờ chép cả `scripts/`, `ea/`, `docs/` vào thư mục cài.

Script PowerShell và bộ cài **chưa chạy thử trên Windows thật**; kiểm thử thủ công theo [VPS-TEST.md](../VPS-TEST.md).
