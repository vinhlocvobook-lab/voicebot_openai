# Kế hoạch cải tiến nhận diện mã danh bộ — 26/07/2026

> **Trạng thái: KẾ HOẠCH — CHƯA SỬA CODE.**
> Tổng hợp từ [`phan_tich_loi_danh_bo_20260726.md`](phan_tich_loi_danh_bo_20260726.md) (phân tích cuộc gọi
> `rtc_u2_E5eDfB96UnJE6iDWfPbRX`) + 3 câu hỏi của anh + vòng review thứ hai trên toàn repo.

---

## 0. Phát hiện quan trọng nhất của vòng review này

**Model KHÔNG "bịa" số vì nó hư — nó bị JSON schema ÉP phải bịa.**

`src/system-prompt.js` — cả 5 tool tra cứu đều khai báo:

```js
required: ["ma_danh_bo"],     // dòng 221, 239, 256, 270, 282
```

`ma_danh_bo` là **trường bắt buộc**. Khi khách mới nói *"Em xem giúp anh tiền nước tháng này"* mà chưa
đọc số nào, model muốn gọi `get_payment_status` thì **bắt buộc phải điền một giá trị** — nó không có
lựa chọn nào khác ngoài việc nghĩ ra `"725625"`. Structured output của OpenAI đảm bảo trường required
luôn có mặt; model không được phép bỏ trống.

Đồng thời `SYSTEM_PROMPT` (dòng 51) lại ra lệnh ngược:
> *"GỌI hàm tra cứu với `ma_danh_bo` = ĐÚNG các chữ số vừa nghe được"*

Model bị kẹt giữa "phải điền" và "chỉ được điền cái đã nghe" → nó chọn vế dễ hơn: **điền bừa**.

Hệ quả: mọi lớp phòng thủ chống-bịa mà ta định xây (edit-distance, đối chiếu transcript, phát hiện
bot đọc số lạ) đều là **đi vá hạ nguồn cho một lỗi thiết kế ở thượng nguồn**. Gỡ `ma_danh_bo` khỏi
schema thì lỗi bịa-ở-tầng-tool **biến mất hoàn toàn, không cần phát hiện gì cả**.

Đây là thay đổi rẻ nhất, an toàn nhất và có tác động lớn nhất trong toàn bộ kế hoạch này.

---

## 1. Trả lời trực tiếp 3 câu hỏi

### 1.1. Có nên bổ sung phát hiện bot bịa số không? — **Có, nhưng ưu tiên CHẶN thay vì PHÁT HIỆN**

Ba tầng, theo đúng thứ tự nên làm:

| Tầng | Cách làm | Đánh giá |
|---|---|---|
| **Chặn tại nguồn** | Gỡ `ma_danh_bo` khỏi `properties` + `required` của 5 tool tra cứu | ⭐ Làm cái này trước. Model không có ô để điền thì không bịa được. Không tốn gì |
| **Lọc phòng bị** | Nếu vẫn giữ tham số: coi arg là bịa khi digits của nó không phải substring của transcript ghép **và** edit-distance tới mọi cửa sổ cùng độ dài đều > 2 → **bỏ hẳn arg** | Chỉ cần nếu vì lý do nào đó không gỡ được schema |
| **Giám sát** | Bóc mọi cụm ≥4 chữ số trong lời bot (`conversation.item.done`), đối chiếu tập được phép nói = `{danhBo.value}` ∪ số trong `_danhBoLastPrompt` → lệch thì ghi event `bot_hallucinated_digits` | Giá trị chính là **đo lường + kích hoạt leo thang**, không phải sửa chữa |

**Khi phát hiện bot đã nói số bịa ra loa thì làm gì:**

1. **KHÔNG cancel response đang chạy.** Lịch sử repo đã trả giá 2 lần cho việc này (bot câm 24s ở
   `fix_echo_cancel_nham_response_20260718`, 28s ở cuộc `E2ou4DurIiPbGRvrrggKr`). Số đã phát ra loa
   rồi, cancel không rút lại được mà còn tạo lỗi mới.
2. **Nói đè bằng câu đúng** — tái dùng `_reAssertDanhBoStep()` đã có sẵn (`session-ws.js:126`).
3. **Đếm và leo thang**: bịa ≥2 lần → nhảy thẳng sang mời DTMF. Bot bịa là dấu hiệu model đã mất
   ngữ cảnh; nghe tiếp chỉ tốn thời gian của khách.

