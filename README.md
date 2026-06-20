# Voice Bot Tổng đài CSKH – Cấp nước Trung An (CNTA)

Trợ lý ảo tiếng Việt trả lời cuộc gọi điện thoại cho tổng đài chăm sóc khách hàng
Công ty CP Cấp nước Trung An. Bot giúp khách hàng tra cứu tiền nước, sản lượng,
so sánh tăng/giảm, kiểm tra tình trạng cúp nước, hướng dẫn thủ tục hành chính,
tiếp nhận sự cố, và chuyển máy cho tổng đài viên khi cần.

## Tính năng

- Tra cứu **tiền nước** (hóa đơn) theo mã danh bộ.
- Tra cứu **sản lượng** nước sử dụng và **so sánh tăng/giảm** so với kỳ trước.
- Kiểm tra **tình trạng cúp nước / sự cố** theo khu vực.
- **Hướng dẫn thủ tục hành chính**: định mức nước, lắp đặt đồng hồ, sang tên...
- **Tiếp nhận sự cố** (rò rỉ, áp lực nước) và tạo phiếu.
- **Chuyển máy** sang tổng đài viên khi vượt phạm vi hỗ trợ.
- Tự nhận diện khách qua số điện thoại gọi đến và xác nhận danh bộ.
- Ghi log hội thoại + chi phí token theo từng cuộc gọi.

## Cách hoạt động

Bot dùng **OpenAI Realtime API qua SIP**. OpenAI nhận và xử lý audio cuộc gọi trực
tiếp; server Node.js chỉ đóng vai trò *control plane*: nhận webhook, accept cuộc gọi,
và mở WebSocket để theo dõi sự kiện + xử lý function call.

```
Asterisk ──SIP──▶ sip:{PROJECT_ID}@sip.api.openai.com
                          │
        OpenAI ──webhook──▶ POST /webhook (server.js)
                          │  accept call (REST) + WebSocket monitor
                          ▼
                  Function calls (tra cứu / chuyển máy / cúp máy)
                          │
                          ▼
                  REST API backend (docs/api.php)
```

Chi tiết các bước:

1. Asterisk → SIP trunk → `sip:{OPENAI_PROJECT_ID}@sip.api.openai.com`.
2. OpenAI gửi `POST /webhook` (`realtime.call.incoming`) → server xác minh chữ ký,
   trích số điện thoại từ SIP header.
3. Tra cứu khách hàng theo SĐT để dựng ngữ cảnh (`customerContext`).
4. Accept cuộc gọi kèm system prompt + danh sách tools + ngữ cảnh khách hàng.
5. Mở WebSocket theo dõi sự kiện, xử lý function call, ghi log khi kết thúc.

## Yêu cầu

- Node.js >= 18 (dùng ESM).
- Tài khoản OpenAI có quyền Realtime API + cấu hình webhook & SIP.
- Asterisk (hoặc SIP trunk) định tuyến cuộc gọi đến OpenAI.
- REST API backend của tổng đài (`docs/api.php`) cho dữ liệu thật.

## Cài đặt

```bash
npm install
cp .env.example .env   # rồi điền các giá trị thật
```

## Cấu hình (.env)

| Biến | Mô tả |
|------|-------|
| `OPENAI_API_KEY` | API key OpenAI (bắt buộc). |
| `OPENAI_WEBHOOK_SECRET` | Secret để verify chữ ký webhook (lấy ở Project > Webhooks). |
| `OPENAI_PROJECT_ID` | Project ID OpenAI (dùng cho SIP URI). |
| `OPENAI_REALTIME_MODEL` | Model Realtime (mặc định `gpt-realtime-2`). |
| `OPENAI_VOICE` | Giọng đọc (`alloy`, `echo`, `shimmer`...). |
| `PORT` | Cổng server (mặc định `8000`). |
| `WEBHOOK_PATH` | Path nhận webhook (mặc định `/webhook`). |
| `AGENT_QUEUE_URI` | SIP URI hàng đợi tổng đài viên để chuyển máy. |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`. |
| `TONGDAI_API_BASE` | Base URL REST API backend (`api.php`). |
| `TONGDAI_API_TIMEOUT_MS` | Timeout gọi backend (ms). |

## Chạy

```bash
npm start        # node server.js
npm run dev      # node --watch server.js (tự reload khi sửa file)
```

Kiểm tra server: `GET http://localhost:8000/health`.

## Cấu trúc thư mục

```
server.js                  # entry point – Express webhook server
src/
  call-manager.js          # REST wrapper: accept / reject / refer / hangup call
  session-ws.js            # WebSocket runtime: sự kiện + function call
  tools.js                 # handler các function call + router
  api.js                   # client gọi REST backend (docs/api.php)
  system-prompt.js         # SYSTEM_PROMPT + định nghĩa TOOLS
  conversation-logger.js   # ghi transcript + chi phí token
  pricing.js               # tính cost từ token usage
  logger.js                # logger theo LOG_LEVEL (giờ GMT+7)
  webhook-verify.js        # verify HMAC chữ ký webhook
  huongdanthutuc-data.js   # dữ liệu thủ tục hành chính
docs/                      # api.php (backend) + tài liệu API
conversation_summary/      # log hội thoại JSON theo ngày
test_case/, test_cases_Excel/  # kịch bản thử nghiệm thủ công
```

## Log hội thoại

Mỗi cuộc gọi được lưu thành JSON trong
`conversation_summary/yyyy/mm/dd/{tel}_{callId}.json`, gồm transcript 2 chiều,
function call, token usage và chi phí ước tính.

## Ghi chú

- Một số file ở thư mục gốc là bản nháp/tham khảo, không phải mã chạy
  (`server copy.js`, `server_loli.js`, `openai_nestle_step3.js`, `_broken_backup_*`).
  Entry point chính thức là `server.js`.
- Tài liệu kỹ thuật cho AI coding assistant: xem [CLAUDE.md](CLAUDE.md).
