# Giai đoạn 2 — Yêu cầu chức năng, phi chức năng và use case

Ngày lập: 31/10/2026, Asia/Saigon.

Trạng thái: **Đã soạn đặc tả; chưa triển khai và chưa nghiệm thu chức năng**. Người học đã yêu cầu tiếp tục Giai đoạn 2. Các mặc định ở [Giai đoạn 1](01-mvp-va-nghiep-vu.md) được dùng làm giả định làm việc, không coi việc tiếp tục là xác nhận mọi chi tiết thời hạn/chính sách.

## 1. Mục tiêu và kết quả của bước

Biến ý tưởng “ký quỹ an toàn” thành điều kiện có thể kiểm tra: ai được làm gì, khi nào được làm, dữ liệu nào thay đổi và bằng chứng nào cho thấy thao tác thành công.

Ví dụ: “Client duyệt milestone” chưa đủ. Yêu cầu đầy đủ phải nói rõ: đúng ví Client, đã nạp đủ, milestone hiện tại đã bàn giao, không có tranh chấp, chưa phân bổ trước đó; khi thành công chỉ tạo quyền rút cho Freelancer đúng số tiền milestone. Gọi lại không tạo thêm quyền rút.

Sản phẩm bàn giao bước này là tài liệu đặc tả và bảng ca nghiệm thu. Chưa tạo backend, database, smart contract hoặc màn hình đăng nhập. Không dùng việc Vite chạy được để kết luận sản phẩm escrow đã hoạt động.

## 2. Điều kiện tiên quyết và hiện trạng

Đã đọc tài liệu Giai đoạn 1 và đối chiếu mã hiện có trong `src/App.tsx`, `package.json`.

| Phần | Hiện có | Còn thiếu để được nghiệm thu |
| --- | --- | --- |
| Giao diện | Dashboard, danh sách dự án, milestone, tranh chấp, bảng giao dịch | Dữ liệu tài khoản thật, loading/error, quyền thật và trạng thái đọc từ chain |
| Dự án | Form tạo dự án và chọn Freelancer cố định trong dữ liệu demo | API, PostgreSQL, đề xuất thật, chọn đúng người và quyền sở hữu |
| Tài khoản | Dropdown đổi vai trò và tên mẫu | Đăng ký, đăng nhập, session, hồ sơ và kiểm tra quyền từng request |
| Ví | Số dư mẫu 250, nhãn Hardhat Local | MetaMask, đúng account/chain, chữ ký xác minh và số dư token thật trên local chain |
| Ký quỹ | Thay `funded` trong localStorage | ERC-20 approve, fund transaction và receipt/event xác minh được |
| Nghiệm thu | Cập nhật `paid` và sinh hash bằng Math.random | Phân bổ on-chain, chống gọi lại, rút riêng và đối soát số dư |
| Sửa đổi | Prompt lý do và cập nhật trạng thái demo | Lưu lý do/bằng chứng, số lần sửa, thời hạn và quyền đúng bên |
| Hủy/hoàn | Client có thể hủy trong mô phỏng | Đồng thuận/timeout hợp lệ, khóa tranh chấp, sổ quyền hoàn và withdraw |
| Tranh chấp | Prompt và hai lựa chọn quyết định mô phỏng | Quyền trọng tài, chia tiền, bằng chứng, lịch sử và khóa trạng thái on-chain |
| Lịch sử | Dữ liệu localStorage và hash rút gọn do UI sinh | Receipt, block/hash, xác nhận, backfill và xử lý reset/reorg |

Những nút đang có là công cụ hình dung luồng, không phải kết quả hoàn thành yêu cầu dưới đây. Đặc biệt, công thức `funded - paid` của prototype chưa mô tả đủ tiền hoàn, tiền chờ rút và tiền đã rút.

## 3. Tác nhân và quyền

| Tác nhân | Quyền nghiệp vụ | Không được phép |
| --- | --- | --- |
| Khách chưa đăng nhập | Xem danh sách dự án công khai, đăng ký/đăng nhập | Đọc bằng chứng riêng hoặc thao tác tài chính qua ứng dụng |
| Client | Tạo dự án của mình, chọn đề xuất, tạo/fund agreement, nghiệm thu/yêu cầu sửa, mở dispute, xác nhận hủy, rút phần hoàn của mình | Bàn giao thay Freelancer, tự hoàn tiền sau start khi chưa đủ điều kiện, sửa tiền/người nhận đã khóa |
| Freelancer | Gửi đề xuất, chấp nhận điều khoản, start, bàn giao, mở dispute, xác nhận hủy và rút phần của mình | Tự duyệt công việc, nạp thay Client qua fundEscrow, sửa giá trị đã khóa |
| Arbitrator | Đọc bằng chứng vụ mình phụ trách, ghi quyết định phân bổ trong phạm vi dispute | Rút tiền của hai bên, chọn địa chỉ hưởng thứ ba, thay trọng tài của escrow đã tạo |
| Backend/indexer | Xác thực, lưu metadata và đồng bộ event/receipt | Ký giao dịch thay người dùng hoặc ghi tiền on-chain thành công từ hash do frontend khai báo |

