# Kế hoạch v2 — Cải tiến nhận diện mã danh bộ (theo phương án đã chốt)

> **Trạng thái: KẾ HOẠCH — CHƯA SỬA CODE.**
> Viết lại theo 9 quyết định của anh (26/07/2026).
> Tài liệu nền: [`phan_tich_loi_danh_bo_20260726.md`](phan_tich_loi_danh_bo_20260726.md) (phân tích cuộc gọi
> `rtc_u2_E5eDfB96UnJE6iDWfPbRX`) và [`ke_hoach_cai_tien_danh_bo_20260726.md`](ke_hoach_cai_tien_danh_bo_20260726.md) (bản đề xuất đầy đủ).

---

## 1. Đánh giá 9 quyết định

| # | Quyết định của anh | Đánh giá | Ghi chú |
|---|---|---|---|
| 1 | Giữ `ma_danh_bo` là `required` | ✅ Chấp nhận được — **với điều kiện #2** | Có một lợi ích phụ đáng kể, xem §1.1 |
| 2 | Phát hiện model bịa số ở tham số tool, bịa thì bỏ qua | ✅ Đúng hướng, **bắt buộc phải có** khi giữ #1 | Thiết kế chi tiết §3 |
| 3 | Nới VAD cho giai đoạn đọc số trước | ✅ Lựa chọn khôn ngoan (rủi ro thấp hơn khoá mõm model) | Thiết kế §4 |
| 4 | Thêm biến lưu số tích luỹ theo mỗi lượt yêu cầu | ✅ **Đúng gốc vấn đề** | Cùng với #9 là phần lõi, §2 |
| 5 | Tra danh bộ theo SĐT từ DB — để sau | ✅ Hợp lý | Chuyển sang §8 |
| 6 | Cấu trúc mã danh bộ — để sau | ✅ Hợp lý | §8 |
| 7 | Tên khách hàng không dấu — để sau | ✅ Đồng ý hoãn, nhưng lý do hơi khác | Xem §8.3 |
| 8 | Graceful shutdown SIGINT/SIGTERM | ✅ Làm đầu tiên | §5 |
| 9 | Hai biến tích luỹ tách vai trò | ✅ **Thiết kế tốt** | §2 |

### 1.1. Nói rõ về quyết định #1

Em muốn nói lại cho chính xác một điểm kỹ thuật: **`required` không phải là thứ giúp model hỏi khách
số danh bộ.** Model hỏi khách bằng cách *nói*, không phải bằng cách điền vào một trường JSON. Việc để
`required` chỉ có một tác dụng duy nhất: structured output của OpenAI **đảm bảo trường đó luôn có giá
trị** — nên khi model chưa nghe được gì, nó **buộc phải nghĩ ra một con số**. Đó chính xác là cách
`725625` ra đời trong cuộc gọi mẫu.

**Tuy nhiên quyết định giữ lại vẫn hợp lý**, vì một lý do khác mà em cho là quan trọng hơn:

Báo cáo trước đã chỉ ra **lỗi #4 — trọng tài vĩnh viễn mất một "tai"**. `_danhBoReads` (bản nghe của
model thoại) chỉ được ghi trong `handleConfirmDanhBo`, mà hàm đó đã thành code chết từ 23/07. Kết quả:
prompt gpt-5.1 luôn in *"BẢN NGHE CỦA MODEL THOẠI: (không có)"*, trọng tài mất hẳn một nguồn quan sát
độc lập mà kiến trúc ban đầu đã thiết kế.

**Giữ `ma_danh_bo` chính là khôi phục lại nguồn nghe thứ hai đó** — miễn là code đối xử với nó đúng
bản chất: **một quan sát nhiễu, không phải một giá trị**.

Nguyên tắc bắt buộc phải giữ trong toàn bộ kế hoạch này:

> `ma_danh_bo` do model truyền vào **CHỈ ĐƯỢC** dùng làm quan sát cho trọng tài (`_danhBoReads`).
> **TUYỆT ĐỐI KHÔNG** dùng để: tra cứu trực tiếp, đếm số chữ số đã có, quyết định đủ/thiếu,
> hay ghi vào `callState.danhBo`.

