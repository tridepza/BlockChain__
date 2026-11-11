# Freelancer Escrow — đồ án blockchain

Đồ án Freelancer Escrow mô phỏng quy trình ký quỹ và thanh toán theo milestone. Website chạy local với React, Vite và API Node.js.

## Bắt đầu

Đọc [Giai đoạn 1 — Phân tích và phạm vi MVP](docs/01-mvp-va-nghiep-vu.md). Tài liệu có kiến trúc đề xuất, luồng tiền, quy tắc cần xác nhận, bài tập và tiêu chí hoàn thành.

Tiếp theo, xem [Giai đoạn 2 — Yêu cầu, use case và ca nghiệm thu](docs/02-yeu-cau-va-use-case.md) để đối chiếu đặc tả MVP. Các ca nghiệm thu trong tài liệu bao gồm nhiều bước tích hợp blockchain ngoài phạm vi mô phỏng hiện tại.

Tài khoản Client và Freelancer hỗ trợ đăng ký, đăng nhập, đăng xuất và sửa tên hiển thị. Mật khẩu được băm bằng scrypt có salt riêng. Cookie phiên HttpOnly có hiệu lực 7 ngày và được thu hồi khi đăng xuất. Backend dùng MongoDB hoặc PostgreSQL khi được cấu hình. Với bản clone mới, backend dùng SQLite tại `.data/escrow.sqlite` cho đến khi có cấu hình database khác.

Xem [Giai đoạn 3 — Trạng thái, quyền hạn và quy tắc tiền](docs/03-state-machine-va-quy-tac-tien.md) và [Giai đoạn 4 — Kiến trúc chi tiết, ERD và luồng giao dịch](docs/04-kien-truc-erd-va-transaction-flow.md). Giai đoạn 4 đã hoàn thành ở mức thiết kế, gồm sơ đồ dữ liệu, luồng xác minh ví và giao dịch, giao diện API/contract, quy cách hash và đối soát. Bước tiếp theo là hoàn tất môi trường local của Giai đoạn 5.

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

## Kết nối MongoDB Atlas

1. Trong Atlas, vào **Connect → Drivers** của cluster và lấy URI. Cấp quyền `readWrite` trên database `freelancer_escrow` cho tài khoản kết nối và thêm IP của mỗi máy vào **Network Access**.
2. Sao chép `.env.mongo.example` thành `.env.mongo.local` ở thư mục gốc. Điền URI vào `MONGODB_URI`. Mỗi máy giữ tệp cục bộ riêng và dùng cùng tên `MONGODB_DB` để chia sẻ dữ liệu.
3. Trên một máy, chạy `db:migrate` để tạo collections và chỉ mục. Sau đó mỗi máy chạy `db:check` và khởi động lại website.

```powershell
npm.cmd run db:migrate
npm.cmd run db:check
```

Khi có `MONGODB_URI`, backend chọn MongoDB trước PostgreSQL. MongoDB cần Atlas hoặc replica set để ghi trạng thái dự án và giao dịch trong cùng một transaction. Khởi tạo MongoDB tạo schema cho dữ liệu mới. Tài khoản và dự án đã có trong SQLite hoặc PostgreSQL cần được chuyển riêng nếu muốn dùng lại.

## Kết nối PostgreSQL local

1. Tạo tài khoản có quyền đăng nhập `freelancer_app` và database `freelancer_escrow` với **Owner** là tài khoản đó.
2. Sao chép `.env.postgres.example` sang `.env.postgres.local` ở thư mục gốc. Điền mật khẩu của `freelancer_app` vào `PGPASSWORD`. Dùng dấu ngoặc kép bao quanh giá trị nếu mật khẩu có khoảng trắng hoặc ký tự `#`. Git bỏ qua tệp cấu hình cục bộ này.
3. Trong terminal tại thư mục dự án, khởi tạo bảng rồi kiểm tra kết nối.

```powershell
npm.cmd run db:migrate
npm.cmd run db:check
```

Khởi động lại website bằng lệnh dev ở trên. PostgreSQL lưu dữ liệu mới sau khi chuyển kết nối. Dữ liệu SQLite cũ vẫn nằm ở `.data/escrow.sqlite` và có thể mở lại bằng cách đặt `ESCROW_DB=sqlite` trong cấu hình cục bộ.