**Điểm cần nhớ:** trong cuộc gọi mẫu, bot bịa vì **bị bỏ đói 21 giây** (tool treo) mà VAD vẫn bắt nó
phải nói. Sửa gốc nằm ở câu 1.2 và Giai đoạn 2 bên dưới, không nằm ở việc phát hiện.

---

### 1.2. Có nên báo cho model biết để nó chờ khách đọc hết 11 số? — **Có, nhưng đừng chỉ dựa vào prompt**

Memory dự án đã ghi rõ: *model mini không tuân thủ rule prompt ổn định → fix hành vi phải deterministic*.
Nên làm cả 3 mức, mức sau mạnh hơn mức trước:

**Mức 1 — Nói cho model biết (gần như miễn phí, vẫn nên làm).**
Thay vì để tool treo im lặng, trả `function_call_output` **ngay lập tức** với nội dung:

```json
{
  "success": false,
  "dang_gom_so": true,
  "da_nghe": 7, "can": 11,
  "doc_cho_khach": "Dạ, em đang nghe ạ, Quý Khách đọc tiếp giúp em.",
  "message": "Hệ thống ĐANG GOM số, chưa đủ 11. Đọc NGUYÊN VĂN doc_cho_khach rồi DỪNG. TUYỆT ĐỐI không đọc lại bất kỳ chữ số nào, không đoán số, không nói 'đang chờ hệ thống'."
}
```

Có nội dung để bám thì xác suất bịa giảm mạnh so với bị bỏ trống 21 giây.

**Mức 2 — Khoá cơ chế sinh lời của model (đây mới là fix thật).**
Realtime API cho phép `session.update` giữa cuộc gọi. Khi bước vào giai đoạn thu danh bộ:

```js
audio: { input: { turn_detection: {
  type: "semantic_vad", eagerness: "low",
  create_response: false,      // ← model KHÔNG được tự sinh response
  interrupt_response: true
} } }
```

Audio vẫn được commit và transcribe bình thường — chỉ là model không tự nói nữa. Toàn bộ lời thoại
trong giai đoạn này do **code** phát qua `_speakVerbatim()`. Đây chính xác là mô hình đã chứng minh
hiệu quả ở luồng DTMF. Chốt xong danh bộ → `session.update` bật lại `create_response: true`.

> ⚠️ **Rủi ro bắt buộc xử lý:** quên bật lại → bot câm vĩnh viễn. Phải kèm **watchdog** tự bật lại sau
> 90 giây, và bật lại trong **mọi** nhánh thoát: `danhBo.confirmed`, `end_call`, `transfer_to_agent`,
> nhánh lỗi, nhánh escalation.

**Mức 3 — Nới VAD riêng cho giai đoạn đọc số.**
Khoảng lặng giữa các hơi đọc số rất ngắn. `eagerness: "low"` đã tốt; nếu vẫn bị cắt giữa chừng thì
cân nhắc tạm chuyển `server_vad` với `silence_duration_ms ≈ 1500`, xong thì trả về `semantic_vad`.

---

### 1.3. Vòng chờ khi đã tích luỹ **quá** 11 số — **không kẹt, nhưng hỏng theo 3 cách khác**

Đã kiểm tra `src/tools.js:702-715`:

```js
while (digitsAvailable() < DANH_BO_LENGTH && waited < DANH_BO_WAIT_MS) { ... }
```

Điều kiện là `< 11`, nên vượt 11 thì thoát ngay — **không bị treo**. Nhưng:

**(a) Sau vài lượt, vòng chờ trở thành vô dụng.** `digitsAvailable()` ghép **toàn bộ** buffer, mà buffer
chỉ bị xoá khi khách xác nhận "đúng" (`session-ws.js:641`) và giữ tới 10 lượt. Tại tool call thứ 2 của
cuộc gọi mẫu, buffer đã là `4+3+6+8+10 = 31 chữ số`. Từ đó tới cuối cuộc gọi, vòng chờ luôn thoát tức
thì — cơ chế "chờ khách đọc tiếp" **chết lâm sàng đúng lúc cần nó nhất**.

**(b) Thông báo cho khách sai hẳn.** Dòng cuối `resolveDanhBo`:

