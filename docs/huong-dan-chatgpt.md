# Mẫu yêu cầu ChatGPT hỗ trợ Freelancer Escrow

Dùng các mẫu dưới đây khi cần nhờ ChatGPT đọc dự án, giải thích lỗi hoặc kiểm tra trước khi commit. Nếu ChatGPT chưa mở repository, gửi những đoạn mã hoặc log liên quan và che dữ liệu riêng tư trước khi gửi.

## Giải thích một tính năng để báo cáo

```text
Tôi đang làm đồ án Freelancer Escrow. Đọc src/Explorer.tsx và tìm handler
của /api/explorer/transfers. Giải thích ngắn gọn luồng từ lúc tôi mở trang
Lịch sử giao dịch đến lúc giao dịch hiển thị. Ghi rõ tên tệp ở từng bước
để tôi có thể mở mã và trình bày lại.
```

## Tìm lỗi khi chạy local

```text
Tính năng gặp lỗi: [ví dụ: ký giao dịch nạp FESC trong MetaMask].
Các bước tôi đã làm: [ghi từng bước đến lúc lỗi xảy ra].
Kết quả mong đợi: [ghi thao tác đáng lẽ phải thành công thế nào].
Lỗi hiện tại: [dán thông báo và đoạn log đã che thông tin riêng tư].
Môi trường: [phiên bản Node.js, Chain ID trong MetaMask và RPC đang dùng].
Đọc hướng dẫn chạy local trong docs/chay-lai-sau-khi-mo-may.md.
Tìm nguyên nhân từ log, đối chiếu với mã và đề xuất cách sửa giữ dữ liệu hiện có.
```

## Rà soát trước khi commit

```text
Xem git status và git diff, gồm cả thay đổi đã stage. Tóm tắt từng tệp
theo mục đích, kiểm tra có tệp cấu hình riêng, dữ liệu local hoặc tệp sinh
tự động bị đưa vào commit không. Viết sẵn tiêu đề commit và 1–2 dòng mô tả
thay đổi. Cho biết kiểm tra nào đã chạy và kết quả.
```

Trước khi gửi ảnh, log hoặc cấu hình, che mật khẩu SMTP, chuỗi kết nối database, OTP, cookie phiên, private key và seed phrase của MetaMask. Các tệp `.env.*.example` có thể dùng để minh họa cấu hình bằng giá trị mẫu.
