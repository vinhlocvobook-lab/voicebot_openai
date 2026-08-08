# Kiểm tra tổng đài viên rảnh trước khi chuyển máy (05/08/2026)

Chủ dự án bổ sung `getAvailableAgents()` (api.js) và sửa `handleTransferToAgent`
trong `tools.js` để kiểm tra có tổng đài viên nào rảnh trước khi chuyển máy:
còn người rảnh → `action: "transfer_to_agent"` như cũ; không còn ai rảnh →
`action: "leave_message"` (mới), hỏi khách có muốn để lại lời nhắn không.

Yêu cầu: rà soát `session-ws.js` xem cần điều chỉnh gì để phát đúng lời thoại
cho cả hai nhánh, đặc biệt khi không có ai rảnh.

## Vấn đề tìm thấy khi rà soát

### 1. `action: "leave_message"` không được `session-ws.js` nhận diện

`session-ws.js` chỉ có nhánh riêng cho `action === "end_call"` và
`action === "transfer_to_agent"`; mọi `action` khác (kể cả `"leave_message"`
mới) rơi vào nhánh tool-thường (`else { _ketQuaToolCuoi = {name, result}; }`).
Nhánh này, nếu tool KHÔNG có trường `doc_cho_khach`, tự ép model kết thúc bằng
đúng câu hỏi cố định "Quý Khách có cần em hỗ trợ gì thêm không ạ?" (đợt 25-27
trong `fix_migrate_gpt_realtime_21_20260730.md`) — SAI hoàn toàn cho tình
huống này: câu cần hỏi là "Quý Khách có muốn để lại lời nhắn không?", không
phải câu hỏi kết thúc.

**Sửa** (`tools.js`): thêm `doc_cho_khach` vào CẢ HAI nhánh của
`handleTransferToAgent` (script để đọc nguyên văn cho khách) — có
`doc_cho_khach`, nhánh tool-thường trong `session-ws.js` tự động đi vào đường
"Đọc CHÍNH XÁC nguyên văn" (đã có sẵn, dùng chung với `get_procedure_info` và
các bước danh bộ), KHÔNG cần thêm nhánh mới nào trong `session-ws.js` cho
`leave_message`. `message` (trường nội bộ, model đọc như hướng dẫn) ghi rõ
bước tiếp theo: khách đồng ý để lại lời nhắn → hỏi nội dung rồi gọi
`create_ticket`; khách từ chối → hỏi còn cần hỗ trợ gì khác không.

### 2. `transfer_to_agent` (chuyển máy thành công) không có lưới an toàn nếu model không nói gì

Nhánh `action === "transfer_to_agent"` gọi thẳng `_handleTransfer` mà KHÔNG
kiểm tra model có thực sự nói câu thông báo chuyển máy trong CHÍNH response
chứa `function_call` hay không — khác hẳn `end_call`, vốn đã có cơ chế
`_hasGoodbyeAudio` + `goodbye_forced` từ fix 18/07/2026 (cuộc
`E2tY3rg44dIiQOsBGYFsi`: model gọi `end_call` không kèm audio → khách nghe
im lặng rồi bị cúp máy đột ngột). `transfer_to_agent` chưa bao giờ được vá lỗ
hổng tương tự. Giờ có thêm một vòng gọi `getAvailableAgents` (mạng, có độ trễ)
TRƯỚC khi tool trả lời, model càng dễ chỉ gọi tool mà không kèm lời nói (không
còn "phản xạ" nói ngay vì đã quen chờ) — rủi ro "chuyển máy trong im lặng"
tăng lên đúng lúc tính năng mới này được thêm vào.

**Sửa** (`session-ws.js`): thêm kiểm tra `_hasTransferAudio` (giống hệt
`_hasGoodbyeAudio`) trong nhánh `action === "transfer_to_agent"` — thiếu audio
thì tự gửi `response.create` ép đọc nguyên văn `result.message` (hoặc câu mặc
định), đặt event `transfer_announce_forced` để theo dõi tần suất xảy ra thật.
`_handleTransfer` nhận thêm tham số `delayMs` (mặc định 2000ms như cũ, giữ
nguyên hành vi ở mọi lời gọi khác) — khi phải tự tạo câu thông báo, gọi với
`5000ms` để chắc chắn câu nói kịp phát xong trước khi REFER.