```js
return notEnough(digitsAvailable() >= DANH_BO_LENGTH ? 0 : digitsAvailable());
```

Vượt 11 → truyền `0` → `invalidDanhBoResponse(0)` → *"Chưa có mã danh bộ"*.
Log xác nhận đúng y như vậy: `do_dai_hien_tai: 0` trong khi hệ thống đã nghe 13 rồi 31 chữ số.
Khách bị hỏi lại từ đầu như chưa hề nói gì — rất ức chế, và đây là lúc đáng lẽ phải chuyển sang DTMF.

**(c) Ghép mù làm hỏng đầu vào của trọng tài.** `txConcat` nối tất cả, kể cả rác và cả các lượt thuộc
lần đọc **trước**. Chính vì vậy gpt-5.1 lần 1 nhận được 13 số rồi từ chối — **nó từ chối đúng, dữ liệu
vào mới là thứ sai**.

**Một lệch nhỏ nữa:** `entrySig` tính ở dòng 692 (trước khi chờ) nhưng `_danhBoLastResolveSig` ghi ở
dòng 718 (sau khi chờ, `transcripts.length` đã khác) → cache chống gọi trùng hay trượt, dễ gọi gpt-5.1 dư.

---

## 2. Ý tưởng mới phát hiện ở vòng review thứ hai

### 2.1. ⭐ Lịch sử danh bộ theo SĐT — nguồn tín hiệu mạnh nhất đang bị bỏ không

`db/schema.sql:97` đã có bảng `voicebot_calllog` với **cả hai** cột và **cả hai** index:

```sql
customer_tel VARCHAR(32),  ma_danh_bo VARCHAR(20),
KEY idx_call_danhbo (ma_danh_bo),  KEY idx_call_tel (customer_tel),
```

Nhưng chưa ai truy vấn nó khi có cuộc gọi đến.

Thống kê thực tế từ `conversation_summary/`: SĐT `0967777637` đã **xác nhận thành công `22023251775`
tới 150 lần**. Trong khi đó backend `getThongTinKhachHang(null, tel)` trả về rỗng cho số này → `knownDanhBo = []`
→ prompt trọng tài in *"DANH BỘ ĐÃ ĐĂNG KÝ THEO SĐT: (không có)"*.

**Nếu có lịch sử này, trọng tài đã chốt đúng ngay từ lần chạy đầu tiên.**

Cách làm: khi nhận cuộc gọi, truy vấn

```sql
SELECT ma_danh_bo, COUNT(*) n, MAX(created) last_at
FROM voicebot_calllog
WHERE customer_tel = ? AND ma_danh_bo IS NOT NULL
GROUP BY ma_danh_bo ORDER BY last_at DESC LIMIT 5;
```

đưa vào `callState` dưới dạng **`historyDanhBo`** — tách bạch với `knownDanhBo` (đăng ký chính thức):

- `knownDanhBo` → hệ thống cấp, tin được ngay.
- `historyDanhBo` → **chỉ là gợi ý cho trọng tài**, vẫn phải đọc lại cho khách xác nhận
  (khách hoàn toàn có thể hỏi giùm danh bộ khác).

Chi phí: 1 truy vấn có index, ~vài ms. Giá trị: rất lớn với khách quen — mà tổng đài CSKH thì phần lớn
là khách quen.

### 2.2. ⭐ Cấu trúc mã danh bộ — ràng buộc miễn phí chưa hề được dùng

Trích 8 mã danh bộ **thật** (lấy từ trường `danhBa` do API trả về, tức ground truth):

```
15062130012   15161929494   15173430690   22023247431
22023251775   22053297085   22063322535   22103398245
```

Quan sát: **100% dài 11 số**, tiền tố 2 số chỉ thuộc `{15, 22}`, chữ số thứ 3 luôn là `0` hoặc `1`.

> ⚠️ 8 mẫu là **quá ít để kết luận**. Đừng hard-code. Nhưng đây là dấu hiệu rõ ràng rằng mã danh bộ
> **có cấu trúc** (nhiều khả năng 2 số đầu = mã khu vực/chi nhánh).

