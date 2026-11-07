# Giai đoạn 3 — Trạng thái, quyền hạn và quy tắc tiền

**Trạng thái bàn giao:** Hoàn thành thiết kế nghiệp vụ MVP. Các quy tắc trong tài liệu này cụ thể hóa [phân tích Giai đoạn 1](01-mvp-va-nghiep-vu.md) và [đặc tả Giai đoạn 2](02-yeu-cau-va-use-case.md). Các thay đổi so với giả định ban đầu được ghi ở mục 7. Tên thao tác dưới đây là tên nghiệp vụ dự kiến.

**Cập nhật: 07/11/2026, Asia/Saigon.** Hiện có React/Vite, API Node.js và SQLite cho tài khoản/workspace; demo riêng vẫn dùng `localStorage`. `src/workflow.ts` mô phỏng tiền bằng `funded/paid` và trạng thái `Paid/Refunded`; `server/api.mjs` sinh mã `DEMO-*`. Đây chưa phải sổ tiền hoặc bằng chứng on-chain. Các quy tắc dưới đây là đích triển khai, không phải chức năng đã nghiệm thu. Chỉ MockUSDC và ETH thử nghiệm được dùng trên mạng local.

Giai đoạn 3 cụ thể hóa các giả định nghiệp vụ của Giai đoạn 1–2; giữ mã FR/UC/AT để truy vết. Lượt cải tiến này chỉ sửa tài liệu, chưa chuyển luồng mô phỏng sang blockchain.

## 1. Trạng thái và dữ liệu điều khoản

| Đối tượng | Trạng thái | Ý nghĩa |
| --- | --- | --- |
| **Agreement** | `AwaitingAcceptance → AwaitingFunding → Funded → Active → Closed` | `Funded` nghĩa là đã nạp nhưng chưa bắt đầu. Có thể đi từ `Active` sang `Disputed`, sau đó chỉ đi tới `Closed`. Khi đóng, lưu lý do kết thúc. |
| **Milestone** | `Pending`, `InProgress`, `Submitted`, `RevisionRequested`, `Disputed`, `Finalized`, `Voided` | `Finalized` có kết quả `Approved`, `RefundAllocated`, `Arbitrated` hoặc `Settled`. `Voided` dành cho đóng trước nạp, với giá trị phân bổ bằng 0. Hai trạng thái này kết thúc vòng đời milestone. |
| **Dispute** | `None → Open → ResolvedByArbitrator / SettledByParties` | Lưu milestone, căn cứ, người mở, hash lý do, lịch sử hash bằng chứng và kết quả. Mỗi agreement tối đa một vụ trong MVP vì giải quyết xong thì đóng agreement. |
| **Transaction** | `AwaitingSignature`, `Rejected`, `Broadcast`, `Mined`, `Confirmed`, `Reverted`, `Unknown` | Đây là trạng thái theo dõi của ứng dụng. `Mined` có receipt thành công, `Confirmed` đạt số block xác nhận theo cấu hình. Receipt lỗi dẫn tới `Reverted`. Lỗi RPC sau gửi dẫn tới `Unknown`, giữ hash nếu đã có và tra lại trước khi gửi lần khác. |

```text
Agreement
  Chờ chấp nhận → Chờ nạp → Đã nạp → Đang làm → Đóng vì hoàn thành
       └── Hủy hoặc hết hạn nạp ─────────────→ Đóng trước nạp
                             Đã nạp ────────→ Đóng do hủy hoặc hết hạn start
                                     Đang làm ────→ Đóng do đồng thuận hủy
                                     Đang làm → Tranh chấp → Đóng do phân xử hoặc hòa giải

Milestone
  Chờ đến lượt → Đang làm → Đã nộp → Đã phân bổ do nghiệm thu
                                ↕
                           Yêu cầu sửa
  Đang làm / Đã nộp / Yêu cầu sửa → Tranh chấp → Đã phân bổ do xử lý tranh chấp
```

Khi `start` thành công, kích hoạt milestone đầu tiên. Sau mỗi lần nghiệm thu, kích hoạt milestone kế tiếp ngay trong cùng giao dịch hoặc đóng agreement nếu đã hết. Freelancer có thể bắt đầu milestone mới dù tiền milestone trước còn chờ rút. Khi đóng, tất cả milestone phải ở trạng thái kết thúc và không còn milestone hiện hành. Tiền chờ rút vẫn thuộc ví đã được phân bổ.

Factory tạo một escrow riêng cho mỗi agreement. Ví gọi tạo là Client. Cố định token MockUSDC của deployment, ba ví khác 0 và khác nhau, tham chiếu project, 1–10 milestone, số tiền nguyên dương, thứ tự, deadline cơ sở và phiên bản chính sách. Tổng các milestone phải bằng ngân sách. Client xác nhận bằng giao dịch tạo, Freelancer xác nhận lại đúng hash điều khoản trước khi được nạp. Hash gắn điều khoản ngoài chain với các thông số đã khóa để hai bên có thể đối chiếu. Giai đoạn 4 quy định cách mã hóa chính xác.

