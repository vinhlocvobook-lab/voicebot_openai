# Kế hoạch v3 — Cải tiến nhận diện mã danh bộ (bản thực hiện)

> **Trạng thái: KẾ HOẠCH ĐÃ CHỐT — CHƯA SỬA CODE.**
> Cập nhật từ [v2](ke_hoach_v2_danh_bo_20260726.md) theo 3 phản hồi của anh (26/07/2026):
> **(1)** giữ `ma_danh_bo` là `required` — chốt, không bàn thêm;
> **(2)** transcript đơn ra đúng 11 số **vẫn phải qua gpt-5.1**;
> **(3)** chọn **mức B** — bỏ chặn đồng bộ, trọng tài chạy nền.
>
> Tài liệu nền: [`phan_tich_loi_danh_bo_20260726.md`](phan_tich_loi_danh_bo_20260726.md) (phân tích cuộc gọi
> `rtc_u2_E5eDfB96UnJE6iDWfPbRX`), [`ke_hoach_cai_tien_danh_bo_20260726.md`](ke_hoach_cai_tien_danh_bo_20260726.md).

---

## 1. Các quyết định đã chốt

| # | Quyết định | Trạng thái |
|---|---|---|
| 1 | Giữ `ma_danh_bo` là `required` trong 5 tool tra cứu | ✅ Chốt — §1.1 |
| 2 | Phát hiện model bịa số ở tham số tool, bịa thì bỏ qua | ✅ Chốt — §4 |
| 3 | Nới VAD cho giai đoạn đọc số | ✅ Chốt — §5 |
| 4 + 9 | Hai biến tích luỹ tách vai trò | ✅ Chốt — §2 |
| 5 | Tra danh bộ theo SĐT từ DB | ⏸ Hoãn — §8.1 |
| 6 | Ràng buộc cấu trúc mã danh bộ | ⏸ Hoãn — §8.2 |
| 7 | Xác nhận bằng tên khách hàng | ⏸ Hoãn — §8.3 |
| 8 | Graceful shutdown SIGINT/SIGTERM | ✅ Chốt — §6 |
| — | Xử lý tool call treo 15–25 giây | ✅ Chốt **mức B** — §3 |

### 1.1. Giữ `required` — nguyên tắc bắt buộc đi kèm

`ma_danh_bo` **giữ nguyên `required`** trong cả 5 tool tra cứu (`system-prompt.js:221, 239, 256, 270, 282`).

Lợi ích: khôi phục **nguồn nghe thứ hai** cho trọng tài. Báo cáo trước đã chỉ ra `_danhBoReads` chết từ
23/07 (chỉ được ghi trong `handleConfirmDanhBo` — hàm đã bị gỡ khỏi `dispatchTool`), nên prompt gpt-5.1
luôn in *"BẢN NGHE CỦA MODEL THOẠI: (không có)"*. Kiến trúc thiết kế 2 "tai" mà thực tế chỉ còn 1.
Giữ `ma_danh_bo` là lấy lại tai thứ hai.

Đánh đổi: structured output đảm bảo trường `required` luôn có giá trị, nên khi chưa nghe được gì model
**buộc phải điền một con số** — đó là cách `725625` ra đời trong cuộc gọi mẫu. Đánh đổi này được xử lý
bằng cơ chế phát hiện ở §4.

> ### ⚠️ Nguyên tắc xuyên suốt toàn kế hoạch
>
> `ma_danh_bo` do model truyền vào **CHỈ ĐƯỢC** dùng làm quan sát cho trọng tài (`_danhBoReads`).
>
> **TUYỆT ĐỐI KHÔNG** dùng để: tra cứu trực tiếp · đếm số chữ số đã có · quyết định đủ/thiếu ·
> ghi vào `callState.danhBo`.

---

## 2. Phần lõi — Hai biến tích luỹ

Sửa cùng lúc 3 lỗi đã nêu trong báo cáo: ghép mù làm hỏng đầu vào trọng tài, vòng chờ chết lâm sàng,
và thông báo sai độ dài cho khách.

### 2.1. Định nghĩa

**Biến 1 — `_danhBoTranscripts`** (giữ nguyên tên, đã có sẵn)

- **Phạm vi:** toàn bộ cuộc gọi.
- **Vai trò:** kho quan sát cấp cho gpt-5.1. Càng nhiều dữ liệu, trọng tài càng dễ đối chiếu chéo.
- **Không bao giờ** dùng để đếm đủ/thiếu.
- Nâng giới hạn 10 → **20 phần tử** (`session-ws.js:624`).

