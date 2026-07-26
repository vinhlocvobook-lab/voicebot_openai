# Phân tích lỗi nhận diện mã danh bộ — cuộc gọi `rtc_u2_E5eDfB96UnJE6iDWfPbRX` (26/07/2026)

> **Trạng thái: BÁO CÁO — CHƯA SỬA CODE.**
> Tài liệu này phân tích nguyên nhân gốc và đề xuất hướng điều chỉnh để review trước khi động vào code.

---

## 1. Tóm tắt một dòng

Mã danh bộ đúng là **`22023251775`**. Khách đã đọc **chính xác trọn vẹn dãy này** ở phút thứ 3 (04:32:06),
transcript ghi lại **đúng 11 chữ số, không sai một số nào** — nhưng **không có dòng code nào xử lý nó**,
vì toàn bộ luồng danh bộ hiện chỉ chạy *bên trong* một tool call, mà lúc đó model không gọi tool nào.
Bot tiếp tục đọc số rác `320325175`, khách cúp máy (WS close `1006`).

---

## 2. Dựng lại diễn biến cuộc gọi

| Thời điểm | Sự kiện | Nhận xét |
|---|---|---|
| 04:29:33 | KH: *"Em xem giúp anh tiền nước tháng này là bao nhiêu vậy em?"* | Bot xin danh bộ — đúng |
| 04:29:52 | KH: *"Xin chào."* | Chưa hề đọc số nào |
| **04:29:58** | Model gọi `get_payment_status({"ma_danh_bo":"725625"})` | **Số BỊA HOÀN TOÀN.** `_danhBoTranscripts` lúc này còn `undefined` |
| 04:29:58 | KH: *"Số danh bộ là 2200"* | hơi 1 |
| 04:30:03 | KH: *"325."* | hơi 2 |
| 04:30:04 | **Bot: *"Quý Khách vừa cho em số danh bộ 725625 đúng rồi phải không ạ?"*** | Bot đọc số bịa ra loa, trong lúc tool đang treo |
| 04:30:07 | KH: *"167775."* | hơi 3 |
| 04:30:09 | Bot: *"em đã ghi lại mã 725625... đang chờ kết quả"* | Độc thoại lần 2 |
| 04:30:17 | Arbiter #1 → `null`, conf 0.2 (*"3 lượt cho tổng 13 chữ số, cần 11"*) | Arbiter từ chối — hợp lý theo prompt |
| 04:30:19 | Tool trả `invalid_danh_bo`, bot xin đọc lại | **Tool call này treo 21 giây** |
| 04:30:47 | KH: *"Hay hay, không hay."* | ASR hỏng |
| 04:30:55 | KH: *"31717575"* | hơi 4 |
| 04:31:20 | KH: *"0223251775"* (10 số) | **Chỉ thiếu đúng số `2` đầu so với đáp án** |
| 04:31:21 | Model gọi `get_payment_status({"ma_danh_bo":"320325175"})` | Lại rác |
| 04:31:36 | Arbiter #2 → `22003251775`, conf 0.78 | **Lệch ĐÚNG 1 chữ số** so với đáp án `22023251775` |
| 04:31:36 | API `/thong-tin-khach-hang` → không tồn tại → **vứt bỏ** | Không thử biến thể gần |
| 04:31:39 | Bot lại xin đọc lại 11 số | Tool call treo 18 giây |
| **04:32:06** | **KH: `22023251775` — ĐÚNG HOÀN TOÀN, đúng 11 số, 1 lượt liền** | **KHÔNG AI XỬ LÝ** |
| 04:32:08 | Bot: *"em đang nghe là dãy số 320325175..."* | Bot vẫn bám số rác của model |
| 04:32:45 | WS đóng `1006` | Khách cúp máy |

---

## 3. Sáu lỗi xếp chồng

### Lỗi #1 — CHÍ MẠNG: transcript 11 số đúng bị vứt đi

