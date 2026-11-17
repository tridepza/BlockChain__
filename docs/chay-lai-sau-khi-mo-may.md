# Chạy lại hệ thống sau khi mở máy

Chỉ cần hai terminal PowerShell chạy thường trực. Mở cả hai tại thư mục dự án. Không cần cài lại thư viện, migrate database hay deploy token sau mỗi lần mở máy.

Nếu thật sự cần cài lại thư viện sau khi cập nhật mã nguồn, dừng cả web và blockchain bằng `Ctrl+C` trước khi chạy `npm.cmd ci --cache .npm-cache --no-audit --no-fund`. Trên Windows, chạy `npm ci` khi Vite/Hardhat còn mở có thể gặp `EPERM` và để lại `node_modules` chưa đầy đủ.

## Terminal 1: blockchain

```powershell
cd "C:\Users\daoph\OneDrive\Documents\GitHub\BlockChain__"
npm.cmd run chain:node
```

Giữ terminal này mở. RPC là `http://127.0.0.1:8545`, Chain ID `31337`, ký hiệu phí gas `ETH` thử nghiệm. Không mở thêm Hardhat node hoặc Anvil ở cùng cổng.

Chain mới sử dụng Hardhat với nhật ký block/giao dịch đã ký tại `.data/chain/state.json`. Node kiểm tra và phát lại nhật ký khi mở; token, vault, số dư, receipt và hash block được giữ nguyên. Giao dịch được ghi bền vững trước khi RPC trả xác nhận. Không xóa `.data`, không chỉnh nhật ký và không deploy lại token để sửa số dư. Giữ các phiên bản thư viện trong `package-lock.json` để phát lại cùng engine.

Chỉ một tiến trình được mở cùng một state, kể cả khi chọn cổng RPC khác hoặc truy cập qua đường dẫn liên kết. Nếu bản node cũ bị tắt giữa lúc tạo khóa và báo **Khóa state chưa hoàn chỉnh và còn mới**, chờ ít nhất 60 giây rồi chạy lại; node tự thu hồi khóa cũ. Nếu báo cổng khóa đang bị chiếm, dừng tiến trình đang giữ state hoặc cổng đó trước khi thử lại. Không xóa state để xử lý lỗi khóa.

## Terminal 2: website và API

```powershell
cd "C:\Users\daoph\OneDrive\Documents\GitHub\BlockChain__"
$env:ESCROW_DB = 'mongodb'
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Mở **http://127.0.0.1:5173/** trong trình duyệt có MetaMask. API đã nằm trong Vite; không chạy server API riêng. MongoDB Atlas và Gmail SMTP dùng cấu hình `.env.mongo.local`, `.env.mail.local`, cần kết nối Internet nhưng không cần terminal riêng. MongoDB local trên máy không phải database của ứng dụng hiện tại.

## Kiểm tra khi cần

Trong một terminal phụ, chạy lệnh sau rồi có thể đóng terminal:

```powershell
npm.cmd run check:system
```

Lệnh kiểm tra Node.js, database, kết nối SMTP, web/API và token/factory/vault trên RPC. Lệnh không gửi email, migrate, deploy hoặc sửa dữ liệu. Khi hai terminal thường trực đã chạy đúng, các thành phần phải báo `OK`.

Muốn chạy kiểm thử:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:contracts
npm.cmd run test:e2e
```

E2E tự mở server kiểm thử riêng với SQLite trong RAM và OTP giả. Trên Windows, nếu chưa cài Chromium của Playwright, cấu hình tự dùng Chrome đã cài. Muốn chọn trình duyệt rõ ràng, đặt `$env:ESCROW_TEST_BROWSER = 'chrome'` trước khi chạy E2E.

## Dừng và sao lưu

Nhấn `Ctrl+C` trong từng terminal để dừng. Sao lưu `.data/chain/state.json` và các manifest trong `.hardhat/` cùng nhau khi node đã dừng. Database Atlas được sao lưu riêng. Không đưa cấu hình chứa mật khẩu hoặc dữ liệu cá nhân lên Git.

## Dữ liệu FESC thuộc chain trước

Chain local cũ không có snapshot hoặc nhật ký, nên không thể khôi phục số dư, receipt và hợp đồng cũ từ database ứng dụng. Các manifest trước khi khởi tạo môi trường mới được giữ dưới `.data/backups/chain-init-*`; database tài khoản và dự án không bị xóa. Dự án FESC thuộc deployment trước chỉ còn lịch sử đã ghi nhận, không thể ký tiếp trên chain mới. Tạo dự án mới để sử dụng chain hiện tại.

`chain:init -- --new` là lệnh tạo môi trường thử mới có sao lưu, **không phải lệnh khởi động hằng ngày và không phải công cụ khôi phục số dư**. Lệnh từ chối nếu đã có state để tránh thay thế chain đang dùng. Không chạy `chain:deploy:fesc`, `chain:deploy` hoặc `FESC_FORCE_REDEPLOY` sau mỗi lần mở máy.
