# Hướng dẫn Codex cho Freelancer Escrow

Dự án dùng React, TypeScript và Vite cho giao diện, Node.js cho API, Solidity và Hardhat cho hợp đồng. Vite chạy kèm API trong môi trường phát triển. Dùng Node.js 24 trở lên và `npm.cmd` trong PowerShell.

## Tìm phần cần sửa

| Công việc | Tệp bắt đầu |
| --- | --- |
| Workspace, trạng thái dự án và yêu cầu từ giao diện | `src/App.tsx`, `src/workflow.ts`, `src/api.ts` |
| Đăng nhập, đăng ký và OTP | `src/Auth.tsx`, `server/api.mjs`, `server/auth-otp.mjs`, `server/mail.mjs` |
| MetaMask, ký quỹ và nạp/rút FESC | `src/WalletLink.tsx`, `src/ProjectFesc.tsx`, `src/FescAccount.tsx`, `server/project-fesc.mjs`, `contracts/` |
| Lịch sử giao dịch và bảng Top FESC | `src/Explorer.tsx`, `server/project-fesc.mjs`, `server/public-projects.mjs` |
| Database và lưu trạng thái blockchain local | `server/database.mjs`, `server/storage-target.mjs`, `scripts/local-node.mjs`, `scripts/hardhat-node.mjs` |

Đối chiếu [quy tắc trạng thái và dòng tiền](docs/03-state-machine-va-quy-tac-tien.md) và [kiến trúc, ERD và luồng giao dịch](docs/04-kien-truc-erd-va-transaction-flow.md) khi sửa nghiệp vụ. Kiểm tra cách mã hiện tại triển khai những quy tắc liên quan và ghi rõ nếu tài liệu với mã đang khác nhau.

## Quy tắc khi thay đổi

- Khi sửa ký quỹ hoặc giải ngân, kiểm tra quyền Client/Freelancer/Arbitrator và điều kiện chuyển trạng thái. Giữ riêng số dư MOCK và FESC. Với giao dịch FESC, đối chiếu receipt thành công trên đúng mạng trước khi ghi nhận kết quả.
- Với `/explorer`, chỉ trả dữ liệu công khai cần cho tra cứu. Giữ email, thông tin tài khoản và tệp bàn giao trong API có quyền phù hợp.
- Dùng dữ liệu thử khi chạy kiểm thử. Giữ `.data/`, `.hardhat/` và cấu hình `.env.*.local` ở máy chạy dự án. Chỉ dùng giá trị mẫu khi bổ sung tài liệu cấu hình.
- Nếu cần khởi động lại hệ thống, làm theo [hướng dẫn chạy local](docs/chay-lai-sau-khi-mo-may.md). Giữ trạng thái chain hiện có khi xử lý sự cố môi trường.

## Kiểm tra trước khi bàn giao

Chọn lệnh theo phạm vi thay đổi. Dùng `npm.cmd run build` cho frontend, `npm.cmd test` cho API và lưu trữ, `npm.cmd run test:contracts` cho hợp đồng và `npm.cmd run test:e2e` cho luồng qua trình duyệt. Ghi rõ kết quả và phần chưa xác minh trong bàn giao.