Nếu sau này anh muốn giảm hẳn tần suất bịa mà vẫn giữ được nguồn quan sát, có một biến thể trung dung:
giữ `ma_danh_bo` trong `properties` nhưng **bỏ khỏi `required`**, kèm mô tả *"dãy số vừa nghe được;
để trống nếu chưa nghe khách đọc số nào"*. Model vẫn có chỗ báo cáo cái nó nghe, nhưng không bị ép phải
bịa khi không có gì. Ghi lại đây để cân nhắc sau, **kế hoạch dưới đây làm theo phương án anh chọn**.

---

## 2. Phần lõi — Hai biến tích luỹ (quyết định #4 + #9)

Đây là thay đổi quan trọng nhất của v2. Nó sửa cùng lúc 3 lỗi đã nêu trong báo cáo:
ghép mù làm hỏng đầu vào trọng tài, vòng chờ chết lâm sàng, và thông báo sai độ dài cho khách.

### 2.1. Định nghĩa hai biến

**Biến 1 — `_danhBoTranscripts` (giữ nguyên tên, đã có sẵn)**

- **Phạm vi:** toàn bộ cuộc gọi.
- **Vai trò:** kho quan sát cấp cho gpt-5.1. Càng nhiều dữ liệu, trọng tài càng dễ đối chiếu chéo.
- **Không bao giờ** dùng để đếm đủ/thiếu.
- Đề xuất nâng giới hạn từ 10 lên **20 phần tử** (`session-ws.js:624`) — trọng tài cần bề dày lịch sử,
  mà mỗi phần tử chỉ là một chuỗi ngắn.

**Biến 2 — `_danhBoSession` (mới)**

```js
_danhBoSession = {
  requestNo: 1,          // lượt yêu cầu thứ mấy (dùng để leo thang DTMF)
  startedAt: 1785015019, // mốc code phát câu "đọc lại toàn bộ 11 số"
  turns: [],             // các lượt transcript SAU mốc này
  digits: "",            // chuỗi chữ số ghép từ turns — CHỈ dùng cho biến này
}
```

- **Phạm vi:** một lượt yêu cầu khách đọc.
- **Reset** mỗi khi code phát câu mời khách đọc **toàn bộ** mã danh bộ (`invalidDanhBoResponse`,
  `reReadRequestResponse`, và câu xin số lần đầu), đồng thời `requestNo++`.
- **Vai trò duy nhất:** xác định lượt đọc hiện tại đã đủ / chưa đủ / vượt 11 số.

Theo đúng ý anh ở #4: **mỗi lượt yêu cầu là yêu cầu khách đọc TRỌN VẸN mã danh bộ**, không phải đọc
tiếp phần còn thiếu. Nhờ vậy `digits` của một phiên có ý nghĩa rõ ràng và so được với 11.

### 2.2. Luật xử lý theo độ dài `_danhBoSession.digits`

| Tình huống | Xử lý |
|---|---|
| **Một lượt transcript ĐƠN ra đúng 11 số** | **Chốt ngay** — `danhBo = {value, confirmed:false}`, `_speakVerbatim` đọc lại xác nhận. Không cần model, không cần gpt-5.1, độ trễ ~0 |
| `digits.length < 11` | Chờ tiếp (còn trong hạn chờ). Trả tool output ngay với `dang_gom_so: true` |
| `digits.length == 11` (ghép từ nhiều hơi) | Gọi trọng tài để chốt thứ tự ghép, rồi đọc lại xác nhận |
| `digits.length > 11` | **KHÔNG báo "chưa có mã danh bộ"** (đây là bug hiện tại). Gọi trọng tài với phiên này ưu tiên cao; không ra thì reset phiên + mời đọc lại |
| Hết hạn chờ mà `< 11` | Gọi trọng tài lần chót; không ra thì reset phiên + mời đọc lại |

Sửa cụ thể dòng cuối `resolveDanhBo` (`tools.js:738`) — chỗ đang truyền `0` làm khách nghe
*"chưa có mã danh bộ"* trong khi hệ thống đã nghe 31 chữ số:

```js
// TRƯỚC (sai):
return notEnough(digitsAvailable() >= DANH_BO_LENGTH ? 0 : digitsAvailable());
// SAU: dùng độ dài THẬT của phiên hiện tại, phân biệt rõ 3 trạng thái
return notEnough(_danhBoSession.digits.length);   // 0 / <11 / >11 → 3 câu thoại khác nhau
```