**Vị trí:** `src/session-ws.js:620-631`

```js
if (_looksLikeDigitTurn(khText)) {
  (_toolCallState._danhBoTranscripts ??= []).push({ at: Date.now(), text: khText });
  ...
  // [fix 25/07/2026] TẮT gom nền theo debounce — trọng tài gpt-5.1 giờ
  // chạy ON-DEMAND trong resolveDanhBo ...
  // _maybeAssembleDanhBo();   ← ĐÃ TẮT
}
```

Sau fix 25/07, đường xử lý nền (`_maybeAssembleDanhBo` → `proactiveAssembleDanhBo`) bị vô hiệu hoá.
Hệ quả: **`resolveDanhBo` là con đường DUY NHẤT để danh bộ được xử lý**, mà `resolveDanhBo` chỉ chạy
khi model chủ động gọi một tool tra cứu.

Nói cách khác, hệ thống đã **đem toàn bộ số phận của bước quan trọng nhất giao lại cho model mini** —
đúng thứ mà `CLAUDE.md` và memory dự án ghi rõ là không được tin
(*"model mini không tuân thủ rule prompt ổn định → fix hành vi phải deterministic"*).

Lúc 04:32:06 model không gọi tool (nó đang bận "chờ kết quả" tưởng tượng) → transcript vàng rơi vào hư không.

**Đây là lỗi duy nhất mà nếu sửa, riêng nó đã cứu được cuộc gọi này.**

---

### Lỗi #2 — `resolveDanhBo` nhận số BỊA của model làm dữ liệu đầu vào

**Vị trí:** `src/tools.js:662-678`

```js
const argModel = normalizeDanhBo(rawArg);
...
// Chưa nghe khách đọc số nào → xin số ngay (chưa cần chờ).
if ((callState._danhBoTranscripts || []).length === 0 && !argModel) {
  return { ok: false, error: invalidDanhBoResponse(0, callState) };
}

const digitsAvailable = () => {
  const txConcat = (callState._danhBoTranscripts || []).map((t) => normalizeDanhBo(t.text)).join("");
  return Math.max(txConcat.length, normalizeDanhBo(rawArg).length);   // ← dùng arg model
};
```

Điều kiện thoát sớm là `transcripts rỗng **VÀ** không có arg`. Trong cuộc gọi này transcripts rỗng
nhưng arg = `"725625"` → **không thoát**, hệ thống lao vào vòng chờ 15 giây cho một con số
mà khách **chưa bao giờ nói**.

Mâu thuẫn với chính comment ngay phía trên hàm (`tools.js:631-635`):
> *"Nguyên tắc: KHÔNG tin 'tai' model (arg `ma_danh_bo` hay sai/thiếu)"*

Nhưng `digitsAvailable()` vẫn lấy `max(..., rawArg.length)` — tức arg model vẫn đủ sức làm vòng chờ
thoát sớm và làm lệch bộ đếm.

---

### Lỗi #3 — Tool call treo 15–25 giây → model độc thoại bịa số ra loa

**Vị trí:** `src/tools.js:702-721`

```js
const DANH_BO_WAIT_MS = Number(process.env.DANH_BO_WAIT_MS || 15000);
while (digitsAvailable() < DANH_BO_LENGTH && waited < DANH_BO_WAIT_MS) { ... }   // tới 15s
const verdict = await runDanhBoArbiter(callState, { waitTranscriptMs: 0 });      // + tới 20s
```

Đo thực tế từ log: tool call #1 treo **21 giây** (04:29:58 → 04:30:19), tool call #2 treo **18 giây**.

Trong khoảng treo đó, `function_call_output` chưa về, nhưng semantic VAD **vẫn tiếp tục tạo response**.
Model không có kết quả nên nó *bịa ra tình trạng*:

- 04:30:04 — *"Quý Khách vừa cho em số danh bộ **725625** đúng rồi phải không ạ?"*
- 04:30:09 — *"em đã ghi lại mã **725625**... em vẫn đang chờ kết quả từ hệ thống"*
- 04:31:34 — *"em vẫn đang chờ kết quả kiểm tra từ hệ thống với số danh bộ **320325175**"*
- 04:32:08 — *"em đang nghe là dãy số **320325175**"*

Khách nghe bot đọc 2 con số hoàn toàn xa lạ, lặp đi lặp lại → mất phương hướng, đọc lung tung
(*"Hay hay, không hay"*), làm chất lượng transcript càng tệ. **Vòng xoáy tự khuếch đại.**

Về mặt kiến trúc: đây là việc dùng cơ chế **đồng bộ** (tool call blocking) cho một bài toán vốn
**bất đồng bộ** (chờ khách đọc hết nhiều hơi). Luồng DTMF đã làm đúng — nó dùng `_speakVerbatim`
từ code, không phụ thuộc tool call.

---

### Lỗi #4 — Trọng tài vĩnh viễn mất một "tai"

**Vị trí:** `src/tools.js:309` đọc `callState._danhBoReads`, nhưng chỗ DUY NHẤT ghi vào nó là
`src/tools.js:544-545` — nằm trong `handleConfirmDanhBo`.

Kiểm chứng: `handleConfirmDanhBo` **không còn nằm trong `dispatchTool`** (đã gỡ tool `confirm_danh_bo`
ngày 23/07, xem `tools.js:1447`). Nghĩa là **hàm này là code chết**, `_danhBoReads` **không bao giờ được ghi**.

Bằng chứng trong log — cả 2 lần gọi arbiter đều in:

```
=== BẢN NGHE CỦA MODEL THOẠI ... ===
(không có)
```

Trọng tài được thiết kế để đối chiếu **2 nguồn nghe độc lập** (`danh-bo-arbiter.js:9-13`), nhưng thực tế
chỉ còn **1 nguồn**. Trong ca này bản nghe của model (`725625`, `320325175`) là rác nên không cứu được,
nhưng ở các ca khác đây là mất mát thật.

---

### Lỗi #5 — Trọng tài chỉ được trả 1 ứng viên; sai 1 số là hỏng cả

**Vị trí:** `src/danh-bo-arbiter.js:38-64` (schema 1 field `ma_danh_bo`) + `src/tools.js:369-390`.

Lần chạy #2, gpt-5.1 trả `22003251775` với conf 0.78 — **lệch đúng 1 chữ số** so với đáp án `22023251775`
(vị trí thứ 5: `0` thay vì `2`). `candidateExistsInApi` tra API → không có → **vứt sạch, không thử gì thêm**.

Đáng chú ý: đáp án đúng gần như chắc chắn nằm trong "top-3" suy luận của model — chỉ là code
không cho nó cơ hội trả thêm ứng viên nào.

Tương tự với lượt 5 của khách: `0223251775` (10 số) chính là đáp án **rơi mất số `2` đầu**.
Một phép sinh biến thể đơn giản (thêm 1 số vào đầu, 10 khả năng) rồi verify qua API sẽ ra ngay `22023251775`.

Hiện tại `candidateExistsInApi` chỉ được dùng như **bộ lọc pass/fail**, trong khi nó hoàn toàn có thể
đóng vai **trọng tài cuối cùng** — API biết chính xác danh bộ nào tồn tại, đó là nguồn sự thật rẻ và chắc nhất.

---

### Lỗi #6 — Không bao giờ leo thang tới DTMF

Có **hai** bộ đếm leo thang, cả hai đều không chạm ngưỡng:

| Bộ đếm | Ngưỡng | Thực tế trong cuộc gọi | Lý do |
|---|---|---|---|
| `_danhBoResolveTries` (`tools.js:682-685`) | 3 | **2** | chỉ tăng trong `notEnough()`, mà nhánh đó chỉ vào 2 lần |
| `_danhBoAssembleTries` (`tools.js:606,614`) | 3 | **0** | chết theo Lỗi #1 (`_maybeAssembleDanhBo` bị tắt) |

