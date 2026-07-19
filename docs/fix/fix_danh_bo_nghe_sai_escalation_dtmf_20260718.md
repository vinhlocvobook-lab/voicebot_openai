# Fix v2: Model không nghe đủ 11 số — escalation + đọc theo nhóm + phương án DTMF (18/07/2026)

Tiếp nối `fix_confirm_danh_bo_20260718.md` (cùng ngày).

## Cuộc gọi lỗi

`rtc_u1_E2v1xrwL73YJDQ89dC9bQ` — 18/07/2026 15:49, SĐT 0967777637 (gọi lại sau cuộc trước 20 phút).

## Hiện tượng

Fix `confirm_danh_bo` hoạt động đúng thiết kế (model gọi tool ngay, không tra
cứu số sai, đọc gần nguyên văn `doc_cho_khach`). Nhưng lộ ra vấn đề sâu hơn:

```
Transcript ASR:  2220 232 517 75   → 12 số (2 lần, ổn định)
Model lần 1:     235217875         → 9 số (mất "220" đầu, bịa số "8")
Model lần 2:     23521775          → 8 số (mất thêm)
```

Khách (có lẽ đọc `22023251775`, 11 số) kẹt trong vòng lặp "đọc lại giúp em"
→ cúp máy sau 2 vòng (1006). **`gpt-realtime-mini` không thể chép chính xác
dãy 11 số liền mạch vào tham số tool** — rơi số đầu + bịa số, không fix được
bằng prompt hay code phía mình.

## Fix đã triển khai (deterministic, `src/tools.js`)

### 1. Escalation sau 2 lần nghe sai

`callState.danhBoInvalidCount` đếm số lần `invalid_danh_bo` theo cuộc gọi
(reset khi nhận đủ 11 số). Từ lần sai thứ 2: `doc_cho_khach` xin lỗi + mời
chọn: đọc lại lần nữa / **chuyển tổng đài viên** (`transfer_to_agent`) / nhân
viên gọi lại (`create_ticket`). Field `da_sai_nhieu_lan` cho model biết route.
Cả 2 cuộc gọi hỏng hôm nay khách đều bỏ cuộc đúng tại vòng lặp này.

### 2. Chế độ ĐỌC THEO NHÓM CÓ DẪN DẮT 4 + 4 + 3 (ý tưởng của anh Lộc)

Sau lần nghe sai **đầu tiên**, code chuyển sang chế độ dẫn dắt: bot **chủ động
xin từng nhóm** thay vì bắt khách đọc lại y hệt cách vừa thất bại. Nhóm 3-4 số
thì mini chép chính xác hơn hẳn, và khi sai chỉ phải đọc lại 1 nhóm.

**Xác nhận NGẦM** (biến thể chọn dùng): mỗi nhóm bot đọc lại + hỏi luôn nhóm kế
trong **cùng một câu** — *"Dạ, em ghi nhận: Hai - Hai - Không - Hai. Quý Khách
đọc tiếp bốn số tiếp theo giúp em ạ."* Khách nghe sai thì ngắt sửa ngay; đủ 11
số mới chốt xác nhận tường minh 1 lần. Giữ nguyên 2 lớp kiểm tra (nghe lại từng
nhóm + chốt cuối) nhưng chỉ ~5 lượt thay vì ~9 nếu xác nhận tường minh từng nhóm
(tiết kiệm ~40-60s và cost mỗi cuộc).

State: `callState._danhBoGuided = { groups: [], at, retry }` (cửa sổ 45s).

| Tình huống | Hành vi |
|---|---|
| Nhóm đúng độ dài, chưa phải nhóm cuối | Đọc lại nhóm + xin nhóm kế (`doc_theo_nhom_co_dan`) |
| Đủ 3 nhóm | Ghép → chốt xác nhận toàn bộ (`cho_khach_xac_nhan`), reset bộ đếm |
| Nhóm sai độ dài | Xin đọc lại **đúng nhóm đó**, các nhóm trước VẪN GIỮ |
| Khách báo nhóm vừa rồi sai | Model gọi lại với `sua_nhom_vua_roi: true` → code bỏ nhóm cuối, thay bằng số mới |
| Khách đọc thẳng đủ 11 số giữa chừng | Nhận luôn, hủy phiên nhóm |
| Chưa vào guided mà khách đọc sẵn đúng 4 số | Nhận làm nhóm 1 luôn, không bắt đọc lại |
| Sai cùng 1 nhóm quá 2 lần, hoặc tổng sai ≥3 | Escalation (chuyển tổng đài viên / tạo phiếu) |

Tool `confirm_danh_bo` thêm param `sua_nhom_vua_roi`; description nhấn mạnh
`day_so` chỉ chứa **chữ số của lượt này**, không gộp nhóm trước (code tự ghép).

### Test đã chạy (node, không cần backend) — 7/7 pass

- Kịch bản cuộc E2v1: chép hụt 9 số → vào guided → 4+4+3 → ghép đúng
  `22023251775`, `invalidCount` reset ✔
