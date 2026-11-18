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

Client có thể gửi khiếu nại về bản đã nộp hoặc khi Freelancer quá hạn bàn giao. Với MOCK và hợp đồng FESC chính sách 2, Freelancer có thể gửi khiếu nại ngay sau 5 ngày kể từ lần nộp hiện hành nếu Client chưa nghiệm thu. Nghiệm thu muộn vẫn được chấp nhận nếu khiếu nại chưa mở. Hạn ngày nhập lúc tạo dự án kết thúc lúc 23:59:59 giờ Việt Nam. Các hạn mốc tăng dần và nằm trong hạn toàn dự án. Hạn này giới hạn bàn giao, còn 5 ngày nghiệm thu tính riêng từ lúc nộp.

Đối với mạng local đã có factory cũ, chạy `npm.cmd run chain:upgrade:fesc-factory` khi node đang chạy để tạo factory hỗ trợ chính sách 2 trên cùng token. Hợp đồng đã tạo giữ nguyên điều khoản và thời hạn trên blockchain, bao gồm 72 giờ nghiệm thu của FESC chính sách 1. Hướng dẫn thiết kế giai đoạn 3 mô tả chính sách 1 với 72 giờ và có thể nới hạn mốc sau. Chính sách 2 giữ hạn bàn giao đã nhập.

Mở hồ sơ để xem nội dung dự án, lý do, milestone, mô tả bản bàn giao và lịch sử xử lý. Ghi chú xem xét không thay đổi số tiền. Quyết định cần lý do, được xem lại trước khi xác nhận, và được lưu cùng tài khoản thực hiện, thời điểm, phiên bản hồ sơ và mã giao dịch nếu có. Hồ sơ đã phân xử vẫn được liệt kê để tra lại.

Admin không được phân xử dự án mà chính tài khoản đó là Client hoặc Freelancer. Hồ sơ thay đổi khi đang mở sẽ yêu cầu tải lại. Các API workspace, tệp và explorer vẫn giữ phân quyền riêng; quyền admin không được gửi từ trình duyệt để bỏ qua kiểm tra server.

- **MOCK:** Admin chọn giải ngân milestone đang tranh chấp cho Freelancer hoặc hoàn tiền cho Client. Milestone chưa thực hiện còn lại được hoàn cho Client. Ghi kết quả, cộng số dư và ghi giao dịch trong cùng transaction database, không giải ngân lại khi gửi lặp.
- **FESC:** Hai bên ký khiếu nại bằng MetaMask. Server đối chiếu trạng thái tranh chấp và receipt trước khi ghi nhận. Quyết định phải ký bằng ví `arbitrator` đã cố định trong hợp đồng, không phải bất kỳ ví nào của tài khoản admin. Trang không lưu private key hoặc tự ký. Server kiểm tra đúng deployment, điều khoản, số bằng chứng hiện hành, receipt thành công, block, người ký, nội dung và các sự kiện phân bổ trước khi ghi kết quả.
- Sau phân xử FESC, contract phân bổ **quyền rút**; chưa phải chuyển token vào ví ngay. Client và Freelancer vào dự án, bấm **Rút FESC được phân xử về ví** để nhận phần của mình. Phần milestone tương lai về Client. Số liệu chuyển token chỉ tăng khi các giao dịch chuyển FESC đã xác nhận.
- Nếu giao dịch phân xử đã gửi nhưng chưa ghi nhận, giữ nguyên quyết định và mã hash, dùng **Kiểm tra và ghi nhận**. Có thể nhập lại hash sau khi tải lại trang; không gửi một giao dịch khác để thay thế kết quả đã xác nhận.

Thiết kế giai đoạn 3/4 quy định trọng tài theo hợp đồng. Triển khai trước đây chỉ có trọng tài ở demo, còn trang này bổ sung quyền quản trị qua email và nối phân xử FESC vào hàm `resolve` hiện có; không thay đổi Solidity hoặc quy tắc phân bổ của hợp đồng.

## Kiểm thử

`npm.cmd run build`, `npm.cmd test`, `npm.cmd run test:e2e`. `tests/admin-fesc.test.mjs` tự mở chain cô lập ở cổng trống, kiểm tra từ mở tranh chấp đến phân xử, chống xác nhận sai/lặp, quyền rút và số liệu đủ bốn kỳ. Không cần tắt node người dùng để chạy bài này.