### 2.3. Cấp dữ liệu cho trọng tài theo hai tầng

Đây là chỗ hai biến phát huy giá trị lớn nhất. Prompt gpt-5.1 (`danh-bo-arbiter.js`) tách rõ:

```
=== LẦN ĐỌC MỚI NHẤT (khách vừa được yêu cầu đọc TRỌN VẸN mã — ƯU TIÊN CAO NHẤT) ===
Lượt 1: "22023251775"

=== CÁC LẦN ĐỌC TRƯỚC ĐÓ (tham khảo để đối chiếu chéo, có thể lẫn nhiễu) ===
Lượt 1: "Số danh bộ là 2200"
Lượt 2: "325."
...
```

Với cuộc gọi mẫu, phiên cuối (04:32:06) chứa **đúng một lượt: `22023251775`** — trọng tài chốt trong
một nốt nhạc. Còn hiện tại nó nhận một đống 31 chữ số trộn lẫn 5 lượt rác và đã từ chối, **rất đúng
đắn, vì dữ liệu vào mới là thứ sai**.

Thêm hướng dẫn vào prompt: *"Nếu LẦN ĐỌC MỚI NHẤT tự nó đã ra đúng 11 số thì lấy luôn, các lần đọc
trước chỉ để đối chiếu."*

### 2.4. Leo thang bằng `requestNo`

`_danhBoSession.requestNo` là bộ đếm leo thang **duy nhất và đáng tin** — nó đếm đúng thứ khách cảm
nhận được: *"tôi đã phải đọc lại bao nhiêu lần rồi"*.

- `requestNo >= 3` → **mời bấm phím DTMF**.
- Đã mời DTMF mà vẫn quay lại đọc → `danhBoEscalationResponse` (chuyển máy / tạo phiếu).
- Bổ sung watchdog: quá **90 giây** kể từ lúc bắt đầu xin danh bộ mà chưa `confirmed` → mời DTMF ngay,
  bất kể `requestNo`.

Cuộc gọi mẫu kéo dài **3 phút 32 giây** qua 6 lượt đọc mà **chưa một lần** khách được mời bấm phím —
vì cả hai bộ đếm cũ (`_danhBoResolveTries`, `_danhBoAssembleTries`) đều đếm theo nhánh code nội bộ chứ
không theo trải nghiệm khách. `requestNo` thay thế cả hai.

### 2.5. Dọn các chỗ liên quan

- Bỏ `normalizeDanhBo(rawArg).length` khỏi `digitsAvailable()` (`tools.js:675-678`) — arg model không
  được tính vào số chữ số đã có (nguyên tắc §1.1).
- Đồng bộ `entrySig` (dòng 692) với `_danhBoLastResolveSig` (dòng 718) — hiện lệch nhau nên cache
  chống gọi trùng hay trượt, gọi gpt-5.1 dư.
- Xoá code chết `handleConfirmDanhBo` (`tools.js:482-589`) để lần sau không ai hiểu nhầm là nó còn chạy.

---

## 3. Phát hiện model bịa số (quyết định #2)

### 3.1. Thuật toán phân loại

Đầu vào: `arg = normalizeDanhBo(ma_danh_bo)` và `_danhBoSession.digits` (chuỗi số của **phiên hiện tại**).

| Luật | Điều kiện | Kết luận |
|---|---|---|
| **R1** | `_danhBoSession.digits` rỗng (khách chưa đọc số nào trong phiên này) | **BỊA** — bắt mọi trường hợp như `725625` |
| **R2** | `arg` là substring của `session.digits` | **Nghe đúng** |
| **R3** | khoảng cách Levenshtein nhỏ nhất giữa `arg` và mọi cửa sổ độ dài `|arg|`, `|arg|±1` trong `session.digits` ≤ `max(1, floor(|arg| * 0.2))` | **Nghe lệch** — chấp nhận làm quan sát |
| **R4** | còn lại | **BỊA** |

Kiểm chứng trên cuộc gọi mẫu:

- `725625` — phiên rỗng hoàn toàn → **R1 → BỊA** ✓
- `320325175` (9 số) — không phải substring; khoảng cách tới mọi cửa sổ đều ≥ 3, ngưỡng `floor(9*0.2)=1`
  → **R4 → BỊA** ✓