**Hành động rẻ nhất và có giá trị nhất trong cả kế hoạch: hỏi phía Cấp nước Trung An bảng quy tắc
đánh mã danh bộ.** Nếu có tiền tố theo khu vực → lọc ứng viên rác không tốn một lần gọi API nào.
Nếu có **check digit** → loại được ~90% ứng viên sai **offline, tức thì, chính xác tuyệt đối** —
mọi thứ khác trong tài liệu này lập tức trở thành phụ.

Trước mắt, khi chưa có quy tắc chính thức: rút tiền tố từ DB (mẫu lớn hơn nhiều) và dùng như
**prior mềm** — đưa vào prompt trọng tài (*"mã danh bộ Trung An hầu hết bắt đầu bằng 22 hoặc 15"*)
và dùng để **xếp hạng** ứng viên, **không dùng để loại thẳng**.

### 2.3. ⭐ Xác nhận bằng TÊN khách hàng thay vì đọc lại 11 chữ số

API `getThongTinKhachHang` trả về `{ danhBa, hoTen }` — **`hoTen` đang bị bỏ phí**.

Hiện tại `confirmRequestResponse` bắt bot đọc `danhBoSpoken()` = 11 chữ số cách nhau dấu gạch,
mất **~10 giây**, dễ bị VAD cắt ngang, và khách phải căng tai đối chiếu từng số — chính chỗ này
khách hay xác nhận bừa.

Đề xuất: khi ứng viên **đã verify tồn tại trong API**, xác nhận bằng danh tính thay vì bằng con số:

> *"Dạ, em tìm thấy danh bộ của chú Nguyễn Văn A, đúng không ạ?"*

Nhanh hơn 5 lần, tự nhiên hơn, và **chống nhầm tốt hơn hẳn** — khách nghe tên mình thì biết ngay
đúng/sai, còn nghe 11 chữ số thì rất dễ gật cho xong.

> ⚠️ Cân nhắc **quyền riêng tư**: đọc tên chủ hợp đồng cho người gọi lạ. Nên đọc **rút gọn**
> (*"chú Nguyễn Văn A"* → *"chú A, họ Nguyễn"*) hoặc chỉ dùng khi SĐT gọi đến khớp hợp đồng.
> **Cần hỏi ý kiến Cấp nước Trung An trước khi triển khai.**

### 2.4. Cuộc gọi lỗi nặng nhất lại KHÔNG có file log

`conversation_summary/2026/07/26/` có file cuối lúc **04:28**. Cuộc gọi lỗi diễn ra **04:29–04:32**
→ **không có file nào**. Nhìn cuối log thấy shell prompt trở lại (`vovinhloc@MacBook-Pro... %`) → tiến
trình node đã thoát ngay sau khi WS đóng, `_saveOnce()` (async, trong `ws.on("close")`) chưa kịp ghi xong.

Cần thêm graceful shutdown `SIGINT`/`SIGTERM`: chặn thoát, flush mọi logger đang mở, rồi mới exit.

**Không có log thì không debug được** — nên việc này phải làm **trước** mọi thứ khác, nếu không ta sẽ
sửa mù ở các vòng sau.

### 2.5. Cập nhật transcription prompt giữa cuộc gọi

`call-manager.js:51` đang set prompt **tĩnh**, chung cho cả cuộc gọi. Khi bước vào giai đoạn thu danh bộ,
có thể `session.update` đổi prompt thành thứ chuyên biệt:

> *"Khách đang đọc mã danh bộ 11 chữ số. Phiên âm thành chữ số Ả Rập liền nhau, không viết thành chữ."*

Độ chính xác digit của ASR sẽ tăng đáng kể.

> ⚠️ **Bẫy nghiêm trọng:** `_isPromptEcho` (`session-ws.js:599`) so khớp echo với
> `callOps.acceptParams...transcription.prompt` — tức prompt **lúc accept**. Nếu đổi prompt giữa chừng
> mà không cập nhật biến so khớp, **echo sẽ lọt thẳng vào `_danhBoTranscripts`** và đầu độc trọng tài.
> Phải sửa `_isPromptEcho` đọc prompt **hiện hành** trong cùng lần sửa, không được tách ra.

### 2.6. Cắt mốc "phiên đọc số" thay vì gom vô hạn

Mỗi khi code phát câu mời đọc lại, đặt `_danhBoReadSessionStart = Date.now()`. Trọng tài chỉ dùng
transcript **sau mốc đó** (hoặc ưu tiên tuyệt đối nhóm sau mốc).

