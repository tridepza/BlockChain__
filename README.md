# Freelancer Escrow — đồ án blockchain

Đồ án Freelancer Escrow mô phỏng quy trình ký quỹ và thanh toán theo milestone. Website chạy local với React, Vite và API Node.js.

## Bắt đầu

Đọc [Giai đoạn 1 — Phân tích và phạm vi MVP](docs/01-mvp-va-nghiep-vu.md). Tài liệu có kiến trúc đề xuất, luồng tiền, quy tắc cần xác nhận, bài tập và tiêu chí hoàn thành.

Tiếp theo, xem [Giai đoạn 2 — Yêu cầu, use case và ca nghiệm thu](docs/02-yeu-cau-va-use-case.md) để đối chiếu đặc tả MVP. Các ca nghiệm thu trong tài liệu bao gồm nhiều bước tích hợp blockchain ngoài phạm vi mô phỏng hiện tại.

Tài khoản Client và Freelancer hỗ trợ đăng ký, đăng nhập, đăng xuất và sửa tên hiển thị. Mật khẩu được băm bằng scrypt có salt riêng. Cookie phiên HttpOnly có hiệu lực 7 ngày và được thu hồi khi đăng xuất. SQLite lưu tài khoản, phiên và dữ liệu workspace tại `.data/escrow.sqlite`.

Xem [Giai đoạn 3 — Trạng thái, quyền hạn và quy tắc tiền](docs/03-state-machine-va-quy-tac-tien.md), đã cải tiến ngày 07/11/2026 ở mức tài liệu. [Giai đoạn 4 — Kiến trúc chi tiết, ERD và luồng giao dịch](docs/04-kien-truc-erd-va-transaction-flow.md) đã có mục 1: sơ đồ thành phần, ranh giới trách nhiệm, nơi lưu file và quyền đọc; mục 2: ERD, lược đồ quan hệ và ràng buộc dữ liệu. Luồng giao dịch chi tiết và các mục còn lại chưa thực hiện; chưa triển khai PostgreSQL.

## Chạy website local

Yêu cầu Node.js 24 trở lên. Mở PowerShell tại thư mục dự án rồi chạy:

```powershell
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

## Thử các luồng

- **Workspace tài khoản.** Đăng ký một Client và một Freelancer. Dùng hai hồ sơ trình duyệt hoặc một cửa sổ thường và một cửa sổ ẩn danh để giữ hai phiên riêng. Client tạo dự án, chọn Freelancer qua email đã đăng ký rồi ký quỹ. Freelancer bấm **Làm mới** để thấy dự án và gửi bàn giao. Client có thể yêu cầu sửa, nghiệm thu hoặc hủy hợp đồng để hoàn phần chưa phân bổ trong mô phỏng.
- **Bản demo.** Chọn **Thử bản demo** ở trang đăng nhập để đổi giữa Client, Freelancer và Arbitrator trên dữ liệu mẫu. Milestone 2 của dự án website đã có bàn giao để thử nhánh tranh chấp và phân xử. Dữ liệu demo lưu riêng trong trình duyệt. Xóa hai khóa `fe-projects` và `fe-txs` để trở về dữ liệu mẫu.

Ký quỹ, giải ngân và hoàn tiền trên website là giao dịch MOCK. Liên kết ví, giao dịch on-chain và phân xử trên workspace tài khoản nằm ngoài phần triển khai hiện tại.

## Kiểm thử tự động

### Bộ công cụ blockchain — Giai đoạn 5, phần 1–2

Đã cài Hardhat 3, Viem và Viem Toolbox (Node.js test runner). Phiên bản các dependency mới được cố định trong `package.json` và `package-lock.json`; kiểu Node.js dùng nhánh 24. Cấu hình dựa trên [Viem Toolbox](https://hardhat.org/docs/plugins/hardhat-toolbox-viem) và [cấu hình Hardhat](https://hardhat.org/docs/reference/configuration).

`hardhat.config.ts` cố định Solidity **0.8.30**, optimizer **enabled, 200 runs**, EVM target **shanghai**. Nguồn nằm trong `contracts/`, test TypeScript trong `tests/contracts/`, đầu ra/cache mới nằm trong `.hardhat/` và không đưa vào Git. Cấu hình TypeScript cho blockchain nằm riêng trong `tsconfig.hardhat.json`, không thay cấu hình React.

```powershell
npm.cmd ci --cache .npm-cache --no-audit --no-fund
npm.cmd run compile:contracts
npm.cmd run typecheck:contracts
npm.cmd run test:contracts
```

Lần biên dịch đầu cần Internet để Hardhat tải compiler. `ToolchainCheck.sol` chỉ kiểm tra môi trường; test triển khai nó trên mạng mô phỏng tạm thời và đọc giá trị bằng Viem, không cần mở node riêng hoặc MetaMask. Chưa triển khai MockUSDC, factory hoặc nghiệp vụ escrow. Cấu hình node local lâu dài, ví và deploy/seed thuộc các phần tiếp theo.

Các thư mục `artifacts/` và `cache/` có từ trước không được dùng bởi cấu hình mới; không coi chúng là kết quả biên dịch có thể tái tạo từ mã nguồn escrow hiện tại.

### Website và API

```powershell
npm.cmd run build
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Đặt `$env:ESCROW_TEST_BROWSER = 'chrome'` trước khi chạy E2E nếu muốn dùng Google Chrome đã cài trên máy. Playwright khởi động server riêng với SQLite trong bộ nhớ. Có thể chạy bản build local bằng `npm.cmd run preview -- --host 127.0.0.1 --strictPort`.

## Cấu trúc hiện tại

```text
README.md
docs/
  01-mvp-va-nghiep-vu.md
  02-yeu-cau-va-use-case.md
  03-state-machine-va-quy-tac-tien.md
  04-kien-truc-erd-va-transaction-flow.md
server/
  api.mjs
src/
  App.tsx
  Auth.tsx
  workflow.ts
  main.tsx
  style.css
tests/
package.json
package-lock.json
index.html
tsconfig*.json
vite.config.ts
```

## Lộ trình

1. Phân tích bài toán và phạm vi MVP — đã có tài liệu; mặc định nghiệp vụ là giả định làm việc.
2. Yêu cầu chức năng, phi chức năng và use case — đã soạn đặc tả, chờ người học xem; chưa triển khai chức năng.
3. State machine, quyền hạn, thời hạn và quy tắc tiền — đã hoàn thành và cải tiến tài liệu; chưa nghiệm thu triển khai on-chain.
4. Kiến trúc chi tiết, ERD và transaction flow — đã có thiết kế sơ đồ thành phần và ERD/lược đồ quan hệ; các phần còn lại chưa thực hiện.
5. Thiết lập môi trường và cấu trúc dự án.
6. Mock ERC-20 và escrow contract.
7. Unit test, kiểm thử thất bại và hành vi tấn công.
8. Backend, tài khoản và database — đã có đăng ký, phiên và hồ sơ trên SQLite local. Liên kết ví thuộc phần tích hợp tiếp theo.
9. MetaMask và giao tiếp on-chain.
10. Dashboard cho ba vai trò.
11. Tích hợp, đối soát và xử lý lỗi.
12. Demo local, báo cáo và kịch bản bảo vệ.
