# Freelancer Escrow — đồ án blockchain

Nền tảng Client–Freelancer dùng smart contract giữ token thử nghiệm và phân bổ tiền theo milestone. Chỉ phục vụ học tập, chạy local; `MockUSDC` không phải USDC thật.

## Bắt đầu

Đọc [Giai đoạn 1 — Phân tích và phạm vi MVP](docs/01-mvp-va-nghiep-vu.md). Tài liệu có kiến trúc đề xuất, luồng tiền, quy tắc cần xác nhận, bài tập và tiêu chí hoàn thành.

Tiếp theo: [Giai đoạn 2 — Yêu cầu, use case và ca nghiệm thu](docs/02-yeu-cau-va-use-case.md). Có bảng đối chiếu giao diện hiện có với chức năng thật còn thiếu, 23 yêu cầu chức năng, 12 use case và 21 ca nghiệm thu dự kiến. Các ca chưa được chạy vì backend/contract chưa được triển khai.

Hiện tại repository có giao diện React + TypeScript + Vite dùng dữ liệu mẫu và `localStorage`. Nút đổi vai trò, số dư, transaction hash và trạng thái xác nhận trên giao diện là mô phỏng; chưa chứng minh có giao dịch blockchain. Chưa có backend, Prisma/PostgreSQL hay Solidity/Hardhat. Đã cài dependency và kiểm tra `npm.cmd run build` thành công sau Giai đoạn 1.

## Chạy giao diện demo

Mở PowerShell tại thư mục dự án. Trên máy hiện tại đã cài thư viện, chạy:

```powershell
Set-Location -LiteralPath 'D:\git_hub\BlockChain\BlockChain__'
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Mở [giao diện local](http://127.0.0.1:5173/). Giữ terminal chạy; nhấn `Ctrl+C` để dừng. Nếu cổng đã được dùng bởi bản demo đang chạy thì mở URL hiện có, hoặc dừng server cũ trước khi chạy lại.

Khi mới tải repository hoặc chưa có `node_modules`, cài thư viện trước:

```powershell
npm.cmd ci --cache .npm-cache --no-audit --no-fund
```

Nếu npm báo `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, với Node 24 đang dùng trên máy này có thể sử dụng kho chứng chỉ hệ thống Windows rồi chạy lại lệnh cài:

```powershell
$env:NODE_USE_SYSTEM_CA = '1'
npm.cmd ci --cache .npm-cache --no-audit --no-fund
```

Kiểm tra bản build:

```powershell
npm.cmd run build
```

Thử demo: mở dự án mẫu, đổi vai trò để xem thao tác Client/Freelancer/Arbitrator. Milestone 2 của dự án website có sẵn trạng thái Submitted để thử nghiệm thu, yêu cầu sửa hoặc tranh chấp. Chọn “Yêu cầu sửa”, đổi sang Freelancer rồi gửi bàn giao lại. Dữ liệu lưu theo trình duyệt/origin; muốn trở về mẫu, xóa hai khóa localStorage `fe-projects` và `fe-txs` rồi tải lại trang.

## Cấu trúc hiện tại

```text
README.md
docs/
  01-mvp-va-nghiep-vu.md
  02-yeu-cau-va-use-case.md
src/
  App.tsx
  main.tsx
  style.css
package.json
package-lock.json
index.html
tsconfig*.json
vite.config.ts
```

## Lộ trình

1. Phân tích bài toán và phạm vi MVP — đã có tài liệu; mặc định nghiệp vụ là giả định làm việc.
2. Yêu cầu chức năng, phi chức năng và use case — đã soạn đặc tả, chờ người học xem; chưa triển khai chức năng.
3. State machine, quyền hạn, thời hạn và quy tắc tiền.
4. Kiến trúc chi tiết, ERD và transaction flow.
5. Thiết lập môi trường và cấu trúc dự án.
6. Mock ERC-20 và escrow contract.
7. Unit test, kiểm thử thất bại và hành vi tấn công.
8. Backend, tài khoản và database.
9. MetaMask và giao tiếp on-chain.
10. Dashboard cho ba vai trò.
11. Tích hợp, đối soát và xử lý lỗi.
12. Demo local, báo cáo và kịch bản bảo vệ.

Mỗi giai đoạn có điểm kiểm tra trước khi chuyển tiếp. Phiên bản dependency sẽ được kiểm tra và khóa ở bước cài đặt; không nâng cấp giao diện hiện có trong bước phân tích.

Giai đoạn 1–4 tạo yêu cầu và thiết kế. Giai đoạn 5 thiết lập đầy đủ môi trường; 6–7 viết và kiểm thử contract; 8 xây backend/database; 9–10 kết nối ví và hoàn thiện các luồng trên UI; 11–12 kiểm thử tích hợp và chuẩn bị demo. Giao diện Vite chạy được hiện nay chưa đồng nghĩa đã có nền tảng escrow hoạt động.
