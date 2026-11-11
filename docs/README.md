# Tài liệu OCEAN Relay

Luồng tổng: **TradingView alert → Worker (Cloudflare) → Server (VPS) → Gateway (localhost) → EA (MT5)**.
Không có đăng nhập; giao diện công khai, chỉ đọc. Bảo mật nằm ở các khóa và chữ ký, không ở mật khẩu người dùng.

## Tài liệu chung
| Tệp | Nội dung |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Kiến trúc, luồng dữ liệu, vì sao Worker không bị đầy hạn mức |
| [SECURITY.md](SECURITY.md) | Mô hình đe dọa, các khóa, chữ ký, giới hạn đã biết |
| [DEPLOY.md](DEPLOY.md) | Cài từ đầu: Worker, VPS, Gateway, MT5, TradingView |
| [USER-GUIDE.md](USER-GUIDE.md) | Hướng dẫn cho người dùng cuối: cài, MT5, sự cố |
| [CONFIG.md](CONFIG.md) | Bảng biến môi trường đầy đủ (Server, Gateway, Worker) |
| [PROTOCOL.md](PROTOCOL.md) | Giao thức từng chặng và định dạng dòng S/U cho EA |
| [OPERATIONS.md](OPERATIONS.md) | Vận hành, log, sự cố thường gặp |
| [ALERT-FORMAT.md](ALERT-FORMAT.md) | Định dạng alert text một dòng của indicator (mẫu thật) |
| [CICD.md](CICD.md) | GitHub Actions: `[deploy]` cho Worker, `[release-server]` cho bộ cài |
| [CHANGELOG.md](CHANGELOG.md) | Thay đổi theo từng bản (Server / EA) |
| [VPS-TEST.md](VPS-TEST.md) | Kiểm thử thủ công bộ cài, Quick Tunnel, giao diện trên VPS |

## Tài liệu theo thư mục
| Thư mục | Tài liệu |
|---|---|
| `src/server/` | [server/README.md](server/README.md) |
| `src/shared/` | [shared/README.md](shared/README.md) |
| `src/gateway/` | [gateway/README.md](gateway/README.md) |
| `worker/` | [worker/README.md](worker/README.md) |
| `ea/` | [ea/README.md](ea/README.md) |
| `ui/` | [ui/README.md](ui/README.md) |
| `scripts/` | [scripts/README.md](scripts/README.md) |
| `test/` | [tests/README.md](tests/README.md) |