**Biến 2 — `_danhBoSession`** (mới)

```js
_danhBoSession = {
  requestNo: 1,          // lượt yêu cầu thứ mấy — dùng để leo thang DTMF
  startedAt: 1785015019, // mốc code phát câu "đọc lại toàn bộ 11 số"
  turns: [],             // các lượt transcript SAU mốc này
  digits: "",            // chuỗi chữ số ghép từ turns — CHỈ dùng cho biến này
}
```

- **Phạm vi:** một lượt yêu cầu khách đọc.
- **Reset + `requestNo++`** mỗi khi code phát câu mời khách đọc **toàn bộ** mã danh bộ
  (`invalidDanhBoResponse`, `reReadRequestResponse`, và câu xin số lần đầu).
- **Vai trò duy nhất:** xác định lượt đọc hiện tại đã đủ / chưa đủ / vượt 11 số.

Mỗi lượt yêu cầu là yêu cầu khách đọc **trọn vẹn** mã danh bộ, không phải đọc tiếp phần còn thiếu —
nhờ vậy `digits` của một phiên có ý nghĩa rõ ràng và so được với 11.

### 2.2. Luật xử lý theo độ dài `_danhBoSession.digits`

| Tình huống | Xử lý |
|---|---|
| **Một lượt transcript ĐƠN ra đúng 11 số** | **Vào luồng xác minh §2.3** — không chốt thẳng |
| `digits.length < 11` | Chờ tiếp. Tool trả ngay `dang_gom_so: true` (§3) |
| `digits.length == 11` (ghép nhiều hơi) | Luồng xác minh §2.3 |
| `digits.length > 11` | **KHÔNG báo "chưa có mã danh bộ"**. Gọi trọng tài với phiên này ưu tiên cao; không ra thì reset phiên + mời đọc lại |
| Hết hạn gom mà `< 11` | Trọng tài lần chót; không ra thì reset phiên + mời đọc lại |

Sửa dòng cuối `resolveDanhBo` (`tools.js:738`) — chỗ đang truyền `0` làm khách nghe *"chưa có mã danh bộ"*
trong khi hệ thống đã nghe 31 chữ số:

```js
// TRƯỚC (sai):
return notEnough(digitsAvailable() >= DANH_BO_LENGTH ? 0 : digitsAvailable());
// SAU: dùng độ dài THẬT của phiên hiện tại, phân biệt rõ 3 trạng thái
return notEnough(_danhBoSession.digits.length);   // 0 / <11 / >11 → 3 câu thoại khác nhau
```

### 2.3. ⭐ Luồng xác minh — transcript 11 số VẪN qua gpt-5.1

Theo phản hồi của anh: **không chốt thẳng transcript, kể cả khi nó ra đúng 11 số.** Lý do chính đáng —
gpt-4o-transcribe cũng có thể nghe sai mà vẫn cho ra đúng 11 chữ số, và khi đó con số trông "sạch"
nhưng lại sai, rất khó phát hiện.

Thiết kế: chạy **song song hai kênh xác minh**, không nối tiếp.

```
Transcript ra 11 số
        │
        ├──► (a) Verify API  getThongTinKhachHang(số)      ~40ms
        │
        ├──► (b) Trọng tài gpt-5.1 (nền)                   ~6-15s
        │          input: LẦN ĐỌC MỚI NHẤT (ưu tiên) + toàn bộ lịch sử
        │
        └──► (c) Code nói NGAY một câu ngắn lấp khoảng lặng:
                 "Dạ, em ghi nhận rồi ạ, Quý Khách chờ em một chút."
```

Chờ kênh (b) tối đa `DANH_BO_ARBITER_FAST_WAIT_MS = 6000`, rồi quyết định:

| Verify API | Kết quả trọng tài | Hành động |
|---|---|---|
| Tồn tại | **cùng số** với transcript | Đọc lại xác nhận số đó — tin cậy cao nhất |
| Tồn tại | khác số / `null` / hết hạn chờ | Đọc lại xác nhận **số transcript** (transcript > suy luận, lại có API bảo chứng) |
| Không tồn tại | ra số khác, **verify API OK** | Đọc lại xác nhận **số của trọng tài** |
| Không tồn tại | `null` / số cũng không tồn tại | Reset phiên, mời khách đọc lại (`requestNo++`) |
| API lỗi/timeout | bất kỳ | Coi như "tồn tại" — giữ quy ước sẵn có ở `candidateExistsInApi` (`tools.js:344-359`) |

