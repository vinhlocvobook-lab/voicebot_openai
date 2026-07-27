# CLAUDE.md

Hướng dẫn cho AI coding assistant khi sửa code trong repo này.
Giới thiệu, cài đặt, cấu trúc chung: xem [README.md](README.md).

## Bối cảnh nhanh

Voice Bot CSKH Cấp nước Trung An — trợ lý tiếng Việt trả lời cuộc gọi qua
**OpenAI Realtime API + SIP**. OpenAI xử lý audio trực tiếp; Node.js chỉ là
*control plane* (webhook → accept call → WebSocket theo dõi sự kiện + function call).
Node >= 18, ESM (`"type": "module"`). Deps: `express`, `ws`, `dotenv`.

Entry point: **`server.js`**. Chạy: `npm start` / `npm run dev`. Health: `GET /health`.
Test: `npm test` (4 file `.test.mjs` trong `test_case/`, thuần logic + giả lập `fetch`, không cần
`.env`/mạng). Các file còn lại trong `test_case/`, `test_cases_Excel/` là kịch bản thủ công.
Cần `.env` (xem `.env.example`); thiếu `OPENAI_API_KEY` server không chạy.

## Bản đồ module (`src/`)

| File | Vai trò |
|------|---------|
| `call-manager.js` | Wrapper REST OpenAI Realtime Calls: `acceptCall`, `rejectCall`, `referCall` (REFER/chuyển máy), `hangupCall`. |
| `session-ws.js` | **Trái tim runtime.** Mở WebSocket, gửi `session.update` (VAD) + `response.create` (chào), bắt function call từ `response.done`, route kết quả, ghi transcript, xử lý `end_call`/`transfer_to_agent`, lưu log khi đóng. |
| `tools.js` | Handler từng function call + `dispatchTool(name, args, callState)` — `callState` là state theo cuộc gọi do session-ws truyền (vd guard "đã hỏi đối tượng"). `normalizeDanhBo()` bỏ mọi ký tự không phải số. |
| `api.js` | Client REST gọi `docs/api.php`. Bóc response 2 lớp (gateway + nghiệp vụ), có timeout. **Nguồn dữ liệu hiện hành.** |
| `danh-bo-arbiter.js` | Trọng tài mã danh bộ: 2 lần đọc chưa chốt → gửi mọi quan sát (dãy model nghe + transcript + danh bộ theo SĐT) cho model mạnh (`DANH_BO_ARBITER_MODEL`, mặc định gpt-5.1) suy ra dãy 11 số khả dĩ nhất. |
| `system-prompt.js` | `SYSTEM_PROMPT` (persona "Em"/"Quý Khách") + mảng `TOOLS` (JSON schema gửi OpenAI). |
| `conversation-logger.js` | `ConversationLogger`: transcript 2 chiều, tool call, token usage, chi phí → `conversation_summary/yyyy/mm/dd/{tel}_{callId}.json`. |
| `pricing.js` | Tính cost từ token (`calcRealtimeCost`, `calcChatCost`) theo `openai_pricing.json`. |
| `logger.js` | Logger tối giản theo `LOG_LEVEL`, timestamp GMT+7. |
| `webhook-verify.js` | Verify HMAC-SHA256 webhook. Bỏ qua nếu chưa set secret (dev). |
| `huongdanthutuc-data.js` | `PROCEDURES` — dữ liệu thủ tục hành chính cho `get_procedure_info`. |
| `audiosocket.js`, `audio-utils.js` | Asterisk AudioSocket (TCP) + resample PCM16. **KHÔNG nằm trong luồng SIP chính** (OpenAI tự xử lý audio); đường để dành. |
| `mock-api.js` | Backend giả cũ. **Đã thay bằng `api.js`** — chỉ tham khảo. |

### Function call (tools)

Schema ở `system-prompt.js` (`TOOLS`), xử lý ở `tools.js` (11 tool):

Tool dữ liệu — `get_bill`, `get_payment_status`, `get_water_usage`,
`compare_usage`, `get_outages`, `create_ticket`, `get_procedure_info`,
`check_missing_docs`: trả JSON cho AI đọc lại cho khách.

**Luồng mã danh bộ — CODE làm chủ, không nhờ model** (fix 26/07/2026, xem
`docs/fix/fix_danh_bo_hai_bien_muc_b_20260726.md`):

