# CLAUDE.md

Hướng dẫn cho AI coding assistant khi sửa code trong repo này.
Giới thiệu, cài đặt, cấu trúc chung: xem [README.md](README.md).

## Bối cảnh nhanh

Voice Bot CSKH Cấp nước Trung An — trợ lý tiếng Việt trả lời cuộc gọi qua
**OpenAI Realtime API + SIP**. OpenAI xử lý audio trực tiếp; Node.js chỉ là
*control plane* (webhook → accept call → WebSocket theo dõi sự kiện + function call).
Node >= 18, ESM (`"type": "module"`). Deps: `express`, `ws`, `dotenv`.

Entry point: **`server.js`**. Chạy: `npm start` / `npm run dev`. Health: `GET /health`.
Không có test tự động/linter — `test_case/`, `test_cases_Excel/` là kịch bản thủ công.
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

Tool state — `confirm_danh_bo`: ghi nhận + đếm + lưu mã danh bộ vào `callState`
(fix 18/07/2026, xem `docs/fix/fix_confirm_danh_bo_20260718.md`); các tool tra
cứu dùng số đã lưu qua `resolveDanhBo`, KHÔNG tin `ma_danh_bo` model truyền lại.
Trọng tài gpt-5.1 chạy như CO-PILOT NGẦM, LUÔN chạy nền (không bao giờ chặn bot
đọc lại — timeout 20s): bot đọc lại NGAY bản realtime, khách báo sai/tra cứu
NOT_FOUND thì thay bằng ứng viên nền. Model mini không gom được số khách đọc qua
NHIỀU HƠI → session-ws tự gọi `proactiveAssembleDanhBo` sau khi khách ngưng ~3s,
gpt-5.1 ghép transcript thành 11 số rồi code tự đọc lại xác nhận (không chờ
model gọi tool). Hết 3 lượt / gom ≥3 nhịp không ra → mời BẤM PHÍM DTMF
(session-ws.js tự buffer, đủ 11 số tự đọc lại xác nhận) (fix 19/07/2026, xem
`docs/fix/fix_danh_bo_trong_tai_20260719.md` và
`docs/fix/fix_danh_bo_copilot_dtmf_20260719.md`).
Danh bộ do trọng tài đưa ra CHỈ được dùng để tra cứu sau khi có LƯỢT KHÁCH THẬT
xác nhận (gate `_danhBoNeedsVerbalYes` — model gọi thẳng tool tra cứu KHÔNG
được tính là bằng chứng đồng ý, đã có cuộc gọi thật bỏ qua bước đọc lại). Số
bấm DTMF không qua "tai" model → không cần gate, chỉ cần xác nhận thường.

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
- Lỗi async bị nuốt nhiều chỗ để **không sập tiến trình giữa cuộc gọi** (có
  `unhandledRejection`/`uncaughtException` handler ở `server.js`). Cẩn thận khi
  refactor xử lý lỗi.
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