> Ngưỡng 0.2 là điểm khởi đầu, **cần chỉnh lại bằng dữ liệu thật** sau vài ngày chạy. Chi phí sai ở cả
> hai chiều đều thấp (xem §3.3), nên không cần cầu toàn ngay từ đầu.

### 3.2. Xử lý khi phát hiện

Khi kết luận **BỊA**:

1. **Bỏ hoàn toàn `arg`** — không tra cứu, không ghi vào `_danhBoReads`, không đếm vào bất kỳ biến nào,
   không lưu vào `callState.danhBo`. Xử lý tiếp y như model không truyền gì.
2. Ghi event `danh_bo_arg_hallucinated` kèm giá trị + lý do (R1/R4) vào timeline.
3. Tăng `callState._hallucinationCount`.
4. `_hallucinationCount >= 2` → **nhảy thẳng sang mời DTMF**. Model bịa 2 lần là dấu hiệu nó đã mất
   ngữ cảnh; nghe tiếp chỉ tốn thời gian của khách.

Khi kết luận **Nghe đúng / Nghe lệch**: đẩy vào `_danhBoReads` để trọng tài đối chiếu — **vẫn không
dùng để tra cứu**.

### 3.3. Tại sao thuật toán không cần quá chính xác

Vì `arg` **không bao giờ được dùng để tra cứu** (nguyên tắc §1.1), hậu quả của việc phân loại sai rất nhẹ:

- **Nhận nhầm số bịa thành quan sát thật** → thêm một dòng nhiễu vào prompt trọng tài, mà prompt đã dán
  nhãn sẵn *"BẢN NGHE CỦA MODEL THOẠI (kém tin cậy hơn, hay rơi mất số đầu, chép sai số)"*.
- **Loại nhầm số nghe đúng** → mất một quan sát; transcript vẫn là trục chính.

Giá trị thật của cơ chế này nằm ở **(a) giữ sạch đầu vào trọng tài** và **(b) đếm để leo thang + đo lường**.

### 3.4. Lớp bổ sung — phát hiện bot NÓI số lạ ra loa (khuyến nghị làm)

Cơ chế §3.1–3.2 chặn số bịa ở **tham số tool**, nhưng **không ngăn được bot đọc số bịa ra loa**.
Trong cuộc gọi mẫu, đây mới là thứ trực tiếp làm khách hoang mang:

> *"Quý Khách vừa cho em số danh bộ **725625** đúng rồi phải không ạ?"* (04:30:04)
> *"em đã ghi lại mã **725625**"* (04:30:09)
> *"em vẫn đang chờ kết quả... với số danh bộ **320325175**"* (04:31:34)

Khách nghe hai con số hoàn toàn xa lạ lặp đi lặp lại → mất phương hướng → đọc lung tung
(*"Hay hay, không hay"*) → transcript càng tệ. **Vòng xoáy tự khuếch đại.**

Cách làm, tại `conversation.item.done`:

- Bóc mọi cụm ≥ 4 chữ số trong lời bot (cả dạng chữ số lẫn dạng chữ *"hai hai không..."*).
- Đối chiếu với **tập được phép nói** = `{callState.danhBo?.value}` ∪ các số có trong `_danhBoLastPrompt`.
- Lệch → ghi event `bot_hallucinated_digits`, tăng `_hallucinationCount` (dùng chung §3.2).

Xử lý:

1. **KHÔNG cancel response đang chạy.** Repo đã trả giá 2 lần cho việc này (bot câm 24s tại
   `fix_echo_cancel_nham_response_20260718`, 28s tại cuộc `E2ou4DurIiPbGRvrrggKr`). Số đã phát ra loa
   rồi, cancel không rút lại được mà còn sinh lỗi mới.
2. **Nói đè bằng câu đúng** — tái dùng `_reAssertDanhBoStep()` đã có sẵn (`session-ws.js:126`).
3. Đếm chung với §3.2 để leo thang DTMF.

---

## 4. Nới VAD cho giai đoạn đọc số (quyết định #3)

### 4.1. Vì sao lựa chọn này hợp lý

