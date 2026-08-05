# Migrate model realtime lên gpt-realtime-2.1-mini (30/07/2026)

Yêu cầu gốc: code hiện tại được phát triển với các workaround nhắm vào model
`gpt-realtime` đời cũ (không có reasoning) — rà soát lại logic, prompt, và luồng
lấy mã danh bộ, cập nhật theo tài liệu chính thức:
[Realtime models prompting guide](https://developers.openai.com/api/docs/guides/realtime-models-prompting).

Model đích do chủ dự án chọn: **`gpt-realtime-2.1-mini`** (không phải bản đầy đủ
`gpt-realtime-2.1`) — bản chưng cất, có reasoning + tool use, giá ngang
`gpt-realtime-mini` cũ. Phạm vi được chọn: **tái kiến trúc sâu** — đánh giá lại
việc có nên bỏ MỨC C (`create_response: false`) và để model tự thu thập mã
danh bộ theo pattern "Entity Collection Workflow" chính thức của OpenAI.

---

## Vì sao không thể "chỉ đổi tên model"

Đọc kỹ [guide gốc](https://developers.openai.com/api/docs/guides/realtime-models-prompting)
+ [VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad) +
[model card gpt-realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1),
rút ra vài điểm quan trọng cho migration này:

1. **Guide gốc không nhắc tên "gpt-realtime-2.1" hay "gpt-realtime-2.1-mini"** —
   chỉ nói về `gpt-realtime-2` (reasoning) và `gpt-realtime-1.5` (không reasoning).
   Model card riêng của `gpt-realtime-2.1` xác nhận: *"updates GPT-Realtime-2 with
   improved alphanumeric recognition, silence and noise handling, and interruption
   behavior"* — đúng 3 điểm yếu mà toàn bộ workaround trong repo này (MỨC C, nới
   VAD, trọng tài gpt-5.1, DTMF) được dựng lên để bù đắp.
2. **`gpt-realtime-2`/`2.1.x` tuân lệnh literal hơn hẳn model cũ** — quote nguyên
   văn: *"gpt-realtime-2 follows instructions more literally than earlier realtime
   models. Prompts that worked well on older models may need tuning."* Đây là lý
   do phải sửa cả `system-prompt.js`, không chỉ đổi `OPENAI_REALTIME_MODEL`.
3. **`reasoning_effort` là tham số MỚI**, không tồn tại ở model cũ. Field đúng
   theo API reference: `session.reasoning = { effort: "low"|"medium"|... }` (gửi
   trong `session.update` hoặc ngay trong body `accept` — xem `call-manager.js`).
   Khuyến nghị của OpenAI: bắt đầu với `low` cho voice agent CSKH.
4. **VAD guide xác nhận schema hiện tại của repo đã ĐÚNG** — `session.audio.input.
   turn_detection` (không phải field phẳng `session.turn_detection` đã deprecated ở
   API rất cũ). `session-ws.js` đã dùng đúng dạng lồng nhau từ trước — không có gì
   phải sửa ở điểm này.
5. **`wait_for_user`** là tool no-op chính thức OpenAI khuyến nghị cho đúng vấn đề
   "model phải nói gì đó mỗi lượt VAD" — về bản chất giống MỨC C nhưng thực thi ở
   tầng prompt/tool (advisory), KHÔNG phải khoá cứng API-level như
   `create_response: false`. Guide tự nhận đây là cơ chế yếu hơn một lock thật.

Kết luận (quan trọng cho quyết định "tái kiến trúc sâu" bên dưới): dời sang
model reasoning tốt hơn không tự động làm cho MỨC C trở nên thừa — OpenAI khuyến
nghị pattern tương đương (`wait_for_user`) NHƯNG cảnh báo nó yếu hơn lock cứng.
Vì vậy thay đổi được triển khai làm **thử nghiệm có thể bật/tắt qua biến môi
trường**, không phải thay thế một chiều.

---

## Thay đổi

### 1. Model + reasoning_effort + voice (`call-manager.js`, `conversation-logger.js`, `.env.example`)

- `OPENAI_REALTIME_MODEL` mặc định: `gpt-realtime-2` → `gpt-realtime-2.1-mini`.
- Thêm `reasoning: { effort: process.env.OPENAI_REALTIME_REASONING_EFFORT || "low" }`
  vào body `accept()` — đây là session-create thật sự cho cuộc gọi SIP (không phải
  `session.update` sau đó), nên field phải nằm ở đây.
- Thêm `audio.output.voice` vào body `accept()`. Phát hiện phụ trong lúc audit:
  `OPENAI_VOICE` trong `.env` trước đây là **config chết** — dòng gán `voice` duy
  nhất nằm trong khối comment ở `session-ws.js`, chưa từng thật sự gửi cho OpenAI.
  Đã bổ sung đường dẫn đúng theo API hiện hành: `session.audio.output.voice`.
- `openai_pricing.json` đã sẵn có entry `gpt-realtime-2.1` và `gpt-realtime-2.1-mini`
  từ trước (không rõ ai thêm, không cần sửa) — `pricing.js` tính cost đúng ngay.

### 2. `system-prompt.js` — thêm mục theo cấu trúc khuyến nghị của guide mới

Giữ NGUYÊN VẸN mọi rule tiếng Việt đã có (kết quả của hàng chục lần fix thật),
chỉ **thêm** các mục còn thiếu so với cấu trúc `# Role and Objective / Personality
and Tone / Language / Reasoning / Preambles / Tools / Unclear Audio / Entity
Capture / Escalation` của guide:

| Mục thêm | Vì sao |
|---|---|
| `# Ngôn ngữ` | Guide cảnh báo: giọng/accent KHÔNG phải tín hiệu đổi ngôn ngữ — chưa có rule này trước đây. |
| `# Suy luận` | `reasoning_effort` mới — cần nói rõ khi nào model nên "nghĩ" trước khi nói/gọi tool, khi nào phản hồi ngay. |
| `# Câu dẫn trước khi xử lý` | Preamble là hành vi mặc định mới của model reasoning — cần định hình khi nào dùng/không dùng. |
| `# Tools` | Guard "chỉ dùng tool có trong danh sách, không bịa tool" — chưa có rule tường minh; thêm cả bảng eagerness ngắn (tool đọc gọi ngay, tool ghi/tác động thật mới cần rõ ý khách). |
| `# Âm thanh không rõ` | Formalize hoá rule đã có rải rác trong `# Phong cách`, dẫn chiếu rõ ràng tới `wait_for_user`. |
| `# Thu thập mã danh bộ` | **Quan trọng nhất** — nói rõ cho model: việc lấy/xác minh mã danh bộ do CODE điều phối, model chỉ làm theo state hệ thống đưa ra qua tool result, không tự quyết. Cần thiết hơn hẳn với model tuân lệnh literal — nếu không nói rõ "đây là ngoại lệ do code kiểm soát", model reasoning có thể "hợp lý hoá" việc tự đọc lại số theo đúng tinh thần "giúp khách càng nhanh càng tốt" mà guide khuyến khích ở chỗ khác. |

### 3. Tool `wait_for_user` (`system-prompt.js` TOOLS array, `tools.js`, `session-ws.js`)

Tool no-op theo đúng pattern OpenAI khuyến nghị. `tools.js` có `handleWaitForUser()`
trả `action: "no_reply"`. `session-ws.js`: nhánh xử lý tool kết quả thêm
`else if (action === "no_reply")` — KHÔNG set `_ketQuaToolCuoi`, nên không có
`response.create` nào được tạo sau `function_call_output` này (khác mọi tool khác,
vốn luôn được nối theo một response đọc kết quả).

### 4. `DANH_BO_MODE=locked|unlocked` — thử nghiệm có thể bật/tắt (`session-ws.js`, `.env.example`)

Đây là phần trả lời cho yêu cầu "tái kiến trúc sâu, đánh giá có nên bỏ MỨC C".

- **`locked` (mặc định)**: giữ nguyên hành vi MỨC C hiện tại — `create_response:
  false` trong giai đoạn đọc số, code phát mọi câu qua `_speakVerbatim`. Đây là cơ
  chế đã kiểm chứng qua 8 đợt fix và nhiều cuộc gọi thật (xem
  `fix_danh_bo_hai_bien_muc_b_20260726.md`).
- **`unlocked` (thử nghiệm)**: `create_response: true` ngay cả trong VAD mode
  `"digits"` — model được tự trả lời mỗi lượt, dựa vào mục "Thu thập mã danh bộ"
  mới trong prompt + tool `wait_for_user`, thay vì bị khoá cứng API-level. Mọi
  lưới an toàn khác (phát hiện số bịa `_checkBotSpokenDigits`, kiểm chứng câu nói
  `_checkExpectedSpeak`, watchdog câm `_armMuteWatchdog`, watchdog danh bộ 90s)
  **vẫn hoạt động nguyên vẹn** ở cả hai chế độ — chúng chỉ quan sát/sửa lời bot đã
  nói ra, không phụ thuộc vào cờ này.
- Hai nhánh xử lý transcript vốn giả định model bị khoá cứng
  (`danh_bo_giu_khoa_dang_xac_minh`, `danh_bo_hoan_vi_doi_chu_de`) đã được chú
  thích rõ: ở chế độ `unlocked`, các nhánh này KHÔNG còn đảm bảo ngăn được model
  nói (vì không có lock thật) — đây là rủi ro có chủ đích của thử nghiệm, không
  phải lỗi.

**Vì sao không xoá hẳn MỨC C**: guide của OpenAI tự nhận `wait_for_user` là cơ chế
*advisory*, yếu hơn hẳn lock API-level, chính vì lo ngại đúng kịch bản mà 8 đợt
fix trước đã chứng minh bằng dữ liệu thật (model — kể cả các bản có reasoning —
vẫn có thể "hợp lý hoá" việc tự trả lời khi được phép). Xoá hẳn workaround đã kiểm
chứng để đặt cược hoàn toàn vào một model mini mới chưa có dữ liệu thật là rủi ro
không cân xứng cho một hệ thống CSKH đang chạy production. Cờ môi trường cho phép
thử nghiệm có kiểm soát, rollback tức thì (đổi biến môi trường + restart, không
cần sửa code) nếu cuộc gọi thật cho kết quả xấu.

---

## Biến môi trường mới

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OPENAI_REALTIME_REASONING_EFFORT` | `low` | `reasoning_effort` cho model 2.1.x — minimal\|low\|medium\|high\|xhigh |
| `DANH_BO_MODE` | `locked` | `locked` = MỨC C hiện tại (khuyến nghị); `unlocked` = thử nghiệm để model tự trả lời trong lúc đọc số |

`OPENAI_REALTIME_MODEL` mặc định đổi từ `gpt-realtime-2` → `gpt-realtime-2.1-mini`
(vẫn override được qua `.env`).

---

## Cách test `DANH_BO_MODE=unlocked` bằng cuộc gọi thật

1. Giữ `DANH_BO_MODE=locked` (mặc định) cho vài cuộc gọi đầu sau khi bump model,
   để tách riêng ảnh hưởng của việc đổi model khỏi ảnh hưởng của việc bỏ khoá.
2. Đổi `DANH_BO_MODE=unlocked`, restart server, gọi thử với kịch bản đọc số tách
   nhiều hơi (kịch bản đã làm hỏng cuộc gọi ở các đợt fix trước — xem
   `fix_danh_bo_hai_bien_muc_b_20260726.md` để tái hiện).
3. Theo dõi trong `conversation_summary/.../{tel}_{callId}.json`:
   - Sự kiện `bot_hallucinated_digits` — model có tự đọc số bịa ra loa không.
   - Sự kiện `speak_verbatim_mismatch` — bot có đọc lệch câu code yêu cầu không.
   - Sự kiện `mute_watchdog` — không nên xuất hiện ở chế độ unlocked (model không
     bị khoá nên không thể "câm" theo đúng nghĩa MỨC C phòng); nếu vẫn xuất hiện,
     có nghĩa model thật sự im lặng dù được phép nói — đáng chú ý.
   - Trường `danh_bo_resolved_by` — tỷ lệ `transcript_11` (khách đọc trôi chảy,
     không cần trọng tài) có tăng không so với chế độ locked.
4. Nếu unlocked gây lỗi rõ rệt (bot đọc số sai ra loa, lặp câu, im lặng dài) →
   đổi lại `DANH_BO_MODE=locked` và restart — không cần revert code.

---

---

## Đợt kết quả thử nghiệm `unlocked` — cuộc test `rtc_u1_E7DdCo6xvc1ydygN5r0Ez` (30/07/2026 12:30) ❌

Cuộc test thật đầu tiên với `DANH_BO_MODE=unlocked`. **Thất bại** — khách hỏi tiền
nước, đọc mã danh bộ bình thường, nhưng cuộc gọi kết thúc bằng lỗi API và WS đóng
bất thường (code 1006), khách không bao giờ nghe được câu xác nhận hay kết quả.

```
12:30:46  KH "Số danh bộ là 2202."     → 4/11 số, VAD→digits (create_response:true)
12:30:49  response TỰ SINH (từ VAD, không phải code) → model gọi
          get_bill({"ma_danh_bo":"2203251775"})       ← BỊA 7 số còn thiếu
          classifyModelArg chặn đúng (R4) — không lộ ra ngoài, nhưng lẽ ra
          KHÔNG được phép xảy ra: model không nên tự hành động khi mới nghe 4/11 số.
12:30:50  KH "3251775" → đủ 11/11 số → luồng xác minh chạy nền bình thường
12:31:00  Trọng tài gpt-5.1 chốt đúng 22023251775, conf 0.8, API xác nhận có
          → code _speakVerbatim đọc lại xác nhận (tool_choice:none, verify:true)
12:31:02  bot nói SAI câu — "Dạ, em chưa nhận đủ số danh bộ..." (không phải câu
          code ép đọc) → _checkExpectedSpeak phát hiện lệch, gửi lại lần 1
12:31:05  bot nói SAI lần 2 → gửi lại lần 2 → ĐỤNG một response.create khác
          → lỗi thật từ OpenAI: conversation_already_has_active_response
12:31:08  bot nói lần 3 (vẫn sai) → "Bot KHÔNG đọc được câu sau 3 lần — bỏ cuộc"
12:31:16  WebSocket đóng: 1006 (bất thường), khách chưa từng nghe được kết quả
```

### Chẩn đoán

1. **`create_response:true` cho phép model tự hành động khi mới nghe 4/11 số** —
   đúng lớp lỗi mà MỨC C được dựng lên để xoá bỏ (xem "Đợt 5" trong
   `fix_danh_bo_hai_bien_muc_b_20260726.md`). An toàn cuối (`classifyModelArg`)
   vẫn chặn được số bịa, nhưng bản thân việc model được phép "thử" là dấu hiệu
   2.1-mini KHÔNG tuân theo mục "Thu thập mã danh bộ" mới trong prompt đủ tốt để
   thay thế lock cứng.
2. **Nguyên nhân trực tiếp gây hỏng cuộc gọi**: trong lúc trọng tài chạy nền (~7s),
   `server_vad` (threshold 0.6, khá nhạy cho giai đoạn đọc số) rất có thể bắt phải
   tạp âm/im lặng, và vì `create_response:true` nên tạp âm đó CŨNG tự sinh response
   — đúng lúc code đang cần gửi câu xác nhận qua `_speakVerbatim`. Ở chế độ
   `locked`, việc này không thể xảy ra vì không response nào được tạo nếu code
   không chủ động gọi.
3. **Lỗi `conversation_already_has_active_response` lộ ra một race có thật, độc
   lập với cờ `DANH_BO_MODE`**: `_speakVerbatim` có 2 cơ chế gọi lại độc lập —
   (a) tự chờ `_responseActive` rảnh rồi gửi, và (b) `_checkExpectedSpeak` phát
   hiện bot nói sai rồi tự lên lịch gọi lại. Cả hai chỉ kiểm tra `_responseActive`
   (được SET bởi event `response.created` từ server, có độ trễ round-trip so với
   lúc ta gọi `ws.send`) — nếu cả hai đến lượt trong đúng khoảng trễ đó, CẢ HAI
   cùng gửi `response.create`. Chế độ `unlocked` làm `_responseActive` dao động
   liên tục nên lộ race này ra, nhưng nó tồn tại ở CẢ HAI chế độ.

### Đã sửa (áp dụng ở cả hai chế độ, không chỉ unlocked)

**Race điều kiện trong `_speakVerbatim`** (`session-ws.js`): thêm cờ
`_verbatimSending` phủ đúng khoảng trễ giữa lúc gọi `ws.send` và lúc server xác
nhận qua `response.created`. Mọi lời gọi `_speakVerbatim` (từ cơ chế nào cũng
vậy) trong khoảng đó tự xếp hàng (retry sau 1200ms) thay vì gửi chồng. Cờ được
mở lại ngay khi `response.created` về (bình thường) hoặc sau 5s (lưới an toàn
nếu không event nào về được), và mở ngay nếu `ws.send` tự nó lỗi.

### Kết luận / khuyến nghị

**`DANH_BO_MODE=locked` (mặc định) là lựa chọn đúng cho production hiện tại.**
`gpt-realtime-2.1-mini` — dù có reasoning — chưa cho thấy đủ tin cậy để bỏ khoá
cứng trong giai đoạn thu mã danh bộ; nên tiếp tục dùng `unlocked` chỉ để thử
nghiệm có kiểm soát (không phải khách thật), không đặt làm mặc định. Race điều
kiện trong `_speakVerbatim` là bug thật, đã sửa độc lập với quyết định trên.

---

## Chưa làm trong lần này (nằm ngoài phạm vi được yêu cầu)

- **`extractAsteriskHeaders()` trong `server.js` hard-code `phoneNumber:
  '0967777637'`** cho MỌI cuộc gọi thật (dòng có comment `// tel for test`) —
  nghĩa là tra cứu danh bộ theo SĐT hiện đang luôn tra một số cố định bất kể ai
  gọi vào. Phát hiện trong lúc đọc `server.js` để hiểu luồng `knownDanhBo`, không
  thuộc phạm vi migration model — cần chủ dự án xác nhận đây có phải hành vi debug
  tạm thời trước khi sửa (ảnh hưởng trực tiếp tới việc khách hàng có bị tra nhầm
  hợp đồng người khác hay không).
- Chưa thử nghiệm loại bỏ hẳn `_danhBoSession`/trọng tài gpt-5.1 để model tự làm
  100% — đánh giá ở trên cho thấy rủi ro không cân xứng nếu làm trong một lần,
  nên dừng ở mức cờ `DANH_BO_MODE` có thể kiểm chứng dần bằng dữ liệu thật.

---

## `DANH_BO_MODE=confirm_tool` — thử nghiệm thứ hai, hẹp hơn "unlocked" (30/07/2026)

### Vì sao cần thêm chế độ thứ ba

Sau khi `unlocked` thất bại ở phép thử thật đầu tiên, câu hỏi đặt ra: luồng thu
mã danh bộ do CODE làm chủ hoàn toàn có đang xung đột với model không, và nếu
có thì nên kiểm soát chặt hơn hay trả bớt quyền cho model? Rà lại toàn bộ luồng
(`resolveDanhBo`, `verifyDanhBoFromSession`, `_speakVerbatim`/`_checkExpectedSpeak`)
cho ra một quan sát quan trọng: **độ chính xác của mã danh bộ hoàn toàn KHÔNG
phụ thuộc việc model đọc lại đúng hay sai** — `resolveDanhBo` (dòng "Đã có số ĐÃ
XÁC NHẬN") luôn dùng `callState.danhBo.value` (giá trị CODE xác minh) để tra
cứu, không bao giờ dùng những gì model tự nói ra loa hay tự truyền vào tool arg.
Nghĩa là rủi ro thật của việc nới lỏng không phải "tra nhầm dữ liệu", mà là UX
(khách nghe bot lặp/nói lệch) và TIMING (bot nói chồng lên xử lý nền — đúng lỗi
gặp ở `unlocked`).

Từ đó, thay vì nhị phân "khoá hẳn / mở hẳn" như `unlocked`, `confirm_tool` thu
hẹp đúng phạm vi cần đổi:

- **Giai đoạn GOM SỐ THÔ giữ khoá y hệt `locked`** — đây không phải chỗ xung
  đột, và để model tự nói lúc này vẫn có rủi ro thật (đọc RA MIỆNG một dãy số
  bịa, khác với việc chỉ truyền bậy vào tool arg — vốn đã được `classifyModelArg`
  lọc).
- **Giai đoạn XÁC NHẬN (đã có `callState.danhBo.value`) mở khoá** — model tự đọc
  câu xác nhận qua tool mới `confirm_danh_bo`, thay vì bị code ép đọc nguyên văn
  qua `_speakVerbatim`.

### Thiết kế `confirm_danh_bo` (tools.js)

Khác hẳn tool `confirm_danh_bo` **cũ** (gỡ 23/07/2026) — tool cũ NHẬN dãy số làm
tham số, dùng làm nguồn ghi nhận (rủi ro: tin "tai" model). Tool mới **không
nhận tham số nào**, chỉ đọc lại `callState.danhBo` và trả về đúng MỘT trong ba
trạng thái tường minh (`trang_thai_danh_bo`): `chua_co` / `dang_cho_xac_nhan` /
`da_xac_nhan`, kèm `ma_danh_bo` (giá trị CODE xác minh). Model chỉ ĐỌC HỘ —
không có quyền tự đánh giá đúng/sai hay tự set `confirmed` (cờ này chỉ do
`session-ws.js` set, dựa trên regex bắt từ khẳng định trên transcript THẬT của
khách — không đổi so với trước, xem `[[voicebot-danhbo-verbal-confirm-gate]]`).

### Cơ chế khơi mào lượt nói — vẫn là CODE, không phải model

Model chỉ được sinh phản hồi khi có lượt audio thật của khách HOẶC code tự gửi
`response.create` — không có cơ chế nào để model "tự nhiên" lên tiếng khi khách
đã ngưng nói (trường hợp phổ biến nhất: khách đọc xong 11 số rồi im chờ). Vậy
"trả quyền cho model" ở đây KHÔNG có nghĩa model tự quyết được KHI NÀO nói —
code vẫn khơi mào (`_openDanhBoConfirmTurn` trong `session-ws.js`, tái dùng
đúng hàng đợi `_verbatimSending`/`_responseActive` đã vá race 30/07) — chỉ khác
ở chỗ code không còn ép NÓI CHÍNH XÁC CÂU GÌ, mà ép bằng `tool_choice:
{type:"function", name:"confirm_danh_bo"}` để model BẮT BUỘC gọi đúng tool này
(không phụ thuộc việc model có tuân thủ hướng dẫn bằng lời hay không — **cú
pháp `tool_choice` ép một hàm cụ thể chưa được test thật, cần đối chiếu lại
với log thật trước khi tin cậy hoàn toàn**). `_openDanhBoConfirmTurn` được gọi ở
đúng 2 thời điểm: (1) `_maybeVerifyDanhBo` vừa chốt được ứng viên, (2) khách vừa
xác nhận bằng lời "đúng" (để model nhận TƯỜNG MINH `da_xac_nhan` trong context,
không chỉ tự suy đoán từ việc nghe khách nói đúng).

### Hai cổng ép-verbatim, không phải một

Phát hiện quan trọng khi wire: `session-ws.js` có **HAI** cơ chế ép model đọc
nguyên văn, không chỉ `_speakVerbatim`. Cổng thứ hai nằm ngay trong luồng
dispatch tool chung — bất kỳ tool nào trả về kèm cờ `dang_gom_so`/`dang_xac_minh`/
`invalid_danh_bo`/`moi_bam_phim`/`cho_khach_xac_nhan`/`da_sai_nhieu_lan` đều tự
động bị gắn `instructions: "Đọc CHÍNH XÁC từng từ..."` (+ `tool_choice:"none"`
nếu khớp `_camGoiTool`). Nếu chỉ loại `confirm_danh_bo` khỏi `_camGoiTool` mà bỏ
sót nhánh `_instructions`, kết quả của tool mới VẪN bị ép đọc nguyên văn y hệt
mọi tool khác — thiết kế "để model tự đọc tự nhiên" coi như vô nghĩa. Đã sửa cả
hai: `confirm_danh_bo` không rơi vào `_camGoiTool` (nó không set các cờ cũ ở
trên, cộng thêm điều kiện tường minh theo tên tool làm lưới phòng thủ), và
`_instructions` cho riêng tool này là gợi ý ngữ cảnh chứ không phải trích dẫn
ép đọc.

### Chống model tự gọi lặp tool vô hạn lần

Trục lỗi mới mà `requestNo`/`_danhBoProposeCount` (đếm "khách đọc lại bao nhiêu
lần") KHÔNG bắt được: model tự gọi lại `confirm_danh_bo` (hoặc một tool dữ liệu
rơi vào nhánh "đang chờ xác nhận" của `resolveDanhBo`) nhiều lần liên tiếp mà
không có lượt khách nào xen giữa → khách nghe lặp lại CÙNG một câu xác nhận vô
ích. Gate `danhBoConfirmSpamGate` (tools.js) so **chữ ký** (trạng thái + giá trị
`ma_danh_bo`, không chỉ trạng thái — để không hiểu lầm "trọng tài đề xuất ứng
viên MỚI sau khi bị bác" là một lần lặp) với lần gọi trước; lặp lại mà chưa có
`noteDanhBoConfirmNewTurn` (gọi mỗi khi có lượt khách THẬT) thì tăng bộ đếm.
Vượt `DANH_BO_CONFIRM_SPAM_MAX` (mặc định 3) → `_danhBoConfirmSpamEscalate:true`
→ `session-ws.js` tự khoá lại (`_setVadMode("digits")`) + `_speakVerbatim` đọc
câu xác nhận một lần (fallback về cơ chế cũ đã kiểm chứng, KHÔNG xoá
`_speakVerbatim` khỏi codebase) — không mời bấm DTMF (mã đã đúng, chỉ là model
hỏi lặp; DTMF sai ngữ cảnh, gây khó hiểu cho khách). Gate này được gọi CHUNG từ
cả `handleConfirmDanhBo` lẫn `confirmRequestResponse` (dùng bởi mọi tool dữ liệu
khi bị `resolveDanhBo` redirect vào nhánh "đang chờ xác nhận"), nên model bỏ
qua `confirm_danh_bo` và spam `get_bill` thay vào đó cũng bị bắt.

### Khi khách bác bỏ ("sai")

Đã mở khoá cho bước xác nhận vừa rồi thì phải khoá lại (`_setVadMode("digits")`)
trước khi quay lại gom số — nếu không, tạp âm có thể tự kích hoạt response ngay
giữa lúc đường nền đang chạy lại (đúng rủi ro đã gặp ở `unlocked`).

### FIX PHỤ phát hiện khi wire tính năng này (không thuộc phạm vi yêu cầu ban đầu)

Công thức `create_response` cho VAD "digits" (`session-ws.js`) từng viết
**`!_DANHBO_UNLOCKED`** — NGƯỢC dấu so với chú thích ngay phía trên nó
("`DANH_BO_MODE=unlocked` → **true**: model được tự trả lời"). Với
`_DANHBO_UNLOCKED=false` (locked, mặc định): `!false = true` → model **không**
bị khoá trong giai đoạn gom số dù `DANH_BO_MODE=locked`. Đã sửa thành so trực
tiếp (`create_response: _DANHBO_UNLOCKED`) — đúng với `locked`/`confirm_tool`
(cả hai cần `false`) và `unlocked` (cần `true`).

**Chưa xác định được mức ảnh hưởng thực tế của bug này tới các cuộc gọi trước
đây** — phần lớn lời thoại trong giai đoạn thu số do CODE chủ động gửi
`response.create` (`_speakVerbatim`/`_requestModelReply`), các lời gọi này
không phụ thuộc field `create_response` của cấu hình VAD; bug chỉ mở đường cho
model tự sinh response theo VAD tự nhiên (không phải do code khơi mào) trong
lúc gom số — cần đối chiếu lại conversation_summary của các cuộc gọi thật gần
đây (tìm response có `trigger` khác `"code"` xảy ra trong giai đoạn gom số) để
đánh giá tác động, việc này CHƯA làm trong lần sửa này.

### Chưa làm / cần lưu ý khi test thật `confirm_tool`

- Cú pháp `tool_choice: {type:"function", name:"confirm_danh_bo"}` dựa theo quy
  ước function-calling chung, CHƯA đối chiếu 1-1 với doc Realtime API — nếu
  model không tuân thủ ép buộc này khi test thật, đây là nghi phạm đầu tiên.
- Luồng xác nhận qua DTMF (`_speakVerbatim` cho `dtmf_danh_bo_confirm`) KHÔNG
  đổi sang cơ chế mới trong đợt này — DTMF là đường escalation đã hiếm khi chạm
  tới, giữ nguyên cơ chế cũ để giảm bề mặt thay đổi.
- Escalation khi vượt ngưỡng spam mới dừng ở mức fallback đọc lại một lần; NẾU
  fallback đó cũng thất bại (`_checkExpectedSpeak` bỏ cuộc sau 3 lần), code hiện
  chỉ log `speak_verbatim_mismatch_giveup` chứ chưa chủ động ép chuyển máy — có
  thể cần bổ sung nếu thực tế cho thấy cần thiết.

---

## Fix 30/07/2026 (tối) — hai nguồn cùng nói "đang xác minh" đụng độ

### Cuộc `rtc_u0_E7JGG7YLOPmJfNx4alnIn` — bot nói linh tinh, kể cả tiếng Anh

Test thật ngay sau khi sửa bug boolean `create_response` ở trên (chế độ
`locked` mặc định, CHƯA dùng `confirm_tool`) lộ ra một bug có thật, độc lập với
mọi thứ đã làm hôm nay:

1. Khách đọc xong 11 số. `session.update` chuyển VAD sang `digits`
   (`create_response:false`) có độ trễ round-trip — response do VAD **cũ**
   (semantic_vad, `create_response:true`) đã kịp tự sinh ra ngay trên chính
   lượt đọc số đó: bot nói một câu dẫn rồi tự gọi `get_bill` với số BỊA (khác
   hẳn số khách vừa đọc). `classifyModelArg` bắt đúng (R4), không lộ dữ liệu
   sai — nhưng bot đã nói sai kịch bản.
2. Tool trả `dang_xac_minh` → **HAI nguồn độc lập cùng cố nói** gần như đồng
   thời: (a) khối dispatch tool CHUNG (`_camGoiTool` ép đọc nguyên văn vì có cờ
   `dang_xac_minh`), và (b) `_maybeVerifyDanhBo` (đường nền) tự gọi
   `_speakVerbatim` filler. Cả hai giành đúng một response slot →
   `conversation_already_has_active_response`.
3. Trọng tài chốt xong mã đúng, hệ thống gửi tiếp câu xác nhận (`danh_bo_confirm`)
   — TRONG LÚC câu filler cũ (`danh_bo_verify_filler`) vẫn đang retry dở dang.
   Hai tag khác nhau cùng retry qua đúng một hàng đợi (`_verbatimSending`/
   `_responseActive`) — không có cơ chế huỷ tag CŨ khi có tag MỚI quan trọng
   hơn thay thế — dội liên tiếp nhiều chỉ dẫn "BỎ QUA hết, chỉ nói đúng câu
   này" mâu thuẫn nhau vào model. Sau 4-5 vòng model bỏ tuân thủ, nói linh
   tinh, có lúc chuyển hẳn sang tiếng Anh.

**Không phải bug do `confirm_tool`** (cuộc này chưa dùng chế độ đó) — bug boolean
sửa hôm nay chỉ vô tình làm `locked` LẦN ĐẦU khoá thật (`create_response` trước
đó luôn `true` do đảo dấu), việc khoá thật lại phơi bày cuộc chiến giành-lượt-
nói vốn đã tồn tại từ trước nhưng bị che khuất vì VAD luôn tự lo thay.

**Gốc rễ:** `_expectedSpeak` là MỘT slot toàn cục, nhưng nhiều nơi độc lập (tool-
dispatch chung, `_maybeVerifyDanhBo`, DTMF...) đều có thể tự đặt vào đó một câu
cần nói, mỗi nơi tự retry theo tag riêng — không nơi nào biết về nơi khác, không
nơi nào huỷ nơi khác.

**Điểm sáng:** tầng dữ liệu vẫn an toàn suốt — số bịa bị lọc đúng, mã cuối cùng
chốt đúng, không có tra cứu sai người. Thiệt hại 100% ở tầng "nói ra sao, lúc
nào", không phải "nói với ai" / "tra thông tin của ai".

### Đã vá (hẹp, theo lựa chọn của chủ dự án — ưu tiên rủi ro thấp, test được ngay)

`session-ws.js`: khi tool trả về `dang_xac_minh`, KHÔNG set `_ketQuaToolCuoi`
(bỏ qua hẳn response.create của khối dispatch tool CHUNG cho đúng trạng thái
này) — để `_maybeVerifyDanhBo` là nguồn DUY NHẤT quyết định nói gì/khi nào cho
trạng thái "đang xác minh". `_armDanhBoWatchdog()` vẫn chạy bình thường (không
liên quan tới việc nói). An toàn vì `dang_xac_minh` chỉ được trả về khi đã đủ
11 số trong phiên — nghĩa là `_maybeVerifyDanhBo` chắc chắn đã được kích hoạt
(hoặc sắp chạy) trước hoặc cùng lúc, nên khách vẫn sẽ nghe được câu chờ/xác
nhận từ đường nền, chỉ là không tức thời từ đúng lượt gọi tool đó.

### Chưa làm (ghi nhận cho lần sau, KHÔNG làm trong đợt vá hẹp này)

Chủ dự án đã chọn vá hẹp trước, sửa hệ thống sau. Việc sửa hệ thống — gộp mọi
nơi muốn nói thành MỘT cổng tập trung, ý định mới luôn thay thế ý định cũ thay
vì cả hai cùng retry song song — vẫn là việc cần làm tiếp theo nếu còn phát
sinh những va chạm tương tự ở nơi khác (không chỉ `dang_xac_minh`, mà bất kỳ
cặp nguồn nói nào khác dùng chung `_expectedSpeak`).

---

## Fix 30/07/2026 (tối, đợt 2) — `viDigitsFromWords` bỏ toàn bộ câu vì một từ khung câu

### So sánh 2 cuộc test thật cùng lúc: đọc 1 hơi (thành công) vs đọc tách chữ (sụp đổ)

**Cuộc `rtc_u2_E7JUTjlLdDEkQgsg661xG`** (khách đọc "Số danh bộ là 2202 3251 775."
— ASR ra NGUYÊN CHỮ SỐ): thành công trọn vẹn, tra đúng dữ liệu, kết thúc gọn.
Chỉ có 2 câu thoại thừa không ảnh hưởng dữ liệu: (1) một câu dẫn thừa do đúng
race đã biết (VAD cũ tự tạo response ngay trên lượt kích hoạt chuyển sang
`digits`, trước khi khoá kịp có hiệu lực — xem phần "Vì sao không thể chỉ đổi
tên model"), cộng thêm một prompt-echo không bị huỷ vì đang có lượt khách thật
chưa trả lời (guard `_unansweredRealTurn`, cố ý để không cắt nhầm câu trả lời
thật); (2) lần đọc xác nhận ĐẦU TIÊN model không tuân thủ đọc nguyên văn, nhưng
tự phục hồi đúng ở lần retry kế — cơ chế `_checkExpectedSpeak` hoạt động đúng
thiết kế. Cả hai đều là giới hạn đã biết, không phải lỗi mới, không cần vá thêm
trong đợt này.

**Cuộc `rtc_u1_E7JWxaN1u2ZbQG9SnKbwh`** (khách đọc TÁCH CHỮ qua nhiều lượt: "Số
danh bộ là hai hai không hai ba hai năm một." — ASR ra CHỮ, không ra số): sụp
đổ hoàn toàn, khách cúp máy sau khi bot lặp lại 4 câu chào hỏi chung chung
không liên quan. Gốc rễ: `viDigitsFromWords` (tools.js) yêu cầu **MỌI** token
trong CẢ câu đều là chữ số đọc bằng lời — chỉ cần MỘT từ khung câu bình thường
xen vào ("Số danh bộ **là**...") là hàm trả về CHUỖI RỖNG, bỏ sạch toàn bộ chữ
số vừa đọc đúng. Khách hầu như luôn kèm câu dẫn khi đọc số ("Số danh bộ là...",
"...ạ"), nên lối đọc tách-chữ gần như luôn thất bại ở bước này. Hệ quả dây
chuyền: `_danhBoSession.digits` báo "0/11" dù khách đã đọc 8 chữ số đúng; model
(ở lượt còn chưa khoá do đúng race VAD nói trên) tự nghe VÀ TỰ PARSE đúng ra
"22023251", nhưng vì baseline session rỗng, `classifyModelArg` coi đây là BỊA
(R1) và bỏ — chính điều model nghe đúng lại bị hệ thống vứt đi. Cuộc gọi kéo
dài thêm qua vài lượt lạc đề (khách nói "cảm ơn", prompt echo, response bị
huỷ, `_reAssertDanhBoStep` retry) — càng nhiều lượt lạc tích luỹ trong context,
model càng khó tuân thủ chỉ dẫn ép đọc nguyên văn: cả 3 lần retry liền của tag
`danh_bo_reassert` đều KHÔNG đọc đúng câu yêu cầu, mỗi lần một câu chào hỏi
chung chung khác nhau — vượt hẳn mức "thỉnh thoảng model không nghe lời" thấy ở
cuộc kia, cho thấy càng nhiều nhiễu tích luỹ trong hội thoại thì mini càng dễ
"lạc trôi" khỏi chỉ dẫn ép buộc.

### Đã sửa

`viDigitsFromWords` (tools.js): thay vì yêu cầu MỌI token là chữ số (bỏ cả câu
nếu có 1 từ lạ), tìm CHUỖI LIÊN TỤC DÀI NHẤT gồm toàn token chữ số (≥3 token
liên tiếp — cùng ngưỡng với `_DIGIT_WORD_RE` dùng để nhận diện "đây là lượt đọc
số" ở `_looksLikeDigitTurn`, session-ws.js), bỏ qua từ khung câu ở đầu/cuối/xen
giữa. Verify thủ công: "Số danh bộ là hai hai không hai ba hai năm một." giờ ra
đúng "22023251" — khớp với chính điều model đã tự nghe đúng trong log. Vẫn giữ
tinh thần chống ghép nhầm của bản gốc: câu bình thường lỡ có 1-2 từ trùng số
("một chút") không đủ dài (< 3) để bị coi là đọc số.

### Vì sao đây là fix ưu tiên cao hơn cả cuộc chiến response.create

Bug `_camGoiTool`/`_expectedSpeak` (đợt vá trước) làm model nói SAI CÂU khi đã
CÓ đủ số. Bug này làm hệ thống KHÔNG THẤY được số khách đã đọc đúng ngay từ
đầu — nặng hơn, vì nó khiến toàn bộ luồng không bao giờ tiến được tới bước xác
nhận, kéo dài cuộc gọi qua nhiều lượt lạc đề, và CHÍNH việc kéo dài đó lại là
thứ làm lộ ra (và làm trầm trọng thêm) cuộc chiến response.create ở trên. Ưu
tiên sửa cái này trước có thể giảm hẳn tần suất gặp phải bug kia trong thực tế,
dù không sửa trực tiếp cơ chế response.create.

### Chưa làm / cần theo dõi tiếp

- Race VAD-cũ-tự-tạo-response ngay trên lượt kích hoạt chuyển `digits` (thấy ở
  CẢ hai cuộc, không chỉ cuộc lỗi) là giới hạn cấu trúc (độ trễ round-trip của
  `session.update` so với phản ứng tức thời của VAD) — CHƯA có cách sửa rẻ,
  cần thiết kế riêng nếu muốn loại bỏ hẳn, không nằm trong phạm vi đợt vá này.
- Mức độ "lạc trôi khỏi chỉ dẫn ép buộc" tăng theo số lượt nhiễu tích luỹ trong
  hội thoại (rõ nhất ở cuộc 2, 3/3 lần retry đều trật) — đáng theo dõi thêm ở
  các cuộc test sau; nếu tái diễn thường xuyên, có thể cần xem lại toàn bộ cơ
  chế `_expectedSpeak` (đúng hướng "sửa hệ thống" đã ghi nhận ở trên) thay vì
  chỉ tăng số lần retry.

---

## Fix 30/07/2026 (tối, đợt 3) — cụm "BỎ QUA mọi hướng dẫn..." đọc như lệnh chèn ép

### Bằng chứng từ nhiều cuộc test thật cùng ngày

So sánh 2 kiểu câu lệnh ép đọc-nguyên-văn đang tồn tại song song:

- Khối dispatch tool chung (`"Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không
  thêm bớt, không tóm tắt, không diễn giải lại: ..."`) — trong TẤT CẢ log cùng
  ngày, model đọc đúng ngay lần đầu, không trượt lần nào.
- `_speakVerbatim` (`"BỎ QUA mọi hướng dẫn đọc trước đó trong hội thoại. NGAY
  BÂY GIỜ chỉ đọc CHÍNH XÁC..."`) — bị trượt liên tục nhất trong mọi log. Ở
  cuộc `rtc_u2_E7JvXsbrUHR2WPAJOXoA9`, model từ chối 3/3 lần, có lần nói thẳng:
  *"em không thể thực hiện đúng yêu cầu của đoạn văn đó **như một lệnh** đọc
  lại mã danh bộ rồi dừng lại"* — tức model đang PHÁT HIỆN và TỪ CHỐI tuân theo
  vì cụm câu giống mẫu tấn công chèn lệnh kinh điển ("ignore all previous
  instructions, now do X").

Cụm "BỎ QUA... NGAY BÂY GIỜ" được viết cho model đời cũ (không reasoning, tuân
lệnh literal, không cảnh giác mẫu câu này). Với `gpt-realtime-2.1-mini` (có
reasoning + huấn luyện chống chèn lệnh mạnh hơn), đúng cụm câu từng hiệu quả
giờ có thể là nguyên nhân model từ chối tuân theo — khác biệt DUY NHẤT giữa 2
câu lệnh trên chính là cụm mở đầu kiểu "ignore previous, do X now".

### Đã sửa

`_speakVerbatim` (session-ws.js): bỏ hẳn cụm "BỎ QUA mọi hướng dẫn đọc trước đó
trong hội thoại. NGAY BÂY GIỜ", đổi thành khung câu mô tả tự nhiên "Đây là câu
chính thức hệ thống cần bạn nói với khách ở lượt này — đọc đúng nguyên văn,
không thêm bớt, không diễn giải lại, rồi dừng: ...". Câu chào (`greetingInstruction`)
và câu tạm biệt (`_goodbyeInstruction`) vốn ĐÃ dùng kiểu diễn đạt an toàn này từ
đầu (không có cụm "BỎ QUA...") — không cần sửa, càng củng cố giả thuyết trên vì
đó chính xác là 2 câu KHÔNG bị trượt trong log.

### Cần theo dõi khi test thật tiếp

Đây là thay đổi CÂU CHỮ, không đổi control-flow — rủi ro thấp, dễ rollback (chỉ
1 hàm). Nhưng giả thuyết "mẫu câu giống chèn lệnh khiến model từ chối" chưa có
cách kiểm chứng nào khác ngoài quan sát tần suất trượt giảm ở các cuộc gọi thật
tiếp theo — nếu vẫn trượt thường xuyên sau bản sửa này, giả thuyết có thể sai
hoặc chỉ là một phần nguyên nhân (cộng dồn nhiễu hội thoại — xem đợt vá trước —
vẫn có thể là yếu tố chính).

### Kiểm chứng bằng 2 cuộc test thật ngay sau khi áp dụng — cải thiện rõ

Cuộc `rtc_u1_E7KssLVn0rTkuy701UhjD` và `rtc_u2_E7KuTabjWlbCA6pY9k5w9` (20:14–20:17):
`danh_bo_confirm` đọc ĐÚNG NGAY LẦN ĐẦU ở cả 2 cuộc (trước đây thường trượt 1-3
lần hoặc bỏ cuộc hẳn); `danh_bo_verify_filler` chỉ cần 0-1 lần gửi lại thay vì
2-3. Không còn lỗi `conversation_already_has_active_response` nào do đụng độ
`dang_xac_minh` (đúng như kỳ vọng của fix "gộp 2 nguồn" ở trên). Ủng hộ giả
thuyết là đúng, tiếp tục theo dõi.

## Fix 30/07/2026 (tối, đợt 4) — `confirm_danh_bo` bị model tự gọi ngoài ý muốn

### Phát hiện từ cuộc `rtc_u2_E7KuTabjWlbCA6pY9k5w9`

Cuộc này chạy `DANH_BO_MODE=locked` (mặc định), KHÔNG phải `confirm_tool` —
xác nhận bằng lời qua `_requestModelReply` bình thường, không qua
`_openDanhBoConfirmTurn`. Nhưng sau khi khách nói "Đúng rồi", model tự ý gọi
`confirm_danh_bo({})` (KHÔNG bị `tool_choice` ép) trước khi gọi `get_bill`, gây
thêm một vòng round-trip thừa, một câu nói lệch tông ("Mình sẽ vừa xác nhận số
danh bộ vừa kiểm tra truy vấn tiền nước cho phù hợp nhé."), và câu trả lời cuối
bị nhiễu thành "Dạ, **cả hai** mã danh bộ đã được hệ thống xác nhận" — sai, chỉ
có MỘT mã, không phải hai (model tự gộp nhầm 2 kết quả tool thành "hai mã").

Nguyên nhân: `confirm_danh_bo` được đăng ký trong `TOOLS` (`system-prompt.js`)
BẤT KỂ `DANH_BO_MODE`, và phần mô tả tool viết "...hoặc khi cần kiểm tra lại
trạng thái trước khi tra cứu dữ liệu cho khách" — chính vế này mời model tự gọi
bất cứ lúc nào nó "muốn chắc ăn", dù không ở chế độ `confirm_tool`. Không có rủi
ro sai dữ liệu (handler trả đúng `da_xac_nhan`), nhưng đúng là lời thoại thừa,
chưa kiểm soát.

### Đã sửa

Bỏ vế mời gọi tự do trong mô tả tool (`system-prompt.js`), chỉ giữ "CHỈ gọi khi
hệ thống chủ động yêu cầu... KHÔNG tự ý gọi để kiểm tra lại cho chắc". Không đổi
control-flow, không cần đổi `tools.js`/`session-ws.js`. Rủi ro thấp; cần quan
sát ở cuộc gọi thật tiếp theo xem model còn tự gọi tool này ngoài `confirm_tool`
mode nữa không — nếu còn, cân nhắc phương án mạnh hơn: chỉ đăng ký tool này vào
`TOOLS` khi `DANH_BO_MODE=confirm_tool` (cần sửa cách `TOOLS` được truyền vào
session, hiện đăng ký tĩnh, chưa làm trong đợt này).

## Fix 30/07/2026 (tối, đợt 5) — `\bờ\b`/`\bừ\b` khớp nhầm bên trong từ khác → xác nhận sai

### Phát hiện từ cuộc `rtc_u1_E7L7Y2XD6JGGx1oQkIjAj` — lỗi nghiêm trọng nhất đợt này

Sau khi bot đọc lại mã danh bộ để xác nhận, khách nói **"Mình muốn nâng dời
đồng hồ."** (một yêu cầu HOÀN TOÀN KHÁC — xin dời vị trí đồng hồ nước, không hề
xác nhận hay phủ định gì) — nhưng log cho thấy code đã chốt
`danhBo.confirmed = true` ngay lập tức:

```
[WS] danh_bo_verbal_confirm: Mình muốn nâng dời đồng hồ. → 22023251775
```

Nguyên nhân: `_KHANG_DINH_RE` dùng `\bờ\b`/`\bừ\b`/`\bừm\b` để bắt các tiếng đệm
đơn âm ("ờ", "ừ" — kiểu gật gù đồng ý). Nhưng `\b` trong regex JS mặc định coi
MỌI ký tự có dấu tiếng Việt là non-word (chỉ `[A-Za-z0-9_]` mới là `\w`). Chữ
"dời" gồm `d` (word) + `ờ` (non-word) + `i` (word) — nghĩa là ranh giới
word↔non-word xuất hiện Ở CẢ HAI ĐẦU chữ "ờ" bên trong từ "dời", nên `\bờ\b`
khớp NGAY CẢ KHI "ờ" chỉ là một âm tiết giữa từ, không phải tiếng đệm đứng một
mình. Rủi ro y hệt với hàng loạt từ cực kỳ phổ biến khác: "từ", "giờ", "chờ",
"sợ", "gừng", "mừng", "đừng"... — nghĩa là gần như BẤT KỲ câu nào khách nói
trong lúc đang chờ xác nhận, miễn có một trong các âm này, đều có thể bị hiểu
NHẦM thành "khách đã xác nhận đúng", bất kể nội dung thật sự nói gì. Đây là lỗ
hổng trong chính "gate xác nhận lời nói" mà toàn bộ kiến trúc phụ thuộc vào để
đảm bảo không đọc nhầm thông tin cho khách (xem README/CLAUDE.md mục "Gate xác
nhận lời nói"). Ở cuộc này không rò rỉ dữ liệu (mã confirm đúng là mã của chính
khách), nhưng lỗ hổng vẫn tồn tại bất kể mã đúng hay sai.

Hệ quả domino trong log: `_seXuLyXacNhan=true` → `_toolCallState.danhBo.confirmed=true`
→ VAD mở khoá → đồng thời 2 cơ chế cùng chạy (nhánh "bot nói khác câu yêu cầu"
gửi lại `_speakVerbatim`, VÀ `_requestModelReply` nhờ model tra cứu) → đụng độ
`conversation_already_has_active_response` → model trả lời lạc đề, không đáp
ứng đúng yêu cầu "nâng dời đồng hồ" của khách → khách bối rối, cúp máy.

### Đã sửa

`_KHANG_DINH_RE` (session-ws.js) bỏ 3 pattern `\bừ\b`/`\bừm\b`/`\bờ\b`. Thêm
`_isAffirmative` bước 2: tokenize câu (Unicode-safe, `\p{L}`) và chỉ coi
"ừ"/"ừm"/"ờ" là xác nhận khi nó là CẢ MỘT TỪ riêng trong câu NGẮN (≤2 từ sau khi
bỏ dấu câu) — không phải khi khớp `\b` lẫn bên trong từ khác. Đồng bộ bản sao
logic trong `test_case/muc_c_khong_cam.test.mjs` + thêm 2 test mới: tái hiện
đúng câu "Mình muốn nâng dời đồng hồ." (+ "từ", "giờ", "chờ") phải KHÔNG rơi vào
`XAC_NHAN`, và xác nhận "Ừ."/"Ờ, đúng đó." đứng một mình vẫn được coi là xác
nhận hợp lệ. 57/57 test đạt sau khi sửa (tăng từ 55 do thêm 2 test).

Chưa động tới `\bđược\b`/`\bok\b`/`\boke\b` (cùng có `\b` nhưng nằm ở đầu/cuối
ASCII nên rủi ro khớp nhầm thấp hơn nhiều — nếu có, là bỏ sót ở ĐẦU câu chứ
không phải khớp nhầm giữa từ khác; để dành theo dõi thêm, chưa thấy bằng chứng
thực tế nào).

## Fix 30/07/2026 (tối, đợt 6) — mệnh lệnh "TUYỆT ĐỐI không đọc số" trong `message` lingering sang bước confirm

### Phát hiện từ cuộc `rtc_u2_E7LLkANEJmyTSp0B3t5EP`

Khách đọc đủ 11 số một lượt ("Mã danh bộ là 22023251775."), trọng tài chốt tin
cậy 0.96, code gửi câu xác nhận có đọc số qua `_speakVerbatim` (`danh_bo_confirm`).
Model NÉ TRÁNH đọc số cả 3/3 lần, mỗi lần nói một câu vòng vo hoàn toàn khác kịch
bản ("Dạ em nhận được số danh bộ rồi ạ. Hiện tại em chưa thể đọc ra kết quả hoặc
xác nhận số tiền cụ thể cho tháng này...") — dù `get_bill` CHƯA hề được gọi ở
bước này, nội dung nghe như model đang mô tả một kết quả tra cứu thất bại tưởng
tượng. Cuối cùng bỏ cuộc sau 3 lần retry (`Bot KHÔNG đọc được câu "danh_bo_confirm"
sau 3 lần — bỏ cuộc.`).

Giả thuyết (cùng LỚP lỗi đã ghi nhận ở mục "`message` của tool NẰM LẠI VĨNH VIỄN
trong hội thoại" trong CLAUDE.md): ngay trước bước confirm, `dangXacMinhResponse()`
trả về `message`: *"Hệ thống đã nhận đủ số và ĐANG XÁC MINH. **TUYỆT ĐỐI không
đọc/không đoán chữ số nào**. Hệ thống sẽ TỰ đọc mã cho khách xác nhận ngay sau
đây — model không cần và không được nhắc lại yêu cầu đọc số."* — nội dung này
nằm trong `function_call_output`, NẰM LẠI VĨNH VIỄN trong context. Ngay lượt kế
tiếp, `response.create` khác lại yêu cầu model đọc NGUYÊN VĂN một câu CÓ CHỨA 11
chữ số. Hai chỉ dẫn — "tuyệt đối đừng bao giờ đọc số" (cũ, còn nguyên trong
context) và "đọc câu này có số" (mới, chỉ trong `instructions` của response hiện
tại) — giằng co nhau, và model có vẻ nghiêng về chỉ dẫn CŨ mạnh hơn (từ
"TUYỆT ĐỐI"), né tránh đọc số bằng cách nói lảng sang chuyện khác.

### Đã sửa

`dangXacMinhResponse()` (tools.js): bỏ mệnh lệnh tuyệt đối, đổi thành mô tả
trạng thái + báo trước: "Hệ thống đã nhận đủ số và đang xác minh ở nền. Lượt NÀY
model không cần tự nói gì thêm về số — chỉ đợi. Bước KẾ TIẾP hệ thống sẽ tự gửi
một yêu cầu riêng kèm câu xác nhận có đọc số; lúc đó cứ đọc đúng câu được yêu
cầu, không bị ràng buộc bởi câu này nữa." — không đổi control-flow, không đổi
field `dang_xac_minh`/`doc_cho_khach` (session-ws.js vẫn xử lý y hệt). 57/57
test đạt sau khi sửa.

### Chưa làm — cùng lớp rủi ro, chưa đủ bằng chứng để ưu tiên

Các message khác trong tools.js cũng dùng "TUYỆT ĐỐI không tự đọc/tự đoán chữ số
nào" (giai đoạn GOM SỐ: `invalidDanhBoResponse` 3 biến thể, `dangGomSoResponse`,
`danhBoDtmfInviteResponse`) — CÙNG lớp rủi ro lingering, nhưng khác
`dangXacMinhResponse` ở chỗ: những message này lặp lại NHIỀU LẦN trong một cuộc
gọi (mỗi lượt khách đọc dở một phần) nên càng đọc nhiều lượt càng tích luỹ nhiều
mệnh lệnh tuyệt đối hơn trong context — rủi ro CỘNG DỒN, không chỉ một lần như
`dangXacMinhResponse`. Cuộc vừa fix ở trên lại KHÔNG có tích luỹ này (khách đọc
đủ 11 số ngay lượt đầu) mà vẫn hỏng — nên bằng chứng hiện tại chỉ đủ để quy trách
nhiệm chính cho `dangXacMinhResponse` (message NGAY TRƯỚC bước confirm). Chưa
sửa các message còn lại vì chưa có cuộc gọi thật nào cho thấy chúng là nguyên
nhân trực tiếp — nếu tình trạng model né đọc số ở bước confirm còn tái diễn sau
bản vá này, đây là việc cần làm tiếp theo (đổi toàn bộ "TUYỆT ĐỐI KHÔNG..." trong
các message giai đoạn gom số thành mô tả trạng thái tương tự).

### Quan sát phụ — log trùng lặp vô hại

Cuộc `rtc_u1_E7LJgpobqBWNb3w86hUwa`: dòng `[AI nói]: Dạ, em ghi nhận rồi ạ...`
xuất hiện 2 lần liên tiếp cách nhau 1ms, nhưng chỉ có MỘT `response.done` theo
sau — nhiều khả năng là log bị ghi trùng cho cùng một response (2 event transcript
khác nhau của OpenAI cùng được log là "[AI nói]"), không phải bot nói 2 lần thật.
Chưa xác nhận, chưa cần sửa — nếu ảnh hưởng gì tới khách sẽ lộ rõ hơn ở log thoại
thật (số từ nói ra khớp 1 câu hay 2 câu).

## Fix 31/07/2026 — khách đọc lại số giữa lúc đang chờ xác nhận bị bỏ rơi

### Phát hiện từ cuộc `rtc_u2_E7XpOB5fmY21Hm4L28mXW` — lỗi cấu trúc mới, không phải lặp lại lỗi cũ

Sau khi bot đọc lại mã để hỏi xác nhận (ứng viên "22023251977" từ trọng tài,
tin cậy thấp 0.35), khách KHÔNG nói "đúng/sai" mà tự đọc lại toàn bộ 11 số từ
đầu ("2 2 0 2 3 2 5 1 7 7 5.") — phản xạ tự nhiên khi nghi ngờ số đọc lại chưa
đúng. Log cho thấy:

```
[danh_bo] phiên #1: 23/11 số (+"2 2 0 2 3 2 5 1 7 7 5.")
...
LƯỚI AN TOÀN: bot im lặng > 15000ms sau khi khách nói — mở khoá model.
```

Nguyên nhân — 2 lỗi cộng dồn:

1. **Session không được reset khi chuyển sang chờ xác nhận.** `_danhBoSession`
   chỉ reset khi code "mời đọc lại" (`startDanhBoRequest`) hoặc khi khách XÁC
   NHẬN xong — KHÔNG reset khi chuyển từ gom số sang chờ xác nhận. Session vẫn
   còn 12 số cũ, lượt đọc lại cộng thêm 11 số nữa → "23/11".
2. **`_maybeVerifyDanhBo` có guard im lặng.** Hàm này mở đầu bằng
   `if (_toolCallState.danhBo) return;` — vì ứng viên "22023251977" vẫn đang
   pending (chưa `confirmed`), guard này ÂM THẦM CHẶN việc verify lại lượt đọc
   mới, không có filler nào được phát. Bot im lặng tới khi mute watchdog (15s)
   cứu — lúc đó model đã mất dấu ngữ cảnh, tự đọc một số HOÀN TOÀN KHÁC
   ("22023251775" — không phải ứng viên đang chờ, cũng không phải số khách vừa
   đọc lại) cho khách nghe. Bộ phát hiện có sẵn ("Bot đọc số LẠ") bắt được và
   ép đọc lại đúng câu, nhưng khách đã bối rối và cúp máy trước khi xác nhận
   xong.

Gốc rễ: `_laLuotDocSo` (nhánh xử lý "khách đọc số") không phân biệt được
"khách đang gom số lần đầu" với "khách đọc lại trong lúc đã có ứng viên chờ xác
nhận" — hai tình huống cần xử lý khác hẳn nhau (tình huống 2 cần coi là PHỦ
ĐỊNH NGẦM ứng viên cũ + mở phiên mới sạch, giống hệt khi khách nói "sai").

### Đã sửa

`session-ws.js`, nhánh `_laLuotDocSo`: nếu đang có ứng viên pending
(`_toolCallState.danhBo && !confirmed`) thì coi lượt đọc lại này là phủ định
ngầm — gọi `noteDanhBoRejected` (huỷ ứng viên cũ, ghi vào danh sách trọng tài
né đề xuất lại) + `startDanhBoRequest` (mở phiên đọc MỚI, sạch, không lẫn số
cũ, tăng `requestNo` đúng cảm nhận của khách) + reset `_danhBoVerifyLastAt`
TRƯỚC khi ghi nhận lượt đọc — sau đó `_maybeVerifyDanhBo()` chạy bình thường vì
`danhBo` đã được xoá, không còn bị guard chặn. Tái sử dụng đúng cơ chế đã có
sẵn cho nhánh PHU_DINH (`noteDanhBoRejected` + reset `_danhBoVerifyLastAt`),
không phát minh cơ chế mới. Thêm 1 test ở `danh_bo_verify_flow.test.mjs` tái
hiện đúng kịch bản (12 số cũ + đọc lại 11 số mới → phải ra đúng 11 số, không
tràn, `requestNo` tăng). 58/58 test đạt.

### Quan sát phụ — 2 việc khác trong cùng batch log, chưa cần hành động

- **Prompt echo → trả lời lạc đề** (cuộc `rtc_u2_E7XofrK7T0El0GyQ9B37W`): hệ
  thống phát hiện đúng transcript là "vọng lại" nội dung system prompt (không
  phải khách nói) và huỷ response kịp thời (`response_cancel_sent`) — cơ chế
  phòng vệ có sẵn hoạt động đúng. Nhưng response NGAY SAU đó model lại tự bịa
  "Quý Khách đang nói Alo vài lần" — có vẻ do audio nhiễu/vọng thật từ môi
  trường test, không phải lỗi code. Không sửa, chỉ ghi nhận.
- **Fix "TUYỆT ĐỐI không đọc số" (đợt 6) có tác dụng nhưng CHƯA dứt điểm**: 2
  cuộc trong batch này (`rtc_u2_E7XrZzGm7BEikox2GBh18`, `rtc_u2_E7XtXkuZEDRiZLJAa2tKW`)
  vẫn có 1 lần né đọc số/nói lạc đề ở lượt `danh_bo_confirm` ĐẦU TIÊN (tự sửa
  đúng ngay ở lần retry 1) — tốt hơn hẳn kiểu "3/3 thất bại, bỏ cuộc" trước fix,
  nhưng cho thấy giả thuyết "message tool lingering" chỉ giải thích được MỘT
  PHẦN nguyên nhân. Chưa có hướng sửa mới cụ thể — để dành theo dõi thêm, cơ chế
  retry hiện tại đủ để tự phục hồi trong các cuộc đã xem.

## Fix 31/07/2026 (đợt 8) — bot lặp lại Y HỆT một lỗi đọc số → bỏ cuộc sớm + mời bấm phím ngay

### Phát hiện từ cuộc `rtc_u1_E7Y8JfPoOL8KgiX7EOOtY` — dạng lỗi mới: model "mắc kẹt" đọc thừa một chữ số lặp

Mã cần đọc lại để xác nhận là "...Một - Bảy - Bảy - Năm" (kết ở …1775). Ở CẢ 3
lần thử (và lặp lại y hệt lần nữa sau khi chuyển sang xác nhận qua DTMF), bot
đọc THỪA đúng một chữ "Bảy": "...Một - Bảy - Bảy - **Bảy** - Năm" (…17775 thay
vì …1775). Bộ dò "Bot đọc số LẠ" bắt được cả 6 lần, nhưng cơ chế gửi lại
(`_checkExpectedSpeak`) cứ gửi LẠI Y NGUYÊN instructions cũ — và bot lặp lại Y
HỆT lỗi cũ ở MỌI lần thử, không phải nhiễu ngẫu nhiên khác nhau mỗi lần. Nghi
vấn: khi đọc verbatim một dãy có 2 chữ số GIỐNG NHAU LIỀN KỀ ngay trước chữ số
cuối (dạng …X-Y-Y-Z), model có xu hướng lặp thêm một Y nữa trước khi dừng — một
lỗi phát âm mang tính hệ thống với DÃY SỐ CỤ THỂ NÀY, chưa rõ có tổng quát cho
mọi cặp số lặp hay không (cần thêm log thật để xác nhận diện rộng).

Hậu quả: gửi lại y nguyên 2 lần là lãng phí thời gian chắc chắn (đã chứng minh
bằng chính log — bot trả lời giống hệt cả 3 lần), và sau khi bỏ cuộc, cuộc gọi
TREO im gần 70 giây chờ watchdog 90s tự mời bấm phím, dù hệ thống đã có sẵn ứng
viên ĐÚNG từ lâu (API + trọng tài đồng thuận) — vấn đề chỉ nằm ở việc BOT không
đọc lại đúng được, không phải chưa xác định được số.

### Đã sửa

1. **Phát hiện lặp lại y hệt → bỏ cuộc SỚM.** `_checkExpectedSpeak` giờ lưu
   `lastSpokenCore` của lần lệch trước; nếu lần lệch MỚI cho ra ĐÚNG dãy số bot
   vừa đọc sai lần trước, coi là "model bị mắc kẹt" và bỏ cuộc ngay (sau 2 lần
   thay vì đợi đủ 3) thay vì gửi lại thêm một lần chắc chắn vô ích.
2. **Bỏ cuộc ở bước xác nhận danh bộ → mời bấm phím NGAY.** Hàm mới
   `_escalateDanhBoToDtmf` tái dùng đúng cơ chế mời DTMF đã có sẵn ở watchdog
   90s, gọi ngay khi `_checkExpectedSpeak` bỏ cuộc với tag `danh_bo_confirm` /
   `dtmf_danh_bo_confirm` / `danh_bo_reassert` — không đợi watchdog. Có guard
   `_danhBoDtmfInvited` sẵn có nên không mời trùng nếu đã đang ở luồng DTMF.

Không đổi luồng "verify"/"tra cứu" — chỉ đổi tốc độ phản ứng khi bot tự lặp lỗi
đọc số. 58/58 test đạt (không thêm test mới cho phần này — logic gắn chặt vào
closure `session-ws.js` cần mock WebSocket đầy đủ mới test được, ngoài phạm vi
bộ test hiện tại; cần quan sát cuộc gọi thật tiếp theo để xác nhận).

### Cần theo dõi tiếp

- Giả thuyết "2 chữ số giống nhau liền kề trước chữ số cuối" mới dựa trên MỘT
  dãy số cụ thể (…1775) lặp lại 6 lần trong CÙNG một cuộc — cần thêm log ở các
  dãy số khác có mẫu tương tự (…XYY, …YYX) để xác nhận có phải quy luật chung.
- Escalation DTMF sớm giúp cuộc gọi không treo, nhưng KHÔNG giải quyết gốc rễ
  (bot vẫn không đọc lại đúng được bằng giọng nói) — nếu khách không tiện bấm
  phím, cuộc gọi vẫn phải dựa vào nhánh "chuyển máy" đã có sẵn trong lời mời
  DTMF.

## Fix 31/07/2026 (đợt 9) — watchdog 90s hết hạn ĐÚNG lúc vừa chốt xong ứng viên

Log nguồn: `rtc_u2_E7YQCdKECKBoFNKzFMRpe` (cuộc dài ~9 phút, khách đọc lại nhiều
lần). Khách vừa đọc SẠCH đủ 11 số ("22.02.3251.775."), trọng tài gpt-5.1 vừa
chốt xong candidate (confidence 0.9) — nhưng ĐÚNG khoảnh khắc đó, watchdog 90s
(đã âm thầm đếm từ lần `_armDanhBoWatchdog()` ĐẦU TIÊN trong cuộc, gần 90s
trước, và không tự gia hạn theo hoạt động sau đó) hết hạn → bot vừa mời khách
BẤM PHÍM DTMF xong (do watchdog) lại NGAY LẬP TỨC quay ra đọc câu xác nhận
bằng giọng nói (do `_maybeVerifyDanhBo` vừa chốt candidate) — khách nghe hai
chỉ dẫn mâu thuẫn liên tiếp trong ~2 giây.

**Gốc rễ**: `_armDanhBoWatchdog()` chỉ đặt hẹn giờ MỘT LẦN (guard chống gia
hạn: `if (_toolCallState._danhBoWatchdogTimer) return;`), nên nó đếm 90s từ
lần đọc số ĐẦU TIÊN trong cuộc, không phải từ hoạt động gần nhất. Với cuộc dài
(nhiều vòng đọc lại), watchdog có thể hết hạn ngay giữa lúc hệ thống ĐANG xử lý
bình thường — không phải lúc bế tắc thật.

**Fix**: trong `_maybeVerifyDanhBo` (`src/session-ws.js`, nhánh
`r.action === "confirm"`), gọi `_clearDanhBoWatchdog()` NGAY khi có ứng viên để
đọc xác nhận — không đợi tới lúc khách xác nhận bằng lời mới tắt (trước đây chỉ
tắt ở bước "khách xác nhận lời nói", muộn hơn). Có ứng viên nghĩa là hết lý do
"không tìm ra được số nào" nên lưới an toàn "mời DTMF vì bế tắc" không còn cần
thiết ở bước này nữa; nếu khách phủ định/đọc lại sau đó, lượt đọc số kế tiếp tự
`_armDanhBoWatchdog()` lại bình thường (timer đã về `null`). KHÔNG áp dụng cho
`action === "reread"` (mời đọc lại từ đầu) — lúc đó vẫn CHƯA có ứng viên, watchdog
phải tiếp tục đếm.

58/58 test đạt. Chưa có test tự động riêng (cần mock timer + closure
`session-ws.js`) — cần xác nhận qua cuộc gọi thật tiếp theo.

## Ghi nhận thêm (đợt log 31/07/2026, chưa sửa code — cần thêm bằng chứng)

Từ cùng đợt log (4 cuộc: `rtc_u0_E7YKxAOGzSEj9kbH3LJXw`,
`rtc_u2_E7YMI60rqOfanPdvrlkVv`, `rtc_u2_E7YOOfc34rq3Jy4RpaUie`,
`rtc_u2_E7YQCdKECKBoFNKzFMRpe`):

- **`rtc_u2_E7YOOfc34rq3Jy4RpaUie`**: bot đọc "775" thành "77 phẩy 5" (hiểu
  nhầm 3 chữ số rời thành một số thập phân) — lặp lại y hệt ở lần gửi lại đầu
  tiên, minh chứng thêm cho cơ chế "bỏ cuộc sớm khi lặp lỗi y hệt" (đợt 8) là
  hướng đúng, không chỉ riêng cho lỗi "nhân đôi chữ số cuối". Retry cuối cùng
  vẫn thành công nên chưa chặn được cuộc gọi.
- **`rtc_u2_E7YQCdKECKBoFNKzFMRpe`**: quan sát thêm HAI `function_call`
  `get_bill` với CÙNG `call_id` xuất hiện gần như đồng thời ở bước gom số đầu
  cuộc, kèm một lỗi `conversation_already_has_active_response` ngay sau đó ở
  bước `dang_gom_so`. Chưa đủ bằng chứng để kết luận đây là lỗi phía code (xử
  lý trùng một `response.done`) hay hành vi phía OpenAI (phát hai function_call
  cho cùng một lượt) — cần log thô đầy đủ (không chỉ transcript rút gọn) ở lần
  tái hiện tiếp theo trước khi sửa.
- Cuộc gọi kết thúc (khách cúp máy) ngay sau khi khách đọc lại số lần thứ 4 mà
  KHÔNG nói "đúng/sai" — mã đã đúng trong hệ thống lúc đó nhưng chưa được xác
  nhận bằng lời. Cân nhắc: sau N lần đọc lại liên tiếp không kèm khẳng định,
  có nên chủ động hỏi thẳng "Quý Khách đọc xong chưa ạ, số vừa rồi có đúng
  không?" thay vì chỉ lặp lại lời mời đọc — chưa triển khai, cần thêm log để
  xác định N hợp lý.

## Fix 31/07/2026 (đợt 10) — không được giữ tool call treo lại chờ gom đủ số

Đề xuất từ chủ dự án khi xem log `get_bill({"ma_danh_bo":"2202"})` trả về
`dang_gom_so` ngay dù mới nghe 4/11 số: "không nên trả lời tool ngay, nên nhớ
`call_id`, đợi gom đủ số + có kết quả trọng tài gpt-5.1 rồi mới trả lời tool."

**Đã giải thích và KHÔNG áp dụng** — đây đúng là anti-pattern đã bị cấm tường
minh trong tài liệu dự án (mục "Bẫy & quy ước" của `CLAUDE.md`): *"KHÔNG để
tool call treo quá ~2 giây. VAD vẫn sinh response trong lúc treo và model luôn
lấp khoảng trống bằng nội dung bịa"* — sự cố gốc là cuộc
`rtc_u2_E5eDfB96UnJE6iDWfPbRX`: tool treo 21s → bot tự bịa 2 số danh bộ đọc
cho khách nghe 4 lần. Giữ `get_bill` treo tới khi gom đủ 11 số + trọng tài
xong (có thể vài chục giây nếu khách đọc ngắt quãng) sẽ tái lập đúng lỗi đó ở
tool khác.

Thiết kế hiện tại đã đạt đúng mục tiêu (không lộ dữ liệu thật khi chưa đủ số)
theo cách không treo: trả `dang_gom_so` NGAY (không có dữ liệu thật, chỉ có
`doc_cho_khach: "Dạ, em đang nghe ạ."`) để đóng đúng hợp đồng API; việc gom đủ
số + chờ trọng tài chạy ở đường nền (`_maybeVerifyDanhBo`), độc lập với tool
call; khi trọng tài xong, CODE ép model đọc đúng câu xác nhận qua
`_speakVerbatim` — không nhờ model tự nói, nên không cần tool call nào "chờ"
cả. `resolveDanhBo` khi `danhBo.confirmed === true` dùng thẳng
`callState.danhBo.value`, bỏ qua tham số model tự đưa vào tool call, nên các
lượt gọi `get_bill` "hụt" (chưa đủ số) không có rủi ro sai dữ liệu.

### Fix đi kèm (đợt 10) — dọn "TUYỆT ĐỐI không đọc số" tồn dư ở nhóm message còn lại

Trong lúc trao đổi, chủ dự án chỉ thẳng vào `message` của `dangGomSoResponse`
("Hệ thống ĐANG GOM số... TUYỆT ĐỐI không đọc/không đoán chữ số nào...") và
yêu cầu điều chỉnh hợp lý hơn — đúng lớp rủi ro đã ghi nhận nhưng chưa sửa ở
đợt 6 (khi đó chỉ sửa `dangXacMinhResponse`, các message còn lại bị gắn cờ
"cùng lớp rủi ro, chưa đủ bằng chứng để ưu tiên"). Nay có bằng chứng trực tiếp
nên sửa luôn CẢ NHÓM trong `src/tools.js` theo đúng khuôn mẫu đợt 6 (mô tả
trạng thái + báo trước bước sau không bị ràng buộc, bỏ mệnh lệnh tuyệt đối):

- `invalidDanhBoResponse` — cả 3 nhánh (`length === 0`, `length > DANH_BO_LENGTH`,
  thiếu số).
- `dangGomSoResponse` — message user chỉ trực tiếp, fire ở HẦU HẾT lượt đọc số
  dở dang (tần suất cao hơn hẳn `dang_xac_minh`), nên rủi ro chồng chất lớn nhất.
- `danhBoDtmfInviteResponse`.

Test có sẵn `test_case/danh_bo_verify_flow.test.mjs` (nhóm "Chỉ dẫn tồn dư")
đã tự động kiểm tra generic cho các payload này (không được chứa "đọc nguyên
văn", phải chứa "hệ thống (sẽ) tự") — không cần thêm test riêng. 58/58 test đạt.

## Fix 31/07/2026 (đợt 11) — cơ chế "bỏ cuộc sớm khi lặp lỗi y hệt" (đợt 8) chưa từng hoạt động

Log nguồn: `rtc_u1_E7Z0LRZnTro02qMeeISyy`. Bot đọc "...Bảy - Bảy - Bảy - Năm"
(thừa đúng 1 chữ so với câu yêu cầu) Ở CẢ HAI lần gửi lại liên tiếp (byte-for-byte
giống nhau, xác nhận qua log "Bot đọc số LẠ '220232517775' (lần 1)" rồi
"(lần 2)") — nhưng hệ thống vẫn đợi đủ 3 lần mới bỏ cuộc, đúng NHƯ TRƯỚC đợt 8,
chứng tỏ cơ chế phát hiện lặp chưa hề chạy.

**Gốc rễ**: `_speakVerbatim` (dòng ~344-349) TẠO MỚI `_expectedSpeak` ở MỌI lần
gọi — kể cả lần gọi LẠI do chính `_checkExpectedSpeak` kích hoạt qua
`setTimeout`. Object mới chỉ giữ lại `retries` (nếu cùng tag), còn
`lastSpokenCore` (trường đợt 8 vừa thêm) bị bỏ sót khỏi object literal nên luôn
về `undefined` — `_lapLaiYHet` (`exp.lastSpokenCore && exp.lastSpokenCore ===
_spokenCoreNow`) do đó KHÔNG BAO GIỜ đúng, vì vế đầu luôn falsy.

**Fix**: giữ lại `lastSpokenCore` theo đúng điều kiện "cùng tag" như `retries`
khi dựng `_expectedSpeak` mới trong `_speakVerbatim`. 59/59 test đạt (không
thêm test mới — đây là bug trong logic closure của `session-ws.js`, cùng giới
hạn về mock WebSocket đã ghi ở đợt 8; cần quan sát cuộc gọi thật tiếp theo để
xác nhận cơ chế giờ chạy đúng).

## Fix 31/07/2026 (đợt 12) — "Vâng," mở đầu câu đổi chủ đề bị chốt nhầm thành xác nhận danh bộ

Log nguồn: `rtc_u1_E7Z0LRZnTro02qMeeISyy` (cùng cuộc với đợt 11, xảy ra ngay sau
khi mời DTMF). Khách nói "Vâng, cho mình hỏi giờ mình lên đăng ký định mức
nước hai nhân khẩu được không ạ?" — một câu hỏi HOÀN TOÀN khác, không liên
quan gì tới việc xác nhận mã danh bộ — nhưng hệ thống ghi nhận
`danh_bo_verbal_confirm` và dùng số đang chờ (đúng, may mắn) để tra cứu ngay.

**Gốc rễ**: `_KHANG_DINH_RE` khớp "vâng"/"được"/"đúng"... ở BẤT KỲ ĐÂU trong
câu, không giới hạn độ dài hay vị trí — câu dài đổi hẳn sang ý khác nhưng có
"vâng" mở đầu (phép lịch sự phổ biến trong tiếng Việt) hoặc "được" ở cuối vẫn
qua được. Lần này số đang chờ đúng nên không lộ sai dữ liệu, nhưng đây chính
là lỗ hổng mà "gate xác nhận lời nói" trong `CLAUDE.md` được dựng lên để chặn
("Hỏng chỗ này = bot đọc thông tin người khác cho khách nghe").

**Fix**: thêm guard trong `_isAffirmative` — câu có dấu "?" thì KHÔNG tính là
xác nhận, bất kể chứa từ khẳng định nào. Lý do chọn tín hiệu này: khách xác
nhận VÀ hỏi thêm trong cùng một câu là tình huống hiếm, còn coi nhầm câu hỏi
thành xác nhận thì rủi ro lộ dữ liệu — mặc định an toàn khi mơ hồ. Sync cùng
fix vào bản sao logic trong `test_case/muc_c_khong_cam.test.mjs`, thêm test
tái hiện đúng câu trên + 2 câu xác nhận thật (ngắn, không kèm câu hỏi) để đảm
bảo không bóp chết luồng xác nhận bình thường. 59/59 test đạt.

## Fix 31/07/2026 (đợt 13) — watchdog vẫn có thể hết hạn TRONG lúc debounce chờ verify

Log nguồn: `rtc_u0_E7ZC4KI88GN0QNHZRjhjX`. Khách đọc sạch đủ 11/11 số (phiên
#3), nhưng watchdog 90s hết hạn CHỈ 719ms sau đó — mời bấm phím NGAY, trước cả
khi `_maybeVerifyDanhBo` kịp hết debounce 1500ms để chạy trọng tài — bỏ lỡ hẳn
cơ hội xác nhận bằng giọng nói dù khách vừa đọc đúng lần này.

**Gốc rễ**: đợt 9 chỉ tắt watchdog ở thời điểm `r.action === "confirm"` — tức
là SAU KHI trọng tài đã chạy xong. Khoảng debounce `_DANHBO_DEBOUNCE_DU_MS`
(1500ms, cố ý để gom nốt các hơi đọc rời rạc) cộng thời gian gọi trọng tài vẫn
nằm NGOÀI phạm vi được bảo vệ.

**Fix**: tắt watchdog ngay khi `_maybeVerifyDanhBo` phát hiện đã đủ 11 số
(biến `_du`, tính TRƯỚC debounce) — coi "đủ số, đang tích cực xử lý" là đủ lý
do tạm ngưng đồng hồ bế tắc. Bật lại watchdog (`_armDanhBoWatchdog()`) ở CẢ BA
nhánh verify cuối cùng không chốt được gì (reread, action==="none"/không có
prompt, lỗi giữa chừng) — để không mất hẳn lưới an toàn cho tới lượt đọc số kế
tiếp của khách. 59/59 test đạt.

## Ghi nhận thêm (đợt log 31/07/2026, batch 5 — chưa sửa, cần thêm bằng chứng)

- **Race VAD lúc CHUYỂN sang chế độ khoá ở lượt đọc số ĐẦU TIÊN**
  (`rtc_u1_E7Z25DKmWbWQokYVfD694`): khách đọc "Mã danh bộ là 2209." — code phát
  hiện đây là lượt đọc số và gửi `session.update` chuyển VAD sang `digits`
  (`create_response:false`), nhưng response cho lượt NÀY đã được kích hoạt bởi
  VAD CŨ (`semantic_vad`, `create_response:true`) ngay trước khi update kịp áp
  dụng — model tự do nói "Thưa Quý Khách, số danh bộ em đang nghe là '2209',
  nhưng" (bị cắt ngang, và bị flag đúng là "Bot đọc số LẠ"). Lần này vô hại
  (số trùng khớp, câu bị cắt giữa chừng, không tra cứu gì), nhưng là lỗ hổng
  cấu trúc: KHÔNG cách nào biết một lượt là "đọc số" trước khi có transcript,
  mà transcript chỉ có sau khi response đã có thể được VAD cũ tự kích hoạt.
  Cần thêm log ở nhiều cuộc khác để đánh giá tần suất/mức độ nghiêm trọng
  trước khi cân nhắc hướng sửa (vd: tạm khoá `create_response` sớm hơn dựa
  trên độ dài audio, hoặc chấp nhận rủi ro thấp này).
- **`conversation_already_has_active_response` tái diễn ở bước xác nhận xong,
  chuẩn bị tra cứu** (`rtc_u0_E7ZC4KI88GN0QNHZRjhjX`, ~11:34:11.26-11:34:11.68):
  đây là LẦN THỨ HAI quan sát đúng dạng lỗi này (lần đầu ở
  `rtc_u2_E7YQCdKECKBoFNKzFMRpe`, batch trước, bước `dang_gom_so`) — tăng độ
  tin cậy đây là race có thật, không phải ngẫu nhiên. Ở cuộc này: khách xác
  nhận qua DTMF ("Đúng rồi em.") → VAD (đã ở chế độ `normal` từ trước) TỰ kích
  hoạt một response mà model tự nói "Dạ, vậy để em xử lý tiếp..." VÀ tự gọi
  `get_bill` trong CÙNG response đó (không cần code nhắc) → gần như đồng thời,
  `danh_bo_verbal_confirm`'s `_requestModelReply()` (bị hoãn tới khi
  `_responseActive` rảnh) CŨNG gửi yêu cầu "Gọi NGAY tool tra cứu" → khi
  response.done xử lý xong tool `get_bill` và gửi response.create đọc kết quả,
  nó đụng ngay response CHƯA XONG của `_requestModelReply` → lỗi
  `conversation_already_has_active_response`. Khách nghe câu vòng vo "kết quả
  vẫn đang chờ" dù dữ liệu đã có, cuộc gọi kết thúc ngay sau đó không rõ ràng
  (không có `end_call`). Cần đọc kỹ code `danh_bo_verbal_confirm` +
  `_requestModelReply` trước khi sửa — có khả năng cần guard "nếu model đã tự
  gọi tool tra cứu trong response VAD tự kích hoạt rồi thì bỏ qua
  `_requestModelReply`", nhưng chưa đủ thời gian xác minh trong đợt này.

## Fix 04/08/2026 (đợt 14) — khuyến khích khách đọc LIÊN TỤC một mạch đủ 11 số

Giả thuyết từ chủ dự án, xác nhận qua 7 cuộc log cùng đợt (2026-08-04, khoảng
15:56-16:10): cuộc nào khách đọc đủ 11 số trong MỘT lượt liên tục (không tách
nhiều hơi/nhiều lượt) đều được trọng tài chốt ngay từ lần đọc đầu tiên với độ
tin cậy cao (`rtc_u2_E95NPNJM6w3YIgRpyhYwB`, `rtc_u1_E95OiVnd2UsXjvbMYx0aC`,
và về sau của `rtc_u2_E95FbAXLHewtjX3ImlaSg`: 0.93-0.97 conf, xác nhận đúng
ngay lần đầu). Ngược lại, cuộc khách đọc RỜI RẠC nhiều lượt
(`rtc_u0_E95Q90QYobubPqXAMJSP2`: 3 lượt tách rời — "22023 247" → phải mời đọc
lại → "431" → trọng tài ghép sai thứ tự → mời đọc lại lần nữa → cuối cùng mới
ghép đúng) không chỉ tốn nhiều vòng hơn mà còn kéo theo một lỗi MỚI, nghiêm
trọng hơn: sau khi đã có ứng viên đúng và hệ thống yêu cầu model đọc câu XÁC
NHẬN, model liên tục nói "còn thiếu số, đọc tiếp đi" — lịch sử hội thoại đầy
các lượt "thiếu số"/"mời đọc lại" khiến model bám vào ngữ cảnh cũ, phớt lờ
`instructions` mới nhất bảo đọc câu xác nhận. 3 lần gửi lại đều bị mismatch
(không giống hệt nhau về câu chữ nên `_lapLaiYHet` — đợt 11 — không bắt được,
nhưng cơ chế "3 lần thì bỏ cuộc" vẫn hoạt động đúng, escalate DTMF thành công).

**Fix**: đổi lời nhắc từ "đọc chậm từng chữ số" (dễ hiểu lầm là ngắt nghỉ giữa
mỗi số) sang "đọc liền một mạch, đừng ngừng giữa chừng" ở cả 3 nhánh
`invalidDanhBoResponse` trong `src/tools.js` (chưa có số / thừa số / thiếu số
— nhánh "thiếu số" giữ nguyên cụm "đọc lại đầy đủ" cũ vì có test kiểm tra cụm
này). Đồng thời thêm hướng dẫn vào `src/system-prompt.js` (mục "Thu thập mã
danh bộ") để lượt hỏi ĐẦU TIÊN (model tự nói, chưa qua code) cũng nói rõ "gồm
11 chữ số" + mời đọc liền một mạch, thay vì chỉ dựa vào 3 câu gợi ý cũ trong
mô tả tool (get_bill/get_payment_status/get_water_usage) vốn không nhắc số
lượng hay cách đọc.

**Ghi chú**: đây là thay đổi NGÔN TỪ dựa trên tương quan quan sát được (7
cuộc), chưa phải thực nghiệm A/B có đối chứng — cần tiếp tục theo dõi tỉ lệ
đọc-một-lượt-thành-công sau khi đổi lời để xác nhận. Lỗi "model quay lại nói
thiếu số khi đang được yêu cầu đọc xác nhận" (quan sát ở
`rtc_u0_E95Q90QYobubPqXAMJSP2`) chưa được sửa TRỰC TIẾP ở lớp code (vẫn dựa
vào cơ chế 3-lần-rồi-bỏ-cuộc có sẵn) — kỳ vọng giảm tần suất nhờ ít lượt đọc
rời rạc hơn, nhưng nếu vẫn tái diễn cần cân nhắc thêm: phát hiện mismatch
"giống Ý NGHĨA" (không chỉ giống y hệt câu chữ) để bỏ cuộc sớm hơn 3 lần.
59/59 test đạt.

## Fix 04/08/2026 (đợt 15) — khách đọc lại TRÙNG số đang chờ bị hiểu nhầm thành phủ định, khoá chết mã ĐÚNG

Log nguồn: `rtc_u1_E95eWKZyqtfuuviHFm4lv`. Khách đọc "Mã danh bộ là 22023 247
431." — ĐÚNG, liền một mạch, đủ 11 số. NHƯNG ngay sau đó bot nói một câu KHÔNG
do code tạo: *"Dạ, cảm ơn Quý Khách đã cho số danh bộ. Tuy nhiên, vị trí số
danh bộ mà em nghe lại thì chưa đúng độ dài. Quý Khách vui lòng đọc lại..."*
— sai hoàn toàn (khách đọc đủ 11 số), rất có thể do cùng loại race đã ghi nhận
ở đợt log trước (model tự trả lời ngay lúc VAD chuyển sang chế độ khoá, trước
khi `session.update` kịp áp dụng). Khách nghe vậy, đọc lại Y HỆT số cũ (không
hề có ý phủ định) — nhưng session-ws.js coi MỌI lượt đọc lại giữa lúc chờ xác
nhận là "phủ định ngầm" (đợt 7), đẩy số ĐÚNG "22023247431" vào danh sách "khách
báo sai" gửi cho trọng tài. Prompt trọng tài có dòng *"đáp án đúng KHÁC các
dãy này ở ít nhất một vị trí — TUYỆT ĐỐI không trả lại y nguyên"* — nên từ đó
trọng tài VĨNH VIỄN từ chối trả lại đúng số đó (`do_tin_cay=0.05`, null), dù
khách có đọc lại đúng bao nhiêu lần nữa. Cuộc gọi bế tắc, phải mời đọc lại vô
ích thêm 1 vòng nữa trước khi log dừng lại.

**Fix**: trong nhánh `_laLuotDocSo` xử lý "khách đọc lại giữa lúc chờ xác
nhận" (`src/session-ws.js`), trước khi coi là phủ định ngầm — so khớp dãy số
khách VỪA đọc (chuẩn hoá bỏ ký tự không phải số) với `_toolCallState.danhBo.value`
đang chờ. TRÙNG Y HỆT → coi là CỦNG CỐ (khách khẳng định lại đúng số), không
phải phủ định: giữ nguyên ứng viên, không đẩy vào danh sách "đã bác bỏ", chỉ
gọi `_reAssertDanhBoStep` (hàm có sẵn) để đọc lại đúng câu xác nhận đang chờ.
Chỉ nhánh KHÔNG trùng (đọc lại ra số khác) mới đi theo đường phủ định ngầm cũ.

**Chưa sửa** (nguyên nhân gốc): race khiến model tự trả lời sai ngay lúc VAD
chuyển chế độ — đã ghi nhận 2 lần ở 2 đợt log liên tiếp (lần trước vô hại, lần
này gây bế tắc thật). Kiến trúc hiện tại không có cách biết trước một lượt là
"đọc số" trước khi có transcript, mà response cũ có thể đã được VAD kích hoạt
trước khi `session.update` (chuyển `create_response:false`) kịp áp dụng. Fix
đợt 15 chỉ chặn HẬU QUẢ nghiêm trọng nhất (khoá chết mã đúng), chưa chặn được
GỐC (model vẫn có thể nói sai lệch một câu). Cần thêm log để đánh giá tần suất
trước khi đầu tư sửa gốc (có thể cần: hủy/bỏ qua response tự phát sinh ngay
sau khi vừa gửi `session.update` chuyển digits, dựa vào cờ `_pendingCodeResponse`
đã có sẵn).

59/59 test đạt. Chưa có test tự động riêng (cùng giới hạn mock WebSocket đã
ghi ở các đợt trước) — cần xác nhận qua cuộc gọi thật tiếp theo.

---

## Fix 04/08/2026 (đợt 16) — model tự đoán ky/nam theo ngày hiện tại thay vì bỏ trống

Log đối chiếu 2 cuộc gọi liên tiếp cùng kịch bản "tiền nước tháng này":

- **`rtc_u2_E95mmJupoqVedcpxyYbaT`**: khách hỏi "tiền nước tháng này là bao
  nhiêu", không nói rõ kỳ/năm. Model tự gọi `get_bill({ma_danh_bo, ky:8,
  nam:2026})` — suy từ NGÀY GỌI ĐIỆN (04/08/2026) chứ không phải kỳ có dữ
  liệu. Kết quả `PRODUCTION_NOT_FOUND` (kỳ 8 chưa có sản lượng), bot phải xin
  lỗi và hỏi lại kỳ khác, khách phải nói lại "Kỳ 7 năm 2026" mới ra kết quả —
  tốn 1 vòng hỏi-đáp thừa.
- **`rtc_u0_E95pYJPzz0rA86H4h2AeB`** (cùng kịch bản, khác cuộc gọi): model gọi
  `get_bill({ma_danh_bo})` — KHÔNG kèm `ky`/`nam` — và hệ thống tự trả về kỳ
  gần nhất có dữ liệu (kỳ 7/2026) ngay lần đầu, không cần hỏi lại.

**Nguyên nhân**: description của `ky`/`nam` trong 4 tool (`get_bill`,
`get_payment_status`, `get_water_usage`, `compare_usage`) chỉ ghi "tùy chọn",
không nói rõ khi nào nên bỏ trống. Bản comment cũ trong file từng có câu "Nếu
không có thông tin kỳ (tháng), năm thì lấy kỳ gần nhất" nhưng đã bị comment-out
từ trước, không còn nằm trong description thật gửi cho model — model quay về
hành vi mặc định là tự suy luận từ ngày hiện tại khi khách nói mơ hồ ("tháng
này").

**Fix**: viết lại description của `ky`/`nam` ở cả 4 tool trong
`src/system-prompt.js`, nêu rõ: CHỈ điền khi khách nói RÕ tháng/kỳ cụ thể;
khách nói mơ hồ ("tháng này", "gần đây", "hiện tại") hoặc không nói gì thì BỎ
TRỐNG field, đừng tự suy ra từ ngày hiện tại — hệ thống tự trả về kỳ gần nhất
có dữ liệu. Nhân tiện phát hiện và sửa luôn một lỗi gõ: khi sửa `compare_usage`
đã lỡ xoá mất `required: ["ma_danh_bo"]`, đã thêm lại.

59/59 test đạt (`node --check` + `npm test` xanh). Đây là quan sát chỉ từ 2
cuộc gọi — cần thêm log thật để xác nhận model tuân theo hướng dẫn mới và
không quay lại thói quen tự đoán kỳ.

---

## Fix 04/08/2026 (đợt 17) — compare_usage vẫn "Chưa có dữ liệu" dù get_bill đã sửa

Log `rtc_u2_E963mRMGPfEe5EOma4Xx1` (cùng ngày, ngay sau đợt 16): đợt 16 đã có
tác dụng đúng như kỳ vọng — `get_bill` gọi KHÔNG kèm `ky`/`nam` và trả về kỳ
7/2026 (kỳ gần nhất có dữ liệu) ngay lần đầu, không cần hỏi lại. Nhưng ngay
sau đó khách hỏi "sản lượng" (ASR nghe thành "Ăn lợn bao nhiêu em?"), model
gọi `compare_usage({ma_danh_bo})` — cũng KHÔNG kèm `ky`/`nam`, đúng theo
hướng dẫn mới — nhưng lại nhận về lỗi "Chưa có dữ liệu sản lượng cho kỳ
8/2026", dù kỳ 7/2026 rõ ràng có dữ liệu (vừa tra `get_bill` thành công ngay
trước đó). Khách quay sang xin gặp tổng đài viên và cuộc gọi được chuyển máy
— một yêu cầu lẽ ra trả lời được ngay bị đẩy thành escalation.

**Nguyên nhân**: đây là instance thứ hai của đúng lỗi đã sửa ở `fetchBilling`
ngày 26/07 (`fix_danh_bo_...` — xem comment trong `fetchBilling`): backend
`/so-sanh-tang-giam`, khi không được truyền `ky`/`nam`, tự mặc định lấy
THEO NGÀY GỌI ĐIỆN HIỆN TẠI (8/2026) thay vì kỳ gần nhất có dữ liệu. Fix 26/07
chỉ vá cho `fetchBilling` (dùng chung bởi `get_bill`/`get_payment_status`/
`get_water_usage`) bằng cách thử lại với `prevPeriod()` khi không có kỳ và
API báo not-found — nhưng `handleCompareUsage` gọi thẳng `getSoSanhTangGiam`
riêng, không đi qua `fetchBilling`, nên không được hưởng fix đó.

**Fix**: thêm đúng logic thử-lại-với-kỳ-liền-trước vào `handleCompareUsage`
(`src/tools.js`) — khi không truyền `ky`/`nam` và lần gọi đầu `!r.success`,
gọi lại `getSoSanhTangGiam` với `prevPeriod()`. Cùng pattern, không tạo
helper mới.

**Ghi nhận thêm**: nên rà lại toàn bộ 4 endpoint dùng `ky`/`nam` tùy chọn
(`/tien-nuoc`, `/san-luong`, `/so-sanh-tang-giam`, và endpoint `get_outages`
không dùng kỳ nên không liên quan) xem có endpoint nào khác cùng hành vi
"mặc định theo ngày hiện tại" mà chưa có lớp thử-lại — hiện `fetchBilling`
dùng chung cho 3/4 tool nên chỉ `compare_usage` bị lọt, nhưng nếu sau này
thêm tool mới dùng `ky`/`nam` tùy chọn thì cần nhớ áp cùng pattern.

59/59 test đạt. Cần xác nhận qua cuộc gọi thật tiếp theo hỏi "sản lượng"/"so
sánh" mà không nói rõ kỳ.

---

## Fix 04/08/2026 (đợt 18) — response.done trùng lặp gọi tool 2 lần, vi phạm call_id

Log `rtc_u1_E96OlQKSLxBoNCZ4pU8Dp`: hai sự kiện `response.done` liên tiếp cách
nhau **38ms**, không có `response.created` mới nào chen giữa, mỗi sự kiện đều
chứa MỘT `function_call` `get_bill({"ma_danh_bo":"123345247"})` — giống hệt
nhau về tên tool, tham số, VÀ `call_id` (`call_dwmJekK0RnjldXP8`). Đây không
phải log trùng do in 2 dòng — hai khối `==========[resolveDanhBo]===========`
riêng biệt trong log xác nhận `dispatchTool` thực sự chạy 2 lần độc lập. Hậu
quả 3 lớp:

1. **Vi phạm bất biến đã ghi ở CLAUDE.md** — "Mỗi `call_id` phải gửi đúng MỘT
   `function_call_output`": code gửi `conversation.item.create` với cùng
   `call_id` hai lần liên tiếp.
2. **Bộ đếm "model bịa số" bị cộng đúp cho MỘT sự kiện logic** — lần xử lý đầu
   ghi nhận R1 (bịa số), lần xử lý thứ hai (38ms sau, cùng args) ghi nhận R4 và
   NGAY LẬP TỨC kết luận "bịa số 2 lần → mời bấm phím DTMF" — leo thang lên
   DTMF chỉ sau khi khách vừa bắt đầu đọc số thật (mới nghe 7/11 số), một trải
   nghiệm tệ và không đúng bản chất (khách chưa hề bịa hay đọc sai 2 lần thật).
3. Gọi `resolveDanhBo`/`fetchBilling` 2 lần cho cùng một tool call — lãng phí,
   và nếu tool đó có side-effect (vd `create_ticket`) sẽ tạo dữ liệu trùng.

**Nguyên nhân**: chưa xác định được OpenAI gửi trùng `response.done` cho CÙNG
một response, hay có race ở tầng WebSocket/xử lý sự kiện của code khiến cùng
một message được xử lý 2 lần — hiện tượng mới quan sát lần đầu, cần thêm log
để khoanh vùng.

**Fix (phòng thủ, không phụ thuộc xác định đúng nguyên nhân gốc)**: thêm
`Set` `_processedToolCallIds` (khai báo cạnh `_toolCallState`, theo cuộc gọi)
trong `src/session-ws.js`. Ngay đầu vòng lặp xử lý `function_call` trong
`response.done`, nếu `call_id` đã có trong Set → bỏ qua hẳn (không chạy
`dispatchTool`, không gửi `function_call_output`, chỉ log
`tool_call_duplicate_ignored`); chưa có thì thêm vào Set rồi xử lý bình
thường. An toàn với MỌI kịch bản có thể gây trùng (OpenAI gửi lặp, code xử lý
lặp, hay retry ở tầng nào khác) vì `call_id` do OpenAI cấp vốn phải duy nhất
cho mỗi lệnh gọi tool thật.

59/59 test đạt. Chưa có test tự động mô phỏng được 2 `response.done` trùng
`call_id` (giới hạn mock WebSocket) — cần theo dõi log
`tool_call_duplicate_ignored` ở các cuộc gọi tiếp theo để biết tần suất hiện
tượng gốc.

---

## Fix 04/08/2026 (đợt 19) — khoá im lặng vô thời hạn, khách cúp máy bực bội

Bug **nghiêm trọng nhất** phát hiện được trong cả đợt rà soát này — có bằng
chứng khách hàng thật sự cúp máy vì tức giận. Log `rtc_u0_E96ZWOOhKRYuhnpys7jYm`:

1. Khách đọc số, hệ thống chốt đúng `22023247431`, bot hỏi xác nhận
   ("...Quý Khách xác nhận giúp em có đúng không ạ?") lúc 17:22:45 — bot nói
   đúng câu, `_expectedSpeak` đã cleared (xác nhận bot nói đúng).
2. Sau đó khách nói LIÊN TIẾP 5 lượt trong 41 giây: "Xin chào quý khách."
   (có thể ASR nghe nhầm ý định trả lời), "Đọc đi em.", "tôi", rồi bực bội
   **"Trời ơi, cái thằng điên này nó làm cái gì vậy?"**, rồi "Dạ." — MỌI lượt
   đều bị log `Giữ khoá — đang xác minh, bỏ qua lượt` — bot không nói bất cứ
   điều gì, không đọc lại câu hỏi, không mở khoá cho model, hoàn toàn im lặng.
3. 17:23:29 — WebSocket đóng (1006, abnormal) — khách cúp máy.

**Nguyên nhân gốc**: nhánh "Giữ khoá — đang xác minh" (thêm từ đợt 8, 27/07)
dùng điều kiện:
```js
_toolCallState._danhBoVerifyRunning || _expectedSpeak ||
  danhBoSessionDigits(_toolCallState) >= 11
```
Mục đích BAN ĐẦU chỉ là bảo vệ một khoảng hẹp — từ lúc đủ 11 số tới lúc câu
hỏi xác nhận được phát ra. Nhưng `danhBoSessionDigits(_toolCallState)` (số ký
tự trong `_danhBoSession.digits` — phiên đọc HIỆN TẠI) **KHÔNG BAO GIỜ được
reset khi chuyển từ "gom số" sang "chờ xác nhận"** — chỉ reset khi một phiên
đọc MỚI được mở (`startDanhBoRequest`, xảy ra khi mời đọc lại hoặc khách đọc
lại giữa chừng). Sau khi câu hỏi xác nhận đã hỏi xong, `_danhBoVerifyRunning`
về false và `_expectedSpeak` đã cleared — nhưng vế thứ ba
(`danhBoSessionDigits >= 11`) **vẫn mãi mãi đúng**, vì phiên đọc cũ (11 số)
chưa từng bị xoá. Kết quả: MỌI lượt khách sau đó (trừ khi khớp đúng "đúng/sai"
rõ ràng qua `_isAffirmative`/`_PHU_DINH_RE`, hoặc khớp regex "đọc lại") đều
rơi vào nhánh này và bị bỏ qua hoàn toàn, VÔ THỜI HẠN — không có gì trong
code từng thoát khỏi trạng thái này.

**Fix** (`src/session-ws.js`):
1. Thêm điều kiện `!_toolCallState.danhBo` vào nhánh "Giữ khoá" — một khi đã
   có ứng viên danh bộ (nghĩa là đã CHUYỂN QUA giai đoạn chờ xác nhận), số đếm
   `danhBoSessionDigits` của phiên gom số cũ coi như hết hiệu lực, không được
   dùng làm lý do giữ khoá nữa. Chỉ `_danhBoVerifyRunning`/`_expectedSpeak`
   (tín hiệu SỐNG, phản ánh đúng trạng thái hiện tại) mới còn được dùng.
2. Thêm nhánh MỚI ngay sau đó: khi đã có ứng viên chưa xác nhận
   (`_toolCallState.danhBo` tồn tại, `!confirmed`) và câu hỏi xác nhận đã có
   sẵn (`_danhBoLastPrompt`), nhưng lượt khách không khớp đúng/sai/đọc lại số/
   xin nhắc lại rõ ràng → **đọc LẠI câu hỏi xác nhận** bằng `_reAssertDanhBoStep`
   (hàm có sẵn, cùng cơ chế dùng ở đợt 15/7), thay vì im lặng. Đồng thời tự
   `_armDanhBoWatchdog()` lại — nếu vòng lặp "trả lời không rõ" kéo dài thật sự
   90 giây không tiến triển, watchdog vẫn là lưới an toàn cuối leo thang DTMF.

59/59 test đạt (`node --check` + `npm test` xanh; test unit sẵn có cho nhánh
"Giữ khoá" dùng mock cục bộ không đụng tới `_toolCallState.danhBo` nên không
bị ảnh hưởng, vẫn xanh). Chưa có test tự động cho nhánh MỚI (cùng giới hạn mock
WebSocket) — cần xác nhận qua cuộc gọi thật: khách trả lời không rõ ràng sau
khi đã được hỏi xác nhận mã danh bộ phải được bot hỏi lại, không im lặng.

---

## Ghi nhận thêm 05/08/2026 — không sửa, chỉ quan sát

Log 2 cuộc gọi sáng 05/08 (`rtc_u2_E9LYHoo962HRmWphKGQj9`,
`rtc_u2_E9La488vj8QS9IXfJ0AgT`): cả hai chốt danh bộ đúng, xác nhận đúng, tra
cứu thành công — không thấy tái diễn bug đợt 19 (im lặng vô thời hạn) hay đợt
15/17/23 (fallback kỳ, đọc lại trùng số). Xác nhận các fix đang hoạt động tốt.

Một hiện tượng ĐÁNG NGHI NGỜ nhưng đã TỰ PHỤC HỒI, không cần sửa: cuộc
`E9La488vj8QS9IXfJ0AgT` lúc 09:24:42 — code vừa yêu cầu bot nói câu
`danh_bo_verify_filler` ("Dạ, em ghi nhận rồi ạ..."), nhưng audio transcript
trả về lại là NGUYÊN VĂN câu `danh_bo_reread` đã nói TRƯỚC ĐÓ ~22 giây ("Dạ,
em nghe được tám số..."). `_checkExpectedSpeak` (đợt 4/11) phát hiện lệch,
tự động gửi lại đúng câu cần nói, cuộc gọi tiếp tục bình thường — khách không
nghe thấy gì bất thường. Rất có thể đây là MỘT BIỂU HIỆN KHÁC của đúng race
đã ghi ở đợt 18 (response.done/response trùng lặp hoặc đến trễ) — lần này lộ
ra qua transcript giọng nói thay vì qua tool call. Không sửa gì thêm ở đợt
này vì lưới an toàn sẵn có đã xử lý đúng; ghi lại làm bằng chứng thứ hai cho
việc điều tra nguyên nhân gốc ở đợt 18 khi có đủ dữ liệu.

Ngoài ra log có nhiều dòng `WARN [DB] ... ECONNREFUSED 127.0.0.1:3306` — MySQL
cục bộ không chạy trong lúc test. Không phải lỗi code: mọi lỗi DB đã được
try/catch + WARN (đúng thiết kế "lỗi DB không được làm sập cuộc gọi"), cuộc
gọi vẫn chạy và tra cứu bình thường qua `TONGDAI_API_BASE` (khác DB nội bộ
dùng để ghi log/giá). Chỉ cần khởi động lại MySQL nếu muốn log được ghi đầy đủ
vào `voicebot_calllog`/`voicebot_toolcall`.

---

## Fix 05/08/2026 (đợt 20) — bỏ cuộc lần 2 sau DTMF, cuộc gọi im lặng tới khi khách cúp máy

Log `rtc_u1_E9LkfCNs3Zs6eNiIHxbXb` — chuỗi sự kiện đầy đủ, một trong những
case rõ ràng nhất về lỗi PHÁT ÂM TTS mang tính hệ thống:

1. Trọng tài chốt đúng `22023247431`. Bot đọc lại xác nhận
   ("Hai-Hai-Không-Hai-Ba-Hai-Bốn-**Bảy**-Bốn-Ba-Một") nhưng audio thực tế lại
   RỚT MẤT đúng chữ "Bảy" — ra "Hai-Hai-Không-Hai-Ba-Hai-Bốn-Bốn-Ba-Một" (10
   số, thiếu 1). `_checkExpectedSpeak` phát hiện lệch, gửi lại — bot đọc lần 2
   RỚT LẠI ĐÚNG CHỮ ĐÓ (giống hệt lần 1) → cơ chế "lặp lại y hệt lỗi cũ" (đợt
   8/31-07) bỏ cuộc SỚM, đúng thiết kế `_escalateDanhBoToDtmf` mời khách bấm
   phím ngay. Đây là lần THỨ HAI ghi nhận model rớt một chữ số cụ thể một cách
   NHẤT QUÁN trên chuỗi 3 số cạnh nhau có 2 số giống nhau kẹp 1 số khác giữa
   (lần trước ở đợt 31/07 là "Bảy-Bảy-Bảy-Năm" bị THỪA; lần này "Bốn-Bảy-Bốn"
   bị THIẾU) — càng củng cố đây là lỗi phát âm TTS của model, không phải
   nhiễu ngẫu nhiên.
2. Khách bấm đúng DTMF `22023247431` (khớp 100% với số đã chốt). Bot đọc lại
   xác nhận số VỪA BẤM (tag `dtmf_danh_bo_confirm`) — và RỚT MẤT ĐÚNG CHỮ
   "Bảy" LẦN NỮA, 2 lần liên tiếp (lần 3 và lần 4 tính từ đầu cuộc gọi) → cơ
   chế "lặp lại y hệt" bỏ cuộc lần 2, gọi `_escalateDanhBoToDtmf` lần nữa.
3. **Bug**: `_escalateDanhBoToDtmf` có guard `if (_toolCallState._danhBoDtmfInvited)
   return;` — vì DTMF đã được mời ở bước 1, guard này chặn và hàm KHÔNG LÀM
   GÌ CẢ. Không còn nhánh nào khác được gọi tiếp theo. Log dừng lại ở dòng
   `response.done` rồi **17 giây im lặng tuyệt đối**, sau đó WebSocket đóng —
   khách tự cúp máy.

**Nguyên nhân**: `_escalateDanhBoToDtmf` chỉ có ĐÚNG MỘT lối thoát (mời bấm
phím), không có phương án dự phòng cho trường hợp kênh DỰ PHÒNG (DTMF) cũng
đã dùng rồi mà bot vẫn không đọc lại xác nhận được — một tình huống mà dữ
liệu đã chắc chắn đúng (DTMF "chính xác tuyệt đối" theo tài liệu dự án) nhưng
hệ thống (TTS) không hoàn thành được vòng xác nhận.

**Fix** (`src/session-ws.js`, trong `_escalateDanhBoToDtmf`): khi guard
`_danhBoDtmfInvited` chặn (nghĩa là đã hết cả 2 kênh tự động — giọng nói và
DTMF), thay vì `return` im lặng, **chuyển máy cho tổng đài viên ngay**: đọc
một câu xin lỗi ngắn không chứa chữ số (né hẳn lỗi phát âm đang gặp phải,
`verify:false` vì cuộc sắp chuyển máy nên không cần đối chiếu), rồi gọi
`_handleTransfer` (hàm dùng chung với nhánh `transfer_to_agent` của tool,
đã có sẵn, xử lý refer + xoá cờ trùng lặp qua `_transferred`). Đúng tinh thần
"Bot câm tệ hơn bot trả lời sai" đã ghi trong CLAUDE.md — không để khách ở
trong im lặng vô thời hạn dù dữ liệu bên dưới đã hoàn toàn chính xác.

59/59 test đạt (`node --check` + `npm test` xanh). Chưa có test tự động cho
nhánh dead-end này (giới hạn mock WebSocket, cũng như đợt 19). Cần xác nhận
qua cuộc gọi thật: nếu bot bỏ cuộc đọc xác nhận DTMF lần 2, cuộc gọi phải
được chuyển máy có lời thông báo, không im lặng.

**Ghi nhận thêm**: đây là lần THỨ HAI (31/07 và 05/08) quan sát model
`gpt-realtime-2.1-mini` rớt/thừa một chữ số MỘT CÁCH NHẤT QUÁN khi đọc chuỗi
3 chữ số có dạng "A-B-A" (hai số giống nhau kẹp một số khác). Nếu còn tái diễn,
nên cân nhắc thêm bước "diễn giải khác cách đọc" (vd chèn khoảng ngắt rõ hơn
giữa từng số, hoặc đọc theo cặp thay vì liền mạch 11 số) cho CHÍNH XÁC câu đọc
lại xác nhận — hiện tại `_speakVerbatim` luôn dùng cùng một cách đọc
("Hai - Hai - Không - ...") cho mọi mã, chưa thử biến thể nào khi phát hiện
lỗi lặp lại.