Ứng dụng chỉ công nhận một agreement còn mở cho mỗi project và kiểm tra lựa chọn Freelancer, các ví, deployment và hash khi liên kết. Đây là ràng buộc của ứng dụng. Agreement tạo trực tiếp qua factory vẫn chịu các quy tắc độc lập của contract đó.

## 2. Quyền theo vai trò

| Quyền | Client | Freelancer | Arbitrator | Người ngoài |
| --- | --- | --- | --- | --- |
| Tạo escrow, nạp, hủy trước nạp, đóng vì hết hạn start | Có | | | |
| Chấp nhận điều khoản, start, nộp bài, nộp bản sửa | | Có | | |
| Yêu cầu sửa, nghiệm thu | Có | | | |
| Đóng vì hết hạn nạp | Có | Có | | |
| Đề nghị hoặc xác nhận hủy và hòa giải | Có | Có | | |
| Mở tranh chấp theo căn cứ, bổ sung bằng chứng khi vụ còn mở | Có | Có | | |
| Phân xử trong phạm vi milestone tranh chấp | | | Có | |
| Rút khoản đã phân bổ cho chính mình | Có | Có | | |

Ô trống nghĩa là từ chối. Contract xác định quyền bằng ví gọi. Backend xác định quyền đọc và sửa dữ liệu riêng bằng session và quan hệ với tài nguyên. Ví có quyền gọi contract vẫn phải qua kiểm tra trạng thái và deadline. Backend, quản trị viên và factory không có quyền ký hoặc rút hộ. Đọc dữ liệu công khai của chain độc lập với quyền tải file riêng. Chỉ hai bên và trọng tài của vụ được cấp quyền xem bằng chứng riêng theo phạm vi vụ việc.

**Tài khoản và ví.** Một tài khoản có một ví EOA đã xác minh đang hoạt động. Một ví chỉ thuộc một tài khoản, kể cả các liên kết lịch sử. Chứng minh quyền sở hữu bằng thông điệp có nonce dùng một lần, gắn tài khoản, session, domain, chain ID, địa chỉ ví, thời điểm cấp và hạn 5 phút. Tiêu thụ nonce cùng cập nhật liên kết trong một thao tác nguyên tử. Private key ở ví người dùng. Trọng tài có tài khoản demo cấp riêng.

Cho đổi ví khi tất cả agreement chính thức liên quan đến ví cũ đã `Closed` và khoản chờ rút của ví cũ ở từng agreement bằng 0. Agreement chưa nạp nhưng còn mở cũng chặn đổi. Xử lý xong đăng ký agreement đang chờ và đối chiếu dữ liệu chain đã xác nhận trước khi đổi. Backend phải chống cạnh tranh giữa đăng ký agreement và đổi ví của cùng tài khoản. Giữ liên kết lịch sử để truy cập agreement cũ theo tài khoản. Ví và quyền trong escrow cũ cố định. Với escrow ngoài ứng dụng, quyền vẫn theo địa chỉ đã khóa trong escrow.

## 3. Đồng hồ và điều kiện theo thời gian

Dùng `t = block.timestamp` tính bằng giây. Mọi điều kiện đúng hạn dùng `t <= deadline`. Hành động dựa vào hết hạn dùng `t > deadline`. Hết giờ thay đổi quyền gửi thao tác. Trạng thái và số tiền chỉ thay đổi sau giao dịch hợp lệ.

| Mốc | Quy tắc |
| --- | --- |
| Chấp nhận và nạp | `fundDeadline = createdAt + 48 giờ`. Cả hai thao tác phải hoàn tất trong hạn. |
| Bắt đầu | `startDeadline = fundDeadline + 7 ngày`. Hạn cơ sở milestone đầu phải sau hạn này. Các hạn cơ sở tăng dần. |
| Nộp lần đầu | Milestone đầu dùng hạn cơ sở. Từ milestone 2, `submitBy = max(baseDue, activatedAt + 72 giờ)`. `activatedAt` là thời điểm nghiệm thu milestone trước. Tính một lần khi kích hoạt. Ví dụ hạn cơ sở ở giờ 360, kích hoạt ở giờ 350 thì hạn nộp là giờ 422. |
| Review | Mỗi lần nộp hợp lệ mở `reviewBy = submittedAt + 72 giờ`. Client được yêu cầu sửa tới đúng mốc này, tối đa 2 lần cho mỗi milestone. Client được duyệt muộn nếu bản nộp vẫn hiện hành và dispute chưa mở. |
| Nộp bản sửa | `revisionBy = requestedAt + 72 giờ`. Hạn này áp dụng cho lần sửa tương ứng. Nộp lại đúng hạn mở cửa sổ review mới. |
| Trễ việc hoặc trễ sửa | Sau `submitBy` hoặc `revisionBy`, chặn nộp muộn. Sau thêm 72 giờ, Client được mở dispute nếu milestone vẫn ở trạng thái chờ bản nộp. Hai bên có thể hủy đồng thuận trong khoảng chờ. |
| Đề nghị hủy hoặc hòa giải | `expiresAt = proposedAt + 72 giờ`. Hai bên phải xác nhận cùng đề nghị khi còn hiệu lực. |

