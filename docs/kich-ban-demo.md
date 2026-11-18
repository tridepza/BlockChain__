# Kịch bản demo Freelancer Escrow

Demo một dự án có một milestone trị giá **100 FESC**, từ lúc Client tạo dự án đến lúc Freelancer nhận tiền. FESC và ETH dùng trong demo đều nằm trên mạng thử nghiệm Hardhat Local.

## Chuẩn bị trước buổi demo

- Khởi động blockchain, website và API theo [hướng dẫn chạy local](chay-lai-sau-khi-mo-may.md). Mở `http://127.0.0.1:5173/` và chạy `npm.cmd run check:system` để kiểm tra môi trường đang dùng.
- Chuẩn bị một tài khoản Client và một tài khoản Freelancer đã đăng ký. Mở hai hồ sơ trình duyệt riêng, đã cài MetaMask, để giữ hai phiên đăng nhập và hai ví.
- Trong cả hai ví, chọn **Hardhat Local**, RPC `http://127.0.0.1:8545`, Chain ID `31337`. Mỗi ví cần ETH thử để trả phí gas. Ví Client cần ít nhất 100 FESC của token đang dùng trong dự án.
- Vào **Ví & giao dịch → Kết nối MetaMask** ở từng hồ sơ rồi ký thông điệp liên kết ví. Chuẩn bị một tệp PDF xem trước dưới 2 MiB để gửi bàn giao.

## Trình diễn

| Bước | Thao tác | Kết quả cần chỉ cho giảng viên |
| --- | --- | --- |
| 1. Tạo dự án | Client mở **Dự án → Tạo dự án**, chọn **FESC**, thêm milestone 100 FESC và chọn Freelancer bằng email đã đăng ký. Trong chi tiết dự án, bấm **Tạo hợp đồng FESC** rồi ký bằng MetaMask. | Dự án hiển thị hợp đồng FESC và chờ Freelancer chấp nhận. |
| 2. Ký quỹ | Freelancer mở dự án và ký **Chấp nhận hợp đồng FESC**. Client bấm **Làm mới FESC**, ký **Cấp quyền ký quỹ FESC**, sau đó ký **Ký quỹ FESC**. | Mục **Ký quỹ FESC** hiển thị 100 FESC trong hợp đồng. |
| 3. Bàn giao | Freelancer ký **Bắt đầu milestone**, bấm **Gửi bàn giao**, tải tệp xem trước rồi ký **Xác nhận bàn giao trong MetaMask**. | Client mở được tệp xem trước để nghiệm thu. |
| 4. Giải ngân | Client làm mới trạng thái rồi ký **Nghiệm thu & giải ngân FESC**. Freelancer mở **Ví & giao dịch** để xem số dư. | Sau khi giao dịch xác nhận, Freelancer nhận 100 FESC và hợp đồng còn 0 FESC. |
| 5. Đối chiếu | Sao chép mã giao dịch giải ngân từ **Ví & giao dịch**, mở `/explorer` và dán vào ô tìm kiếm của **Lịch sử giao dịch**. | Kết quả hiển thị giao dịch 100 FESC từ địa chỉ hợp đồng đến ví Freelancer, kèm mã giao dịch và số block. |

Nếu MetaMask báo thiếu gas, kiểm tra ví đang chọn và số dư ETH thử trên Hardhat Local. Nếu giao diện còn hiển thị trạng thái cũ sau khi ký, chờ giao dịch xác nhận rồi bấm **Làm mới FESC**.

Khi kết thúc, có thể tóm tắt bằng một câu “Client chuyển FESC vào hợp đồng để ký quỹ. Khi Client nghiệm thu, hợp đồng chuyển FESC cho Freelancer và giao dịch có thể tra cứu công khai.”