Đặc điểm quan trọng: **khách không phải chờ trong im lặng**. Câu (c) do code phát ngay khi phát hiện đủ
11 số, nên khoảng 6 giây chờ trọng tài được lấp tự nhiên. Đây là chỗ mức B (§3) phát huy tác dụng —
model không còn bị bỏ đói nên không có cớ để bịa.

Áp vào cuộc gọi mẫu: lúc 04:32:06 khách đọc `22023251775`; phiên mới chỉ chứa đúng lượt này;
API xác nhận tồn tại; trọng tài nhận *"LẦN ĐỌC MỚI NHẤT: 22023251775"* nên trả cùng số →
**bot đọc lại xác nhận sau ~8 giây thay vì bế tắc rồi mất khách.**

> ⚠️ **Guard bắt buộc cho luồng này:** số điện thoại VN cũng 10–11 chữ số. Chỉ kích hoạt khi đang thật
> sự ở bước thu danh bộ (đã có `_danhBoLastPrompt`, hoặc bot vừa hỏi xin mã danh bộ).

### 2.4. Cấp dữ liệu cho trọng tài theo hai tầng

Đây là chỗ hai biến phát huy giá trị lớn nhất. Prompt gpt-5.1 (`danh-bo-arbiter.js:70-105`) tách rõ:

```
=== LẦN ĐỌC MỚI NHẤT (khách vừa được yêu cầu đọc TRỌN VẸN mã — ƯU TIÊN CAO NHẤT) ===
Lượt 1: "22023251775"

=== CÁC LẦN ĐỌC TRƯỚC ĐÓ (tham khảo để đối chiếu chéo, có thể lẫn nhiễu) ===
Lượt 1: "Số danh bộ là 2200"
Lượt 2: "325."
...
```

Thêm hướng dẫn: *"Nếu LẦN ĐỌC MỚI NHẤT tự nó đã ra đúng 11 số thì lấy luôn, các lần đọc trước chỉ để
đối chiếu."*

Hiện tại trọng tài nhận một đống 31 chữ số trộn lẫn 5 lượt rác rồi từ chối — **nó từ chối rất đúng đắn,
dữ liệu vào mới là thứ sai.**

### 2.5. Leo thang bằng `requestNo`

`_danhBoSession.requestNo` là bộ đếm leo thang **duy nhất và đáng tin** — nó đếm đúng thứ khách cảm nhận
được: *"tôi đã phải đọc lại bao nhiêu lần rồi"*.

- `requestNo >= 3` → **mời bấm phím DTMF**.
- Đã mời DTMF mà vẫn quay lại đọc → `danhBoEscalationResponse` (chuyển máy / tạo phiếu).
- **Watchdog 90 giây** kể từ lúc bắt đầu xin danh bộ mà chưa `confirmed` → mời DTMF ngay, bất kể `requestNo`.

Cuộc gọi mẫu kéo dài **3 phút 32 giây** qua 6 lượt đọc mà **chưa một lần** khách được mời bấm phím —
vì cả hai bộ đếm cũ (`_danhBoResolveTries`, `_danhBoAssembleTries`) đếm theo nhánh code nội bộ chứ không
theo trải nghiệm khách. `requestNo` thay thế cả hai.

### 2.6. Dọn các chỗ liên quan

- Bỏ `normalizeDanhBo(rawArg).length` khỏi `digitsAvailable()` (`tools.js:675-678`) — theo nguyên tắc §1.1.
- Đồng bộ `entrySig` (dòng 692) với `_danhBoLastResolveSig` (dòng 718) — hiện lệch nhau nên cache chống
  gọi trùng hay trượt, gọi gpt-5.1 dư.
- Xoá code chết `handleConfirmDanhBo` (`tools.js:482-589`).

---

## 3. Mức B — Bỏ chặn đồng bộ, trọng tài chạy nền

### 3.1. Vấn đề đang sửa

Đo từ log: tool call #1 treo **21 giây**, #2 treo **18 giây** — do `DANH_BO_WAIT_MS = 15000`
(`tools.js:702`) cộng trọng tài gpt-5.1 chạy đồng bộ (tới 20 giây).

Trong khoảng treo đó `function_call_output` chưa về, nhưng VAD **vẫn tiếp tục tạo response**. Model không
có kết quả nên nó *bịa ra tình trạng*:

> *"Quý Khách vừa cho em số danh bộ **725625** đúng rồi phải không ạ?"* (04:30:04)
> *"em đã ghi lại mã **725625**"* (04:30:09)
> *"em vẫn đang chờ kết quả... với số danh bộ **320325175**"* (04:31:34)