Nếu máy đã cấu hình MongoDB, đặt `$env:ESCROW_DB = 'postgres'` trong terminal trước khi chạy các lệnh database và website bằng PostgreSQL.

## Thử các luồng

- **Workspace tài khoản.** Đăng ký một Client và một Freelancer. Dùng hai hồ sơ trình duyệt hoặc một cửa sổ thường và một cửa sổ ẩn danh để giữ hai phiên riêng. Client tạo dự án, chọn Freelancer qua email đã đăng ký rồi ký quỹ. Freelancer bấm **Làm mới** để thấy dự án và gửi bàn giao. Client có thể yêu cầu sửa hoặc nghiệm thu. Để hủy dự án đã ký quỹ, một bên chọn **Đề nghị hủy**, bên còn lại bấm **Làm mới** và xác nhận trong 72 giờ. Số dư chưa phân bổ chỉ được hoàn khi xác nhận thành công. Tiến độ thay đổi làm đề nghị cũ hết hiệu lực.
- **Bản demo.** Chọn **Thử bản demo** ở trang đăng nhập để đổi giữa Client, Freelancer và Arbitrator trên dữ liệu mẫu. Milestone 2 của dự án website đã có bàn giao để thử nhánh tranh chấp và phân xử. Dữ liệu demo lưu riêng trong trình duyệt. Xóa hai khóa `fe-projects` và `fe-txs` để trở về dữ liệu mẫu.

Ký quỹ, giải ngân và hoàn tiền trên website là giao dịch MOCK. Liên kết ví, giao dịch on-chain và phân xử trên workspace tài khoản nằm ngoài phần triển khai hiện tại.

## Kiểm thử tự động

### Smart contract và bộ công cụ blockchain

Đã cài Hardhat 3, Viem và Viem Toolbox (Node.js test runner). Phiên bản các dependency mới được cố định trong `package.json` và `package-lock.json`; kiểu Node.js dùng nhánh 24. Cấu hình dựa trên [Viem Toolbox](https://hardhat.org/docs/plugins/hardhat-toolbox-viem) và [cấu hình Hardhat](https://hardhat.org/docs/reference/configuration).

`hardhat.config.ts` cố định Solidity **0.8.30**, optimizer **200 runs**, **viaIR** và EVM target **shanghai**. Mã Solidity nằm trong `contracts/`, dùng OpenZeppelin Contracts 5.6.1. Test TypeScript nằm trong `tests/contracts/`. ABI, bytecode và cache mới được sinh trong `.hardhat/`.

```powershell
npm.cmd ci --cache .npm-cache --no-audit --no-fund
npm.cmd run compile:contracts
npm.cmd run typecheck:contracts
npm.cmd run test:contracts
```

Lần biên dịch đầu cần Internet để Hardhat tải compiler. Test triển khai `ToolchainCheck`, `MockUSDC`, `EscrowFactory` và `Escrow` trên mạng mô phỏng tạm thời.

`EscrowFactory` nhận địa chỉ token và `instanceKey` khác 0. Mỗi lần triển khai dùng một khóa ngẫu nhiên 32 byte mới. `createEscrow(terms, expectedTermsHash)` tính lại hash theo [quy cách Giai đoạn 4](docs/04-kien-truc-erd-va-transaction-flow.md#74-file-điều-khoản-và-đề-nghị-đồng-thuận), kiểm tra hạn tạo và chỉ tạo một lần cho mỗi cặp Client–`agreementRef`. Các hàm xử lý milestone, phân xử và đồng thuận trong `Escrow` dùng ABI của bản Solidity khôi phục. Chữ ký hàm và event thực tế nằm trong ABI mới tại `.hardhat/artifacts/`. Thư mục `artifacts/` ở gốc là đầu ra của bản cũ.

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
4. Kiến trúc chi tiết, ERD và transaction flow — đã hoàn thành thiết kế.
5. Thiết lập môi trường và cấu trúc dự án.
6. Mock ERC-20 và escrow contract.
7. Unit test, kiểm thử thất bại và hành vi tấn công.
8. Backend, tài khoản và database — đã có đăng ký, phiên và hồ sơ trên SQLite, PostgreSQL hoặc MongoDB. Liên kết ví thuộc phần tích hợp tiếp theo.
9. MetaMask và giao tiếp on-chain.
10. Dashboard cho ba vai trò.
11. Tích hợp, đối soát và xử lý lỗi.
12. Demo local, báo cáo và kịch bản bảo vệ.