Thao tác nhắm vào milestone hoặc bản nộp cần đối chiếu chỉ số milestone và phiên bản công việc mà người gửi đã xem. Nếu hai giao dịch cạnh tranh, EVM thực thi theo thứ tự trong block. Sau giao dịch thứ nhất, giao dịch thứ hai phải kiểm tra lại toàn bộ điều kiện. Ví dụ, nghiệm thu đi trước sẽ khiến lệnh mở dispute của milestone cũ bị từ chối. Dispute đi trước sẽ khóa lệnh nghiệm thu.

## 4. Bảng chuyển trạng thái

Trong bảng, **C** và **F** ở cột ví gọi là Client và Freelancer, **A** là Arbitrator. `D` là đã nạp, `U` là chưa phân bổ, `Cc/Cf` là khoản chờ rút của Client/Freelancer. Sai người gọi, sai trạng thái, sai milestone, sai phiên bản hoặc vi phạm điều kiện ở bất kỳ dòng nào đều bị từ chối, giữ nguyên trạng thái và sổ tiền. Dấu `0` ở cột tiền là không có biến động.

| Thao tác | Ví gọi | Trước | Điều kiện và deadline | Sau | Biến động tiền | Ví dụ bị từ chối |
| --- | --- | --- | --- | --- | --- | --- |
| Tạo escrow | C qua factory | Chưa có escrow | Điều khoản hợp lệ theo mục 1 | `AwaitingAcceptance`, milestone `Pending` | 0 | Tổng milestone sai, trùng ví, deadline sai thứ tự |
| Chấp nhận | F | `AwaitingAcceptance` | Đúng hash và `t <= fundDeadline` | `AwaitingFunding` | 0 | Hash sai hoặc chấp nhận lặp |
| Cấp allowance ERC-20 | C qua token | Đã đối chiếu escrow | Đúng token, spender là escrow và hạn mức bằng ngân sách theo luồng UI | Agreement giữ nguyên | 0 | UI chặn sai mạng, token hoặc spender |
| Nạp | C | `AwaitingFunding` | `t <= fundDeadline`, đủ allowance và số dư, nhận thực đúng tổng trong một lần | `Funded` | `D = U = tổng` | Chưa chấp nhận, nạp lặp, nhận thiếu |
| Hủy trước nạp | C | `AwaitingAcceptance` hoặc `AwaitingFunding` | Chưa nạp | `Closed/CancelledBeforeFunding`, tất cả `Voided` | 0 | Đã nạp |
| Đóng hết hạn nạp | C hoặc F | `AwaitingAcceptance` hoặc `AwaitingFunding` | `t > fundDeadline` | `Closed/FundingExpired`, tất cả `Voided` | 0 | Gọi đúng tại hạn hoặc đã nạp |
| Bắt đầu | F | `Funded` | `t <= startDeadline` | `Active`, milestone đầu `InProgress` | 0 | Chưa nạp hoặc quá hạn |
| Đóng hết hạn start | C | `Funded` | `t > startDeadline` | `Closed/StartExpired`, tất cả `Finalized/RefundAllocated` | Toàn bộ `U → Cc` | Đã start hoặc chưa quá hạn |
| Nộp lần đầu | F | `Active`, milestone hiện hành `InProgress` | Hash bàn giao khác 0 và `t <= submitBy` | `Submitted`, lưu bản nộp và hạn review | 0 | Nộp trước lượt hoặc nộp muộn |
| Yêu cầu sửa | C | `Active`, milestone hiện hành `Submitted` | Đúng phiên bản, hash lý do khác 0, `t <= reviewBy`, còn lượt | `RevisionRequested`, tăng lượt, ghi hạn sửa | 0 | Yêu cầu lần ba hoặc sau hạn |
| Nộp bản sửa | F | `Active`, milestone hiện hành `RevisionRequested` | Hash khác 0, lưu lần nộp riêng và giữ lịch sử bản cũ, `t <= revisionBy` | `Submitted`, tạo hạn review mới | 0 | Dùng yêu cầu cũ hoặc quá hạn |
| Nghiệm thu | C | `Active`, milestone hiện hành `Submitted` | Đúng bản nộp hiện hành, chưa phân bổ. Cho duyệt cả sau `reviewBy` nếu dispute chưa mở | `Finalized/Approved`. Mở mốc kế hoặc `Closed/Completed` | Giá trị milestone `U → Cf` | Duyệt lặp hoặc dispute đã mở |
| Đề nghị hủy | C hoặc F | `Funded` hoặc `Active` | Điều kiện đề nghị ở mục 5, ghi rõ hoàn cả phần đang làm hoặc chờ review chưa phân bổ | Lưu đề nghị, giữ trạng thái | 0 | Đã có đề nghị còn hiệu lực hoặc đang tranh chấp |
| Xác nhận hủy | Ví còn lại | `Funded` hoặc `Active` | Đúng đề nghị và `t <= expiresAt` | `Closed/CancelledByConsent`, các milestone chưa phân bổ `Finalized/RefundAllocated` | Toàn bộ `U → Cc` | Một ví tự xác nhận hai lần hoặc snapshot đã đổi |
| Mở dispute | C hoặc F | `Active`, milestone hiện hành chưa phân bổ, dispute `None` | Đúng căn cứ, phiên bản và hash lý do theo mục 5 | Agreement và milestone `Disputed`, dispute `Open` | 0 | Mở trước start, sai căn cứ hoặc mở lần hai |
| Ghi bằng chứng | C hoặc F | Dispute `Open` | Đúng vụ, hash khác 0 và chưa được ghi cho vụ này | Giữ `Open`, tăng số thứ tự bằng chứng | 0 | Vụ đã đóng hoặc hash trùng |
| Phân xử | A | Dispute `Open` | Đúng vụ và số thứ tự bằng chứng đã xem, có hash phán quyết, chia đúng giá trị milestone tranh chấp | `ResolvedByArbitrator`, `Closed/Arbitrated`. Milestone tranh chấp `Finalized/Arbitrated`, các mốc tương lai `Finalized/RefundAllocated` | Chia milestone tranh chấp cho hai bên, hoàn phần tương lai cho C, `U = 0` | Xử quá giá trị milestone, sai ví hoặc xử lại |
| Đề nghị hòa giải | C hoặc F | Dispute `Open` | Đúng vụ và phiên bản, chia đủ từng milestone còn lại theo mục 5 | Lưu đề nghị, giữ `Open` | 0 | Thiếu phần chia hoặc có đề nghị còn hiệu lực |
| Xác nhận hòa giải | Ví còn lại | Dispute `Open` | Đúng đề nghị và `t <= expiresAt` | `SettledByParties`, `Closed/Settled`, các milestone còn lại `Finalized/Settled` | Toàn bộ `U` chuyển sang `Cc/Cf` theo đề nghị | Hết hạn, phát lại hoặc đã có phán quyết |
| Rút | C hoặc F | Có khoản chờ rút của ví gọi | Khoản chờ rút dương. Đích là chính ví cố định được hưởng. Cho phép cả khi đang dispute hoặc đã đóng | Giữ trạng thái công việc, ghi nhận đã rút | Rút toàn bộ quyền hiện có của người gọi. Giảm `Cc/Cf`, tăng `Wc/Wf`, chuyển token | Không có quyền rút, người khác gọi, chuyển token thất bại |

