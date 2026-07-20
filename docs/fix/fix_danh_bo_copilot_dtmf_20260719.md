# Fix 19/07/2026 v2 — Co-pilot gpt-5.1 từ lượt 1 + nhập danh bộ bằng DTMF

## Vấn đề

Trọng tài gpt-5.1 (fix_danh_bo_trong_tai_20260719.md) chỉ kích hoạt SAU khi
khách đã đọc 2 lần thất bại — khách phải đọc lại nhiều lần trước khi được hỗ
trợ. Ngoài ra chưa có phương án nhập số bằng bàn phím khi giọng nói bó tay.

## Phương án: co-pilot ngầm chạy song song (khách vẫn đọc tự nhiên, UX không đổi)

### Luồng mới (`tools.js` — `handleConfirmDanhBo`, `DANH_BO_MAX_READS = 3`)

1. **Lượt 1, đủ 11 số** → bot đọc lại NGAY bản realtime (không thêm độ trễ),
   đồng thời `fireBackgroundArbiter()` cho gpt-5.1 phân tích NỀN (transcript +
   bản nghe + danh bộ theo SĐT) trong lúc bot đang đọc (~8-10s).
2. **Khách nói "đúng"** → dùng bản realtime, verdict nền bỏ đi. Vô hại.
3. **Khách báo SAI không kèm dãy mới** → model gọi `confirm_danh_bo` với
   `day_so` RỖNG (hướng dẫn mới trong message + system prompt), hoặc lặp số cũ
   sau lượt khách phủ định (cờ `_danhBoCustomerSaidNo` từ session-ws.js) →
   dùng NGAY ứng viên nền (`awaitBackgroundVerdict`): "Có phải số X không ạ?"
   — khách không phải đọc lại. Số cũ vào `_danhBoRejected`.
4. **Khách đọc lại (lượt ≥2)** → trọng tài chạy ĐỒNG BỘ đối chiếu TẤT CẢ quan
   sát (kèm danh sách dãy đã bị bác — arbiter cấm trả lại y nguyên). Trọng tài
   khác bản nghe + đủ tin cậy + qua API → đề xuất; ngược lại dùng bản khách đọc.
5. **Hết 3 lượt giọng nói** → `danhBoDtmfInviteResponse`: mời BẤM 11 số trên
   bàn phím, phím `*` xoá nhập lại; không tiện bấm → chuyển máy / tạo phiếu.

### DTMF (`session-ws.js` — `input_audio_buffer.dtmf_event_received`)

- Nhận phím **bất kỳ lúc nào** (không chờ bot mời — khách sốt ruột bấm luôn được).
- Buffer theo `_toolCallState._dtmfBuffer`; phím cách nhau >15s → coi như nhập
  mới; `*` xoá buffer; đủ 11 số → lưu `callState.danhBo` + `_speakVerbatim`
  ép bot đọc lại xác nhận (retry nếu đang có response active, tối đa 8 lần).
- Số bấm phím KHÔNG qua "tai" model → không cần gate `_danhBoNeedsVerbalYes`,
  chỉ cần vòng xác nhận thường.

### Guard chống lặp

- `tryProposeArbiterCandidate`: tối đa **2 lần đề xuất** / cuộc gọi; không đề
  xuất số nằm trong `_danhBoRejected`; vẫn xác thực API + gate xác nhận lời
  nói thật (giữ nguyên fix E3JJPyzYujYdwQG048Bf7).
- Sau khi đã mời bấm phím (`_danhBoDtmfInvited`) mà khách vẫn đọc sai tiếp →
  escalation (chuyển máy / tạo phiếu), không lặp.

## File thay đổi

- `src/tools.js` — luồng mới, export `danhBoSpoken` cho session-ws.
- `src/session-ws.js` — case DTMF, `_speakVerbatim`, cờ `_danhBoCustomerSaidNo`.
- `src/danh-bo-arbiter.js` — thêm quan sát `rejected` vào prompt.
- `src/system-prompt.js` — hướng dẫn `day_so` rỗng khi khách báo sai, mục `moi_bam_phim`.

### Tự sửa khi tra cứu CUSTOMER_NOT_FOUND (`danhBoNotFoundSelfCorrect`)