### 3. `Promise.race` với timeout ngắn hơn timeout nội bộ của `callApi` — nguy cơ vỡ toàn bộ luồng

Bản gốc: `Promise.race([getAvailableAgents(), timeoutPromise(3000ms)])` không
có `try/catch`. Nhưng `callApi` (api.js) đã có timeout nội bộ riêng
(`TONGDAI_API_TIMEOUT_MS`, mặc định **15000ms**) và **không bao giờ throw** —
luôn trả `{success:false, error_code,...}` khi lỗi/timeout. Nếu
`getAvailableAgents` chỉ hơi chậm (3-15s, vẫn trong giới hạn bình thường của
chính nó), `timeoutPromise` reject TRƯỚC — văng lên `dispatchTool`'s catch
chung (`tools.js`), trả về `"Đã xảy ra lỗi hệ thống. Vui lòng thử lại."`
**KHÔNG có field `action`** → khách hỏi chuyển máy nhưng chỉ nghe một câu lỗi
chung chung, không được mời chuyển máy hay để lại lời nhắn gì cả — tệ hơn cả
hai nhánh dự định.

**Sửa** (`tools.js`): bọc `try/catch` quanh `Promise.race`; timeout của race
tăng lên 4500ms (dư dả hơn 3000ms cũ, vẫn ngắn hơn hẳn timeout nội bộ 15000ms
để không bắt khách chờ quá lâu); lỗi/timeout → coi như "không xác định được
có ai rảnh", rơi thẳng vào nhánh `leave_message` (an toàn hơn báo lỗi trắng).

## Việc CHƯA làm (cần cân nhắc thêm, ngoài phạm vi rà soát session-ws.js lần này)

- `create_ticket` hiện mô tả chung "Tạo phiếu tiếp nhận phản ánh sự cố hoặc
  khiếu nại ban đầu" — chưa có ví dụ/nhánh riêng cho "khách để lại lời nhắn
  nhờ gọi lại" (không phải phản ánh/khiếu nại). Hướng dẫn tạm thời đặt trong
  `message` của `leave_message` (mô tả rõ đây là yêu cầu gọi lại, không phải
  sự cố) — nếu log thật cho thấy model ghi sai loại phiếu, cân nhắc sửa
  `system-prompt.js`/mô tả tool `create_ticket` sau.
- Chưa có test case tự động (`test_case/*.test.mjs`) cho luồng
  `leave_message` — bộ test hiện tại (`danh_bo_verify_flow`,
  `speak_verbatim`, `muc_c_khong_cam`, `danh_bo_20260726`) không đụng tới
  `transfer_to_agent`. Cân nhắc thêm nếu luồng này quan trọng.

## Kiểm chứng

`node --check src/session-ws.js` + `node --check src/tools.js` + `npm test`:
59/59 xanh (không có test nào phủ trực tiếp luồng mới, chỉ xác nhận không phá
vỡ gì hiện có). **Chưa có log cuộc gọi thật nào** dùng luồng này — cần theo
dõi cuộc gọi test đầu tiên có chuyển máy, đặc biệt kịch bản không có tổng đài
viên rảnh, để xác nhận khách nghe đúng câu hỏi để lại lời nhắn và không bị
ghép thêm câu hỏi kết thúc cố định.

---

## Cập nhật 07/08/2026 — cuộc test thật đầu tiên: câu hỏi để lại lời nhắn ĐÚNG, nhưng kẹt ở bước tạo phiếu

Cuộc `rtc_u7_EA507YePMlSD2e1ixrC08` (09:53:32–09:55:45) là cuộc test thật đầu
tiên dùng luồng này.

**Phần đã sửa hoạt động đúng**: sau khi `transfer_to_agent` báo không có tổng
đài viên rảnh, bot đọc ĐÚNG NGUYÊN VĂN câu hỏi "Dạ, hiện tại chưa có tổng đài
viên nào rảnh để hỗ trợ ạ. Quý Khách có muốn để lại lời nhắn để nhân viên liên
hệ lại không ạ?" (không bị ghép câu hỏi kết thúc cố định nào khác — xác nhận
fix `doc_cho_khach` hoạt động đúng như thiết kế).