Approve là quyền sử dụng token ở ERC-20. Các điều kiện chấp nhận và hạn nạp được escrow kiểm tra tại thao tác nạp. Khi triển khai, nếu lần chuyển token thất bại thì hoàn tác cả giao dịch, giữ quyền rút. Số dư và lịch sử cần tách **đã phân bổ** khỏi **đã rút**. File, nội dung bàn giao và lý do chi tiết lưu ngoài chain có kiểm soát truy cập. Upload thành công mới tạo bản ghi ứng dụng. Trạng thái bàn giao chỉ đổi sau khi giao dịch ghi hash thành công.

## 5. Đồng thuận, tranh chấp và các nhánh cạnh tranh

**Đồng thuận bằng hai giao dịch.** Giao dịch tạo đề nghị là sự chấp thuận của người tạo. Người đề nghị phải gửi đúng phiên bản công việc hiện hành và hash lý do khác 0. Ví còn lại xác nhận bằng nonce và hash của đúng đề nghị còn hiệu lực. Tối đa một đề nghị còn hiệu lực trên mỗi agreement. Khi hết hạn hoặc bị vô hiệu có thể tạo đề nghị mới với nonce tăng dần.

Hash đề nghị gắn phiên bản chính sách, chain ID, địa chỉ escrow, loại đề nghị, người đề nghị, nonce, hạn, phiên bản công việc, trạng thái, milestone hiện hành, ID dispute nếu có, `U`, hash lý do và nội dung phân bổ. Dữ liệu băm phải có thứ tự và kiểu xác định. Khi xác nhận, tiêu thụ đề nghị, ghi phân bổ và đóng trong cùng giao dịch. Đề nghị hết hạn, đã dùng, khác hash hoặc khác phiên bản đều bị từ chối.