Khách nghe hai con số xa lạ lặp đi lặp lại → mất phương hướng → đọc lung tung (*"Hay hay, không hay"*)
→ transcript càng tệ. **Vòng xoáy tự khuếch đại.**

### 3.2. Thiết kế mức B

**Gỡ bỏ hoàn toàn vòng chờ đồng bộ** trong `resolveDanhBo` (`tools.js:702-715`). Hằng số
`DANH_BO_WAIT_MS` trở thành vô nghĩa — xoá luôn, không cần hạ xuống 4 giây như phương án A.

**Tool trả kết quả NGAY** (mục tiêu ≤ 2 giây) khi chưa đủ số:

```json
{
  "success": false,
  "dang_gom_so": true,
  "da_nghe": 7,
  "can": 11,
  "doc_cho_khach": "Dạ, em đang nghe ạ, Quý Khách đọc tiếp giúp em.",
  "message": "Hệ thống ĐANG GOM số, chưa đủ 11. Đọc NGUYÊN VĂN doc_cho_khach rồi DỪNG. TUYỆT ĐỐI không đọc lại bất kỳ chữ số nào, không đoán số, không nói 'đang chờ hệ thống'."
}
```

**Trọng tài chuyển sang chạy nền.** Tái dùng hạ tầng đã có sẵn, không viết mới:

| Hàm có sẵn | Vai trò trong mức B |
|---|---|
| `fireBackgroundArbiter` (`tools.js:329`) | Bắn trọng tài fire-and-forget |
| `awaitBackgroundVerdict` (`tools.js:337`) | Lấy verdict, chờ thêm tối đa N ms |
| `proactiveAssembleDanhBo` (`tools.js:603`) | Chạy trọng tài rồi trả **câu đọc lại** cho session-ws phát |
| `_maybeAssembleDanhBo` (`session-ws.js:192`) | Đường nền đã bị comment ở dòng 630 — **bật lại** |
| `_speakVerbatim` (`session-ws.js:157`) | Code tự phát lời, có sẵn retry khi `_responseActive` |

**Code làm chủ lời đọc lại xác nhận** — không nhờ model, giống hệt luồng DTMF đã chứng minh hiệu quả.

### 3.3. Các guard bắt buộc

| Guard | Lý do |
|---|---|
| `if (callState.danhBo) return null` trước khi phát verdict nền | Khách đã chốt số bằng đường khác (DTMF / lượt đọc mới) trong lúc trọng tài chạy → verdict cũ phải bị bỏ |
| `_danhBoAssembleRunning` + `_DANHBO_ASSEMBLE_MIN_GAP_MS` (đã có) | Chống chạy nhiều trọng tài song song, chống spam gpt-5.1 |
| Verdict về sau khi `requestNo` đã tăng | Verdict thuộc phiên cũ → bỏ, không phát |
| Mỗi `call_id` đúng **một** `function_call_output` | Quy ước cốt lõi trong `CLAUDE.md` — mức B không được phá |
| `_speakVerbatim` retry khi `_responseActive` | Tránh `conversation_already_has_active_response` |

### 3.4. Kỳ vọng sau mức B

- Không `function_call_output` nào chậm hơn **2 giây**.
- Model luôn có nội dung để bám → `bot_hallucinated_digits` về **0**.
- Trọng tài chạy nền nên có thể nâng `ARBITER_REASONING_EFFORT` từ `low` → `medium` (đo lại độ trễ
  trước/sau; log hiện cho thấy 518 và 1038 reasoning token, tương ứng 8s và 15s).

---

## 4. Phát hiện model bịa số

### 4.1. Thuật toán phân loại

Đầu vào: `arg = normalizeDanhBo(ma_danh_bo)` và `_danhBoSession.digits` (chuỗi số của **phiên hiện tại**).

| Luật | Điều kiện | Kết luận |
|---|---|---|
| **R1** | `_danhBoSession.digits` rỗng (khách chưa đọc số nào trong phiên này) | **BỊA** |
| **R2** | `arg` là substring của `session.digits` | **Nghe đúng** |
| **R3** | Levenshtein nhỏ nhất giữa `arg` và mọi cửa sổ độ dài `\|arg\|`, `\|arg\|±1` trong `session.digits` ≤ `max(1, floor(\|arg\| * 0.2))` | **Nghe lệch** — chấp nhận làm quan sát |
| **R4** | còn lại | **BỊA** |

Kiểm chứng trên cuộc gọi mẫu:

- `725625` — phiên rỗng hoàn toàn → **R1 → BỊA** ✓
- `320325175` (9 số) — không phải substring; khoảng cách tới mọi cửa sổ đều ≥ 3, ngưỡng
  `floor(9*0.2)=1` → **R4 → BỊA** ✓