MVP dùng tài khoản Client hoặc Freelancer. Tài khoản Arbitrator được cấp qua thiết lập demo riêng, không xuất hiện trong lựa chọn tự đăng ký. Ba địa chỉ của một agreement phải khác nhau. Trọng tài không mặc nhiên có quyền đọc mọi file của mọi dự án.

Session cho phép truy cập API; chữ ký liên kết chứng minh sở hữu ví; chữ ký transaction cho phép thực hiện hành động on-chain. Đây là ba lần kiểm tra có mục đích khác nhau. Người dùng có thể gọi contract trực tiếp ngoài UI, nên contract phải tự kiểm tra quyền/trạng thái.

## 4. Yêu cầu chức năng và tiêu chí chấp nhận

Tất cả FR dưới đây là bắt buộc trong MVP. Các tiêu chí là mục tiêu kiểm thử tương lai, **chưa phải test đã pass**.

| ID | Yêu cầu | Tiêu chí chấp nhận tối thiểu |
| --- | --- | --- |
| FR-01 | Đăng ký, đăng nhập, đăng xuất | Email không trùng; mật khẩu không lưu dạng rõ; đăng nhập sai bị từ chối; đăng xuất làm session hết hiệu lực; API riêng trả 401 nếu thiếu session hợp lệ |
| FR-02 | Hồ sơ và phân quyền | Client/Freelancer sửa hồ sơ của mình; request giả role hoặc dùng ID của người khác không được thao tác tài nguyên riêng; không tự cấp Arbitrator |
| FR-03 | Liên kết ví bằng challenge | Challenge gắn tài khoản/session, địa chỉ, domain, chainId, nonce và hạn 5 phút; chữ ký đúng mới liên kết; hết hạn/sai domain/sai session/phát lại bị từ chối; hai request đồng thời chỉ tiêu thụ nonce một lần |
| FR-04 | Kết nối và thay đổi ví/mạng | UI hiện account/chain thật; sai account đã liên kết hoặc sai chain thì chặn gửi qua UI và chỉ cách đổi; disconnect/accountChanged/chainChanged làm đọc lại dữ liệu và vô hiệu thao tác cũ |
| FR-05 | Tạo và quản lý dự án | Chỉ Client tạo; title/description bắt buộc, ngân sách hợp lệ; chỉ chủ sở hữu sửa metadata được phép; không dùng sửa metadata để thay điều khoản đã khóa |
| FR-06 | Đề xuất và lựa chọn | Freelancer gửi/chỉnh đề xuất trước khi được chọn; không tự đề xuất dự án của mình; Client chỉ chọn đề xuất của dự án mình; chọn đồng thời không tạo hai lựa chọn có hiệu lực |
| FR-07 | Chốt điều khoản và xác nhận hai bên | Client tạo escrow cho đúng hai ví/token/trọng tài và hash điều khoản; Freelancer xác nhận cùng nội dung; phải xác nhận trước fund; 1–10 milestone, số tiền dương, tổng bằng budget, deadline hợp lệ |
| FR-08 | Nạp ký quỹ | Chỉ Client, đã xác nhận và còn hạn; approve token không đồng nghĩa fund; fund đủ một lần; số dư token nhận thực bằng tổng; thiếu allowance/số dư, nạp lặp hoặc token bất thường phải thất bại và không ghi D |
| FR-09 | Bắt đầu công việc | Chỉ Freelancer, đã fund và còn hạn start; ghi thời điểm bắt đầu on-chain; gọi lặp/trước fund/sau đóng bị từ chối |
| FR-10 | Bàn giao milestone và bằng chứng | Freelancer của escrow chỉ nộp milestone hiện tại ở trạng thái cho phép; file/mô tả lưu riêng ở backend, hash được neo on-chain; upload chưa có receipt bàn giao thì hiện “chưa xác nhận on-chain” |
| FR-11 | Yêu cầu sửa đổi | Client yêu cầu sửa trong cửa sổ review, có lý do/hash; tối đa 2 lần; mở hạn sửa 72 giờ; chỉ lần nộp lại hợp lệ mới tạo lần review mới; giữ lịch sử cũ |
| FR-12 | Nghiệm thu và phân bổ | Client chỉ duyệt milestone hiện tại đã bàn giao và chưa phân bổ, không dispute; chuyển đúng số tiền từ U sang quyền rút Freelancer; gọi lại hoặc duyệt milestone khác thứ tự bị từ chối |
| FR-13 | Rút tiền | Người hưởng gọi withdraw với quyền rút > 0; token chỉ về ví đã cố định; thành công giảm quyền rút và tăng số đã rút; thất bại không mất quyền rút; gọi lặp không vượt phần được hưởng |
| FR-14 | Hủy trước ký quỹ | Client hủy escrow chưa fund hoặc một bên đóng khi hết hạn funding; không ghi giao dịch hoàn tiền giả vì escrow chưa nhận tiền; giữ lịch sử agreement |
| FR-15 | Hủy sau ký quỹ | Chưa start: đồng thuận hoặc Client dùng timeout start hợp lệ; đã start: cần hai bên xác nhận cùng yêu cầu còn hiệu lực; chỉ phân bổ hoàn phần U, giữ nguyên tiền chờ rút/đã rút và chặn hủy một phía |
| FR-16 | Theo dõi im lặng/quá hạn | UI hiện deadline và thao tác hợp lệ; hết hạn review cho Freelancer quyền mở dispute, trễ công việc/sửa và hết thời gian gia hạn cho Client quyền mở dispute; không tự giải ngân/hoàn chỉ vì hết giờ |
| FR-17 | Mở và bổ sung bằng chứng dispute | Chỉ hai bên khi đủ điều kiện; một dispute mở/agreement; giữ nguyên số đã phân bổ; khóa phân bổ mới/hủy thông thường; hai bên xem và bổ sung bằng chứng có lịch sử |
| FR-18 | Phân xử | Chỉ ví trọng tài cố định; chia đúng giá trị milestone tranh chấp giữa hai bên; hoàn U của milestone tương lai rồi đóng công việc; sai tổng/địa chỉ/thẩm quyền hoặc xử lại phải revert |
| FR-19 | Hòa giải khi đang tranh chấp | Hai bên xác nhận cùng phân bổ toàn bộ U với nonce/hash trạng thái/hạn; tổng đúng và chỉ hai bên hưởng; đóng dispute, không thay đổi khoản đã phân bổ; không tái dùng xác nhận cũ |
| FR-20 | Trạng thái transaction | Phân biệt chờ ký, từ chối ký, đã gửi, mined, confirmed, reverted và chưa rõ do RPC; lưu hash thật khi đã gửi; hiển thị lỗi và đối chiếu receipt trước khi khuyến nghị gửi lại |
| FR-21 | Đồng bộ và đối soát | Index chỉ nhận đúng deployment/factory/escrow/token trên đúng chain; xác minh receipt/log/block; chống trùng event; lưu cursor/blockHash; quét bù sau restart và phân biệt chain reset/reorg; không tin số tiền/trạng thái frontend gửi |
| FR-22 | Dashboard và lịch sử theo quyền | Client thấy dự án/tiền mình nạp/chờ hoàn; Freelancer thấy việc/tiền chờ rút/đã rút; Arbitrator thấy vụ được giao; lịch sử chỉ rõ allocation hay withdraw và thời điểm đối soát |
| FR-23 | Thiết lập demo local tái lập | Có ba tài khoản/ví thử nghiệm, MockUSDC và local ETH đủ dùng; script seed/deploy tách với nghiệp vụ; reset có hướng dẫn và không trộn dữ liệu deployment cũ; không đòi tiền thật |