- **Hai biến tích luỹ tách vai trò.** `_danhBoTranscripts` (biến 1, TOÀN cuộc gọi,
  ≤20 lượt) chỉ cấp quan sát cho trọng tài — **không bao giờ** dùng để đếm.
  `_danhBoSession` (biến 2 = `{requestNo, startedAt, turns, digits}`, MỘT lượt yêu
  cầu khách đọc, reset mỗi lần mời đọc lại) là biến **duy nhất** để xác định đủ /
  chưa đủ / vượt 11 số.
- **`resolveDanhBo` là CỔNG KHÔNG CHẶN** (~1ms): trả `dang_gom_so` / `dang_xac_minh`
  / `invalid_danh_bo` ngay. TUYỆT ĐỐI không `await` việc gom số hay trọng tài trong
  tool — xem quy ước "không để tool call treo" bên dưới.
- **Thu số + xác minh + đọc lại xác nhận chạy ở ĐƯỜNG NỀN** (`session-ws.js` →
  `verifyDanhBoFromSession`), code tự phát lời bằng `_speakVerbatim`. Khách ngưng
  đọc ~1,5s → chạy SONG SONG verify API (~40ms) và trọng tài gpt-5.1 (hạn 6s).
  Transcript ra đúng 11 số **vẫn phải qua gpt-5.1** — ASR có thể nghe sai mà vẫn
  ra đủ 11 chữ số, con số trông "sạch" nhưng lại sai.
- **`ma_danh_bo` model truyền vào CHỈ là một quan sát** cho trọng tài
  (`_danhBoReads`). Không tra cứu, không đếm, không ghi vào `callState.danhBo`.
  `classifyModelArg` (R1–R4, Levenshtein) lọc số bịa — trường này là `required`
  trong schema nên model BỊ ÉP phải điền kể cả khi chưa nghe được gì.
- **Leo thang theo `_danhBoSession.requestNo`** (bộ đếm DUY NHẤT, đếm đúng thứ khách
  cảm nhận): đạt 3 → mời BẤM PHÍM DTMF. Watchdog 90s là lưới an toàn cuối.
- **VAD đổi theo giai đoạn**: đang đọc số → `server_vad` `silence_duration_ms: 2000`
  (semantic_vad chốt lượt theo ngữ nghĩa nên cắt vụn từng hơi đọc số); chốt xong →
  `semantic_vad`. Phải trả về ở MỌI nhánh thoát + watchdog 90s.
- **MỨC C — model bị KHOÁ trong giai đoạn thu số** (`create_response: false`).
  Audio vẫn transcribe, chỉ là model không tự nói → hết cảnh model bịa số/đọc nhầm
  câu. Đổi lại CODE phải phát MỌI câu: mỗi lượt khách nói phải rơi vào đúng một
  nhánh có phát lời (gom số / xác nhận / phủ định / đổi chủ đề), xem bảng quyết
  định trong `session-ws.js`. `_requestModelReply()` để nhờ model tự trả lời.
  Lưới an toàn `_armMuteWatchdog` (15s) mở khoá nếu bot lỡ im lặng — mỗi event
  `mute_watchdog` trong log là một nhánh code còn thiếu, phải bịt riêng.
  **Bot câm tệ hơn bot trả lời sai.**
- **`message` của tool NẰM LẠI VĨNH VIỄN trong hội thoại** (nó là nội dung
  `function_call_output`). TUYỆT ĐỐI không đặt mệnh lệnh kiểu 'Đọc NGUYÊN VĂN
  doc_cho_khach' vào đó — model sẽ bám vào ở mọi lượt sau, kể cả khi code đã
  gửi `instructions` mới (cuộc `rtc_u2_E66xM4TYW8qxz07ijdLzB`). `message` chỉ
  MÔ TẢ TRẠNG THÁI; việc ép đọc nguyên văn đặt ở `instructions` của
  `response.create` — chỉ hiệu lực cho đúng response đó rồi biến mất.