> Ngưỡng 0.2 là điểm khởi đầu, cần chỉnh lại bằng dữ liệu thật sau vài ngày chạy.

### 4.2. Xử lý khi phát hiện

Khi kết luận **BỊA**:

1. **Bỏ hoàn toàn `arg`** — không tra cứu, không ghi vào `_danhBoReads`, không đếm vào bất kỳ biến nào,
   không lưu vào `callState.danhBo`. Xử lý tiếp y như model không truyền gì.
2. Ghi event `danh_bo_arg_hallucinated` kèm giá trị + lý do (R1/R4).
3. Tăng `callState._hallucinationCount`.
4. `_hallucinationCount >= 2` → **nhảy thẳng sang mời DTMF**.

Khi kết luận **Nghe đúng / Nghe lệch**: đẩy vào `_danhBoReads` cho trọng tài đối chiếu — **vẫn không
dùng để tra cứu**.

### 4.3. Vì sao thuật toán không cần quá chính xác

Vì `arg` **không bao giờ được dùng để tra cứu** (§1.1), hậu quả phân loại sai rất nhẹ:

- **Nhận nhầm số bịa thành quan sát thật** → thêm một dòng nhiễu vào prompt trọng tài, mà prompt đã dán
  nhãn sẵn *"BẢN NGHE CỦA MODEL THOẠI (kém tin cậy hơn, hay rơi mất số đầu, chép sai số)"*.
- **Loại nhầm số nghe đúng** → mất một quan sát; transcript vẫn là trục chính.

Giá trị thật nằm ở **(a) giữ sạch đầu vào trọng tài** và **(b) đếm để leo thang + đo lường**.

### 4.4. Lớp bổ sung — phát hiện bot NÓI số lạ ra loa

§4.1–4.2 chặn số bịa ở **tham số tool**, nhưng không ngăn bot **đọc số bịa ra loa** — thứ trực tiếp làm
khách hoang mang trong cuộc gọi mẫu. Mức B (§3) đã xử lý phần lớn nguyên nhân, lớp này là lưới an toàn.

Tại `conversation.item.done` (`session-ws.js:708-720`):

- Bóc mọi cụm ≥ 4 chữ số trong lời bot (cả dạng chữ số lẫn dạng chữ *"hai hai không..."*).
- Đối chiếu **tập được phép nói** = `{callState.danhBo?.value}` ∪ các số có trong `_danhBoLastPrompt`.
- Lệch → ghi event `bot_hallucinated_digits`, tăng `_hallucinationCount` (dùng chung §4.2).

Xử lý:

1. **KHÔNG cancel response đang chạy.** Repo đã trả giá 2 lần (bot câm 24s tại
   `fix_echo_cancel_nham_response_20260718`, 28s tại cuộc `E2ou4DurIiPbGRvrrggKr`). Số đã phát ra loa
   rồi, cancel không rút lại được mà còn sinh lỗi mới.
2. **Nói đè bằng câu đúng** — tái dùng `_reAssertDanhBoStep()` (`session-ws.js:126`).
3. Đếm chung để leo thang DTMF.

---

## 5. Nới VAD cho giai đoạn đọc số

### 5.1. Vì sao

`semantic_vad` quyết định "khách nói xong chưa" theo **ngữ nghĩa**. Khi khách đọc số tách nhiều hơi
(*"hai hai không hai..."* — ngừng — *"ba hai năm..."*), mỗi hơi trông như một lượt hoàn chỉnh → OpenAI
chốt lượt sớm và tạo response ngay. Đó là lý do log có **6 lượt transcript rời rạc** cho cùng một mã.

`server_vad` với ngưỡng im lặng dài thì dễ đoán hơn hẳn cho việc đọc số, và rủi ro thấp hơn nhiều so với
phương án khoá `create_response`.

### 5.2. Cấu hình

**Khi vào giai đoạn thu danh bộ** — `session.update`:

```js
audio: { input: { turn_detection: {
  type: "server_vad",
  threshold: 0.6,            // giữ giá trị đã hiệu chỉnh ở fix 08/07
  prefix_padding_ms: 500,    // không mất các chữ số đầu
  silence_duration_ms: 2000, // ← điểm mấu chốt: cho khách ngừng giữa các hơi
  create_response: true,
  interrupt_response: true
} } }
```

**Khi chốt xong** — trả về `semantic_vad`, `eagerness: "low"`, `create_response: true`, `interrupt_response: true`.

### 5.3. Điểm vào / điểm ra