Giao diện có thể ẩn nút không hợp lệ để dễ dùng, nhưng kiểm thử phải gọi trực tiếp API/contract để chứng minh việc ẩn nút không phải cơ chế bảo vệ duy nhất.

## 5. Use case chính

### UC-01 — Tạo tài khoản, đăng nhập và liên kết ví

- **Tác nhân:** Client hoặc Freelancer. **Liên quan:** FR-01–04.
- **Tiền điều kiện:** chưa có tài khoản trùng email; có ví EOA thử nghiệm.
- **Luồng:** đăng ký vai trò hợp lệ → đăng nhập → kết nối MetaMask → yêu cầu challenge → ký thông điệp → backend xác minh và tiêu thụ nonce → lưu ví liên kết.
- **Kết quả:** session hợp lệ và bằng chứng liên kết ví; chưa có khoản ký quỹ nào.
- **Ngoại lệ:** từ chối ký không liên kết; chữ ký tài khoản khác, nonce hết hạn, phát lại hoặc liên kết ví đã thuộc tài khoản khác bị từ chối. MVP không đổi ví khi còn agreement có nghĩa vụ tài chính; chi tiết quản lý ví chốt ở Giai đoạn 3.

### UC-02 — Tạo dự án, gửi và chọn đề xuất

- **Tác nhân:** Client và Freelancer. **Liên quan:** FR-05–06.
- **Tiền điều kiện:** đã đăng nhập đúng vai trò; dự án còn nhận đề xuất.
- **Luồng:** Client tạo dự án → Freelancer xem và gửi đề xuất → Client xem đề xuất của dự án mình → chọn một người → hai bên thống nhất milestone/deadline.
- **Kết quả:** có bản nháp điều khoản và Freelancer được chọn; chưa được hiển thị là đã ký quỹ.
- **Ngoại lệ:** khác chủ dự án, tự đề xuất hoặc hai lựa chọn cạnh tranh phải bị kiểm soát. Một project chỉ có một agreement chính thức đang hiệu lực trong ứng dụng; deployment ngoài luồng không tự được công nhận là agreement của project.