**Bug mới phát hiện**: khách đồng ý để lại lời nhắn ("À cái đó là lời nhắn
đi.") → bot hỏi nội dung → khách mô tả ("Cho người xuống kiểm tra hệ thống
nước nhà anh nha.") → bot tóm tắt xác nhận đúng → khách xác nhận ("Đúng rồi
ạ.") → bot gọi `create_ticket({"loai":"phan_anh","mo_ta":"..."})`. Nhưng
`create_ticket` (logic có sẵn từ trước, không phải do đợt sửa hôm nay) LUÔN
gọi `resolveDanhBo` — BẮT BUỘC mã danh bộ 11 số trước khi tạo phiếu. Khách gọi
chỉ để nhờ liên hệ lại (không phải đang tra cứu hoá đơn) nên không có mã danh
bộ sẵn trong đầu — nói "Anh có máy ảnh đó em." (rất có thể ASR nghe sai từ
"anh không có mã đó em" — khách đang từ chối/báo không có mã), nhưng bot không
nhận ra, cứ lặp lại yêu cầu đọc số. Khách nói "Alo có ai bên đó." (bối rối) rồi
cúp máy (`WebSocket đóng: 1006`) sau khi bot lặp yêu cầu đọc số lần 2.

Thêm phát hiện liên quan: `server.js` (`extractAsteriskHeaders`) đang HARDCODE
số điện thoại tra cứu thành `'0967777637'` cho MỌI cuộc gọi ("tel for test")
thay vì dùng SĐT thật của người gọi (`phoneNumber_real`, tính ra nhưng KHÔNG
được dùng ở đâu cả — dead code) — đây là lý do `knownDanhBo` luôn rỗng trong
mọi cuộc test, khiến kịch bản "phải hỏi lại mã danh bộ" xảy ra thường xuyên
hơn hẳn so với cuộc gọi thật (khách gọi từ SĐT đã đăng ký sẽ có `knownDanhBo`
ngay, tin luôn không cần hỏi).

**Đã hỏi ý kiến chủ dự án** (AskUserQuestion) về hướng xử lý — chọn: **cho
phép tạo phiếu "lời nhắn" không cần mã danh bộ**, dùng SĐT người gọi.

### Sửa

Thêm tool RIÊNG `leave_callback_message` (không đụng vào `create_ticket` —
tránh rủi ro cho luồng phản ánh sự cố thông thường, vốn cần mã danh bộ thật để
gắn đúng tài khoản):

- **`system-prompt.js`**: thêm schema `leave_callback_message` (tham số duy
  nhất `noi_dung`, required) + cập nhật mục `# Tools` — liệt kê tool này trong
  nhóm "tác động thật", áp cùng yêu cầu "tóm tắt + xin xác nhận trước khi gọi"
  như `create_ticket`, và ghi rõ: CHỈ dùng sau `action:"leave_message"`, KHÔNG
  dùng `create_ticket` cho trường hợp này.
- **`tools.js`**: `handleLeaveCallbackMessage({noi_dung}, callState)` — KHÔNG
  gọi `resolveDanhBo`. Backend `/bao-su-co` (`docs/api.php`) bắt buộc
  `danhba` không rỗng (không có endpoint riêng cho lời nhắn không gắn tài
  khoản) — dùng `callState.callerPhone` làm giá trị thay thế, và ghi RÕ trong
  nội dung gửi lên đây là SĐT liên hệ chứ không phải mã danh bộ thật, tránh
  nhân viên xem phiếu hiểu nhầm. Đây là workaround cho giới hạn API hiện có,
  không phải thiết kế lý tưởng.
- **`tools.js` / `handleTransferToAgent`**: đổi `message` của nhánh
  `leave_message` — hướng dẫn model gọi `leave_callback_message` thay vì
  `create_ticket`.
- **`session-ws.js`**: `_toolCallState` thêm field `callerPhone =
  callOps.asteriskData?.phoneNumber_real || callOps.tel || null` — dùng đúng
  SĐT thật (field đã tồn tại sẵn trong `asteriskData` nhưng trước đây không ai
  đọc tới), KHÔNG dùng `callOps.asteriskData.phoneNumber` (đang hardcode test).
  Không cần sửa gì thêm ở nhánh dispatch chung — `leave_callback_message` trả
  `doc_cho_khach` nên tự động đi qua đường đọc-nguyên-văn có sẵn.

### Chưa làm / cần cân nhắc thêm

- **Chưa bỏ hardcode `'0967777637'`** trong `server.js` — chủ dự án chọn
  phương án khác (tool riêng không cần mã danh bộ) thay vì bỏ hardcode, nên
  hardcode này vẫn còn nguyên. Field `phoneNumber_real` giờ ĐÃ được dùng (qua
  `callerPhone`), nhưng CHỈ trong `leave_callback_message` — `knownDanhBo` và
  toàn bộ luồng tra cứu khác vẫn tra theo `'0967777637'` như cũ. Nếu sau này
  muốn bỏ hardcode, cần đánh giá riêng (ảnh hưởng rộng hơn, tới cả luồng chính).
- Dùng SĐT làm giá trị `danhba` là workaround do backend không có field riêng
  cho "lời nhắn không gắn tài khoản" — nếu backend team có thể thêm hỗ trợ
  thật (vd endpoint riêng hoặc cho phép `danhba` rỗng), nên chuyển sang cách
  đó thay vì nhồi SĐT vào field `danhba`.

`node --check` (session-ws.js, tools.js, system-prompt.js) + `npm test`:
59/59 xanh. Cần theo dõi cuộc gọi thật tiếp theo dùng đúng luồng "để lại lời
nhắn" để xác nhận `leave_callback_message` hoạt động và không còn bị đòi mã
danh bộ.

---

## Cập nhật 07/08/2026 (lần 2) — theo yêu cầu chủ dự án: lưu remote + local, mã danh bộ optional

Chủ dự án yêu cầu: luồng để lại lời nhắn xử lý GIỐNG `create_ticket` (gọi
`baoSuCo` lưu remote + `insertTicket` lưu local database), API `baoSuCo` đã
được bổ sung thêm tham số SĐT, và vẫn hỏi mã danh bộ nhưng KHÔNG bắt buộc.

Ghi nhận: `api.js`'s `baoSuCo(maDanhBo, noiDung, tel)` đã có sẵn tham số `tel`
thứ 3 (chủ dự án tự cập nhật trước khi nhắn yêu cầu này) — dùng luôn, không
cần đoán tên tham số.

### Sửa

- **`tools.js` / `handleLeaveCallbackMessage`**: bỏ workaround cũ (nhồi SĐT
  vào chuỗi `noidung`) — giờ gọi `baoSuCo(maDanhBoChuan || null, noi_dung,
  phone)` với `phone` truyền riêng qua tham số thứ 3. Thêm tham số
  `ma_danh_bo` (optional) vào handler: chuẩn hoá bằng `normalizeDanhBo` NẾU
  khách có cung cấp, nhưng KHÔNG gọi `resolveDanhBo` — cơ chế đó (thu thập +
  xác nhận nghiêm ngặt, VAD digits, trọng tài gpt-5.1, DTMF...) được thiết kế
  cho tra cứu TÀI KHOẢN (sai 1 số là lộ dữ liệu người khác), không phù hợp cho
  một trường tham khảo không bắt buộc trên lời nhắn.
- **`system-prompt.js`**: thêm `ma_danh_bo` (optional) vào schema
  `leave_callback_message`; cập nhật `description` + `message` hướng dẫn của
  `handleTransferToAgent`'s nhánh `leave_message`: model CÓ THỂ hỏi thêm mã
  danh bộ nếu khách có sẵn, nhưng khách không có/không nhớ thì bỏ qua, KHÔNG
  ép đọc.
- **`session-ws.js`**: mở rộng khối `insertTicket` (trước đây chỉ chạy khi
  `name === "create_ticket"`) sang cả `leave_callback_message` — map args
  `{noi_dung, ma_danh_bo}` sang hình dạng `{ma_danh_bo, loai:
  "loi_nhan_goi_lai", mo_ta}` mà `insertTicket` đang đọc; `customerTel` dùng
  `_toolCallState.callerPhone` (SĐT thật, đã thêm ở lần sửa trước) thay vì số
  hardcode test — tách riêng logic này khỏi `create_ticket` (giữ nguyên
  `customerTel` cũ cho `create_ticket`, không đổi hành vi hiện có).
- **`db.js`**: cập nhật JSDoc của `insertTicket` — ghi rõ giờ phục vụ cả 2
  tool, `ma_danh_bo` có thể rỗng/null.
- **`docs/api.php`** (tài liệu tham khảo, KHÔNG phải gateway thật đang chạy —
  Node gọi qua `TONGDAI_API_BASE`): cập nhật mô tả endpoint `/bao-su-co` —
  `danhba` không còn bắt buộc, thêm `tel`. Đã ghi chú rõ cần đối chiếu lại với
  gateway PHP thật trên server, vì không có cách nào kiểm chứng file này từ
  phía Node.

`node --check` (session-ws.js, tools.js, system-prompt.js, db.js, api.js) +
`npm test`: 59/59 xanh. Cần theo dõi cuộc gọi thật tiếp theo: xác nhận
`baoSuCo` với SĐT thành công trên remote thật, `insertTicket` ghi đúng vào
bảng `ticket` với `ma_danh_bo` rỗng khi khách không cung cấp, và model không
ép khách đọc mã danh bộ trong luồng này.

---

## Cập nhật 07/08/2026 (lần 3) — cuộc test xác nhận lưu local DB hoạt động, phát hiện model glitch mới

Cuộc `rtc_u7_EABQDU5tpimk6LbvxKJrg` (16:44:57–16:47:06): chủ dự án hỏi vì sao
không thấy code lưu local DB. Log xác nhận **`insertTicket` CÓ chạy đúng** —
dòng `[DB] Đã ghi ticket cho call...` xuất hiện 2 lần trong cuộc này (khớp với
2 lần `leave_callback_message` được gọi, xem bên dưới), cả khi remote thất bại
(`remote_success=0`) lẫn thành công (`remote_success=1`).

### Phát hiện thêm (không phải điều đang hỏi, nhưng đáng ghi nhận)

Lần gọi `leave_callback_message` ĐẦU TIÊN (16:46:15.184) có `arguments`
KHÔNG PHẢI JSON hợp lệ — lẫn một đoạn văn bản tiếng Anh giống nội dung suy
luận nội bộ bị rò rỉ ra ngoài (vd "It's created? tool returned? We'll see.
Need call...") và một khối khoảng trắng khổng lồ, thay vì dừng đúng ở dấu `}`
đóng JSON. `JSON.parse` thất bại → `args` rơi về `{}` rỗng (trước đây lỗi này
bị NUỐT ÂM THẦM, không có log nào báo) → tool nhận `noi_dung`/`ma_danh_bo`
rỗng → backend `/bao-su-co` trả 400 "tel và noidung required" (đúng, vì
noidung rỗng thật). Model TỰ nhận ra và gọi lại NGAY (16:46:16.205) với args
sạch, hợp lệ — lần này thành công (200, `remote_success=1`). Khách không bị
ảnh hưởng nặng (chỉ nghe một câu hơi lạ "Dạ, tóm tắt lại cho rõ nội dung mọi
người cần rồi gửi lời nhắn nhé." rồi mọi thứ tiếp tục bình thường).

Đây là hiện tượng MỚI, chưa từng thấy trong các cuộc trước — nhiều khả năng là
glitch phía model (gpt-realtime-2.1-mini) khi sinh function-call arguments,
không phải lỗi logic trong code. Không có action nào để "sửa" trực tiếp phía
model, nhưng lỗi parse trước đây hoàn toàn im lặng — nếu không đọc log thô
từng dòng như lần này sẽ không phát hiện được.

**Sửa** (`session-ws.js`, chỗ `JSON.parse(argsStr)`): thêm `log.warn` + event
`tool_args_parse_error` (ghi tên tool, lỗi parse, độ dài raw string) khi
parse thất bại — áp dụng cho MỌI tool, không riêng `leave_callback_message`,
để các glitch tương tự sau này hiện rõ trong log thay vì phải suy luận từ
gián tiếp (2 lần gọi cùng tool cách nhau <1s, một lần lỗi một lần đúng).

Cũng ghi nhận thêm 1 lỗi phụ tự phục hồi: ngay sau khi
`leave_callback_message` thành công, có 1 lỗi
`conversation_already_has_active_response` (16:46:16.695, do transcript "ạ
chiêm" — tạp âm/không rõ nghĩa — kích hoạt response mới trong lúc response ép
đọc `doc_cho_khach` còn đang chạy). Bot vẫn tự hồi phục, nói đúng nội dung ở
lượt kế — thuộc lớp lỗi đã biết/đã có mức chấp nhận rủi ro trong file này, chưa
cần sửa thêm.

`node --check src/session-ws.js` + `npm test`: 59/59 xanh.