Kết quả: cuộc gọi kéo dài **3 phút 32 giây**, trải qua 6 lượt khách đọc số, mà **chưa một lần** khách
được mời bấm phím — trong khi DTMF là lối thoát chắc chắn 100% (không qua "tai" model, xem
`docs/fix/fix_danh_bo_copilot_dtmf_20260719.md`).

Ngưỡng leo thang hiện đang tính theo **số lần code đi qua một nhánh cụ thể**, chứ không theo
**trải nghiệm thực của khách** (đã đọc bao nhiêu lần, đã tốn bao nhiêu giây).

---

## 4. Sơ đồ nguyên nhân

```
Model mini gọi tool với số BỊA (#2)
        │
        ├──► resolveDanhBo chấp nhận arg → vào vòng chờ 15s (#2,#3)
        │            │
        │            └──► tool treo 21s → model độc thoại đọc số bịa ra loa (#3)
        │                        │
        │                        └──► khách hoang mang, đọc lung tung → transcript tệ hơn
        │
        ├──► arbiter thiếu nguồn "reads" (#4) + chỉ 1 ứng viên, sai 1 số là vứt (#5)
        │
        └──► KHÔNG có đường nền nào bắt transcript (#1)
                     │
                     └──► khách đọc ĐÚNG 11 số lúc 04:32:06 → RƠI VÀO HƯ KHÔNG
                                  │
                                  └──► không leo thang DTMF (#6) → deadlock → khách cúp máy
```

---

## 5. Hướng đề xuất điều chỉnh

Xếp theo tỉ lệ **hiệu quả / rủi ro**. Nhóm A đủ để cứu cuộc gọi trong log này.

### Nhóm A — Rẻ, deterministic, không đụng kiến trúc

**A1. Bắt transcript 11 số ngay tại `session-ws.js`, không chờ model** ⭐ *ưu tiên cao nhất*

Trong `conversation.item.input_audio_transcription.completed`, ngay sau khi push vào
`_danhBoTranscripts`: nếu `normalizeDanhBo(khText).length === 11` **và** chưa có
`_toolCallState.danhBo` đang chờ/đã xác nhận **và** dãy đó chưa nằm trong `_danhBoRejected`
→ set `danhBo = { value, confirmed: false }` rồi `_speakVerbatim(...)` đọc lại xác nhận **ngay lập tức**.

- Không cần gpt-5.1, không cần model gọi tool, không tốn token, độ trễ ~0.
- Đúng tinh thần memory dự án: *fix hành vi phải deterministic trong code, không dựa vào model*.
- Đây là case "vàng" và cũng là case phổ biến nhất khi khách đọc trôi chảy.
- Rủi ro cần cân nhắc: khách đọc **số điện thoại** 11 số cũng khớp → nên chỉ kích hoạt khi
  đang ở trong ngữ cảnh xin danh bộ (đã có `_danhBoLastPrompt`, hoặc model đã hỏi xin danh bộ).

**A2. Không cho arg model khởi động luồng khi khách chưa đọc số nào**

`tools.js:670` đổi điều kiện thoát sớm từ `AND` sang chỉ xét transcript:

```js
if ((callState._danhBoTranscripts || []).length === 0) {
  return { ok: false, error: invalidDanhBoResponse(0, callState) };   // xin số NGAY, không chờ
}
```

Đồng thời bỏ `normalizeDanhBo(rawArg).length` khỏi `digitsAvailable()` (`tools.js:675-678`) —
chỉ đếm transcript. Arg model vẫn giữ lại để đưa vào `reads` cho trọng tài đối chiếu (xem B1),
nhưng **không được phép** làm căn cứ đếm/chờ/quyết định.

**A3. Leo thang theo trải nghiệm khách, không theo nhánh code**

