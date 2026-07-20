# Fix 19/07/2026 — Trọng tài gpt-5.1 cho mã danh bộ (bỏ 4-4-3)

## Bối cảnh

Cuộc `rtc_u1_E2yeCWEsecOlWrgBM8CW1` (18/07 19:41): khách đọc đủ 11 số nhưng tách
2 hơi (`220232` + `47431`), VAD cắt thành 2 turn; model mini chỉ lấy cụm cuối và
chép sai số (`47431` → `43243`). Chế độ đọc theo nhóm 4-4-3 kích hoạt đúng thiết
kế nhưng model không đọc nguyên văn kịch bản → khách rối, cúp máy.

Quyết định: **bỏ toàn bộ chế độ 4-4-3** (trải nghiệm đọc từng nhóm chậm, "bị
lỗi thời"). Khách đọc liền 11 số tự nhiên như cũ; phần sai sót xử lý ở hậu trường.

## Luồng mới

1. Khách đọc mã danh bộ (liền 11 số), tối đa **2 lần** (`DANH_BO_MAX_READS`).
   Ra đúng 11 số → đọc lại xác nhận như cũ.
2. Sau 2 lần vẫn chưa ra 11 số → **TRỌNG TÀI** (`src/danh-bo-arbiter.js`):
   gửi mọi quan sát cho model mạnh (env `DANH_BO_ARBITER_MODEL`, mặc định
   `gpt-5.1`, timeout `DANH_BO_ARBITER_TIMEOUT_MS` = 12s):
   - các dãy số model realtime nghe được (`callState._danhBoReads`),
   - transcript các lượt khách đọc số (`callState._danhBoTranscripts`,
     session-ws buffer các lượt có ≥ 3 token chữ số),
   - danh bộ đăng ký theo SĐT gọi đến (`knownDanhBo`).
   Model trả `{ma_danh_bo, do_tin_cay, ly_do}` (JSON).
3. Ứng viên đủ 11 số và `do_tin_cay ≥ 0.7` → **xác thực** qua
   `getThongTinKhachHang`: không tồn tại → escalation; API lỗi mạng/timeout →
   vẫn cho xác nhận (lỗi mạng ≠ số sai). Hợp lệ → đọc lại từng chữ số cho khách
   xác nhận 1 lần cuối (flow `cho_khach_xac_nhan` như cũ).
4. Không đủ tin cậy / trọng tài lỗi / khách vẫn bác sau trọng tài
   (`_danhBoArbitrated` guard chống lặp vô hạn) → escalation: chuyển tổng đài
   viên hoặc tạo phiếu.

## Điểm cần biết

- **Ngoại lệ có chủ đích** của quy ước "transcript chỉ để debug": transcript
  được dùng làm dữ liệu cho trọng tài ở bước fallback. An toàn vì kết quả luôn
  qua 2 lớp kiểm tra: xác thực API + khách xác nhận lại từng số.
- Trước khi gọi trọng tài code chờ 800ms cho transcript lượt cuối kịp về
  (transcription chạy song song, thường trễ hơn tool call).
- `_danhBoLastPrompt` giờ được lưu ở MỌI bước danh bộ (qua `danhBoPayload`) —
  cơ chế re-assert của session-ws hoạt động cho cả luồng thường, không chỉ
  guided mode như trước; tắt khi danh bộ được chốt (`resolveDanhBo`).
- `_toolCallState._logger = logger`: tools.js ghi event `danh_bo_arbiter`
  (verdict/failed) vào timeline cuộc gọi.
- Đã gỡ: `_danhBoGuided`, `sua_nhom_vua_roi` (cả trong TOOLS schema),
  các bullet 4-4-3 trong system prompt.

## Đã test (stub fetch, `dispatchTool` trực tiếp)

11 số ngay lần 1 → xác nhận; 2 lần fail → trọng tài ra số đúng → xác nhận;
fail tiếp sau trọng tài → escalation; confidence 0.4 → escalation; ứng viên
không có trong hệ thống → escalation; API nghiệp vụ sập → vẫn cho xác nhận;
`get_bill` khi chưa có số → xin mã.

## Hardening (rà soát 19/07/2026, sau khi test thực tế)

- **Bug thật đã sửa**: `dispatchTool` case `confirm_danh_bo` thiếu `await`.
  `handleConfirmDanhBo` giờ là async (nhánh trọng tài có `fetch`) — thiếu
  `await` thì lỗi bên trong sẽ KHÔNG rơi vào try/catch của `dispatchTool`
  (promise trả về trực tiếp từ `return`, ngoài phạm vi try/catch khi reject).
- **Bug thật đã sửa**: so sánh độ tin cậy viết theo hướng "từ chối"
  (`conf < ARBITER_MIN_CONFIDENCE`) — nếu `do_tin_cay` bị thiếu hoặc sai kiểu
  (vd model trả `"cao"` thay vì số), `Number()` ra `NaN`, và MỌI so sánh với
  `NaN` đều `false` (kể cả `NaN < 0.7`) → vô tình coi là đủ tin cậy. Đổi sang
  điều kiện "chấp nhận" (`Number.isFinite(conf) && conf >= ngưỡng`) để dữ liệu
  rác luôn rơi về escalation an toàn. Test: `do_tin_cay: "cao"` và thiếu hẳn
  field `do_tin_cay` đều → escalation đúng như kỳ vọng.
- **Structured output**: đổi `response_format` từ `json_object` (lỏng) sang
  `json_schema` strict (ép đúng 3 field, đúng kiểu dữ liệu) — giảm khả năng
  model trả thiếu/sai kiểu field ngay từ nguồn, thay vì chỉ chặn ở code.
- **Latency**: gpt-5.1 là reasoning model, mặc định có thể "suy nghĩ" vài giây
  — khách đang chờ trong im lặng giữa cuộc gọi thoại. Thêm
  `reasoning_effort: "low"` (env `DANH_BO_ARBITER_REASONING_EFFORT`) để ưu
  tiên tốc độ, vẫn đủ suy luận cho việc đối chiếu vài dãy số nhiễu.
- **Cấu hình được ngưỡng tin cậy**: `ARBITER_MIN_CONFIDENCE` giờ đọc từ env
  `DANH_BO_ARBITER_MIN_CONFIDENCE` (mặc định 0.7) — chỉnh được không cần sửa code.

## Kiểm chứng qua cuộc gọi thật (19/07/2026 17:21, `rtc_u0_E3IwDpl3qXKJ2hoRtHHRU`)

Trọng tài hoạt động đúng thiết kế: model mini gọi `confirm_danh_bo` với CÙNG một
dãy sai (`2343247431`) hai lần liên tiếp — kể cả sau khi khách đã đọc lại đầy đủ
rõ ràng ở lượt 2 (nghi mini không thực sự xử lý lượt nói mới, trả lại tool-call
cũ). Vì `_danhBoReads` toàn dữ liệu rác nhưng `_danhBoTranscripts` có transcript
đúng ("hai hai không hai ba hai bốn bảy bốn ba một"), gpt-5.1 vẫn ghép ra đúng
`22023247431` (conf 0.9), xác thực API OK, khách xác nhận "Đúng rồi", tra hóa đơn
thành công. Tổng chi phí cuộc gọi: $0.065 (gồm cả trọng tài, ~1.2K token).

**Lỗ hổng phát hiện qua log**: `_looksLikeDigitTurn` ở `session-ws.js` (bộ lọc
buffer transcript cho trọng tài) chỉ nhận diện số đọc TÁCH TỪNG CHỮ ("hai hai
không..."), bỏ sót transcript ASR phiên âm thành CHUỖI SỐ LIỀN ("232474431") —
lượt đọc đầu tiên của khách trong cuộc gọi này rơi đúng vào trường hợp này và
KHÔNG được đưa vào trọng tài (may mà lượt đọc lại sau đó có transcript dạng tách
chữ nên vẫn cứu được). Đã sửa: thêm nhánh đếm số ký tự chữ số liền
(`(s.match(/\d/g) || []).length >= 3`) song song với nhánh từ tiếng Việt cũ.

## Lỗ hổng nghiêm trọng phát hiện + đã vá (19/07/2026, cuộc `rtc_u2_E3JJPyzYujYdwQG048Bf7`)

Sau khi trọng tài trả `cho_khach_xac_nhan`, model **bỏ qua hẳn việc đọc lại xác
nhận**, tự nói câu khác rồi gọi thẳng `get_bill({})` — không có lượt khách nào
xác nhận "đúng rồi" ở giữa. Lần đó trọng tài đoán đúng nên không sao, nhưng
`resolveDanhBo` set `stored.confirmed = true` **vô điều kiện** mỗi khi có tool
tra cứu được gọi trong khi đã có `callState.danhBo.value` — field `confirmed`
được ghi nhưng KHÔNG có nơi nào đọc lại để làm cổng chặn. Nếu trọng tài đoán
**sai nhưng vẫn trùng danh bộ thật của khách hàng khác** (qua được xác thực
API), hệ thống sẽ đọc thông tin của người khác cho người gọi nghe mà không ai
chặn lại — rủi ro lộ dữ liệu khách hàng.

**Quyết định phạm vi fix** (đã hỏi ý kiến): chỉ siết ở nhánh RỦI RO NHẤT — danh
bộ do TRỌNG TÀI suy luận (qua 2 lần đọc thất bại, độ chắc chắn a-priori thấp
hơn khách đọc trôi chảy đúng ngay từ đầu). Luồng đọc thẳng vẫn giữ nguyên hành
vi cũ (không thêm gate, tránh rủi ro chặn nhầm luồng đang chạy ổn định).

### Cơ chế

- `arbitrateAndConfirm` (tools.js): sau khi có ứng viên hợp lệ, set thêm
  `callState._danhBoNeedsVerbalYes = true` (song song với `confirmed: false`).
- `session-ws.js`: mỗi lượt khách nói thật được soi qua `_isAffirmative()` —
  regex nhận diện từ khẳng định ("đúng", "chính xác", "vâng", "ok"...) TRỪ khi
  câu chứa từ phủ định trước đó ("không đúng", "sai", "chưa đúng"...). Khớp →
  gỡ cờ + `danhBo.confirmed = true`, ghi event `danh_bo_verbal_confirm`.
- `resolveDanhBo` (tools.js): nếu `_danhBoNeedsVerbalYes` vẫn `true` khi có tool
  tra cứu gọi tới → CHẶN, trả lại đúng câu xác nhận (không tra cứu).
- `acceptFullDanhBo` (luồng đọc thẳng, không qua trọng tài) và nhánh "khách đọc
  số MỚI trực tiếp vào tool tra cứu" trong `resolveDanhBo`: luôn set
  `_danhBoNeedsVerbalYes = false` — không áp gate này, giữ hành vi cũ.

### Đã test

`dispatchTool` trực tiếp: (A) trọng tài xong → gọi `get_bill({})` ngay không có
xác nhận → bị chặn, trả lại câu xác nhận, không có data. (B) mô phỏng khách nói
"Đúng rồi anh" → gỡ cờ → `get_bill({})` trả dữ liệu thật. (C) luồng đọc thẳng
11 số → không bị gate, hoạt động như cũ. (D) danh bộ theo SĐT (`knownDanhBo`) →
không bị gate, hoạt động như cũ. Regex khẳng định/phủ định: 11 case (đúng rồi,
chính xác, vâng đúng, ok, ừ đúng — dương; không đúng, sai rồi, chưa đúng — âm;
câu không liên quan — âm) đều đúng kỳ vọng.

## Chưa xử lý (ghi nhận từ cuộc gọi lỗi, ngoài phạm vi đợt fix này)

1. VAD cắt dãy số khi khách ngắt hơi — cân nhắc tăng `silence_duration_ms`
   khi đang chờ danh bộ.
2. Model mini không đọc nguyên văn `doc_cho_khach` — cân nhắc out-of-band
   response (`conversation: "none"`).
3. Phương án DTMF (bấm phím) — diệt tận gốc lỗi nghe số.
4. Khách chờ trong im lặng suốt lúc trọng tài chạy (~1-4s với reasoning
   effort thấp) — chưa có câu "chờ chút" phát trước. Chưa làm vì rủi ro đụng
   state machine response.create vốn đã rất mong manh trong repo này (xem các
   comment `_pendingCodeResponse`, `conversation_already_has_active_response`
   trong `session-ws.js`) — cần thiết kế + test kỹ riêng nếu làm.