Cuộc gọi thật E3KOvwoNn4gWn4VhY6e4C cho thấy 2 lỗ hổng: khách đọc
`232-732-401-68`, realtime nghe `22273240168` (sai số thứ 3), co-pilot suy ra
đúng `23273240168` (conf 0.85) — nhưng (1) khách nói "xài lại" (ASR nhiễu),
model coi là xác nhận số realtime, và (2) `get_bill` trả `CUSTOMER_NOT_FOUND`
rồi dừng, phí mất verdict co-pilot đã có sẵn trong callState.

Vá: `fetchBilling` khi gặp `CUSTOMER_NOT_FOUND` → gọi `danhBoNotFoundSelfCorrect`:
lấy verdict co-pilot nền, nếu có dãy KHÁC số vừa fail + xác thực API OK →
đẩy số cũ vào `_danhBoRejected` và đọc lại ứng viên co-pilot cho khách xác nhận
("Em kiểm tra lại, có phải số ... không ạ?") thay vì báo "không tìm thấy".
Chỉ áp cho `CUSTOMER_NOT_FOUND`; `INVOICE/PRODUCTION_NOT_FOUND` (danh bộ đúng,
kỳ chưa có dữ liệu) giữ nguyên. Còn lỗ hổng (2b): nếu số realtime sai lại TRÙNG
danh bộ khách khác (API vẫn found) thì không kích hoạt — chấp nhận, hiếm.

## v3 — Co-pilot tự gom số qua nhiều hơi + luôn chạy nền (cuộc E3KbgngzfpyMMwworgeXs)

Cuộc gọi thật: khách đọc danh bộ tách nhiều hơi (`hai hai không bảy` / `ba hai
bốn` / `không một sáu tám`). Semantic VAD (`create_response: true`) tạo response
MỖI hơi → model mini buộc đáp "chưa đủ số" ngay, không kịp tích lũy, thậm chí
KHÔNG gọi `confirm_danh_bo` suốt ~2 phút → mọi logic co-pilot bên tools.js không
chạy. Ngoài ra gpt-5.1 timeout 12s cả 2 lần; nhánh "lượt ≥2 đồng bộ" khiến khách
chờ 13s mới nghe đọc lại.

Vá:
1. **Luôn chạy nền, không bao giờ chặn.** Bỏ nhánh "lượt ≥2 đồng bộ" trong
   `handleConfirmDanhBo` — đủ 11 số là đọc lại NGAY bản realtime + co-pilot chạy
   nền. Timeout arbiter 12s → 20s (an toàn vì không còn chặn).
2. **Co-pilot tự gom từ transcript** (`proactiveAssembleDanhBo`, gọi từ
   session-ws sau khi khách ngưng đọc số ~3s — debounce reset mỗi hơi, min-gap
   6s giữa 2 lần chạy). gpt-5.1 ghép các hơi transcript đã buffer thành 11 số;
   đủ tin cậy + xác thực API → code TỰ đọc lại xác nhận (`_speakVerbatim`),
   KHÔNG chờ model gọi tool. Số này là arbiter-derived → giữ gate
   `_danhBoNeedsVerbalYes`. Chỉ chạy khi CHƯA có ứng viên nào (`callState.danhBo`
   null) — không chen ngang model/DTMF.
3. **Fallback DTMF chủ động.** Gom ≥3 nhịp không ghép nổi → `proactiveAssembleDanhBo`
   trả thẳng câu mời bấm phím (không phụ thuộc model), tránh im lặng vĩnh viễn.
4. Khách phủ định số co-pilot đề xuất (regex `_PHU_DINH_RE`) → `noteDanhBoRejected`
   đẩy vào `_danhBoRejected`, cho gom lại dãy khác.

## Đã kiểm tra

`node --check` 4 file + smoke test mock fetch: lượt 1 đọc ngay + bg fire; báo
sai → ứng viên nền (không gọi lại gpt-5.1); bác ứng viên → không đề xuất lại,
mời đọc lại; hết 3 lượt → mời bấm phím. Chưa test cuộc gọi SIP thật — cần theo
dõi payload thực tế của `input_audio_buffer.dtmf_event_received` (giả định
digit nằm ở `event.event`).