Thêm một bộ đếm/đồng hồ duy nhất, đặt ở `session-ws.js` (nơi thấy được lượt khách thật):

- `_danhBoTurnCount` — tăng mỗi lượt transcript có vẻ đọc số;
- `_danhBoStartedAt` — mốc bắt đầu bước lấy danh bộ.

Chạm **`_danhBoTurnCount >= 3`** hoặc **quá 60 giây** mà chưa `confirmed` → gọi thẳng
`danhBoDtmfInviteResponse` qua `_speakVerbatim`. Với cuộc gọi trong log, mốc này rơi vào
~04:30:07 (lượt 3) — sớm hơn 2,5 phút so với thực tế.

---

### Nhóm B — Bỏ chặn đồng bộ, chuyển hẳn sang mô hình nền

**B1. Tool trả kết quả NGAY, việc gom số chuyển sang chạy nền**

`resolveDanhBo` khi chưa đủ số thì trả **ngay** một câu ngắn ("Dạ em đang ghi nhận, Quý Khách đọc
tiếp giúp em ạ") thay vì `await` 15–25 giây. Việc gom nhiều hơi + gọi trọng tài + đọc lại xác nhận
do đường nền lo (bật lại `_maybeAssembleDanhBo`, hoặc gộp chung với A1).

- Triệt tiêu hoàn toàn cảnh model bịa "em đang chờ kết quả" — vì không còn khoảng treo nào.
- Về đúng mô hình đã chứng minh hiệu quả ở luồng DTMF: **code chủ động nói, không nhờ model**.
- Rủi ro: cần giữ nguyên luật *"mỗi `call_id` đúng một `function_call_output`"* và tránh
  `conversation_already_has_active_response` — `_speakVerbatim` đã có sẵn cơ chế retry cho việc này.

**B2. Push arg model vào `_danhBoReads` từ `resolveDanhBo`**

Khôi phục nguồn nghe thứ 2 cho trọng tài (Lỗi #4). Kèm theo: xoá hoặc đánh dấu rõ
`handleConfirmDanhBo` là code chết để lần sau không ai hiểu nhầm là nó còn chạy.

---

### Nhóm C — Nâng cấp trọng tài (đắt hơn, cần đo lại)

**C1. Trọng tài trả TOP-3 ứng viên, để API tra cứu làm trọng tài cuối**

Đổi schema `danh-bo-arbiter.js` thành mảng `ung_vien: [{ma_danh_bo, do_tin_cay, ly_do}]` (2–5 phần tử,
xếp theo độ tin cậy giảm dần). Code lần lượt verify từng ứng viên qua `candidateExistsInApi`,
lấy ứng viên **đầu tiên tồn tại** để đọc lại xác nhận.

Với lần chạy #2 trong log, đáp án `22023251775` gần như chắc chắn nằm trong top-3 → cuộc gọi được cứu.
Chi phí: mỗi ứng viên thêm 1 lần gọi API (~40ms theo log) — không đáng kể.

**C2. Sinh biến thể gần khi ứng viên NOT_FOUND**

Khi ứng viên đủ tin cậy nhưng API báo không tồn tại, thử một tập biến thể nhỏ có kiểm soát:

- dãy 10 số → thêm 1 chữ số vào **đầu** (10 khả năng) — bắt đúng case `0223251775` → `22023251775`;
- dãy 11 số → sửa 1 chữ số tại các vị trí model đánh dấu kém chắc chắn.

Verify từng biến thể qua API, chỉ nhận khi **đúng một** biến thể tồn tại (nhiều hơn một → mơ hồ, bỏ).
Cần **chặn số lần gọi API** (ví dụ tối đa 15 lượt/cuộc gọi) để không tạo tải bất thường lên backend.

**C3. Nới ràng buộc "đúng 11 số" trong prompt trọng tài**

Prompt hiện tại nói *"KHÔNG bịa: nếu dữ liệu không đủ để tự tin ghép ra 11 số, trả do_tin_cay thấp"*.
Lần chạy #1 model từ chối rất hợp lý (3 lượt = 13 số ≠ 11). Nhưng nếu cho phép nó **trả nhiều
phương án ghép** kèm độ tin cậy thấp (thay vì `null`), thì kết hợp với C1 vẫn có cơ hội trúng —
API sẽ lọc giúp. Nói cách khác: **giảm gánh nặng quyết định cho LLM, đẩy về cho API.**

---

## 6. Nguyên tắc rút ra (nên ghi vào `CLAUDE.md`)

1. **Mọi đường xử lý danh bộ phải có lối đi không phụ thuộc model gọi tool.**
   Fix 25/07 tắt đường nền để "tránh lệch pha" đã vô tình biến model mini thành điểm lỗi đơn (single
   point of failure) cho bước quan trọng nhất của cuộc gọi.

2. **Không để tool call treo quá ~2 giây trong cuộc gọi thoại.**
   Semantic VAD vẫn sinh response trong lúc treo, và model **luôn** lấp khoảng trống bằng nội dung bịa.
   Việc chờ phải nằm ở đường nền, không nằm trong `function_call_output`.

3. **API tra cứu là trọng tài rẻ nhất và chắc nhất — dùng nó nhiều hơn.**
   Đừng bắt LLM chọn duy nhất một đáp án khi có thể cho nó đề xuất vài phương án rồi để API phân xử.

4. **Ngưỡng leo thang phải tính theo trải nghiệm khách** (số lượt đã đọc, số giây đã trôi qua),
   không theo số lần code chạy qua một nhánh nội bộ.

---

## 7. Đề xuất thứ tự triển khai

| Bước | Nội dung | Rủi ro | Kỳ vọng |
|---|---|---|---|
| 1 | A1 + A2 | Thấp | Cứu được ca trong log; bắt trọn case khách đọc trôi chảy |
| 2 | A3 | Thấp | Không còn cuộc gọi >3 phút mắc kẹt ở bước danh bộ |
| 3 | B2 | Thấp | Trọng tài có lại đủ 2 nguồn nghe |
| 4 | C1 | Trung bình | Tăng tỉ lệ chốt số khi khách đọc tách nhiều hơi |
| 5 | B1 | Trung bình–cao | Dứt điểm hiện tượng model bịa; cần test hồi quy kỹ |
| 6 | C2 | Trung bình | Bắt các ca ASR rơi/sai 1 chữ số |

Nên chạy lại bộ kịch bản trong `test_case/` sau mỗi bước, đặc biệt các ca đã fix trước đây:
`fix_danh_bo_trong_tai_20260719`, `fix_danh_bo_copilot_dtmf_20260719`,
`fix_confirm_danh_bo_20260718` — để chắc chắn không làm hồi quy.

---

## 8. Tham chiếu vị trí code

| Lỗi | File | Dòng |
|---|---|---|
| #1 đường nền bị tắt | `src/session-ws.js` | 620–631 (dòng 630 đã comment) |
| #1 hàm nền còn nguyên | `src/session-ws.js` | 192–217 |
| #2 điều kiện thoát sớm | `src/tools.js` | 670–672 |
| #2 `digitsAvailable` dùng arg model | `src/tools.js` | 675–678 |
| #3 vòng chờ 15s | `src/tools.js` | 702–715 |
| #3 gọi trọng tài đồng bộ | `src/tools.js` | 717–725 |
| #4 đọc `_danhBoReads` | `src/tools.js` | 309 |
| #4 ghi `_danhBoReads` (code chết) | `src/tools.js` | 544–545 (trong `handleConfirmDanhBo`, không có trong `dispatchTool`) |
| #5 schema 1 ứng viên | `src/danh-bo-arbiter.js` | 38–64 |
| #5 lọc ứng viên | `src/tools.js` | 344–390 |
| #6 bộ đếm leo thang | `src/tools.js` | 606, 614, 682–685 |
