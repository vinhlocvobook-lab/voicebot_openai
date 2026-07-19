# Fix: Model "chế" số danh bộ — thêm tool `confirm_danh_bo` (18/07/2026)

## Cuộc gọi lỗi

`rtc_u2_E2uhVdS9X4mVBoXs0uYMP` — 18/07/2026 15:28, SĐT 0967777637.
Log: `conversation_summary/2026/07/18/0967777637_E2uhVdS9X4mVBoXs0uYMP.json`.

## Hiện tượng

Khách hỏi thanh toán tiền nước, đọc mã danh bộ **2 lần giống nhau, đủ 11 số**:

```
Khách đọc:        2 2 0 2 3 2 4 7 4 3 1   (11 số → 22023247431)
Bot đọc lại:      2 2 0 2 2 3 2 4 7 4 3 1 (12 số — thêm "2" ở vị trí 5)
Tool call gửi:    220232432431            (12 số — mất "7", thêm "3 2", KHÁC cả bản bot vừa đọc)
```

Guard 11 số trong `tools.js` chặn đúng (`invalid_danh_bo`, `do_dai_hien_tai: 12`),
bot xin đọc lại → khách cúp máy (WS đóng 1006 sau ~12s im lặng).

## Nguyên nhân gốc

`gpt-realtime-mini` **không giữ được dãy số ổn định qua các lượt**: mỗi lần
nhắc lại (đọc xác nhận, truyền tham số tool) là một biến thể mới. Khách đọc lại
đúng lần 2 nhưng model coi đó là "xác nhận" rồi dùng bản sai của chính nó để
gọi tool. Prompt đã cấm ("khớp từng chữ số, KHÔNG thêm/bớt") nhưng model mini
không tuân thủ — cùng bài học các fix trước: **hành vi phải deterministic
bằng CODE trong `tools.js`, không dựa vào rule prompt.**

Khoảng hở chết người: **dãy bot đọc xác nhận ≠ dãy bot tra cứu** — khách xác
nhận một số, hệ thống tra một số khác.

## Giải pháp

Đưa vòng đời mã danh bộ về CODE, model chỉ còn 2 việc: chép số nghe được vào
tool 1 lần, và đọc nguyên văn output tool.

### 1. Tool mới `confirm_danh_bo(day_so)` — `src/tools.js`, `src/system-prompt.js`

- Khách đọc dãy số (lần đầu HAY đọc lại/sửa) → model **phải gọi tool này ngay**.
- Code `normalizeDanhBo` + đếm:
  - ≠ 11 số → `invalid_danh_bo` + `doc_cho_khach` viết sẵn (số chữ số nghe được,
    nhờ đọc lại) — hết cảnh model nói vụng "em **chỉ** nhận được 12".
  - = 11 số → **lưu `callState.danhBo = { value, confirmed: false }`** và trả
    `cho_khach_xac_nhan` + `doc_cho_khach` chứa dạng đọc từng chữ số
    (`Hai - Hai - Không - ...`, cùng format `spokenDanhBo` của server.js).
- Bot đọc lại **nguyên văn từ output tool** → dãy khách nghe = dãy sẽ tra cứu.
  Khoảng hở "đọc một đằng, tra một nẻo" bị khép kín.

### 2. `resolveDanhBo(rawArg, callState)` — thay `checkDanhBo` ở mọi tool tra cứu

Áp dụng cho `get_bill`, `get_payment_status`, `get_water_usage`,
`compare_usage`, `get_outages`, `create_ticket` (qua `fetchBilling` hoặc trực tiếp):

| Tình huống | Hành vi |
|---|---|
| Đã có `callState.danhBo`, arg trống/trùng/sai độ dài | **Dùng số đã lưu**, bỏ qua arg của model (arg lệch = model chép sai — đúng lỗi cuộc này), đánh dấu `confirmed` |
| Đã có số lưu, arg là **11 số KHÁC** | Coi là danh bộ MỚI (khách đổi/đọc lại) → lưu pending, trả `cho_khach_xac_nhan`, KHÔNG tra |
| Chưa có số lưu, arg ≠ 11 số | `invalid_danh_bo` (case 0 số: câu xin danh bộ riêng) |
| Chưa có số lưu, arg ∈ `knownDanhBo` (hệ thống cấp theo SĐT) | Tin ngay, tra luôn — số không đi qua "tai" model, và context đã có vòng xác nhận riêng |
| Chưa có số lưu, arg 11 số lạ (model bỏ qua confirm_danh_bo) | Lưu pending, trả `cho_khach_xac_nhan` — **ép read-back từ tool output ít nhất 1 lần** rồi mới tra |