### UC-03 — Tạo agreement và chấp nhận điều khoản

- **Tác nhân:** Client, Freelancer. **Liên quan:** FR-07, FR-20–21.
- **Tiền điều kiện:** ví đã xác minh; đề xuất đã chọn; điều khoản đủ và có cùng biểu diễn để tính hash.
- **Luồng:** hai bên xem bản điều khoản cuối → Client ký transaction tạo escrow qua factory → xác minh deployment → Freelancer đối chiếu hash và ký chấp nhận → đồng bộ trạng thái.
- **Kết quả:** escrow giữ địa chỉ các bên, token, milestone, thời hạn và hash điều khoản cố định, sẵn sàng fund.
- **Ngoại lệ:** 30 + 40 + 20 khác budget 100 phải bị từ chối; không cho fund trước chấp nhận; sửa file metadata không thay được điều khoản on-chain.

### UC-04 — Nạp 100 MockUSDC

- **Tác nhân:** Client. **Liên quan:** FR-08, FR-20–21.
- **Tiền điều kiện:** agreement đã chấp nhận, chưa fund, còn hạn, đúng ví/chain và đủ MockUSDC/local ETH.
- **Luồng:** xem token/escrow/số tiền → approve đúng 100 → chờ receipt approve → gửi fund → contract kiểm tra số dư nhận thực → xác minh receipt/event → dashboard hiện D = 100.
- **Kết quả:** escrow giữ 100, U = 100, tiền chờ rút = 0.
- **Ngoại lệ:** chỉ approve mà chưa fund thì D vẫn 0; ví thiếu gas, thiếu token/allowance hoặc hủy ký phải hiện đúng lỗi; fund lần hai không tăng D.

### UC-05 — Bắt đầu và bàn giao milestone 1

- **Tác nhân:** Freelancer. **Liên quan:** FR-09–10.
- **Tiền điều kiện:** đã fund, chưa đóng/tranh chấp và còn hạn start.
- **Luồng:** ký start → làm việc → upload file và mô tả → lấy hash → ký bàn giao milestone 1 → backend xác minh receipt và lưu lần bàn giao.
- **Kết quả:** milestone 1 đang chờ nghiệm thu, deadline review hiển thị; U vẫn 100, chưa có quyền rút.
- **Ngoại lệ:** upload lỗi không gửi hash không tồn tại; transaction bàn giao revert thì metadata upload còn ở trạng thái chưa neo; không bàn giao milestone 2 trước milestone 1.

### UC-06 — Yêu cầu sửa và nộp lại

- **Tác nhân:** Client, Freelancer. **Liên quan:** FR-10–11, FR-16.
- **Tiền điều kiện:** milestone đã bàn giao, còn review window và còn lượt sửa.
- **Luồng:** Client ghi lý do và ký yêu cầu sửa → cập nhật số lần sửa/deadline → Freelancer upload phiên bản mới → ký nộp lại → bắt đầu review mới.
- **Kết quả:** lưu cả phiên bản cũ và mới; tiền chưa phân bổ không thay đổi.
- **Ngoại lệ:** lần yêu cầu sửa thứ 3 hoặc người ngoài gọi bị từ chối; quá hạn không được tự hủy để lấy lại tiền, chuyển nhánh dispute nếu đủ điều kiện.

### UC-07 — Nghiệm thu và rút 30

- **Tác nhân:** Client rồi Freelancer. **Liên quan:** FR-12–13, FR-20–22.
- **Tiền điều kiện:** milestone 1 trị giá 30 đã bàn giao, chưa phân bổ, không dispute.
- **Luồng:** Client ký duyệt → quyền rút Freelancer tăng 30 và U còn 70 → Freelancer ký withdraw → token chuyển vào ví → index cập nhật đã rút 30.
- **Kết quả:** D = 100, U = 70, C = 0, Wf = 30, Wc = 0; escrow còn 70 nếu không có chuyển token ngoài luồng.
- **Ngoại lệ:** gọi duyệt lại không thêm 30; withdraw lỗi thì vẫn giữ quyền rút; đổi người nhận hoặc rút lần nữa vượt quyền bị từ chối.

### UC-08 — Hủy và nhận lại phần chưa sử dụng

