# Freelancer Escrow — đồ án blockchain

Đồ án Freelancer Escrow mô phỏng quy trình ký quỹ và thanh toán theo milestone. Website chạy local với React, Vite và API Node.js.

## Bắt đầu

Đọc [Giai đoạn 1 — Phân tích và phạm vi MVP](docs/01-mvp-va-nghiep-vu.md). Tài liệu có kiến trúc đề xuất, luồng tiền, quy tắc cần xác nhận, bài tập và tiêu chí hoàn thành.

Tiếp theo, xem [Giai đoạn 2 — Yêu cầu, use case và ca nghiệm thu](docs/02-yeu-cau-va-use-case.md) để đối chiếu đặc tả MVP. Các ca nghiệm thu trong tài liệu bao gồm nhiều bước tích hợp blockchain ngoài phạm vi mô phỏng hiện tại.

Tài khoản Client và Freelancer hỗ trợ đăng ký, đăng nhập, đăng xuất và sửa tên hiển thị. Mật khẩu được băm bằng scrypt có salt riêng. Cookie phiên HttpOnly có hiệu lực 7 ngày và được thu hồi khi đăng xuất. Backend dùng MongoDB hoặc PostgreSQL khi được cấu hình. Với bản clone mới, backend dùng SQLite tại `.data/escrow.sqlite` cho đến khi có cấu hình database khác.

Xem [Giai đoạn 3 — Trạng thái, quyền hạn và quy tắc tiền](docs/03-state-machine-va-quy-tac-tien.md) và [Giai đoạn 4 — Kiến trúc chi tiết, ERD và luồng giao dịch](docs/04-kien-truc-erd-va-transaction-flow.md). Giai đoạn 4 có sơ đồ dữ liệu, luồng xác minh ví và giao dịch, giao diện API/contract, quy cách hash và đối soát. Mã Solidity và kịch bản triển khai local thực hiện các quy tắc tiền của thiết kế này.

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

## Lưu trữ dữ liệu

### Giữ và khôi phục dữ liệu dự án

Sau lần chạy thành công, ứng dụng ghi nơi lưu dữ liệu vào `.data/database-target.json`. Khi cấu hình thay đổi hoặc database cũ không kết nối được, backend báo lỗi thay vì tự mở database khác. Không xóa `.data` khi khởi động lại. Dữ liệu tài khoản và dự án không có thời hạn theo ngày; phiên đăng nhập hết hạn không xóa dự án.

Nếu đã tạo dữ liệu ở SQLite hoặc PostgreSQL rồi chuyển sang MongoDB, có thể kiểm tra và hợp nhất bằng:

```powershell
npm.cmd run db:migrate
npm.cmd run db:select -- mongodb
npm.cmd run db:recover -- sqlite
npm.cmd run db:recover -- sqlite --apply
npm.cmd run db:recover -- postgres
npm.cmd run db:recover -- postgres --apply
```

Không có `--apply` thì chỉ kiểm tra. Lệnh khôi phục sao lưu MongoDB vào `.data/backups` trước khi ghi, giữ nguồn cũ, đối chiếu tài khoản theo email, giữ mật khẩu hiện có ở đích, chuyển dự án, giao dịch và tệp bàn giao, đồng thời tránh nhập lại dự án đã khôi phục. Các tham chiếu điều khoản FESC cũ được giữ khi ID dự án thay đổi. Ví đã thuộc tài khoản khác không bị chuyển chủ; số liên kết xung đột được báo sau khi nhập. Số dư MOCK chỉ được nhập cho tài khoản mới để tránh cộng lặp vào tài khoản đã có.

Để chủ động đổi database, chạy `npm.cmd run db:select -- <mongodb|postgres|sqlite>` sau khi chuẩn bị database đích và khởi động lại website. Chuyển database không tự chuyển dữ liệu.

`chain:node` hiện dùng Anvil có lưu trạng thái, vẫn giữ RPC `127.0.0.1:8545`, Chain ID `31337` và tên mạng Hardhat Local để tương thích MetaMask. State, token, số dư, block và receipt được lưu vào `.data/chain/state.json`, nạp lại khi mở node. RPC chỉ trả kết quả giao dịch sau khi giao dịch vào block và checkpoint đã ghi xong ra đĩa; có checkpoint bổ sung mỗi 30 giây khi phát hiện block mới. Không xóa thư mục này và không chạy lại deploy token mỗi ngày. Chương trình từ chối mở chain rỗng khi đã có deployment mà thiếu state.