Phiên bản công việc tăng khi chấp nhận, nạp, start, nộp, yêu cầu sửa, nghiệm thu, mở dispute hoặc đóng. Những thay đổi này vô hiệu đề nghị cũ. Rút tiền đã phân bổ giữ nguyên phiên bản và `U`. Bổ sung bằng chứng tăng số thứ tự bằng chứng riêng, giữ nguyên đề nghị hòa giải. Trọng tài phải gửi số thứ tự mình đã xem. Nếu bằng chứng mới vào trước phán quyết, trọng tài phải đọc lại và gửi với số mới.

**Điều kiện mở tranh chấp.** Chỉ xét milestone hiện hành chưa phân bổ khi agreement đang `Active`. Cần mã căn cứ và hash lý do khác 0.

| Căn cứ | Bên được mở | Điều kiện |
| --- | --- | --- |
| Bất đồng về bàn giao | Client | Milestone `Submitted`, kể cả đã qua hạn review |
| Chờ nghiệm thu quá hạn | Freelancer | Milestone `Submitted` và `t > reviewBy` |
| Trễ công việc hoặc bản sửa | Client | `InProgress` và `t > submitBy + 72 giờ`, hoặc `RevisionRequested` và `t > revisionBy + 72 giờ` |
| Bế tắc hủy sau start | Client hoặc Freelancer | Đã quá hạn đề nghị hủy **đầu tiên của phiên bản công việc hiện hành**. Đề nghị thay thế không làm mất căn cứ bế tắc. Khi phiên bản công việc đổi thì căn cứ cũ hết hiệu lực. |

Trước start, nếu bế tắc hủy thì chờ đồng thuận hoặc Client đóng sau `startDeadline`. Khi dispute mở, khóa bàn giao, yêu cầu sửa, nghiệm thu và hủy thông thường. Hai bên vẫn bổ sung bằng chứng, hòa giải và rút các khoản đã phân bổ trước đó.

- **Phân xử:** Với milestone tranh chấp giá trị `m`, trọng tài chọn hai phần không âm có tổng đúng `m`. Các milestone tương lai hoàn toàn bộ cho Client. Chỉ hai ví cố định được hưởng. Phần đã phân bổ trước đó giữ nguyên.
- **Hòa giải:** Hai bên thống nhất phần Client và Freelancer cho từng milestone còn lại theo đúng thứ tự. Mỗi cặp cộng đúng giá trị milestone, nên tổng các cặp bằng `U`. Không cần chữ ký của trọng tài. Phân xử và hòa giải cạnh tranh thì giao dịch đóng thành công trước quyết định kết quả.
- **Chờ xử:** MVP chưa đặt deadline cho trọng tài. Nếu thiếu cả phán quyết lẫn đồng thuận, `U` có thể tiếp tục bị giữ. Hiển thị trạng thái chờ xử và quyền rút hiện có.

## 6. Sổ tiền và ba kịch bản 100 MockUSDC

Tính bằng số nguyên theo đơn vị nhỏ nhất. `1 MockUSDC = 1.000.000` đơn vị. `D` là tổng nạp đã ghi, `U` là chưa phân bổ, `Cf/Cc` là chờ rút, `Wf/Wc` là đã rút. Tổng chờ rút `C = Cf + Cc`.

```text
D = U + C + Wf + Wc
balanceOf(escrow) >= U + C
Cf + Wf = tổng phần đã phân bổ cho Freelancer
Cc + Wc = tổng phần đã phân bổ cho Client
Sau nạp: U = tổng giá trị các milestone chưa phân bổ
Closed: U = 0
```

Mỗi giá trị không âm, mỗi milestone chỉ phân bổ một lần và `D` chỉ tăng một lần. Nạp trực tiếp token vào địa chỉ escrow ngoài thao tác nạp chỉ tạo phần dư trong số dư thực, không tăng `D` hoặc quyền rút. Khi không có phần dư, số dư escrow bằng `U + C`. Bản MVP không có chức năng quét phần dư. Nghiệm thu, hủy, hòa giải và phân xử chỉ ghi quyền rút. Giao dịch rút giảm quyền chờ rút trước khi gọi token, chống gọi lại và hoàn tác nếu token chuyển thất bại.