- **Tác nhân:** Client, có thể cần Freelancer đồng thuận. **Liên quan:** FR-14–16, FR-13.
- **Tiền điều kiện:** tùy nhánh chưa fund/chưa start/đã start; không có dispute mở nếu dùng luồng hủy thông thường.
- **Luồng:** hệ thống giải thích điều kiện và số tiền có thể hoàn → tạo yêu cầu hủy → lấy đủ đồng thuận hoặc kiểm tra timeout start → phân bổ phần U cho Client → Client withdraw.
- **Kết quả ví dụ:** sau UC-07 và đồng thuận hủy, Wf = 30, Wc = 70, U = C = 0.
- **Ngoại lệ:** một bên không đồng ý sau start thì không hoàn tự động; khi trạng thái đổi, xác nhận yêu cầu cũ không còn hiệu lực; không hủy để thu hồi cả tiền đang chờ rút.

### UC-09 — Mở và phân xử tranh chấp

- **Tác nhân:** Client/Freelancer mở, Arbitrator xử. **Liên quan:** FR-16–18, FR-13.
- **Tiền điều kiện:** milestone hiện tại đủ điều kiện tranh chấp, còn U và chưa có dispute mở.
- **Luồng:** một bên nộp lý do và ký mở dispute → khóa phân bổ mới → hai bên bổ sung bằng chứng → Arbitrator xem phạm vi tiền được xử → ký quyết định → phân bổ milestone tranh chấp và hoàn milestone tương lai → từng bên rút.
- **Kết quả ví dụ:** sau khi đã rút milestone 1 = 30, dispute milestone 2 = 40 chia 15 cho Freelancer/25 cho Client, hoàn milestone 3 = 30; tổng cuối Wf = 45, Wc = 55.
- **Ngoại lệ:** chia 41 từ milestone 40, người ngoài xử, xử lại, duyệt khi đang dispute hoặc hủy một phía đều bị từ chối. Tiền đã phân bổ trước dispute vẫn được người hưởng rút.

### UC-10 — Hai bên hòa giải khi dispute đang mở

- **Tác nhân:** Client và Freelancer. **Liên quan:** FR-19, FR-13.
- **Tiền điều kiện:** dispute mở; cả hai đồng ý cùng bản chia toàn bộ U.
- **Luồng:** một bên tạo đề nghị chia → bên còn lại kiểm tra nonce/hash/hạn và xác nhận → thực hiện phân bổ nguyên tử → đóng dispute/agreement → rút tiền.
- **Kết quả:** không phụ thuộc trọng tài để kết thúc khi hai bên đã cùng đồng ý; không thay đổi quyền rút đã có.
- **Ngoại lệ:** thiếu một bên, quá hạn, state/hash thay đổi hoặc phát lại thì không phân bổ. Nếu không hòa giải được và trọng tài im lặng, UI phải nêu trạng thái đang chờ xử; không giả định có timeout tự trả tiền.

### UC-11 — Theo dõi transaction và đối soát lại

- **Tác nhân:** người dùng và bộ đồng bộ. **Liên quan:** FR-20–21.
- **Tiền điều kiện:** giao dịch đã được gửi hoặc backend đã lưu cursor của deployment hiện tại.
- **Luồng:** lưu hash thật → kiểm tra receipt/địa chỉ/log/block → đạt số confirmation cấu hình → ghi index một lần → đọc lại trạng thái và số dư → hiển thị thời điểm đồng bộ.
- **Kết quả:** reload/backend restart không mất lịch sử và không cộng tiền hai lần.
- **Ngoại lệ:** RPC mất sau khi gửi thì giữ “chưa xác định”; transaction revert không có tác dụng nghiệp vụ; chain reset cùng chainId phải nhận biết deployment cũ và không gộp số dư cũ vào chain mới.

### UC-12 — Xem dashboard đúng vai trò

- **Tác nhân:** Client, Freelancer, Arbitrator. **Liên quan:** FR-02, FR-22.
- **Tiền điều kiện:** session hợp lệ, dữ liệu đã có hoặc đang đồng bộ.
- **Luồng:** backend lọc theo tài khoản/địa chỉ của người dùng → trả chỉ số và danh sách có quyền → UI hiện loading/empty/error hoặc dữ liệu kèm mốc đồng bộ.
- **Kết quả:** phân biệt tiền chưa phân bổ, đang chờ rút và đã rút; Arbitrator chỉ xem được bằng chứng vụ được giao.
- **Ngoại lệ:** sửa URL/API ID để xem file hoặc thao tác của người khác phải bị từ chối; lỗi RPC không được biến số dư thành 0 mà không giải thích.

## 6. Yêu cầu phi chức năng

Đây là tiêu chí cần đo khi triển khai, chưa phải số liệu thực nghiệm.