`semantic_vad` quyết định "khách nói xong chưa" theo **ngữ nghĩa**. Khi khách đọc số tách nhiều hơi
(*"hai hai không hai..."* — ngừng — *"ba hai năm..."*), mỗi hơi trông như một lượt hoàn chỉnh → OpenAI
chốt lượt sớm và tạo response ngay. Đó là lý do trong log có tới **6 lượt transcript rời rạc** cho cùng
một mã danh bộ, và là gốc của việc model *"đáp chưa đủ"* liên tục.

`server_vad` với ngưỡng im lặng dài thì **dễ đoán hơn hẳn** cho việc đọc số, và rủi ro thấp hơn nhiều
so với phương án khoá `create_response` (bot có thể câm vĩnh viễn nếu quên bật lại).

### 4.2. Cấu hình đề xuất

**Khi vào giai đoạn thu danh bộ** — `session.update`:

```js
audio: { input: { turn_detection: {
  type: "server_vad",
  threshold: 0.6,            // giữ như giá trị đã hiệu chỉnh ở fix 08/07
  prefix_padding_ms: 500,    // không mất các chữ số đầu
  silence_duration_ms: 2000, // ← điểm mấu chốt: cho khách ngừng giữa các hơi
  create_response: true,     // model VẪN được nói (khác phương án khoá mõm)
  interrupt_response: true
} } }
```

**Khi chốt xong danh bộ** — trả về cấu hình cũ:

```js
audio: { input: { turn_detection: {
  type: "semantic_vad", eagerness: "low",
  create_response: true, interrupt_response: true
} } }
```

### 4.3. Điểm vào / điểm ra và watchdog

| Sự kiện | Hành động |
|---|---|
| Code phát câu xin / mời đọc lại mã danh bộ | Chuyển sang `server_vad` (nếu chưa) |
| `danhBo.confirmed === true` | Trả về `semantic_vad` |
| Mời DTMF / escalation / `end_call` / `transfer_to_agent` | Trả về `semantic_vad` |
| **Watchdog 90 giây** kể từ lúc chuyển | Tự trả về `semantic_vad` |

> ⚠️ Phải trả về `semantic_vad` ở **mọi** nhánh thoát, kể cả nhánh lỗi. Watchdog là lưới an toàn cuối
> cùng, không phải cơ chế chính.

### 4.4. Cần đo sau khi triển khai

- `silence_duration_ms: 2000` làm **toàn bộ phản hồi trong giai đoạn đó chậm thêm ~2 giây**. Nếu khách
  thấy bot "đơ", cân nhắc hạ về 1500ms.
- Theo dõi `vad_speech_started` so với số lượt khách nói thật — `server_vad` nhạy với nhiễu đường
  truyền SIP hơn `semantic_vad`, có thể làm phantom turn quay lại (vấn đề đã gặp ở fix 08/07 đợt 3).
  Nếu phantom turn tăng → nâng `threshold` lên 0.7.

---

## 5. Graceful shutdown (quyết định #8)

**Vấn đề:** `conversation_summary/2026/07/26/` có file cuối lúc **04:28**. Cuộc gọi lỗi diễn ra
**04:29–04:32** → **không có file nào**. Cuối log thấy shell prompt trở lại → tiến trình node đã thoát
trước khi `_saveOnce()` (async, trong `ws.on("close")`) kịp ghi xong.

**Cuộc gọi lỗi nặng nhất lại là cuộc không có log để phân tích.** Việc này phải làm trước, nếu không
các vòng sau vẫn sửa mù.

Thiết kế:

1. **Registry logger đang mở** — `openSessionWebSocket` đăng ký logger vào một `Set` ở module cấp cao,
   gỡ ra khi `_saveOnce` xong.
2. **Handler `SIGINT` / `SIGTERM`** — chặn thoát mặc định, log số logger đang chờ, `await Promise.allSettled`
   toàn bộ `_saveOnce` với **timeout 5 giây**, rồi `process.exit(0)`.
3. **Nhấn Ctrl+C lần 2 → thoát ngay** (thói quen thông thường, tránh treo terminal).
4. Gọi cùng đường flush đó trong handler `uncaughtException` hiện có ở `server.js`.
5. Đóng pool DB (`closeDb()` đã có sẵn ở `db.js:61`) **sau khi** flush xong.

---

