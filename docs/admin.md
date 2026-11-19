# Trang quản trị

Mở `http://127.0.0.1:5173/admin`. Trang dùng cùng tài khoản, mật khẩu và OTP với workspace. Không có mật khẩu quản trị mặc định hoặc cách đăng ký tự chọn quyền admin.

## Cấp quyền

Tạo `.env.admin.local` từ `.env.admin.example`, đặt `ESCROW_ADMIN_EMAILS` bằng email đã đăng ký; nhiều email phân cách bằng dấu phẩy. Khởi động lại web/API sau khi cập nhật cấu hình. Biến môi trường `ESCROW_ADMIN_EMAILS` ưu tiên hơn tệp này. Tệp local được Git bỏ qua và Vite chặn truy cập HTTP. Chỉ email được cấu hình mới thấy liên kết **Quản trị** trong workspace và được truy cập các API quản trị. Server kiểm tra lại phiên và quyền trước mỗi lần ghi.

Chạy `npm.cmd run admin:check` để kiểm tra cấu hình: lệnh chỉ đọc, báo từng email đã có tài khoản hay chưa, còn là email mẫu hay không. Tệp lưu bằng Notepad/PowerShell (UTF-8 có BOM) vẫn được đọc đúng.

Chạy lệnh kiểm tra với cùng cấu hình database như terminal chạy website. Nếu website dùng MongoDB Atlas theo hướng dẫn chạy local, đặt `$env:ESCROW_DB = 'mongodb'` trong terminal kiểm tra trước khi chạy `npm.cmd run admin:check`.

## Số liệu

- Chọn **Ngày / Tuần / Tháng / Năm** và một ngày nằm trong kỳ. Mọi kỳ dùng múi giờ Việt Nam; tuần bắt đầu thứ Hai. Điểm đầu được tính, điểm cuối thuộc kỳ tiếp theo.
- **Lượt xem trang** tính mỗi lần tải ứng dụng. **Trình duyệt truy cập** đếm cookie ẩn danh khác nhau trong kỳ, không phải số người đang online. Không lưu IP, tên hoặc email vào dữ liệu truy cập. Xóa cookie hoặc dùng trình duyệt khác sẽ tạo định danh mới; số liệu bắt đầu từ lúc tính năng ghi nhận được triển khai, không suy ra lịch sử cũ.
- Tổng dự án, số đã hoàn tất và số đang tranh chấp là hiện trạng database. Dự án tạo trong kỳ dùng thời điểm tạo mới; bản ghi cũ chỉ có ngày được xếp kỳ theo ngày đã lưu.
- Nút **‹ trước / Hôm nay / sau ›** chuyển nhanh sang kỳ liền kề. Với Tuần/Tháng, bảng **Chi tiết theo ngày** chia lượt xem, trình duyệt, dự án tạo và FESC theo từng ngày; với Năm, bảng chia theo tháng. Một trình duyệt vào nhiều ngày được đếm ở từng dòng nhưng chỉ một lần trong tổng kỳ.
- **Khối lượng FESC** cộng giá trị mỗi sự kiện chuyển token thành công trong kỳ, gồm chuyển giữa ví, ký quỹ và nạp/rút. Một số token có thể chuyển nhiều lần và được cộng mỗi lần. Phát hành/đốt token và cấp quyền không tính là chuyển tiền. Tổng cung và số dư ví admin là giá trị hiện tại tại block hiển thị, không phải giá trị cuối kỳ lịch sử. Số dư ví admin cần liên kết MetaMask trong workspace. Thống kê dùng token FESC của deployment hiện tại; khi RPC lỗi, giao diện báo không đọc được thay vì ghi số 0.

Dữ liệu truy cập được lưu tại `.data/admin-analytics.sqlite` (kèm WAL/SHM khi đang chạy), riêng với database nghiệp vụ. Sao lưu tệp này khi web đã dừng cùng với dữ liệu cần giữ của máy chạy web. Kiểm thử dùng database và chain tạm, không cộng lượt truy cập vào dữ liệu thật.

## Quản lý tranh chấp

Mở hồ sơ để xem nội dung dự án, lý do, milestone, mô tả bản bàn giao và lịch sử xử lý. Ghi chú xem xét không thay đổi số tiền. Quyết định cần lý do, được xem lại trước khi xác nhận, và được lưu cùng tài khoản thực hiện, thời điểm, phiên bản hồ sơ và mã giao dịch nếu có. Hồ sơ đã phân xử vẫn được liệt kê để tra lại.

Admin không được phân xử dự án mà chính tài khoản đó là Client hoặc Freelancer. Hồ sơ thay đổi khi đang mở sẽ yêu cầu tải lại. Các API workspace, tệp và explorer vẫn giữ phân quyền riêng; quyền admin không được gửi từ trình duyệt để bỏ qua kiểm tra server.