| ID | Yêu cầu | Cách nghiệm thu |
| --- | --- | --- |
| NFR-01 | Bảo vệ tài khoản/session | Mật khẩu được hash bằng cơ chế phù hợp; cookie/session có cấu hình phù hợp môi trường; giới hạn thử đăng nhập/challenge; logout vô hiệu session; không log mật khẩu/chữ ký/session token |
| NFR-02 | Phân quyền theo tài nguyên | Kiểm thử gọi API/contract trực tiếp với chủ thể sai; không dựa vào role gửi từ frontend; file riêng kiểm tra quyền khi tải |
| NFR-03 | Bảo toàn tiền | Sau mỗi chuyển trạng thái: D = U + C + Wf + Wc; số dư thực >= U + C; không phân bổ/rút lặp, không đổi bên nhận; số tiền lưu bằng đơn vị nguyên nhỏ nhất |
| NFR-04 | Chống gọi lặp/cạnh tranh | Double click, hai request đồng thời, event phát lại và hai transaction cạnh tranh không tạo hai lần phân bổ/tiêu thụ nonce; transaction lỗi không làm nửa chừng sổ tiền |
| NFR-05 | Khôi phục đồng bộ | Dừng backend rồi tạo event, khởi động lại và quét bù; số tiền và lịch sử khớp chain; mô phỏng reset/reorg không để receipt cũ tiếp tục được coi confirmed |
| NFR-06 | Trải nghiệm trạng thái rõ ràng | Tất cả thao tác có loading/disabled khi chờ phù hợp; từ chối ký và revert có thông báo; hiển thị hash thật và lý do chưa xác nhận; không báo Paid chỉ vì phân bổ |
| NFR-07 | Hiệu năng demo | Với dữ liệu seed 100 dự án, 300 milestone, 3 người dùng thử đồng thời, mục tiêu p95 API đọc dashboard <= 1 giây trên môi trường local được ghi cấu hình; không tính thời gian chờ ví/block; ghi kết quả đo khi kiểm thử |
| NFR-08 | Khả năng tái lập | Từ checkout sạch theo README có thể cài, migrate, deploy, seed, chạy API/UI và test; dependency có lockfile; env mẫu không có secret; hướng dẫn thứ tự chạy và reset |
| NFR-09 | Kiểm thử và bằng chứng | Có contract unit/attack tests, backend authorization tests và integration tests; mỗi FR có ca nghiệm thu; lưu kết quả thực tế khi chạy, không đánh dấu pass bằng việc đọc code |
| NFR-10 | Quyền riêng tư và file | Không đưa file/mật khẩu/dữ liệu hồ sơ cá nhân lên chain; file demo <= 10 MiB, giới hạn tổng request, kiểm tra nội dung cho phép, không thực thi upload, tải file qua endpoint có quyền |
| NFR-11 | Giới hạn triển khai | Chỉ local và mock token; không yêu cầu seed phrase/private key thật; không có endpoint hoặc hàm Admin rút toàn bộ tiền; quyền mint demo tách khỏi quyền phân xử |
| NFR-12 | Khả dụng UI | Kiểm tra ở chiều rộng 390px và 1440px; thao tác chính có label, dùng được bằng bàn phím; nội dung trạng thái không chỉ dựa vào màu; bảng dài cuộn được |

## 7. Danh mục ca nghiệm thu để triển khai sau

Các mã AT sẽ dùng để nối yêu cầu với test tự động hoặc kịch bản demo. Cột cuối tất cả đang “Chưa chạy” vì phần chức năng thật chưa được viết.