| Bước, tính bằng MockUSDC | D | U | Cf | Cc | Wf | Wc | Số dư escrow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Nạp 30 + 40 + 30 | 100 | 100 | 0 | 0 | 0 | 0 | 100 |
| Duyệt mốc 1 | 100 | 70 | 30 | 0 | 0 | 0 | 100 |
| Freelancer rút 30, tiếp tục công việc | 100 | 70 | 0 | 0 | 30 | 0 | 70 |
| Kịch bản 1, duyệt và rút hết các mốc còn lại | 100 | 0 | 0 | 0 | 100 | 0 | 0 |
| Kịch bản 2, hủy sau khi đã rút mốc 1 | 100 | 0 | 0 | 70 | 30 | 0 | 70 |
| Kịch bản 2, Client rút 70 | 100 | 0 | 0 | 0 | 30 | 70 | 0 |
| Kịch bản 3, đã rút mốc 1, xử mốc 2 chia 15/25 và hoàn 30 tương lai | 100 | 0 | 15 | 55 | 30 | 0 | 70 |
| Kịch bản 3, hai bên rút hết | 100 | 0 | 0 | 0 | 45 | 55 | 0 |

Ba kịch bản tách nhánh sau dòng Freelancer rút 30. Nếu hủy **trước khi** Freelancer rút 30, kết quả phân bổ vẫn là 30/70 với `Cf = 30`, `Cc = 70`, `U = 0` và số dư 100. Nếu hòa giải sau khi đã rút mốc 1, chia mốc 2 là 20/20 và mốc 3 là 10/20 theo thứ tự Freelancer/Client, hai bên sẽ nhận tổng cuối 60/40 sau khi rút hết.

## 7. Đối chiếu quyết định và ca nghiệm thu

| Điểm mở | Quyết định của Giai đoạn 3 | Yêu cầu và ca dự kiến |
| --- | --- | --- |
| DL-01 — Bế tắc hủy trước start | Không mở dispute trước start vì chưa có milestone hiện hành để phân xử. Hủy đồng thuận hoặc Client đóng khi hết hạn start. Sau start, bế tắc theo phiên bản mới là một căn cứ. | FR-15–18, AT-13–16 |
| DL-02 — Duyệt muộn | Vẫn cho nghiệm thu bản nộp hiện hành sau hạn review. Freelancer đồng thời có quyền mở dispute, giao dịch hợp lệ vào trước quyết định trạng thái. Yêu cầu sửa vẫn giới hạn trong hạn review. | FR-11–12, FR-16–17, AT-10–11, AT-15 |
| DL-03 — Deadline mốc sau | Hạn cơ sở vẫn khóa lúc tạo. Hạn nộp hiệu lực từ milestone 2 có cửa sổ tối thiểu 72 giờ kể từ kích hoạt để tránh trễ ngay khi vừa đến lượt. | FR-07, FR-10–11, FR-16, AT-05, AT-09–10, AT-15 |
| DL-04 — Đồng thuận | Hai giao dịch, một đề nghị, nonce/hash/hạn và phiên bản công việc. Withdraw giữ đề nghị có hiệu lực, tiến triển công việc vô hiệu đề nghị. | FR-13, FR-15, FR-19, AT-12, AT-14, AT-17 |
| DL-05 — Đổi ví | Một ví xác minh đang dùng. Chỉ đổi sau khi agreement chính thức đã đóng và ví cũ không còn khoản chờ rút. Liên kết lịch sử để đọc dữ liệu cũ. | FR-02–04, FR-22, AT-02–03, AT-20 |
| DL-06 — Tên trạng thái | Tách agreement, milestone, dispute và transaction. Phân bổ được ghi ở milestone, đã rút được ghi ở sổ rút. Đóng agreement vẫn rút được. | FR-12–13, FR-20–22, AT-11–12, AT-18–20 |

Các ca cần bổ sung tình huống khi triển khai gồm đúng tại deadline và sau hạn một giây, duyệt cạnh tranh mở dispute, hủy trong khi 30 còn chờ rút, xác nhận đề nghị sau một lần withdraw, phát lại nonce, đổi ví khi còn agreement mở hoặc khoản chờ rút, và hòa giải cạnh tranh với phán quyết. Các mã AT ở trên là tham chiếu để kiểm thử sau.

## 8. Quy tắc bổ sung để triển khai nhất quán

### 8.1. Điều khoản và vòng đời dự án

- Bản nháp được sửa trước tạo escrow. Từ giao dịch tạo, khóa ba ví, token, ngân sách, danh sách/thứ tự milestone, hạn cơ sở, hash điều khoản và phiên bản chính sách. MVP không có sửa điều khoản, gia hạn hoặc thay trọng tài giữa chừng.
- Nếu điều khoản sai hoặc Freelancer không đồng ý, Client hủy trước nạp hoặc hai bên chờ hết hạn nạp để đóng. Thỏa thuận lại phải tạo agreement mới, giữ lịch sử cũ.
- Project chỉ được liên kết agreement chính thức mới sau khi agreement cũ `Closed`. Khoản chờ rút cũ vẫn rút riêng; không gộp sổ tiền giữa agreement. Đổi ví vẫn chịu điều kiện mục 2.
- Quy tắc đổi ví mục 2 áp dụng cả Arbitrator: agreement còn mở với vai trò trọng tài cũng chặn đổi ví. Đóng agreement không chuyển quyền trong escrow cũ sang ví mới.
- Hủy đồng thuận chỉ hoàn toàn bộ `U` cho Client, kể cả phần đang làm/chờ review. Muốn chia thêm cho Freelancer phải qua dispute và hòa giải theo căn cứ hợp lệ, không tự diễn giải xác nhận hủy thành chia tiền tùy ý.