| Sự kiện | Hành động |
|---|---|
| Code phát câu xin / mời đọc lại mã danh bộ | Chuyển sang `server_vad` (nếu chưa) |
| `danhBo.confirmed === true` | Trả về `semantic_vad` |
| Mời DTMF / escalation / `end_call` / `transfer_to_agent` | Trả về `semantic_vad` |
| **Watchdog 90 giây** kể từ lúc chuyển | Tự trả về `semantic_vad` |

> ⚠️ Phải trả về `semantic_vad` ở **mọi** nhánh thoát, kể cả nhánh lỗi. Watchdog là lưới an toàn cuối
> cùng, không phải cơ chế chính.

### 5.4. Cần đo sau khi triển khai

- `silence_duration_ms: 2000` làm phản hồi trong giai đoạn đó chậm thêm ~2 giây. Khách thấy bot "đơ" thì
  hạ về 1500ms.
- Theo dõi `vad_speech_started` so với lượt khách nói thật — `server_vad` nhạy nhiễu SIP hơn, có thể làm
  phantom turn quay lại (vấn đề đã gặp ở fix 08/07 đợt 3). Phantom turn tăng → nâng `threshold` lên 0.7.

---

## 6. Graceful shutdown

**Vấn đề:** `conversation_summary/2026/07/26/` có file cuối lúc **04:28**. Cuộc gọi lỗi diễn ra
**04:29–04:32** → **không có file nào**. Cuối log thấy shell prompt trở lại → tiến trình node thoát
trước khi `_saveOnce()` (async, trong `ws.on("close")`) kịp ghi xong.

**Cuộc gọi lỗi nặng nhất lại là cuộc không có log để phân tích.** Làm trước, nếu không các vòng sau vẫn
sửa mù.

Thiết kế:

1. **Registry logger đang mở** — `openSessionWebSocket` đăng ký logger vào một `Set` ở module cấp cao,
   gỡ ra khi `_saveOnce` xong.
2. **Handler `SIGINT` / `SIGTERM`** — chặn thoát mặc định, log số logger đang chờ,
   `await Promise.allSettled` toàn bộ `_saveOnce` với **timeout 5 giây**, rồi `process.exit(0)`.
3. **Ctrl+C lần 2 → thoát ngay** (tránh treo terminal).
4. Gọi cùng đường flush đó trong handler `uncaughtException` hiện có ở `server.js`.
5. `closeDb()` (`db.js:61`) **sau khi** flush xong.

---

## 7. Kế hoạch triển khai

### Bước 0 — Nền tảng (nửa ngày)

| # | Việc | File |
|---|---|---|
| 0.1 | Graceful shutdown SIGINT/SIGTERM + flush logger (§6) | `server.js`, `session-ws.js` |
| 0.2 | Dọn `console.log` của `normalizeDanhBo` — log mẫu có **hơn 40 khối**, che hết dòng quan trọng | `tools.js` |
| 0.3 | Thêm trường đo: `danh_bo_resolved_by`, `danh_bo_request_count`, `danh_bo_seconds`, `hallucination_count` | `conversation-logger.js` |

> 0.3 nhẹ nhưng nên có: không có số nền thì không biết các bước sau là cải thiện hay hồi quy.

### Bước 1 — Lõi: hai biến tích luỹ + mức B (2,5 ngày) ⭐

Gộp chung vì cả hai đều sửa cùng một hàm `resolveDanhBo`, tách ra sẽ phải sửa hai lần.

| # | Việc | File |
|---|---|---|
| 1.1 | Thêm `_danhBoSession`, reset + `requestNo++` tại mọi chỗ phát câu mời đọc lại | `session-ws.js`, `tools.js` |
| 1.2 | Chuyển mọi phép đếm đủ/thiếu sang `_danhBoSession.digits`; bỏ `rawArg` khỏi `digitsAvailable()` | `tools.js:675-678` |
| 1.3 | **Gỡ vòng chờ đồng bộ**, xoá `DANH_BO_WAIT_MS`; tool trả ngay `dang_gom_so` (§3.2) | `tools.js:702-725` |
| 1.4 | Bật lại đường nền `_maybeAssembleDanhBo`; trọng tài chạy nền qua `fireBackgroundArbiter` | `session-ws.js:630` |
| 1.5 | **Luồng xác minh 11 số song song API + gpt-5.1** (§2.3), kèm câu lấp khoảng lặng | `session-ws.js`, `tools.js` |
| 1.6 | Sửa `notEnough` — phân biệt 3 trạng thái `0` / `<11` / `>11` | `tools.js:681-689, 738` |
| 1.7 | Prompt trọng tài tách 2 tầng "LẦN ĐỌC MỚI NHẤT" / "CÁC LẦN TRƯỚC" | `danh-bo-arbiter.js` |
| 1.8 | Leo thang `requestNo >= 3` + watchdog 90 giây → DTMF | `session-ws.js`, `tools.js` |
| 1.9 | Áp đủ 5 guard ở §3.3 | `tools.js`, `session-ws.js` |
| 1.10 | Cap `_danhBoTranscripts` 10 → 20; đồng bộ `entrySig`; xoá `handleConfirmDanhBo` | `session-ws.js`, `tools.js` |