| ID | Ca kiểm tra | Yêu cầu | Kết quả mong đợi | Hiện trạng |
| --- | --- | --- | --- | --- |
| AT-01 | Đăng nhập đúng/sai và logout rồi gọi API riêng | FR-01–02 | Đúng được vào; sai/logout bị từ chối | Chưa chạy |
| AT-02 | Ký challenge đúng, hết hạn, dùng lại, gửi đồng thời | FR-03 | Chỉ một lần đúng được liên kết | Chưa chạy |
| AT-03 | Ví sai account hoặc sai chain | FR-04 | UI chặn gửi và hướng dẫn đổi, không báo đã fund | Chưa chạy |
| AT-04 | Chủ khác sửa project; tự đề xuất; chọn đồng thời | FR-05–06 | Không vượt quyền, chỉ một lựa chọn hiệu lực | Chưa chạy |
| AT-05 | Milestone 30/40/30 so với budget 100 và 30/40/20 | FR-07 | Bộ đầu hợp lệ; bộ sau bị từ chối | Chưa chạy |
| AT-06 | Fund trước xác nhận, chỉ approve, fund hợp lệ và fund lặp | FR-07–08 | Chỉ lần fund hợp lệ ghi D = 100 | Chưa chạy |
| AT-07 | Thiếu số dư/allowance, token false/no-return/phí chuyển | FR-08 | Xử lý theo hỗ trợ token đã định; không ghi thiếu nhận thành đủ; token false/phí bị từ chối | Chưa chạy |
| AT-08 | Start trước fund, sai người, đúng hạn và sau deadline | FR-09 | Chỉ người/trạng thái/thời gian hợp lệ thành công | Chưa chạy |
| AT-09 | Upload rồi hủy ký bàn giao; bàn giao sai thứ tự | FR-10 | Không ghi Submitted on-chain, không mở milestone sau | Chưa chạy |
| AT-10 | Yêu cầu sửa hai lần, lần ba và nộp lại | FR-11 | Giữ lịch sử; giới hạn lượt/hạn đúng | Chưa chạy |
| AT-11 | Duyệt 30 rồi duyệt lại, sai người, khi dispute | FR-12 | Chỉ tăng C một lần 30 trong trường hợp hợp lệ | Chưa chạy |
| AT-12 | Rút 30, rút lại, transfer lỗi và gọi lại reentrancy | FR-13 | Không vượt quyền; transfer lỗi giữ quyền; invariant luôn đúng | Chưa chạy |
| AT-13 | Hủy trước fund và hủy sau start chỉ có Client | FR-14–15 | Nhánh đầu không có tiền hoàn; nhánh sau bị chặn | Chưa chạy |
| AT-14 | Đồng thuận hủy sau trả 30; phát lại đồng thuận cũ | FR-15 | Hoàn đúng 70 một lần; yêu cầu cũ không hiệu lực | Chưa chạy |
| AT-15 | Client im lặng sau bàn giao và thời điểm biên deadline | FR-16–17 | Không tự trả tiền; chỉ mở đúng quyền theo thời gian | Chưa chạy |
| AT-16 | Dispute 40 chia 15/25; thử chia 41 và xử hai lần | FR-17–18 | Sau rút hết Wf = 45, Wc = 55; nhánh sai bị từ chối | Chưa chạy |
| AT-17 | Hòa giải đủ hai bên, thiếu bên, hết hạn và phát lại | FR-19 | Chỉ một phân bổ toàn bộ U hợp lệ được thực hiện | Chưa chạy |
| AT-18 | Hash giả, transaction revert, RPC mất sau khi gửi | FR-20–21 | Không báo confirmed sai; có cách tra lại hash | Chưa chạy |
| AT-19 | Index lại event hai lần, backend restart, chain reset | FR-21 | Không cộng trùng, quét bù được, không dùng index cũ sai chain | Chưa chạy |
| AT-20 | Dashboard theo ba tài khoản, tải file bằng ID đoán | FR-02, FR-22 | Chỉ thấy/thao tác đúng quyền | Chưa chạy |
| AT-21 | Checkout sạch, chạy theo README và demo 100 token | FR-23 | Tái lập được, không cần tài sản thật | Chưa chạy |

Các mốc thời gian trong test phải dùng điều khiển thời gian của mạng kiểm thử ở Giai đoạn 7, không bắt người học chờ thực tế 48/72 giờ. Chọn cơ chế/lệnh cụ thể sau khi chốt phiên bản công cụ.

## 8. Những điểm phải giải quyết ở Giai đoạn 3

| ID | Điểm cần làm rõ | Yêu cầu thiết kế đầu ra |
| --- | --- | --- |
| DL-01 | Bế tắc yêu cầu hủy trước start so với dispute của milestone đã start | Chỉ rõ có được mở dispute trước start không, khoản nào bị khóa và phạm vi trọng tài; không để quyền hoàn/duyệt mâu thuẫn |
| DL-02 | Client duyệt muộn sau review deadline nhưng Freelancer chưa mở dispute | Chốt vẫn cho duyệt hay buộc dispute; xác định thời điểm `<=`/`>` và hành vi khi transaction cạnh tranh |
| DL-03 | Deadline cố định của milestone sau và thời gian sửa milestone trước | Chốt không gia hạn tự động hay quy tắc gia hạn đã được hai bên chấp thuận; không làm milestone sau vừa bắt đầu đã bị coi vi phạm mà không giải thích |
| DL-04 | Đồng thuận hủy/hòa giải | Chốt state version, nonce, hạn, cách hai bên xác nhận, hành vi khi withdraw xảy ra và phạm vi vô hiệu yêu cầu cũ |
| DL-05 | Tài khoản/ví khi còn nghĩa vụ | Chốt ràng buộc một ví/tài khoản, điều kiện thay ví khi không còn nghĩa vụ và cách người dùng truy xuất agreement cũ; không đổi địa chỉ nhận trong escrow |
| DL-06 | Tên trạng thái | Tách agreement khỏi milestone và transaction; phân biệt Approved/Allocated/Withdrawn; đóng công việc vẫn cho rút tiền chờ rút |