### 8.2. Phiên bản và đề nghị đồng thuận

| Dữ liệu | Quy tắc |
| --- | --- |
| Phiên bản công việc | Khởi tạo 0 khi tạo escrow; mỗi thao tác thành công thuộc danh sách mục 5 tăng đúng 1, kể cả khi đồng thời kích hoạt milestone kế. Giao dịch thất bại không tăng. |
| Phiên bản bản nộp | Mỗi milestone bắt đầu 0 (chưa nộp), lần đầu 1, hai bản sửa tối đa 2 và 3. Hash giống bản cũ không thay thế kiểm tra phiên bản. Duyệt/yêu cầu sửa phải trỏ đúng bản hiện hành. |
| Lượt sửa | Khởi tạo 0, chỉ tăng khi yêu cầu sửa thành công, không giảm khi nộp lại hoặc hết hạn. |
| Bằng chứng | Số thứ tự khởi tạo 0 khi mở dispute, tăng 1 mỗi bằng chứng bổ sung hợp lệ. Hash lý do mở vụ lưu riêng. Trọng tài xác nhận đúng vụ và số thứ tự mới nhất. |
| Nonce đề nghị | Bắt đầu 1, tăng khi tạo đề nghị mới, không tái sử dụng. MVP không có rút lại/sửa đề nghị còn hiệu lực; người tạo đã chấp thuận trong cửa sổ 72 giờ, trừ khi công việc đổi phiên bản. |
| Bế tắc hủy | Ghi hạn đề nghị hủy đầu tiên của phiên bản hiện hành. Đề nghị thay thế không dời thời điểm được mở dispute. Hết hạn không tự mở dispute hoặc đóng agreement. |

Tạo đề nghị không khóa tiến triển công việc. Start, nộp, yêu cầu sửa, nghiệm thu hoặc mở dispute hợp lệ vẫn thực hiện được và vô hiệu đề nghị cũ. Đề nghị hủy còn hạn không ngăn dispute theo căn cứ khác đã đủ điều kiện. Bổ sung bằng chứng không vô hiệu hòa giải vì hai bên đã đồng ý phân bổ cụ thể, nhưng làm phán quyết dùng số thứ tự cũ bị từ chối.

### 8.3. Bằng chứng và dữ liệu được công nhận

Upload thành công tạo phiên bản nội dung bất biến cùng hash để xem trước khi ký. Sửa nội dung phải tạo phiên bản/hash mới, giữ bản cũ; không ghi đè file đã neo. Upload thất bại thì chưa có bản để ký. Upload xong nhưng từ chối ký hoặc giao dịch thất bại thì bản đó vẫn là nháp, không tạo `Submitted` hoặc mở review.

Hash chứng minh nội dung trùng khớp, không chứng minh chất lượng hoặc khả năng tải file. Nếu file không truy cập được hoặc không khớp hash, giao diện phải hiện rõ chưa kiểm chứng. Không đưa nội dung riêng, URL chứa quyền truy cập hoặc thông tin đăng nhập lên chain. Quy cách băm, giới hạn file và chính sách lưu trữ chốt ở Giai đoạn 4.

Trạng thái, deadline và sổ tiền lấy từ chain đúng deployment; tài khoản, nháp và quyền tải file lấy từ backend. Session hết hạn không tước quyền ví trong contract. API hiện có không được tự ghi thành công tài chính cho luồng chính thức. Khi RPC lỗi hoặc chưa đối soát, hiển thị chưa xác minh, không suy ra thất bại hoặc tự gửi lại. Receipt `approve` không xác nhận đã nạp; receipt `withdraw` không thay đổi kết quả milestone.

## 9. Ma trận rà soát thiết kế bổ sung

Các mã `BR3-*` bổ sung cho 21 ca AT Giai đoạn 2, không thay thế chúng. Đây là ca dự kiến cho contract/tích hợp, **chưa thực thi trên hệ thống**.