### Bước 2 — Phát hiện bịa số (1 ngày)

| # | Việc | File |
|---|---|---|
| 2.1 | Hàm `classifyModelArg(arg, session)` theo R1–R4 + unit test bằng chính dữ liệu cuộc gọi mẫu | `tools.js` (mới) |
| 2.2 | Nối vào `resolveDanhBo`: BỊA → bỏ hẳn; còn lại → đẩy vào `_danhBoReads` | `tools.js:636-739` |
| 2.3 | `_hallucinationCount`, ≥2 → DTMF | `tools.js` |
| 2.4 | Phát hiện bot **nói** số lạ ra loa + `_reAssertDanhBoStep` (§4.4) | `session-ws.js:708-720` |

### Bước 3 — Nới VAD (1 ngày)

| # | Việc | File |
|---|---|---|
| 3.1 | Hàm `setVadMode('digits' \| 'normal')` gửi `session.update` | `session-ws.js` |
| 3.2 | Gắn điểm vào / điểm ra + watchdog 90 giây (§5.3) | `session-ws.js` |
| 3.3 | Đo `vad_speech_started` vs lượt khách thật trước/sau; phantom turn tăng thì nâng `threshold` 0.6 → 0.7 | — |

### Bước 4 — Tinh chỉnh (nửa ngày)

| # | Việc |
|---|---|
| 4.1 | Nâng `ARBITER_REASONING_EFFORT` `low` → `medium`, đo lại độ trễ (chỉ sau khi Bước 1 chạy ổn) |
| 4.2 | Chỉnh ngưỡng 0.2 của R3 theo dữ liệu thật |
| 4.3 | Chỉnh `silence_duration_ms` theo phản hồi thực tế |

---

## 8. Hoãn lại

### 8.1. Lịch sử danh bộ theo SĐT từ DB

`db/schema.sql:97` đã có sẵn `voicebot_calllog(customer_tel, ma_danh_bo)` với **index cả hai cột** —
chỉ cần một truy vấn, không phải sửa schema.

Số liệu để cân nhắc khi quay lại: SĐT `0967777637` đã xác nhận thành công `22023251775` **150 lần**
trong `conversation_summary/`, trong khi backend `getThongTinKhachHang(null, tel)` trả rỗng cho số này.
Với khách quen — phần lớn khách tổng đài CSKH — đây có thể là tín hiệu mạnh nhất trong toàn hệ thống.

Khi làm, tách `historyDanhBo` (gợi ý, vẫn phải đọc lại xác nhận) khỏi `knownDanhBo` (hệ thống cấp,
tin ngay) — khách hoàn toàn có thể gọi hỏi giùm danh bộ khác.

### 8.2. Ràng buộc cấu trúc mã danh bộ

8 mã ground truth (trường `danhBa` do API trả về): tiền tố 2 số chỉ thuộc `{15, 22}`, chữ số thứ 3 luôn
`0` hoặc `1`. Mẫu quá nhỏ để kết luận, nhưng đủ để thấy mã **có cấu trúc**.

Việc rẻ nhất nên làm sớm dù hoãn phần code: **hỏi CNTA bảng quy tắc đánh mã danh bộ**. Nếu có
**check digit**, ta loại được phần lớn ứng viên sai **offline, tức thì, chính xác tuyệt đối** — khi đó
gần như mọi thứ khác trong tài liệu này trở thành phụ. Nên gửi ngay vì phải chờ phía khách hàng.

### 8.3. Xác nhận bằng tên khách hàng

Ý tưởng này **không cần tra cứu theo tên**. API `getThongTinKhachHang` đã trả sẵn `{ danhBa, hoTen }`
trong cùng lời gọi kiểm tra danh bộ — ta chỉ **đọc tên ra** cho khách xác nhận thay vì đọc 11 chữ số.