Đây là đầu vào công việc tiếp theo, không phải chức năng đã có hoặc lỗi build. Không viết Solidity khi các nhánh này còn mâu thuẫn. Chi tiết ERD/API thuộc Giai đoạn 4 và 8; tài liệu này không bịa endpoint đã tồn tại.

## 9. Hướng dẫn người học thực hiện bước này

1. Đọc bảng hiện trạng để phân biệt prototype với sản phẩm thật.
2. Đọc FR-07–19: đây là phần quyết định tiền có thể đi đâu, khác với chỉ có nút trên màn hình.
3. Đi qua UC-04 → UC-05 → UC-07 và tính lại D/U/C/Wf/Wc cho ví dụ 100 token.
4. Đi qua UC-08 và UC-09 như hai nhánh riêng: hủy sau trả 30 cho kết quả 30/70; dispute chia 15/25 cho kết quả 45/55.
5. Ghi yêu cầu nào muốn sửa; nếu dùng mặc định thì gửi “tiếp Giai đoạn 3”. Không bắt buộc tự viết code hay cài thêm thư viện ở bước đặc tả.

Chạy **PowerShell tại `D:\git_hub\BlockChain\BlockChain__`** để đọc tài liệu:

```powershell
Set-Location -LiteralPath 'D:\git_hub\BlockChain\BlockChain__'
Get-Content -LiteralPath '.\docs\02-yeu-cau-va-use-case.md' -Encoding utf8
```

Kết quả mong đợi: xem được FR-01–23, UC-01–12, NFR-01–12 và AT-01–21. Mở tệp bằng editor sẽ dễ đọc bảng hơn terminal.

Các tệp tạo/cập nhật:

```text
docs/02-yeu-cau-va-use-case.md     Đặc tả và ca nghiệm thu
README.md                         Liên kết và tiến độ theo sản phẩm bàn giao
docs/01-mvp-va-nghiep-vu.md        Ghi nhận người học yêu cầu sang Giai đoạn 2
```

Không có code ứng dụng mới trong bước này nên không có khối code chức năng cần chạy. Không chạy lại build chỉ để xác minh một thay đổi tài liệu; kiểm tra tính đủ của FR/UC/AT, tham chiếu và phép tính mới phù hợp mục tiêu bước này.

## 10. Kiểm tra, lỗi thường gặp và tiêu chí hoàn thành

| Hiện tượng | Cách nhận biết và xử lý |
| --- | --- |
| “Đã chạy web” bị hiểu là “đã có escrow” | Đòi bằng chứng receipt/event/số dư on-chain. Hiện trạng chưa có phần này |
| Nghiệm thu bị gọi là đã nhận tiền | Kiểm tra C và Wf: C tăng chỉ là quyền rút; Wf tăng mới là tiền đã rút |
| Hủy có vẻ hoàn đúng nhưng dashboard vẫn giữ tiền | Kiểm tra riêng U, C và Wc; không dùng riêng funded - paid |
| Bằng chứng chỉ tồn tại trong prompt | Chưa đạt FR-10/17 nếu không có metadata/hash/file có quyền và lịch sử |
| AT được đánh dấu pass vì nút có trên UI | Phải chạy với API/contract thật và thu kết quả; hiện mọi AT đang Chưa chạy |
| Nhập lại lệnh dev bị Port 5173 is already in use | Mở URL server đang chạy; không cần chạy thêm server để đọc tài liệu |
| Thông số thời hạn chưa phù hợp đồ án | Ghi yêu cầu sửa trước thiết kế state machine; demo tăng thời gian kiểm thử thay vì thay chính sách ngầm |

Hoàn thành bước đặc tả khi:

- Có danh mục yêu cầu chức năng/phi chức năng, tác nhân, luồng thành công và ngoại lệ.
- Mỗi FR liên kết được với ít nhất một AT; tất cả chưa triển khai được ghi rõ.
- Hai ví dụ tiền cân bằng 100 và không nhầm phân bổ với rút tiền.
- Các điểm DL-01–06 được chuyển thành nhiệm vụ của Giai đoạn 3, không bị giấu bằng giả định trong code.
- Người học hiểu web hiện tại chỉ hỗ trợ hình dung và biết chức năng thật sẽ được triển khai ở các giai đoạn 6–10, kiểm chứng ở 7 và 11.

Sau khi người học xem kết quả và yêu cầu tiếp tục, Giai đoạn 3 sẽ tạo state machine, bảng chuyển trạng thái, kiểm tra quyền và quy tắc thời gian cho từng thao tác. Chưa chuyển sang viết toàn bộ ứng dụng trong lượt này.