Nếu đang dùng node Hardhat trong bộ nhớ, giữ node đó chạy, dừng gửi giao dịch và chạy `npm.cmd run chain:migrate`. Lệnh sao lưu các giao dịch đã ký, tái hiện trên node tạm và kiểm tra hash giao dịch, trạng thái receipt, bytecode, nonce và số dư trước khi ghi state mới. Sau đó dừng node cũ, chạy `npm.cmd run chain:node` và `npm.cmd run chain:adopt`. Lệnh adopt chỉ cập nhật block xác minh; token, ví và giao dịch không được phát hành lại. Các trạng thái đã mất từ trước khi có bản sao lưu không thể suy ra chỉ từ database ứng dụng.

Kiểm tra dữ liệu mất liên kết bằng `npm.cmd run db:cleanup`. Thêm `-- --apply` để sao lưu MongoDB vào `.data/backups` rồi dọn trong transaction. Chỉ xóa dự án mất chủ hoặc mất Freelancer đã liên kết, giao dịch/tệp không còn dự án, phiên và liên kết ví không còn tài khoản. Dự án chưa chọn Freelancer vẫn hợp lệ. Truy vấn workspace được lọc theo tài khoản ngay trong database; giao dịch chỉ liên kết theo ID dự án, không dựa vào tên trùng nhau. Dữ liệu của tài khoản khác không được trả về khi đoán ID.

## Gmail SMTP và xác nhận OTP

Đăng ký cần xác nhận OTP trước khi tài khoản được tạo. Đăng nhập cần đúng mật khẩu và xác nhận OTP trước khi cấp cookie phiên. Mã được gửi tới email người dùng nhập; tài khoản Gmail cấu hình SMTP là bên đứng ra gửi thư.