Trong cuộc gọi mẫu, lượt 6 (`22023251775` — đáp án đúng, đọc liền mạch, không sai một số) là một lần
đọc lại **hoàn toàn mới**, nhưng bị trộn chung với 5 lượt rác trước đó. Ngoài ra nên gom transcript
theo **cụm thời gian liền kề** (các lượt cách nhau < 8 giây thuộc cùng một lần đọc).

### 2.7. API tra cứu nên là trọng tài cuối, không phải bộ lọc

`candidateExistsInApi` (~40ms/lần theo log) hiện chỉ dùng như **pass/fail cho đúng 1 ứng viên**.
Nên dùng nó để phân xử **một tập ứng viên**:

- **Top-N từ trọng tài** — đổi schema arbiter sang mảng `ung_vien[]` (2–5 phần tử, giảm dần theo tin cậy).
  Lần chạy #2 trả `22003251775` — **lệch đúng 1 chữ số** so với đáp án; đáp án gần như chắc chắn nằm trong top-3.
- **Biến thể 1 lỗi** — dãy 10 số thì thử thêm 1 chữ số vào đầu (10 khả năng): đúng case `0223251775` → `22023251775` ✓.
- **Cửa sổ trượt 11 số** trên chuỗi transcript ghép.

Chỉ nhận khi **đúng một** ứng viên tồn tại (nhiều hơn một → mơ hồ, phải hỏi khách).
**Bắt buộc giới hạn** tổng số lần gọi API cho việc dò (đề xuất ≤ 15 lượt/cuộc gọi) để không tạo tải
bất thường lên backend của khách hàng.

Kèm theo: `ARBITER_MIN_CONFIDENCE = 0.7` nên **hạ hoặc bỏ** khi đã có API phân xử — giữ 0.7 làm ngưỡng
cho trường hợp API không phản hồi. Và `ARBITER_REASONING_EFFORT` có thể nâng `low → medium` một khi
trọng tài chạy nền hoàn toàn (không còn chặn ai).

### 2.8. Chưa có cách đo "fix có ăn thua không"

Mọi fix từ 18/07 đến nay đều dựa trên **một cuộc gọi mẫu**. Không ai biết tỉ lệ thành công thực sự
đang là bao nhiêu, và fix hôm nay có làm hồi quy fix hôm qua không.

Đề xuất ghi vào mỗi bản ghi cuộc gọi:

| Trường | Ý nghĩa |
|---|---|
| `danh_bo_resolved_by` | `transcript_11` \| `dtmf` \| `arbiter` \| `known_tel` \| `history_tel` \| `none` |
| `danh_bo_turns` | số lượt khách đọc số |
| `danh_bo_seconds` | số giây từ lúc bắt đầu xin số tới lúc `confirmed` |
| `danh_bo_arbiter_calls` | số lần gọi gpt-5.1 |
| `bot_hallucinated_digits` | số lần bot đọc số không được phép |

Rồi làm một script thống kê chạy trên `conversation_summary/`. **Đây là điều kiện tiên quyết để biết
các giai đoạn dưới có thật sự cải thiện hay không.**

### 2.9. Dọn log rác

Log cuộc gọi mẫu có **hơn 40 khối** `==========[normalizeDanhBo]==========`, làm việc đọc log rất mệt
và che mất các dòng quan trọng. Chuyển sang `log.debug` hoặc gỡ hẳn.

---

## 3. Kế hoạch thực hiện theo giai đoạn

### Giai đoạn 0 — Điều kiện tiên quyết (làm trước, nửa ngày)

| # | Việc | File | Rủi ro |
|---|---|---|---|
| 0.1 | Graceful shutdown `SIGINT`/`SIGTERM`, flush logger trước khi thoát (§2.4) | `server.js` | Thấp |
| 0.2 | Thêm 5 trường đo lường vào bản ghi cuộc gọi (§2.8) | `conversation-logger.js` | Thấp |
| 0.3 | Script thống kê tỉ lệ chốt danh bộ trên `conversation_summary/` — **chạy ngay để lấy số nền** | mới | Không |
| 0.4 | Dọn `console.log` của `normalizeDanhBo` (§2.9) | `tools.js` | Không |
| 0.5 | **Gửi công văn hỏi CNTA quy tắc đánh mã danh bộ** (tiền tố khu vực? check digit?) (§2.2) | — | Không |