Trở ngại thật nằm ở chỗ khác: **tên không dấu sẽ bị TTS đọc sai thanh điệu**, khách nghe không ra.
Nếu sau này DB có tên đủ dấu, hoặc thêm bước khôi phục dấu, thì rất đáng làm — đọc tên mất ~2 giây so
với ~10 giây đọc 11 chữ số, và khách nghe tên mình thì biết đúng/sai ngay, còn nghe 11 chữ số thì rất
dễ gật cho xong. Ngoài ra cần CNTA duyệt về quyền riêng tư.

---

## 9. Tiêu chí nghiệm thu

| Bước | Tiêu chí |
|---|---|
| 0 | Ctrl+C giữa cuộc gọi → file `conversation_summary` vẫn được ghi đầy đủ |
| 1 | Dựng lại kịch bản cuộc gọi mẫu (3 hơi rời + 1 lần đọc liền 11 số) → chốt đúng `22023251775` trong **≤ 60 giây**; khách không bao giờ nghe câu *"chưa có mã danh bộ"* khi đã đọc số |
| 1 | Không `function_call_output` nào chậm hơn **2 giây** |
| 1 | Transcript ra 11 số nhưng **sai** (API không tìm thấy) → hệ thống không chốt bừa, phải hỏi lại hoặc dùng ứng viên trọng tài |
| 2 | `arg = 725625` với phiên rỗng → phân loại BỊA, **không** xuất hiện trong `_danhBoReads`, **không** ảnh hưởng phép đếm |
| 2 | `bot_hallucinated_digits = 0` trên toàn bộ tập test |
| 3 | Khách đọc tách 3 hơi cách nhau ~1,5 giây → gộp thành **1 lượt transcript**, không bị cắt thành 3 |
| Tổng | Không cuộc gọi nào mắc ở bước danh bộ quá **90 giây** mà chưa được mời bấm phím |

---

## 10. Rủi ro hồi quy cần canh

| Fix cũ | Bị đụng bởi | Triệu chứng nếu hồi quy |
|---|---|---|
| Gate `_danhBoNeedsVerbalYes` (fix 19/07) | 1.5, 1.6 | Tra cứu bằng số chưa được khách xác nhận → **đọc nhầm thông tin người khác**. Nghiêm trọng nhất, phải test riêng |
| `fix_danh_bo_copilot_dtmf_20260719` | 1.8, 2.3 | DTMF không nhận được, hoặc mời bấm phím quá sớm gây khó chịu |
| `fix_echo_cancel_nham_response_20260718` | 2.4, 3.1 | Bot câm 20–30 giây giữa cuộc |
| Phantom turn (fix 08/07 đợt 3) | 3.1 | `server_vad` nhạy nhiễu SIP hơn → bot tự nói khi khách im lặng |
| `fix_danh_bo_trong_tai_20260719` | 1.4, 1.7 | Trọng tài đề xuất lại đúng số khách đã báo sai |
| Quy ước 1 `function_call_output` / `call_id` | 1.3, 1.4 | `conversation_already_has_active_response`, model treo |

---

## 11. Tham chiếu code

| Chủ đề | File | Dòng |
|---|---|---|
| Buffer transcript + đường nền đã tắt | `src/session-ws.js` | 620–631 |
| `_maybeAssembleDanhBo` (bật lại ở 1.4) | `src/session-ws.js` | 192–217 |
| `_speakVerbatim` | `src/session-ws.js` | 157–181 |
| `_reAssertDanhBoStep` | `src/session-ws.js` | 126–151 |
| Bắt lời AI (chỗ gắn §4.4) | `src/session-ws.js` | 708–720 |
| Cấu hình VAD hiện tại | `src/session-ws.js` | 285–313 |
| `resolveDanhBo` | `src/tools.js` | 636–739 |
| Vòng chờ 15 giây (gỡ ở 1.3) | `src/tools.js` | 702–715 |
| `digitsAvailable` dùng arg model | `src/tools.js` | 675–678 |
| `notEnough` báo sai độ dài | `src/tools.js` | 681–689, 738 |
| `candidateExistsInApi` | `src/tools.js` | 344–359 |
| `fireBackgroundArbiter` / `awaitBackgroundVerdict` | `src/tools.js` | 329–341 |
| `proactiveAssembleDanhBo` | `src/tools.js` | 603–618 |
| `handleConfirmDanhBo` (code chết) | `src/tools.js` | 482–589 |
| Prompt trọng tài | `src/danh-bo-arbiter.js` | 70–105 |
| `required: ["ma_danh_bo"]` — **giữ nguyên** | `src/system-prompt.js` | 221, 239, 256, 270, 282 |
| `closeDb` | `src/db.js` | 61 |