- **Gate xác nhận lời nói**: `danhBo.confirmed` chỉ được đặt bởi LƯỢT KHÁCH THẬT
  chứa từ khẳng định (`session-ws.js`). Model gọi thẳng tool tra cứu KHÔNG tính là
  bằng chứng đồng ý. Hỏng chỗ này = bot đọc thông tin người khác cho khách nghe.
  Ngoại lệ: danh bộ hệ thống cấp theo SĐT (`knownDanhBo`) tin ngay.
  (fix 19/07/2026: `docs/fix/fix_danh_bo_trong_tai_20260719.md`,
  `docs/fix/fix_danh_bo_copilot_dtmf_20260719.md`)

Tool action — `transfer_to_agent`, `end_call`: handler chỉ trả confirmation;
hành động thật (REFER / hangup) thực thi trong `session-ws.js` dựa trên field
`action`, có guard chống trùng (`_hungUp`, `_transferred`).

## Bẫy & quy ước (đọc trước khi sửa)

- **Mã danh bộ** = chuỗi 11 chữ số. AI hay đọc kèm gạch ngang/khoảng trắng → luôn
  chạy `normalizeDanhBo()` trước khi gọi API. Khi đọc lại cho khách thì đọc **từng
  chữ số** tiếng Việt (`spokenDanhBo` trong `server.js`).
- **SIP session khác WebSocket thường**: KHÔNG có `session.created`. Phải gửi
  `session.update` (kèm `type: "realtime"`) ngay khi WS `open`, nếu không lỗi
  "Missing session.type". Câu chào gửi qua `response.create` sau ~1s.
- Mỗi `call_id` phải gửi đúng **một** `function_call_output`. Với
  `end_call`/`transfer_to_agent` **không** gửi thêm `response.create` (model đã nói
  lời kết) — tránh `conversation_already_has_active_response`.
- `hangupCall`/`referCall` có delay (3s/2s) cho AI nói xong; lỗi **404 khi cúp máy
  coi như thành công** (cuộc gọi đã kết thúc).
- **KHÔNG để tool call treo quá ~2 giây.** VAD vẫn sinh response trong lúc treo và
  model **luôn** lấp khoảng trống bằng nội dung bịa (cuộc `rtc_u2_E5eDfB96UnJE6iDWfPbRX`:
  tool treo 21s → bot đọc 2 số danh bộ tự nghĩ ra cho khách nghe 4 lần). Việc chờ
  phải nằm ở đường nền + `_speakVerbatim`, không nằm trong `function_call_output`.
- **Mọi bước quan trọng phải có lối đi không phụ thuộc việc model gọi tool.** Fix
  25/07 tắt đường nền danh bộ đã vô tình biến model mini thành điểm lỗi đơn.
- **Ngưỡng leo thang tính theo trải nghiệm khách** (số lượt đã đọc, số giây đã trôi),
  không theo số lần code chạy qua một nhánh nội bộ.
- **API tra cứu là trọng tài rẻ nhất và chắc nhất** (~40ms) — dùng nó để phân xử ứng
  viên, đừng bắt LLM tự chịu trách nhiệm chọn duy nhất một đáp án.
- Lỗi async bị nuốt nhiều chỗ để **không sập tiến trình giữa cuộc gọi** (có
  `unhandledRejection`/`uncaughtException` handler ở `server.js`). Cẩn thận khi
  refactor xử lý lỗi. `SIGINT`/`SIGTERM` flush log mọi phiên đang mở trước khi
  thoát (`flushAllSessions`) — không có nó thì cuộc gọi lỗi nặng nhất lại là cuộc
  không có log để phân tích.
- `api.js` trả về **lớp trong** (nghiệp vụ) đã bóc khỏi response gateway 2 lớp —
  đừng giả định cấu trúc phẳng.

## File KHÔNG phải mã chạy (bỏ qua)

`server copy.js`, `server_loli.js`, `openai_nestle_step3.js`,
`_broken_backup_20260602/`, `huongdanthutuc.js/.md/.docx`, `plan.docx/.md`,
`src/mock-api.js`, `src/audiosocket.js` + `src/audio-utils.js` (không trong luồng SIP).
Entry point chính thức: `server.js`.

## Biến môi trường

Danh sách đầy đủ + mô tả: xem bảng trong [README.md](README.md#cấu-hình-env).
Tối thiểu cần `OPENAI_API_KEY`; chuyển máy cần `AGENT_QUEUE_URI`; dữ liệu thật cần
`TONGDAI_API_BASE`.