> Không có 0.1 thì cuộc gọi lỗi tiếp theo lại mất log. Không có 0.2 + 0.3 thì không ai biết các giai
> đoạn sau có hiệu quả hay không. 0.5 nên gửi ngay vì phải chờ phía khách hàng trả lời.

---

### Giai đoạn 1 — Chặn nguồn bịa số + bắt đúng case dễ nhất (1 ngày) ⭐

| # | Việc | File | Ghi chú |
|---|---|---|---|
| 1.1 | **Gỡ `ma_danh_bo` khỏi `properties` + `required` của 5 tool tra cứu** (§0) | `system-prompt.js:217-282` | Model hết đường bịa. Sửa luôn `SYSTEM_PROMPT` dòng 51/116 cho khỏi mâu thuẫn |
| 1.2 | `resolveDanhBo` bỏ hẳn `rawArg` khỏi `digitsAvailable()` và khỏi điều kiện thoát sớm | `tools.js:662-678` | Đúng nguyên tắc "không tin tai model" đã ghi ở `CLAUDE.md` |
| 1.3 | **Bắt transcript đúng 11 số ngay tại `session-ws`**, không chờ model gọi tool: set `danhBo` + `_speakVerbatim` đọc lại xác nhận | `session-ws.js:620-631` | Riêng mục này đã cứu được cuộc gọi mẫu |
| 1.4 | Sửa `notEnough()` — vượt 11 số **không** báo `do_dai_hien_tai: 0` mà chuyển thẳng sang DTMF (§1.3b) | `tools.js:681-689, 738` | Hết cảnh hỏi khách lại từ đầu |
| 1.5 | Leo thang theo trải nghiệm khách: `_danhBoTurnCount >= 3` **hoặc** quá 60 giây → mời DTMF | `session-ws.js` | Cuộc mẫu sẽ được mời bấm phím lúc 04:30:07 thay vì không bao giờ |
| 1.6 | Đồng bộ `entrySig` / `_danhBoLastResolveSig` (§1.3, lệch nhỏ) | `tools.js:692, 718` | Giảm gọi gpt-5.1 dư |

> ⚠️ **1.3 cần một guard:** số điện thoại VN cũng có 10–11 chữ số. Chỉ kích hoạt khi đang thật sự ở
> trong ngữ cảnh xin danh bộ (đã có `_danhBoLastPrompt`, hoặc bot vừa hỏi xin danh bộ).

**Tiêu chí nghiệm thu GĐ1:** dựng lại đúng kịch bản cuộc gọi mẫu (khách đọc tách 3 hơi, sau đó đọc
liền 11 số) → bot phải chốt đúng `22023251775` trong vòng **≤ 60 giây**, và **không đọc ra loa bất kỳ
chữ số nào khách chưa từng nói**.

---

### Giai đoạn 2 — Bỏ chặn đồng bộ, code làm chủ lời thoại (2 ngày)

| # | Việc | File | Ghi chú |
|---|---|---|---|
| 2.1 | `resolveDanhBo` trả kết quả **ngay**, kèm `dang_gom_so` (§1.2 mức 1) | `tools.js:702-725` | Hết khoảng treo 21 giây |
| 2.2 | Chuyển gom số + trọng tài + đọc lại sang **đường nền** (bật lại `_maybeAssembleDanhBo` hoặc gộp với 1.3) | `session-ws.js:192-217, 630` | Về đúng mô hình DTMF |
| 2.3 | `create_response: false` trong lúc thu danh bộ + **watchdog 90 giây** + bật lại ở mọi nhánh thoát (§1.2 mức 2) | `session-ws.js` | Rủi ro cao nhất kế hoạch — test kỹ nhánh `end_call`/`transfer`/lỗi |
| 2.4 | Cắt mốc phiên đọc số + gom theo cụm thời gian < 8 giây (§2.6) | `session-ws.js`, `tools.js` | Làm sạch đầu vào trọng tài |
| 2.5 | Push arg model vào `_danhBoReads` từ `resolveDanhBo`; xoá code chết `handleConfirmDanhBo` | `tools.js:544, 482` | Trọng tài có lại đủ 2 "tai" |