| Mã | Thiết lập/thao tác | Kết quả bắt buộc | Truy vết |
| --- | --- | --- | --- |
| BR3-01 | Chấp nhận/nạp/start/nộp/yêu cầu sửa/xác nhận tại hạn và sau 1 giây | Tại hạn được phép nếu đủ điều kiện khác; sau hạn từ chối. Timeout chỉ hợp lệ sau hạn. | FR-07–11, FR-14–16, FR-19 |
| BR3-02 | Dispute trễ việc tại `submitBy + 72 giờ`, rồi sau 1 giây; lặp với hạn sửa | Tại mốc từ chối, sau mốc Client được mở; nộp muộn vẫn bị chặn trong khoảng chờ. | FR-10–11, FR-16–17 |
| BR3-03 | Duyệt muộn cạnh tranh dispute theo hai thứ tự | Chỉ thao tác hợp lệ đầu tiên thành công; không phân bổ hai lần. | FR-12, FR-16–17 |
| BR3-04 | Yêu cầu sửa lần ba; duyệt bản 1 khi bản 2 hiện hành | Đều bị từ chối; giữ lịch sử các bản nộp. | FR-10–12 |
| BR3-05 | Đề nghị hủy khi `Cf=30, U=70`; F rút, ví còn lại xác nhận | Đề nghị vẫn hợp lệ; `Wf=30, Cc=70, U=0`. | FR-13, FR-15 |
| BR3-06 | Đề nghị rồi start/nộp/nghiệm thu; xác nhận đề nghị cũ | Tiến triển không bị khóa; phiên bản đổi, đề nghị cũ bị từ chối. | FR-09–12, FR-15, FR-19 |
| BR3-07 | Tạo lại đề nghị hủy sau khi đề nghị đầu hết hạn, cùng phiên bản | Căn cứ bế tắc cũ còn hiệu lực; nonce mới không dời thời điểm mở dispute. | FR-15, FR-17 |
| BR3-08 | Chính ví đề nghị xác nhận; sai nonce/hash; phát lại sau đóng | Từ chối, sổ tiền không đổi. | FR-15, FR-19 |
| BR3-09 | Bằng chứng mới trước phán quyết; hòa giải cạnh tranh phán quyết | Số thứ tự cũ bị từ chối; chỉ thao tác đóng hợp lệ đầu tiên thành công. | FR-17–19 |
| BR3-10 | Chia mốc 40 thành 15/25, hoàn tương lai 30; thử chia 15/26 hoặc ví thứ ba | Chỉ đúng tổng và hai ví cố định được hưởng; giữ phần phân bổ cũ. | FR-18–19 |
| BR3-11 | Token chuyển thất bại khi nạp/rút; rút lặp hoặc gọi lại | Hoàn tác, không mất quyền rút hoặc tăng D/W sai. | FR-08, FR-13 |
| BR3-12 | Gửi token trực tiếp, rồi đóng và rút hết phần hợp lệ | Phần dư không tăng D/U/C; còn ở escrow, không có quyền quét. | FR-08, FR-13, FR-21 |
| BR3-13 | Đổi ví khi chưa nạp nhưng còn mở, còn C hoặc còn nhiệm vụ trọng tài | Từ chối, kể cả request đổi ví cạnh tranh đăng ký agreement. | FR-02–04, FR-22 |
| BR3-14 | Upload rồi từ chối ký/revert; gửi hash giả hoặc receipt approve | Không ghi bàn giao/nạp thành công; nháp tách khỏi dữ liệu chain. | FR-08, FR-10, FR-20–21 |
| BR3-15 | Đóng theo từng lý do ở mục 4, trước và sau nạp | Không còn mốc hiện hành; trước nạp tất cả Voided, sau nạp tất cả Finalized; U=0, vẫn rút C được. | FR-12–19 |

Sau mỗi thao tác thành công hoặc bị từ chối, kiểm tra bất biến mục 6 và phân bổ từng milestone. Thao tác bị từ chối không thay đổi trạng thái hoặc sổ tiền escrow; gas ETH vẫn có thể bị tính.

## 10. Điểm bàn giao

Thiết kế đạt khi đủ sáu quyết định, mọi thao tác có quyền và điều kiện từ chối, mọi nhánh đóng kết thúc các milestone, và ba kịch bản đối soát đúng. Kiểm tra bằng cách đọc đặc tả và so sánh số liệu với các bất biến ở mục 6. Từ thư mục gốc của repo có thể đọc bản UTF-8 và kiểm tra chênh lệch văn bản.

```powershell
Get-Content -LiteralPath '.\docs\03-state-machine-va-quy-tac-tien.md' -Encoding UTF8
git diff --check
```

Giai đoạn 4 dùng các trạng thái, quyền và dữ liệu đã chốt để thiết kế ERD, quy cách hash, sự kiện và luồng đối soát. Cần thể hiện định danh deployment/agreement, liên kết ví lịch sử, phiên bản điều khoản/bản nộp, đề nghị/nonce, bằng chứng, phân bổ và lần rút; luồng xác minh ví, approve → fund, withdraw và phục hồi đồng bộ phải giữ các bất biến trên. Đối chiếu thêm toàn bộ BR3 ở mục 9 trước bàn giao triển khai. Các ca nghiệm thu hệ thống vẫn chưa chạy.