## 6. Khoảng trống còn lại — cần anh quyết

Chín quyết định của anh **chưa chạm** vào một lỗi mà em cho là còn khá nặng, nên nêu riêng ở đây để anh
cân nhắc chứ không tự đưa vào kế hoạch.

**Tool call vẫn treo 15–25 giây.** Đo từ log: tool call #1 treo **21 giây**, #2 treo **18 giây** —
do `DANH_BO_WAIT_MS = 15000` (`tools.js:702`) cộng với trọng tài gpt-5.1 chạy đồng bộ (tới 20 giây).

Trong khoảng treo đó `function_call_output` chưa về, nhưng VAD **vẫn tiếp tục tạo response**. Model
không có kết quả nên nó *bịa ra tình trạng* — đó chính là nguồn gốc của 4 câu bịa số đã trích ở §3.4.

Nới VAD (#3) giúp khách được nghe trọn vẹn hơn, nhưng **không giải quyết việc model bị bỏ đói**.
Phát hiện bịa số (#2) chặn được ở tham số tool, nhưng **không ngăn bot nói ra loa**.

Ba mức xử lý, từ nhẹ đến triệt để:

| Mức | Nội dung | Công sức | Rủi ro |
|---|---|---|---|
| **A** | Hạ `DANH_BO_WAIT_MS` 15s → **4s**. Nhờ biến 2 (§2), phiên đọc mới lấp đầy rất nhanh nên không cần chờ lâu | Rất thấp | Rất thấp |
| **B** | A + trả tool output **ngay** với `dang_gom_so: true` (model có nội dung để bám, đỡ bịa), trọng tài chuyển sang chạy nền | Trung bình | Thấp |
| **C** | B + `create_response: false` trong giai đoạn thu số (code làm chủ hoàn toàn lời thoại) | Trung bình | **Cao** — bot có thể câm nếu quên bật lại |

**Em đề xuất mức A ngay trong đợt này** (gần như miễn phí, chỉ đổi một hằng số, và biến 2 đã làm cho
việc chờ lâu trở nên không cần thiết), rồi cân nhắc mức B ở đợt sau. **Mức C thì khoan** — nó hợp lý về
mặt kỹ thuật nhưng rủi ro cao, chỉ nên làm khi code đã thật sự làm chủ được lời thoại.

Anh cho em biết chọn mức nào để em đưa vào bước triển khai.

---

## 7. Kế hoạch triển khai

### Bước 0 — Nền tảng (nửa ngày)

| # | Việc | File |
|---|---|---|
| 0.1 | Graceful shutdown SIGINT/SIGTERM + flush logger (§5) | `server.js`, `session-ws.js` |
| 0.2 | Dọn `console.log` của `normalizeDanhBo` — log mẫu có **hơn 40 khối**, che hết dòng quan trọng | `tools.js` |
| 0.3 | Thêm trường đo: `danh_bo_resolved_by`, `danh_bo_request_count`, `danh_bo_seconds`, `hallucination_count` | `conversation-logger.js` |

> 0.3 nhẹ nhưng nên có: không có số nền thì không biết các bước sau là cải thiện hay hồi quy.

### Bước 1 — Hai biến tích luỹ (1,5 ngày) ⭐ phần lõi

| # | Việc | File |
|---|---|---|
| 1.1 | Thêm `_danhBoSession`, reset + `requestNo++` tại mọi chỗ phát câu mời đọc lại | `session-ws.js`, `tools.js` |
| 1.2 | Chuyển mọi phép đếm đủ/thiếu sang `_danhBoSession.digits` | `tools.js:675-678, 702-715` |
| 1.3 | **Transcript đơn ra đúng 11 số → chốt ngay + `_speakVerbatim` đọc lại xác nhận** | `session-ws.js:620-631` |
| 1.4 | Sửa `notEnough` — phân biệt 3 trạng thái `0` / `<11` / `>11`, bỏ hẳn câu "chưa có mã danh bộ" khi đã nghe thừa số | `tools.js:681-689, 738` |
| 1.5 | Prompt trọng tài tách 2 tầng "LẦN ĐỌC MỚI NHẤT" / "CÁC LẦN TRƯỚC" | `danh-bo-arbiter.js` |
| 1.6 | Leo thang theo `requestNo >= 3` + watchdog 90 giây → DTMF | `session-ws.js`, `tools.js` |
| 1.7 | Nâng cap `_danhBoTranscripts` 10 → 20; đồng bộ `entrySig`; xoá `handleConfirmDanhBo` | `session-ws.js`, `tools.js` |

> ⚠️ **1.3 cần một guard:** số điện thoại VN cũng 10–11 chữ số. Chỉ kích hoạt khi đang thật sự ở bước
> thu danh bộ (đã có `_danhBoLastPrompt`, hoặc bot vừa hỏi xin mã danh bộ).

**Riêng bước 1 đã đủ cứu cuộc gọi mẫu** — lượt `22023251775` lúc 04:32:06 sẽ được chốt ngay tại 1.3.

### Bước 2 — Phát hiện bịa số (1 ngày)

| # | Việc | File |
|---|---|---|
| 2.1 | Hàm `classifyModelArg(arg, session)` theo R1–R4 (§3.1) + unit test bằng chính dữ liệu cuộc gọi mẫu | `tools.js` (mới) |
| 2.2 | Nối vào `resolveDanhBo`: BỊA → bỏ hẳn; còn lại → đẩy vào `_danhBoReads` | `tools.js:636-739` |
| 2.3 | Đếm `_hallucinationCount`, ≥2 → DTMF | `tools.js` |
| 2.4 | (khuyến nghị) Phát hiện bot **nói** số lạ ra loa + `_reAssertDanhBoStep` (§3.4) | `session-ws.js:708-720` |

### Bước 3 — Nới VAD (1 ngày)

| # | Việc | File |
|---|---|---|
| 3.1 | Hàm `setVadMode('digits' \| 'normal')` gửi `session.update` | `session-ws.js` |
| 3.2 | Gắn điểm vào / điểm ra + watchdog 90 giây (§4.3) | `session-ws.js` |
| 3.3 | Đo `vad_speech_started` vs lượt khách thật trước/sau; phantom turn tăng thì nâng `threshold` 0.6 → 0.7 | — |

### Bước 4 — Tuỳ §6

Chờ anh chọn mức A / B / C.

---

## 8. Hoãn lại (quyết định #5, #6, #7)

Ghi lại kèm điều kiện để lấy ra làm sau.

### 8.1. Lịch sử danh bộ theo SĐT từ DB (#5)

`db/schema.sql:97` đã có sẵn `voicebot_calllog(customer_tel, ma_danh_bo)` với **index cả hai cột** —
chỉ cần một truy vấn, không phải sửa schema.

Số liệu để anh cân nhắc khi quay lại: SĐT `0967777637` đã xác nhận thành công `22023251775` **150 lần**
trong `conversation_summary/`, trong khi backend `getThongTinKhachHang(null, tel)` trả rỗng cho số này.
Với khách quen — vốn là phần lớn khách tổng đài CSKH — đây có thể là tín hiệu mạnh nhất trong toàn hệ thống.

Khi làm, nhớ tách `historyDanhBo` (gợi ý, vẫn phải đọc lại xác nhận) khỏi `knownDanhBo` (hệ thống cấp,
tin ngay) — khách hoàn toàn có thể gọi hỏi giùm danh bộ khác.

### 8.2. Cấu trúc mã danh bộ (#6)

8 mã ground truth (trường `danhBa` do API trả về): tiền tố 2 số chỉ thuộc `{15, 22}`, chữ số thứ 3 luôn
`0` hoặc `1`. Mẫu quá nhỏ để kết luận, nhưng đủ để thấy mã **có cấu trúc**.

Việc rẻ nhất và nên làm sớm dù hoãn phần code: **hỏi CNTA bảng quy tắc đánh mã danh bộ**. Nếu có
**check digit**, ta loại được phần lớn ứng viên sai **offline, tức thì, chính xác tuyệt đối** — khi đó
gần như mọi thứ khác trong tài liệu này trở thành phụ. Câu hỏi này nên gửi ngay vì phải chờ phía khách hàng.

### 8.3. Xác nhận bằng tên khách hàng (#7)

Em nói rõ hơn để lúc quay lại anh có thông tin đúng: ý tưởng này **không cần tra cứu theo tên**.
API `getThongTinKhachHang` đã trả sẵn `{ danhBa, hoTen }` trong cùng lời gọi kiểm tra danh bộ — ta chỉ
**đọc tên ra cho khách xác nhận** thay vì đọc 11 chữ số.

Trở ngại thật nằm ở chỗ khác: **tên không dấu sẽ bị TTS đọc sai thanh điệu** (*"Nguyen Van Cuong"* →
đọc thành *"Nguyen Van Cuong"* trọ trẹ, khách nghe không ra). Nếu sau này DB có tên đủ dấu, hoặc ta
thêm một bước khôi phục dấu, thì ý tưởng này rất đáng làm — đọc tên mất ~2 giây so với ~10 giây đọc
11 chữ số, và khách nghe tên mình thì biết đúng/sai ngay, còn nghe 11 chữ số thì rất dễ gật cho xong.

Ngoài ra cần CNTA duyệt về quyền riêng tư (đọc tên chủ hợp đồng cho người gọi).

---

## 9. Tiêu chí nghiệm thu

| Bước | Tiêu chí |
|---|---|
| 0 | Ctrl+C giữa cuộc gọi → file `conversation_summary` vẫn được ghi đầy đủ |
| 1 | Dựng lại kịch bản cuộc gọi mẫu (3 hơi rời + 1 lần đọc liền 11 số) → chốt đúng `22023251775` trong **≤ 60 giây**; khách không bao giờ nghe câu *"chưa có mã danh bộ"* khi đã đọc số |
| 2 | `arg = 725625` với phiên rỗng → phân loại BỊA, **không** xuất hiện trong `_danhBoReads`, **không** ảnh hưởng phép đếm |
| 3 | Khách đọc tách 3 hơi cách nhau ~1,5 giây → gộp thành **1 lượt transcript**, không bị cắt thành 3 |
| Tổng | Không cuộc gọi nào mắc ở bước danh bộ quá **90 giây** mà chưa được mời bấm phím |

---

## 10. Rủi ro hồi quy cần canh

| Fix cũ | Bị đụng bởi | Triệu chứng nếu hồi quy |
|---|---|---|
| Gate `_danhBoNeedsVerbalYes` (fix 19/07) | 1.3, 1.4 | Tra cứu bằng số chưa được khách xác nhận → **đọc nhầm thông tin người khác**. Nghiêm trọng nhất, phải test riêng |
| `fix_danh_bo_copilot_dtmf_20260719` | 1.6, 2.3 | DTMF không nhận được, hoặc mời bấm phím quá sớm gây khó chịu |
| `fix_echo_cancel_nham_response_20260718` | 2.4, 3.1 | Bot câm 20–30 giây giữa cuộc |
| Phantom turn (fix 08/07 đợt 3) | 3.1 | `server_vad` nhạy nhiễu SIP hơn → bot tự nói khi khách im lặng |
| `fix_danh_bo_trong_tai_20260719` | 1.5, 1.7 | Trọng tài đề xuất lại đúng số khách đã báo sai |

---

## 11. Tham chiếu code

| Chủ đề | File | Dòng |
|---|---|---|
| Buffer transcript + đường nền đã tắt | `src/session-ws.js` | 620–631 |
| `_speakVerbatim` (mẫu để nhân rộng) | `src/session-ws.js` | 157–181 |
| `_reAssertDanhBoStep` | `src/session-ws.js` | 126–151 |
| Bắt lời AI (chỗ gắn §3.4) | `src/session-ws.js` | 708–720 |
| Cấu hình VAD hiện tại | `src/session-ws.js` | 285–313 |
| `resolveDanhBo` | `src/tools.js` | 636–739 |
| Vòng chờ 15 giây | `src/tools.js` | 702–715 |
| `digitsAvailable` dùng arg model | `src/tools.js` | 675–678 |
| `notEnough` báo sai độ dài | `src/tools.js` | 681–689, 738 |
| Cache sig lệch | `src/tools.js` | 692, 718 |
| `handleConfirmDanhBo` (code chết) | `src/tools.js` | 482–589 |
| Prompt trọng tài | `src/danh-bo-arbiter.js` | 70–105 |
| `required: ["ma_danh_bo"]` | `src/system-prompt.js` | 221, 239, 256, 270, 282 |
| `closeDb` | `src/db.js` | 61 |