> **Chỉ làm 2.3 sau khi 2.1 + 2.2 đã chạy ổn định.** Nếu code chưa làm chủ được lời thoại mà đã khoá
> mõm model thì bot sẽ câm.

**Tiêu chí nghiệm thu GĐ2:** không cuộc gọi nào có `function_call_output` trả về chậm hơn **2 giây**;
`bot_hallucinated_digits = 0` trên toàn bộ tập test.

---

### Giai đoạn 3 — Tăng tỉ lệ chốt số (2–3 ngày)

| # | Việc | File | Ghi chú |
|---|---|---|---|
| 3.1 | **Lịch sử danh bộ theo SĐT từ DB** → `historyDanhBo`, đưa vào prompt trọng tài như mục riêng (§2.1) | `db.js`, `server.js`, `danh-bo-arbiter.js` | Tác động lớn nhất trong GĐ3, chi phí gần như bằng 0 |
| 3.2 | Trọng tài trả **top-3** ứng viên; API verify lần lượt, lấy cái đầu tiên tồn tại (§2.7) | `danh-bo-arbiter.js`, `tools.js:369-390` | Hạ/bỏ `ARBITER_MIN_CONFIDENCE` |
| 3.3 | Sinh **biến thể 1 lỗi** + cửa sổ trượt khi ứng viên NOT_FOUND, có **trần 15 lượt API/cuộc gọi** (§2.7) | `tools.js:400-415` | Bắt case `0223251775` → `22023251775` |
| 3.4 | Đưa ràng buộc cấu trúc mã danh bộ vào prompt trọng tài (§2.2) | `danh-bo-arbiter.js` | Dùng làm **prior mềm**, tuyệt đối không loại thẳng |
| 3.5 | Nâng `ARBITER_REASONING_EFFORT` `low → medium` (chỉ khi đã chạy nền hoàn toàn) | `.env` | Đo lại độ trễ trước/sau |

**Tiêu chí nghiệm thu GĐ3:** tỉ lệ chốt được danh bộ tăng có ý nghĩa so với **số nền đo ở bước 0.3**
(dùng chính script đó, không đánh giá bằng cảm tính).

---

### Giai đoạn 4 — Trải nghiệm & chất lượng ASR (1–2 ngày, cần CNTA duyệt)

| # | Việc | File | Ghi chú |
|---|---|---|---|
| 4.1 | **Xác nhận bằng tên khách hàng** thay vì đọc 11 chữ số (§2.3) | `tools.js:250-264` | ⚠️ Cần CNTA duyệt về quyền riêng tư trước |
| 4.2 | Đổi transcription prompt riêng cho giai đoạn đọc số (§2.5) | `call-manager.js`, `session-ws.js` | ⚠️ **Phải sửa `_isPromptEcho` trong cùng lần sửa** |
| 4.3 | Áp quy tắc cấu trúc chính thức từ CNTA (nếu 0.5 có kết quả) | `tools.js` | Có check digit thì đây là fix mạnh nhất toàn bộ kế hoạch |

---

## 4. Ma trận ưu tiên

| Việc | Công sức | Tác động | Rủi ro | Ưu tiên |
|---|---|---|---|---|
| 1.1 Gỡ `ma_danh_bo` khỏi schema | Rất thấp | **Rất cao** | Rất thấp | **1** |
| 1.3 Bắt transcript 11 số tại session-ws | Thấp | **Rất cao** | Thấp | **2** |
| 0.1 Graceful shutdown | Rất thấp | Cao (gián tiếp) | Rất thấp | **3** |
| 3.1 Lịch sử danh bộ theo SĐT | Thấp | **Rất cao** | Thấp | **4** |
| 1.5 Leo thang theo lượt/giây | Thấp | Cao | Thấp | **5** |
| 0.2+0.3 Đo lường | Trung bình | Cao (gián tiếp) | Không | **6** |
| 2.1+2.2 Bỏ chặn đồng bộ | Trung bình | Cao | Trung bình | 7 |
| 3.2 Trọng tài top-3 | Trung bình | Cao | Thấp | 8 |
| 2.3 `create_response: false` | Trung bình | Cao | **Cao** | 9 |
| 3.3 Biến thể 1 lỗi | Trung bình | Trung bình | Trung bình | 10 |
| 4.1 Xác nhận bằng tên | Thấp | Cao | Cần duyệt | 11 |
| 0.5 Hỏi CNTA quy tắc mã | Rất thấp | **Có thể rất cao** | Không | Gửi ngay |