- **Hồ sơ khiếu nại:** loại lý do, người gửi, thời điểm, yêu cầu chấm dứt hợp đồng (nếu có) và danh sách bằng chứng. Hai bên ký bổ sung bằng chứng bằng ví đã ký hợp đồng. Website chỉ chia sẻ tài liệu sau khi xác minh giao dịch. Nếu bằng chứng được bổ sung sau khi admin mở hồ sơ, admin phải tải lại để xem bằng chứng mới rồi xác nhận quyết định.
- **Phản hồi:** nội dung trong ô **Phản hồi cho hai bên** hiển thị trong dự án của Client và Freelancer, không đổi số tiền.
- **Quyết định** chỉ áp dụng cho giai đoạn bị khiếu nại: giải ngân 100% cho Freelancer, chia đều 50/50 hoặc hoàn 100% cho Client. Sau đó chọn **Tiếp tục giai đoạn sau** (hợp đồng chạy tiếp) hoặc **Chấm dứt hợp đồng** (các giai đoạn còn lại hoàn cho Client). Dự án tạo trước khi nâng cấp factory chỉ hỗ trợ chấm dứt.
- **Admin không cần ví.** Khi admin bấm **Xác nhận quyết định**, máy chủ tự ký giao dịch phân xử bằng ví trọng tài của hợp đồng (trên Hardhat Local đây là tài khoản thử nghiệm công khai số 3; có thể đặt khóa khác bằng `ESCROW_ARBITRATOR_KEY` trong `.env.admin.local`). Server kiểm tra quyền admin, phiên bản hồ sơ và trạng thái trên chain trước khi ký, rồi xác minh receipt, ghi kết quả và gửi email như trước. Nếu máy chủ không có khóa của ví trọng tài, trang hiện mục **Ví ký phân xử** để chọn ví trọng tài trong MetaMask và ký như cũ. Khiếu nại của Client/Freelancer vẫn ký bằng MetaMask của họ.
- Đầu hồ sơ hiển thị **Ví trọng tài của hợp đồng**. Bấm **Chọn ví trọng tài trong MetaMask** để cấp quyền cho đúng tài khoản và chuyển sang Hardhat Local; thao tác này không ký quyết định. Nếu chưa nhập ví đó vào MetaMask, cần nhập ví tương ứng trước. Đổi `accounts.arbitrator` trong cấu hình deployment chỉ áp dụng cho hợp đồng mới, không đổi trọng tài của hợp đồng đã tạo hoặc bản điều khoản đã lưu.
- **Chia tiền:** hợp đồng tạo từ factory đã nâng cấp (`FACTORY_REVISION` 3) **chuyển FESC thẳng về ví** Client và Freelancer ngay trong giao dịch phân xử. Hợp đồng cũ (quy tắc 1 hoặc factory trước đó) chỉ phân bổ **quyền rút**; hai bên vào dự án, bấm **Rút FESC được phân xử** để nhận.
- **Mỗi dự án FESC gắn với blockchain local của máy đã tạo nó.** Cả nhóm dùng chung MongoDB nhưng mỗi máy có Hardhat riêng, nên phải phân xử trên máy đang chạy đúng blockchain đó (và có ví trọng tài của chain đó). Ở máy khác, hồ sơ báo rõ "nằm trên một blockchain local khác" và chỉ gửi được phản hồi; quyết định, chia tiền và email chỉ xảy ra khi giao dịch phân xử được xác nhận.
- **Email kết quả** được gửi tới Client và Freelancer qua SMTP trong `.env.mail.local`. Nếu gửi lỗi, quyết định vẫn giữ nguyên; lịch sử hiện "gửi lỗi" và nút **Gửi lại email**.
- Nếu giao dịch phân xử đã gửi nhưng chưa ghi nhận, giữ nguyên quyết định, lựa chọn sau quyết định, lý do và mã hash, rồi dùng **Kiểm tra và ghi nhận**. Khi mất mã hash sau lúc tải lại trang, nhập lại đúng quyết định và lý do đã ký để hệ thống tìm giao dịch trên Hardhat.

Với mạng local đã có factory cũ, chạy `npm.cmd run chain:upgrade:fesc-factory` khi node đang chạy để tạo factory hỗ trợ chính sách 2 trên cùng token. Server đọc `LATEST_POLICY_VERSION` và `FACTORY_REVISION` trên chain; dự án có hạn sẽ báo lỗi thay vì dùng quy tắc cũ khi factory chưa nâng cấp. Hợp đồng đã tạo giữ nguyên điều khoản, kể cả 72 giờ nghiệm thu của chính sách 1.

## Tài khoản và giao dịch

- Tab **Tài khoản**: tổng số tài khoản đã đăng ký, số tài khoản hoạt động (ví đã liên kết đang giữ FESC > 0), số đã liên kết ví và bảng FESC sở hữu của từng tài khoản, đọc tại block hiện tại. Khi RPC lỗi, số dư hiện "—" thay vì 0.
- Tab **Giao dịch**: toàn bộ giao dịch FESC đã ghi nhận của mọi dự án, có tìm kiếm, phân trang và liên kết sang trình tra cứu on-chain.

## Kiểm thử

`npm.cmd run build`, `npm.cmd test`, `npm.cmd run test:e2e`. `tests/admin-fesc.test.mjs` tự mở chain cô lập ở cổng trống, kiểm tra từ mở tranh chấp đến phân xử, chống xác nhận sai/lặp, quyền rút và số liệu đủ bốn kỳ. Không cần tắt node người dùng để chạy bài này.