1. Sao chép `.env.mail.example` thành `.env.mail.local`.
2. Bật xác minh hai bước cho Gmail gửi thư, rồi tạo [Mật khẩu ứng dụng theo hướng dẫn Google](https://support.google.com/accounts/answer/185833?hl=vi). Điền địa chỉ Gmail vào `SMTP_USER`, Mật khẩu ứng dụng vào `SMTP_PASSWORD`, và địa chỉ Gmail gửi vào `SMTP_FROM`. Không dùng mật khẩu đăng nhập Gmail thông thường. Tệp cấu hình này được Git bỏ qua và bị chặn qua HTTP.
3. Chạy `npm.cmd run mail:check` để kiểm tra kết nối, rồi khởi động lại website. Lệnh kiểm tra không gửi thư.

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sender@gmail.com
SMTP_PASSWORD=your-16-character-app-password
SMTP_FROM="Freelancer Escrow <sender@gmail.com>"
```

SMTP dùng STARTTLS bắt buộc trên cổng 587; cổng 465 cũng được hỗ trợ khi chuỗi chứng chỉ hợp lệ. Máy có Avast chặn chứng chỉ SMTPS trên 465 có thể dùng 587. Không tắt xác minh chứng chỉ TLS. OTP có 6 chữ số, hết hạn sau 5 phút, dùng một lần, tối đa 5 lần nhập sai; gửi lại sau 60 giây và tối đa 10 mã mỗi giờ cho mỗi email/loại thao tác. Mã mới vô hiệu hóa mã cũ. Mã được băm và ràng buộc với trình duyệt gửi yêu cầu; OTP không được trả về qua API hoặc ghi vào log. Các yêu cầu OTP còn hiệu lực được lưu qua lần khởi động lại backend.

Mật khẩu đăng ký phải có 12–128 ký tự, gồm chữ thường, chữ số và ký tự đặc biệt. Tài khoản cũ giữ mật khẩu hiện có và cũng phải xác nhận OTP khi đăng nhập. Thiếu cấu hình SMTP hoặc gửi thư thất bại thì không tạo tài khoản hay cấp phiên đăng nhập. Các bài kiểm thử dùng hàm gửi thư riêng trong server kiểm thử, không gửi email thật.

Nút **Quên mật khẩu?** nhận Gmail đã đăng ký. Email chưa đăng ký cũng nhận phản hồi chung nhưng không gửi thư, giúp hạn chế dò tài khoản. Chỉ sau OTP đúng mới hiện hai ô **Mật khẩu mới** và **Xác nhận mật khẩu mới**. Quyền đổi mật khẩu có hiệu lực 10 phút, dùng một lần, ràng buộc trình duyệt và tài khoản ban đầu. Đặt lại mật khẩu băm mật khẩu mới, thu hồi mọi phiên cũ và mã đăng nhập/khôi phục đang chờ trong cùng transaction. OTP không cấp quyền ký ví hoặc khôi phục khóa ví.

## Nạp và rút tài khoản FESC

Trong **Ví & giao dịch**, số dư **Ví MetaMask** là token thật của địa chỉ đã liên kết. Nghiệm thu dự án trả thẳng FESC vào ví Freelancer, nên không cần thao tác rút thêm cho khoản nghiệm thu đó.

Để gửi FESC từ ví vào tài khoản hợp đồng và rút trở lại, chạy một lần `npm.cmd run chain:deploy:vault` sau khi đã có token FESC. Lệnh này giữ nguyên token và số dư, triển khai `FescVault` nếu chưa có, giữ hợp đồng vault nếu đã triển khai. Sau đó dùng:

- **Nạp FESC vào tài khoản**: nhập số tiền, ký cấp quyền đúng số token trong MetaMask, rồi bấm lại để ký giao dịch nạp. Hạn mức cũ khác số tiền yêu cầu được đặt về 0 trước khi cấp lại.
- **Rút FESC về ví**: nhập số tiền và ký giao dịch rút. Chỉ ví gửi tiền mới được rút phần của mình, luôn về chính ví đó; không có hàm rút của quản trị viên.

Số dư tài khoản đọc trực tiếp từ contract, không cộng tiền bằng dữ liệu do trình duyệt gửi hoặc dựa vào mã giao dịch chưa xác nhận. Giao dịch đang chờ chặn gửi trùng trong giao diện. Xóa tài khoản web không chuyển quyền sở hữu token trên blockchain.

Luồng này dùng [approve/transferFrom và SafeERC20 của OpenZeppelin](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20), kiểm tra số dư, chống reentrancy và kiểm thử bảo toàn tổng tài sản. Mỗi giao dịch cần chữ ký của ví, phí gas và xác nhận mạng theo [mô hình giao dịch Ethereum](https://ethereum.org/developers/docs/transactions/). Không cần bên thứ ba duyệt thủ công; không có thời gian khóa tiền bổ sung trong vault này. Các giao thức khác có quy tắc riêng: [Aave](https://www.aave.com/help/supplying/withdraw-tokens) yêu cầu đủ thanh khoản khi rút, còn [Lido](https://docs.lido.fi/contracts/withdrawal-queue-erc721/) có hàng đợi và bước finalization cho rút staking. Không áp dụng thời gian chờ staking vào tài khoản giữ FESC thông thường.

## Giao dịch dự án công khai

Mở `/explorer` để xem các dự án FESC đã có giao dịch được xác nhận, nhóm theo giai đoạn ký quỹ và từng milestone. Mỗi giai đoạn chỉ có khối lượng FESC, ví thanh toán và ví nhận, dưới ID dự án. API `/api/explorer/projects` không trả tên người dùng, email, tên/mô tả dự án hoặc tệp bàn giao. Có thể lọc theo ID dự án hoặc địa chỉ ví. Giao dịch MOCK và yêu cầu chưa được xác nhận không được đưa vào danh sách này.

Giao dịch cũ chưa có bản chiếu sẽ được đọc từ receipt nếu blockchain cũ còn tồn tại rồi lưu lại; không suy đoán địa chỉ nhận khi không còn receipt.

## Cấu hình MongoDB Atlas

1. Trong Atlas, vào **Connect → Drivers** của cluster và lấy URI. Cấp quyền `readWrite` trên database `freelancer_escrow` cho tài khoản kết nối và thêm IP của mỗi máy vào **Network Access**.
2. Sao chép `.env.mongo.example` thành `.env.mongo.local` ở thư mục gốc. Điền URI vào `MONGODB_URI`. Mỗi máy giữ tệp cục bộ riêng và dùng cùng tên `MONGODB_DB` để chia sẻ dữ liệu.
3. Trên một máy, chạy `db:migrate` để tạo collections và chỉ mục. Sau đó mỗi máy chạy `db:check` và khởi động lại website.

```powershell
npm.cmd run db:migrate
npm.cmd run db:check
```

Khi chạy web để cả nhóm dùng Atlas, đặt `$env:ESCROW_DB = 'mongodb'` trong terminal trước khi chạy `npm.cmd run dev`. Dòng `Escrow database` trong terminal cho biết máy đang dùng backend nào. `db:check` in số tài khoản trong collection `users` của database đang cấu hình. Nếu từng đăng ký bằng SQLite, chạy `npm.cmd run db:import:sqlite-accounts` trên máy chứa các tài khoản đó. Lệnh giữ mật khẩu đã băm, bỏ qua email đã có và chỉ nhập tài khoản.

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

- **Workspace tài khoản.** Đăng ký một Client và một Freelancer. Dùng hai hồ sơ trình duyệt để giữ hai phiên và hai tài khoản MetaMask riêng. Client tạo dự án, chọn Freelancer qua email đã đăng ký và chọn đơn vị ngân sách. Mặc định là **FESC** trên Hardhat Local.
- **Bản demo.** Chọn **Thử bản demo** ở trang đăng nhập để đổi giữa Client, Freelancer và Arbitrator trên dữ liệu mẫu. Milestone 2 của dự án website đã có bàn giao để thử nhánh tranh chấp và phân xử. Dữ liệu demo lưu riêng trong trình duyệt. Xóa hai khóa `fe-projects` và `fe-txs` để trở về dữ liệu mẫu.

Dự án dùng **MOCK** có số dư mô phỏng riêng. Client có thể nhận ngân sách 1.000 MOCK một lần ở **Ví & giao dịch**. Luồng MOCK hỗ trợ yêu cầu sửa và đề nghị hủy có xác nhận trong 72 giờ. Bạn có thể thử phân xử trong bản demo trình duyệt.

Khi gửi bàn giao, Freelancer đính kèm bản xem trước PDF, PNG hoặc JPEG (tối đa 2 MiB) và có thể thêm bản gốc thử ZIP, PDF, PNG, JPEG hoặc TXT (tối đa 10 MiB). Client có thể tải bản xem trước và chỉ tải được bản gốc của phiên bản đã giải ngân. Nếu dùng MongoDB hoặc PostgreSQL, chạy `db:migrate` để tạo nơi lưu tệp.

## Chạy hợp đồng trên Hardhat local

Cài thư viện theo lockfile ở trên. Chạy node trong PowerShell và giữ cửa sổ này mở.

```powershell
npm.cmd run chain:node
```

Trong một cửa sổ PowerShell khác tại thư mục gốc, biên dịch và triển khai lên chính node đó.

```powershell
npm.cmd run compile:contracts
npm.cmd run chain:deploy
```

Script triển khai MockUSDC, cấp token thử cho ba tài khoản Hardhat và tạo factory với `instanceKey` mới. Nó chạy một escrow mẫu với ngân sách 100 MockUSDC, nghiệm thu milestone đầu 30, rồi rút 30 về ví Freelancer. Sau khi số dư escrow còn 70 và các receipt khớp block, script ghi địa chỉ, mã nhận diện deployment, hash giao dịch và số block vào `.hardhat/local-deployment.json`.

| Mục | Giá trị local |
| --- | --- |
| RPC | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Ký hiệu phí gas | `ETH` thử nghiệm |
| Tài khoản mẫu | `#0` Client, `#1` Freelancer, `#2` Arbitrator |

Để thử từ MetaMask, thêm mạng tùy chỉnh với các giá trị trên và nhập tài khoản Hardhat thử từ terminal node. Xác nhận địa chỉ ví và số dư ETH thử nghiệm. Sau khi triển khai, dùng địa chỉ `token` trong manifest để thêm MockUSDC vào MetaMask. Khóa Hardhat chỉ dùng trên mạng local. [Hướng dẫn thêm mạng vào MetaMask](https://support.metamask.io/configure/networks/how-to-add-a-custom-network-rpc)

Nhấn `Ctrl+C` ở terminal node để dừng. Lần sau chỉ chạy lại `chain:node` để nạp state đã lưu; không triển khai lại token sau mỗi lần khởi động. `chain:deploy` là tạo deployment MockUSDC mới, không phải khôi phục số dư cũ.

### Token thử Freelance Token trong MetaMask

Giữ `npm.cmd run chain:node` chạy. Trong MetaMask Extension, thêm mạng **Hardhat Local** với RPC `http://127.0.0.1:8545`, Chain ID `31337` và ký hiệu `ETH`. Sao chép địa chỉ công khai của tài khoản ví thử. Để thử gửi FESC, dùng một tài khoản thử do Hardhat in trong terminal node để có ETH trả gas.

Trong một cửa sổ PowerShell khác tại thư mục dự án, điền địa chỉ công khai của ví nhận (nhiều địa chỉ thì cách nhau bằng dấu phẩy).

```powershell
$env:FESC_RECIPIENTS = '0xDIA_CHI_VI_THU'
$env:FESC_TOKEN_ONLY = '1'
npm.cmd run chain:deploy:fesc
Remove-Item Env:FESC_TOKEN_ONLY
```

Lệnh triển khai hợp đồng ERC-20 và cấp **1.000 FESC** cho mỗi ví chỉ định. Trong MetaMask, chọn đúng ví và mạng **Hardhat Local**, mở **Manage tokens → Add custom token**, dán địa chỉ hợp đồng trên dòng `FESC 0x…`, rồi xác nhận nhập. Nếu MetaMask yêu cầu, nhập ký hiệu `FESC` và số chữ số thập phân `18`. FESC ở đây chỉ tồn tại trên chuỗi thử local và được lưu cùng state. Không triển khai token mới để sửa số dư đang thiếu; kiểm tra đúng mạng, địa chỉ token và bản sao lưu chain. [Hướng dẫn thêm token của MetaMask](https://support.metamask.io/manage-crypto/tokens/how-to-display-tokens-in-metamask)

### Ký quỹ và giải ngân FESC theo dự án

1. Chạy `npm.cmd run chain:node` nếu Hardhat chưa chạy. Dùng tài khoản Hardhat `#0` làm ví Client và `#1` làm ví Freelancer để cả hai có ETH thử trả gas.
2. Lần đầu, trên PowerShell, đặt `FESC_RECIPIENTS` thành địa chỉ của Client và triển khai FESC cùng factory. Nếu đã có deployment, giữ nguyên và bỏ qua bước deploy; mỗi dự án tiếp tục dùng token và factory được ghi lúc tạo.

   ```powershell
   $env:FESC_RECIPIENTS = '0xDIA_CHI_VI_CLIENT'
   Remove-Item Env:FESC_TOKEN_ONLY -ErrorAction SilentlyContinue
   npm.cmd run chain:deploy:fesc
   npm.cmd run dev
   ```

3. Mở `http://127.0.0.1:5173/` trong từng hồ sơ trình duyệt. Đăng nhập hai tài khoản web và liên kết đúng ví trong **Ví & giao dịch → Kết nối MetaMask**.
4. **Client** vào **Dự án → Tạo dự án**, chọn **FESC**, nhập ngân sách và các milestone, rồi chọn Freelancer theo email. Trong chi tiết dự án, bấm **Tạo hợp đồng FESC** và ký trong MetaMask.
5. **Freelancer** mở dự án, bấm **Làm mới FESC** nếu cần, rồi ký **Chấp nhận hợp đồng FESC**. **Client** đọc lại trạng thái, ký **Cấp quyền ký quỹ FESC** và **Ký quỹ FESC**. Số tiền nằm trong hợp đồng.
6. **Freelancer** ký **Bắt đầu milestone**, bấm **Gửi bàn giao** để lưu tệp, rồi ký **Xác nhận bàn giao trong MetaMask**.
7. **Client** làm mới trạng thái, kiểm tra bản xem trước và ký **Nghiệm thu & giải ngân FESC**. Hợp đồng chuyển đúng số tiền milestone vào ví Freelancer ngay trong giao dịch. Lặp lại bước bàn giao và nghiệm thu cho các milestone còn lại.

Mục **Ký quỹ FESC** hiển thị số dư của bên đang đăng nhập, số token trong hợp đồng và số đã chuyển cho Freelancer. **Ví & giao dịch** hiển thị số dư FESC và mã giao dịch ký quỹ, giải ngân. Dùng địa chỉ token trong dự án để nhập đúng đồng FESC vào MetaMask.

Chỉ triển khai FESC lần đầu. Script từ chối thay token đã có để tránh khiến người dùng nhìn nhầm số dư của token mới. Việc cố ý tạo môi trường thử mới cần cấu hình `FESC_FORCE_REDEPLOY=1`; không dùng tùy chọn này cho khôi phục số dư.

### Liên kết MetaMask với tài khoản web

Nếu dùng MongoDB hoặc PostgreSQL, chạy lại `npm.cmd run db:migrate` để tạo nơi lưu địa chỉ ví và yêu cầu ký. Mở website tại `http://127.0.0.1:5173/` trong trình duyệt đã cài MetaMask Extension. Đăng nhập, vào **Ví & giao dịch → Kết nối MetaMask**, chọn ví Hardhat và ký thông điệp **Link wallet to Freelancer Escrow**. Yêu cầu ký có hiệu lực 5 phút và được dùng một lần trong phiên đã tạo yêu cầu.

Mỗi tài khoản liên kết một địa chỉ ví. Sau khi liên kết, **Kiểm tra ví đang mở** giúp bạn kiểm tra tài khoản và mạng đang chọn trong MetaMask. Ký thông điệp xác minh địa chỉ không tốn gas.

Mục **Bài thử ký quỹ Hardhat độc lập** trong **Ví & giao dịch** vẫn có bài thử nạp 100 FESC hoặc MockUSDC. Để bàn giao và giải ngân, mở hợp đồng trong chi tiết dự án FESC.

## Kiểm thử tự động

### Smart contract và bộ công cụ blockchain

Đã cài Hardhat 3, Viem và Viem Toolbox (Node.js test runner). Phiên bản các dependency mới được cố định trong `package.json` và `package-lock.json`; kiểu Node.js dùng nhánh 24. Cấu hình dựa trên [Viem Toolbox](https://hardhat.org/docs/plugins/hardhat-toolbox-viem) và [cấu hình Hardhat](https://hardhat.org/docs/reference/configuration).

`hardhat.config.ts` dùng compiler Solidity **0.8.30** từ gói `solc` đã khóa trong lockfile, optimizer **200 runs**, **viaIR** và EVM target **shanghai**. Hardhat biên dịch bằng compiler này sau khi cài thư viện. Mã Solidity dùng OpenZeppelin Contracts 5.6.1. ABI, kiểu TypeScript và bytecode được sinh trong `.hardhat/`.

```powershell
npm.cmd ci --cache .npm-cache --no-audit --no-fund
npm.cmd run compile:contracts
npm.cmd run typecheck:contracts
npm.cmd run test:contracts
```

Biên dịch trước khi chạy kiểm tra kiểu để sinh khai báo ABI. Test triển khai `ToolchainCheck`, `MockUSDC`, `EscrowFactory` và `Escrow` trên mạng mô phỏng tạm thời của Hardhat.

Để chạy cả bài kiểm thử FESC qua API, giữ node Hardhat Local chạy, đặt `$env:ESCROW_TEST_FESC = '1'`, rồi chạy `npm.cmd test`. Bài kiểm thử tạo hợp đồng và cơ sở dữ liệu thử riêng.

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
contracts/
scripts/
  deploy-local.ts
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
5. Thiết lập môi trường và cấu trúc dự án — đã có compiler cố định, node local và hướng dẫn thử ví.
6. Mock ERC-20 và escrow contract — đã có mã, kịch bản deploy/seed và kiểm tra nạp, nghiệm thu, rút trên node local.
7. Unit test, kiểm thử thất bại và hành vi tấn công.
8. Backend, tài khoản và database — đã có đăng ký, phiên và hồ sơ trên SQLite, PostgreSQL hoặc MongoDB. Liên kết ví thuộc phần tích hợp tiếp theo.
9. MetaMask và giao tiếp on-chain.
10. Dashboard cho ba vai trò.
11. Tích hợp, đối soát và xử lý lỗi.
12. Demo local, báo cáo và kịch bản bảo vệ.