---

## 5. Nguyên tắc nên bổ sung vào `CLAUDE.md`

1. **Không khai báo `required` cho tham số mà model có thể không biết.** Structured output sẽ ép model
   bịa. Ngược hẳn với ý định thiết kế.
2. **Mọi đường xử lý danh bộ phải có lối đi không phụ thuộc việc model gọi tool.** Fix 25/07 tắt đường
   nền đã vô tình biến model mini thành điểm lỗi đơn cho bước quan trọng nhất cuộc gọi.
3. **Không để tool call treo quá ~2 giây trong cuộc gọi thoại.** VAD vẫn sinh response trong lúc treo,
   và model **luôn** lấp khoảng trống bằng nội dung bịa. Việc chờ phải nằm ở đường nền.
4. **API tra cứu là trọng tài rẻ nhất và chắc nhất.** Đừng bắt LLM chọn duy nhất một đáp án khi có thể
   cho nó đề xuất vài phương án rồi để API phân xử.
5. **Ngưỡng leo thang tính theo trải nghiệm khách** (số lượt đã đọc, số giây đã trôi), không theo số lần
   code chạy qua một nhánh nội bộ.
6. **Mỗi fix phải kèm cách đo.** Sửa dựa trên một cuộc gọi mẫu mà không có số liệu nền thì không biết
   được là cải thiện hay hồi quy.

---

## 6. Rủi ro hồi quy cần canh

Các fix cũ dễ bị đụng nhất — chạy lại kịch bản tương ứng sau mỗi giai đoạn:

| Fix cũ | Bị đụng bởi | Triệu chứng nếu hồi quy |
|---|---|---|
| `fix_echo_cancel_nham_response_20260718` | 2.3, 4.2 | Bot câm 20–30 giây giữa cuộc |
| `fix_danh_bo_copilot_dtmf_20260719` | 1.5, 2.2 | DTMF không được nhận hoặc mời quá sớm |
| `fix_danh_bo_trong_tai_20260719` | 2.5, 3.2, 3.4 | Trọng tài đề xuất lặp lại số đã bị bác |
| `fix_end_call_khong_tam_biet_20260718` | 2.3 | Cúp máy khi chưa nói lời tạm biệt |
| Gate `_danhBoNeedsVerbalYes` | 1.3, 3.2 | Tra cứu bằng số chưa được khách xác nhận → **đọc nhầm thông tin người khác** (nghiêm trọng nhất) |

---

## 7. Tham chiếu code

| Chủ đề | File | Dòng |
|---|---|---|
| `required: ["ma_danh_bo"]` (5 chỗ) | `src/system-prompt.js` | 221, 239, 256, 270, 282 |
| Chỉ thị mâu thuẫn trong SYSTEM_PROMPT | `src/system-prompt.js` | 51, 116 |
| Đường nền bị tắt | `src/session-ws.js` | 620–631 (dòng 630) |
| Hàm nền còn nguyên | `src/session-ws.js` | 192–217 |
| `_isPromptEcho` bám prompt lúc accept | `src/session-ws.js` | 599–612 |
| `_speakVerbatim` (mẫu để nhân rộng) | `src/session-ws.js` | 157–181 |
| `_reAssertDanhBoStep` | `src/session-ws.js` | 126–151 |
| Vòng chờ 15 giây | `src/tools.js` | 702–715 |
| `digitsAvailable` dùng arg model | `src/tools.js` | 675–678 |
| `notEnough` báo sai độ dài | `src/tools.js` | 681–689, 738 |
| Cache sig lệch | `src/tools.js` | 692, 718 |
| `handleConfirmDanhBo` (code chết) | `src/tools.js` | 482–589 |
| Lọc ứng viên trọng tài | `src/tools.js` | 344–390 |
| Schema 1 ứng viên | `src/danh-bo-arbiter.js` | 38–64 |
| Transcription prompt tĩnh | `src/call-manager.js` | 39–55 |
| Lookup SĐT lúc nhận cuộc gọi | `server.js` | 184–200 |
| Bảng `voicebot_calllog` | `db/schema.sql` | 97–153 |