### 3. Schema TOOLS — `src/system-prompt.js`

- Thêm `confirm_danh_bo` (param `day_so`).
- `ma_danh_bo` ở các tool tra cứu → **optional** (`required: []`), mô tả
  "BỎ TRỐNG nếu đã xác nhận qua confirm_danh_bo" — giảm cơ hội model tự chép
  số (nguồn sai chính).

### 4. System prompt — section "Mã danh bộ" viết lại

Quy trình mới: khách đọc số → gọi `confirm_danh_bo` → đọc nguyên văn
`doc_cho_khach` → khách xác nhận → gọi tool tra cứu KHÔNG truyền `ma_danh_bo`.
Khách báo sai / đọc dãy khác → gọi lại `confirm_danh_bo` (input mới, không
phải xác nhận).

### 5. `knownDanhBo` — `server.js`, `src/session-ws.js`

Lookup SĐT thành công → `server.js` bóc danh sách `danhBa` vào
`callOps.knownDanhBo` → `session-ws.js` seed vào `_toolCallState`. Tránh bắt
khách xác nhận 2 lần khi danh bộ do hệ thống cấp.

## Luồng sau fix (kịch bản cuộc gọi lỗi)

1. Khách đọc 11 số → model gọi `confirm_danh_bo("...")`.
2. Model nghe sai thành 12 số → code đếm 12 → `doc_cho_khach`: "em nghe được 12
   chữ số... đọc lại giúp em" (không tra, không lưu).
3. Khách đọc lại → model gọi `confirm_danh_bo` lần nữa → 11 số → lưu
   `callState`, bot đọc lại đúng dãy sẽ tra.
4. Khách "đúng rồi" → model gọi `get_payment_status` (không truyền số) → code
   tra bằng số đã lưu — model không còn cơ hội chế biến dãy số.

## Rủi ro còn lại (chấp nhận)

- `confirm_danh_bo` nhận `day_so` từ transcription của model — vẫn có thể nghe
  sai, nhưng khách **luôn nghe đúng dãy sẽ tra** để sửa.
- Model có thể gọi tool tra cứu ngay sau `confirm_danh_bo` mà không chờ khách
  xác nhận — code không phân biệt được bằng transcript (transcript chỉ để debug).
- Khách đọc dãy mới nhưng model chép y nguyên số cũ → tra số cũ; nếu sai sẽ ra
  `CUSTOMER_NOT_FOUND` → prompt đã có nhánh xử lý đọc lại.

## Test đã chạy (node, không cần backend)

- 12 số → `invalid_danh_bo`, `do_dai_hien_tai: 12` ✔
- 11 số (có khoảng trắng) → lưu state, spoken "Hai - Hai - Không..." ✔
- Lookup với 11 số MỚI khác số lưu → ép xác nhận lại, state cập nhật ✔
- Lookup với số thuộc `knownDanhBo` (kể cả có gạch ngang) → tra thẳng, `confirmed: true` ✔
- Lookup thẳng số lạ bỏ qua confirm → ép xác nhận ✔
- Lookup không có số → câu xin danh bộ (không nói "0 chữ số") ✔

## File thay đổi

| File | Thay đổi |
|---|---|
| `src/tools.js` | Thêm `handleConfirmDanhBo`, `resolveDanhBo`, `invalidDanhBoResponse`, `confirmRequestResponse`, `danhBoSpoken`; các handler tra cứu nhận `callState` |
| `src/system-prompt.js` | Tool `confirm_danh_bo`; `ma_danh_bo` optional; viết lại section "Mã danh bộ" |
| `server.js` | Bóc `knownDanhBo` từ lookup SĐT vào `callOps` |
| `src/session-ws.js` | Seed `knownDanhBo` vào `_toolCallState` |