- Sửa nhóm giữa chừng (`sua_nhom_vua_roi`) → thay đúng nhóm 2, giữ nhóm 1 ✔
- Nhóm sai độ dài (3/4 số) → chỉ đọc lại nhóm đó, nhóm 1 còn nguyên ✔
- Sai cùng nhóm 3 lần → escalation, xóa state guided ✔
- Đọc đúng 11 số ngay lần đầu → không vào guided ✔
- Đọc sẵn 4 số ngay từ đầu → nhận làm nhóm 1 ✔
- Đang guided mà khách đọc luôn cả dãy 11 số → nhận, hủy phiên nhóm ✔

## Phương án DTMF (khách bấm phím) — KHẢ THI, chưa triển khai

### Kết quả nghiên cứu

OpenAI Realtime API **có hỗ trợ DTMF cho SIP**: server event
**`input_audio_buffer.dtmf_event_received`** (SIP-only) đẩy về đúng WebSocket
mà `session-ws.js` đang lắng nghe, mỗi phím bấm một event:

```json
{
  "type": "input_audio_buffer.dtmf_event_received",
  "event": "5",          // phím: 0-9, *, #, A-D
  "received_at": 1750287078
}
```

Nguồn: [API Reference — Realtime](https://developers.openai.com/api/reference/ruby/resources/realtime),
[Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations).
(Guide [Realtime SIP](https://developers.openai.com/api/docs/guides/realtime-sip)
không nhắc tới — event nằm trong reference phần server events.)

Ưu điểm quyết định: **số bấm phím là ground truth** — không đi qua "tai"
model, loại bỏ hoàn toàn lớp lỗi nghe số (nguyên nhân cả 2 cuộc gọi hỏng).

### Thiết kế đề xuất

1. **`session-ws.js`**: handler event DTMF, gom phím vào buffer theo cuộc gọi:
   - `0-9` → nối vào buffer; `#` → chốt; `*` → xóa buffer làm lại.
   - Tự chốt khi đủ 11 số (không cần `#`), timeout buffer ~20s không bấm gì.
2. **Khi chốt đủ 11 số**: set `_toolCallState.danhBo = { value, confirmed: false }`
   (đi thẳng vào hạ tầng `resolveDanhBo` sẵn có) + inject
   `conversation.item.create` (message hệ thống: "khách đã bấm mã danh bộ,
   đọc xác nhận: Hai - Hai - ...") + `response.create`.
   **Lưu ý**: phải tôn trọng các guard response hiện có (`_responseActive`,
   `conversation_already_has_active_response`, cancel-echo) — đây là phần cần
   cẩn thận nhất, phải test cuộc gọi thật.
3. **Mời bấm phím trong escalation**: lần sai ≥2, `doc_cho_khach` thêm lựa
   chọn *"hoặc Quý Khách bấm trực tiếp mười một số danh bộ trên bàn phím điện
   thoại, kết thúc bằng phím thăng"*.
4. Handler luôn lắng nghe passive — khách rành có thể bấm ngay từ đầu không
   cần được mời.

### Rủi ro / cần kiểm chứng khi làm

- SIP trunk của nhà mạng/Asterisk phía trước phải relay DTMF chuẩn
  (RFC 2833 / telephone-event) — cần test với hạ tầng thật của Trung An.
- Tương tác VAD: tiếng "bíp" DTMF có thể bị VAD bắt như speech → có thể cần
  cancel response đang chạy khi nhận chuỗi DTMF.
- Inject message + `response.create` giữa lúc model đang nói → phải qua guard
  sẵn có, tránh double-response.

## File thay đổi (fix đã triển khai)

| File | Thay đổi |
|---|---|
| `src/tools.js` | `danhBoInvalidCount` + `danhBoEscalationResponse`; chế độ dẫn dắt: `GUIDED_GROUPS` (4+4+3), `guidedStartResponse`, `guidedNextResponse`, `guidedRetryResponse`, `handleGuidedGroup`, `acceptFullDanhBo` |
| `src/system-prompt.js` | Param `sua_nhom_vua_roi` cho `confirm_danh_bo`; rule cho `doc_theo_nhom_co_dan`, sửa nhóm, `da_sai_nhieu_lan` |

### 3. Phòng lỗi model GỘP nhóm cũ

Rủi ro thấy trước: mini hay gửi cả `nhóm1+nhóm2` dù đã dặn chỉ gửi nhóm mới →
code sẽ thấy 8 số ở bước cần 4 → bắt khách đọc lại oan. Đã xử lý trong
`handleGuidedGroup`: input **dài hơn** nhóm mong đợi và **bắt đầu bằng** đúng
các nhóm đã có → tự cắt phần đuôi, log cảnh báo. Điều kiện "dài hơn" giữ cho
trường hợp nhóm mới trùng ngẫu nhiên với nhóm cũ (vd `2202` + `2202`) không bị
cắt nhầm — đã test.

### 4. Sửa sau cuộc test thật `rtc_u2_E2yQmFyGFTDr4ZQu3cGiM` (19:27)

Cuộc test đầu tiên của chế độ dẫn dắt: luồng chạy **đúng tới 8/11 số**
(nhóm 1 `2202` ✔, nhóm 2 `3247` ✔) rồi hỏng ở 2 điểm, khách cúp máy:

**a) Model set `sua_nhom_vua_roi: true` SAI ngữ cảnh.**
Bot vừa xin "đọc lại ba số cuối", khách đọc `431` (đúng nhóm 3) — model lại
đánh dấu là sửa nhóm trước → code xóa mất nhóm 2 đã đúng, lùi một bước, khách
bỏ cuộc. Đúng bài học chung của repo: **cờ điều khiển do model set không đáng
tin**. Fix — ưu tiên bằng chứng ĐỘ DÀI:

- Số vừa đọc khớp độ dài nhóm **đang cần** và khác độ dài nhóm trước
  → chắc chắn là nhóm hiện tại, **bỏ qua cờ** (log cảnh báo).
- Không phân biệt được bằng độ dài (nhóm 1 và 2 đều 4 số) → mới xét
  `g.lastAction`: chỉ chấp nhận sửa khi lượt trước code vừa **nhận xong** một
  nhóm; nếu lượt trước code đang xin đọc lại/nhắc lại thì bỏ qua cờ.

**b) Khách LẶP LẠI nhóm vừa đọc.**
Bot xin 3 số cuối, khách nói *"ba hai bốn bảy thôi em"* (lặp nhóm 2) → code
tính là nhóm 3 sai độ dài. Fix: input trùng y hệt nhóm vừa nhận → không phải
lỗi, trả `guidedRepeatResponse` ("phần đó em ghi nhận rồi ạ, em còn thiếu ba số
cuối thôi ạ"), **không tính retry**, đặt `lastAction = "repeat"`.

Replay đúng kịch bản cuộc gọi này sau fix → ra `22023247431` ✔ (8 test pass, 0 fail).

**Điểm tốt của cuộc gọi:** model đọc `doc_cho_khach` gần như nguyên văn ở mọi
bước nhóm; nhịp dẫn dắt 4+4+3 khách theo được ngay, không cần giải thích thêm.

**Còn lệch nhẹ:** ở lượt vào guided đầu tiên model tự chế thêm ("em nghe được
4 số, là 4 7 4 3 1") thay vì đọc đúng câu tool trả về — chưa gây hại, theo dõi tiếp.

### 5. Prompt echo làm bot "mất trí" giữa luồng — `rtc_u2_E2yXyLXpaZz66DmCfxQBi` (19:35)

Hỏng theo cơ chế **khác hẳn**, không nằm ở logic nhóm:

1. Bot vừa đọc đúng câu xin "bốn số đầu".
2. Transcript **prompt echo** về → guard cancel-echo hoạt động đúng (item khớp,
   không có lượt thật chưa trả lời) → gửi `response.cancel`.
3. Nhưng response đã kịp phát một phần: *"Dạ, em nghe rõ. Mình đang ở nhóm 4 số
   đầu. Quý Khách đọc giúp em nguyên văn: **Hai hai**"* — câu **nói dở** này nằm
   lại trong context.
4. Model đọc lại chính câu dở của mình, tưởng **"Hai hai" là số khách vừa đọc**
   → 4 lượt liền tự bịa hội thoại (*"em nghe là hai hai ạ... 2 rồi 2 nữa, đúng
   không Quý Khách?"*), **KHÔNG gọi `confirm_danh_bo` lần nào nữa**. Khách hỏi
   *"Là sao em?"*, *"A lô"*, *"Bốn số đầu hả?"* rồi cúp máy.

**Điểm sáng:** vì không có tool call nào, hệ thống KHÔNG tra cứu số bịa —
kiến trúc "số chỉ đi qua tool" đã chặn được hậu quả nghiêm trọng.

**Fix (deterministic, 2 file):**

- `tools.js`: `guidedPayload()` lưu câu đang chờ khách trả lời vào
  `callState._danhBoLastPrompt` ở MỌI bước nhóm (start / next / retry / repeat);
  xóa khi chốt xong hoặc escalation.
- `session-ws.js`: `_reAssertDanhBoStep()` — sau khi cancel response do echo, nếu
  còn đang giữa luồng nhóm thì chờ 900ms (cho cancel hoàn tất) rồi tự
  `response.create` bắt model đọc lại **đúng câu của bước hiện tại**, kèm chỉ thị
  *"KHÔNG nhắc lại bất kỳ chữ số nào ngoài đoạn này"*. Có guard `_hungUp` /
  `_transferred` / `_responseActive` và kiểm tra lại guided còn sống trước khi gửi.

Nhờ vậy state machine tự kéo cuộc gọi về đúng nhịp thay vì để model ứng biến từ
một câu nói dở. 9 test pass.

## Việc còn lại

- Test cuộc gọi thật để xem mini có theo được nhịp dẫn dắt từng nhóm không.
- Cân nhắc triển khai DTMF (phần dưới) nếu đọc theo nhóm vẫn chưa đủ tin cậy.
