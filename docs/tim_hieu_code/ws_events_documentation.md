# Tài Liệu Chi Tiết Về Các Event Trong WebSocket Session (`session-ws.js`)

Tài liệu này tổng hợp toàn bộ các **Sự kiện (Events)** được xử lý và gửi đi trong file [`session-ws.js`](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js). Hệ thống sử dụng kết nối WebSocket trực tiếp đến OpenAI Realtime API over SIP để điều khiển luồng cuộc gọi voice tự động.

Các event được chia làm 3 nhóm chính:
1. **[Nhóm 1] Sự kiện Kết Nối WebSocket Hạ Tầng (Socket Lifecycle Events)**
2. **[Nhóm 2] Sự kiện OpenAI Realtime API Gửi Về Client (Server-to-Client Events)**
3. **[Nhóm 3] Lệnh Client Gửi Lên OpenAI Realtime API (Client-to-Server Events)**

---

## 🌐 NHÓM 1: Sự Kiện Kết Nối WebSocket Hạ Tầng (Socket Lifecycle)

Đây là các sự kiện chuẩn của thư viện WebSocket (`ws` trong Node.js) quản lý việc đóng/mở kết nối mạng.

### 1.1 `ws.on("unexpected-response")`
- **Khi nào xảy ra?**: Khi quá trình bắt tay WebSocket (Handshake) bị máy chủ OpenAI từ chối (trả về HTTP Status khác 101 Switching Protocols, ví dụ: HTTP 404, 401, 403, 500).
- **Dùng để làm gì?**: Đọc thông tin chi tiết HTTP Status, `x-request-id`, `openai-project` và Response Body trả về từ OpenAI để phục vụ debug lý do từ chối handshake (ví dụ: Session ID không tồn tại hoặc hết hạn).
- **Đoạn code xử lý**: [Lines 235-246](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L235-L246)

### 1.2 `ws.on("open")`
- **Khi nào xảy ra?**: Ngay khi kết nối WebSocket với OpenAI Realtime API thiết lập thành công.
- **Dùng để làm gì?**:
  1. Gửi cấu hình session mở đầu (`session.update`) quy định voice model, cấu hình Semantic VAD, transcription model.
  2. Hẹn giờ (`setTimeout 1000ms`) gửi lệnh `response.create` để bot phát câu chào cố định đến khách hàng.
- **Đoạn code xử lý**: [Lines 248-331](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L248-L331)

### 1.3 `ws.on("close")`
- **Khi nào xảy ra?**: Khi kết nối WebSocket bị đóng (do khách cúp máy, server kết thúc cuộc gọi hoặc lỗi mạng).
- **Dùng để làm gì?**: Ghi log sự kiện đóng kết nối và kích hoạt hàm `_saveOnce()` để lưu toàn bộ nhật ký cuộc gọi (conversation summary) và thống kê chi phí vào cơ sở dữ liệu.
- **Đoạn code xử lý**: [Lines 773-777](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L773-L777)

### 1.4 `ws.on("error")`
- **Khi nào xảy ra?**: Khi xảy ra lỗi ổ cắm WebSocket (network socket error).
- **Dùng để làm gì?**:
  - Ghi log lỗi vào hệ thống.
  - **Cơ chế Retry tự động**: Nếu lỗi chứa mã `404` (session chưa sẵn sàng trên SIP gateway) và số lần retry `< 3`, hệ thống sẽ hẹn giờ tự động mở lại WebSocket (`openSessionWebSocket`) sau khoảng thời gian tăng dần (2s, 4s, 6s).
- **Đoạn code xử lý**: [Lines 779-791](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L779-L791)

---

## 📥 NHÓM 2: Sự Kiện OpenAI Realtime API Gửi Về Client (Server-to-Client)

Đây là các sự kiện do máy chủ OpenAI phát ra thông qua kết nối WebSocket trong suốt cuộc gọi (`ws.on("message")`).

---

### 🟢 Nhóm Session Management

#### 2.1 `session.created`
- **Khi nào xảy ra?**: Ngay sau khi kết nối WebSocket được chấp nhận, OpenAI gửi sự kiện này xác nhận một Realtime Session đã tạo thành công.
- **Dùng để làm gì?**: Lưu thông tin `session.id` vào Conversation Logger và ghi nhận event khởi tạo session.
- **Đoạn code xử lý**: [Lines 755-760](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L755-L760)

#### 2.2 `session.updated`
- **Khi nào xảy ra?**: Khi OpenAI cập nhật xong các thông số session sau khi nhận được lệnh `session.update` từ client.
- **Dùng để làm gì?**: Ghi log xác nhận cấu hình VAD, voice, tools đã áp dụng thành công.
- **Đoạn code xử lý**: [Lines 762-766](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L762-L766)

---

### 🎤 Nhóm Nhận Diện Âm Thanh & Giọng Nói (VAD & STT)

#### 2.3 `input_audio_buffer.speech_started`
- **Khi nào xảy ra?**: Khi bộ phát hiện giọng nói (Server VAD) của OpenAI bắt đầu phát hiện có âm thanh/tiếng nói từ phía người gọi.
- **Dùng để làm gì?**: Ghi log sự kiện `vad_speech_started` để theo dõi tần suất khách bắt đầu nói và phân tích hiện tượng ngắt lời (interruption).
- **Đoạn code xử lý**: [Lines 722-725](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L722-L725)

#### 2.4 `input_audio_buffer.speech_stopped`
- **Khi nào xảy ra?**: Khi VAD phát hiện người gọi đã ngừng nói (vừa trải qua khoảng im lặng `silence_duration_ms`).
- **Dùng để làm gì?**: Ghi log sự kiện `vad_speech_stopped`.
- **Đoạn code xử lý**: [Lines 727-730](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L727-L730)

#### 2.5 `input_audio_buffer.committed`
- **Khi nào xảy ra?**: Khi OpenAI chốt đoạn âm thanh vừa nghe được thành một Conversation Item chính thức.
- **Dùng để làm gì?**: Lấy `event.item_id` lưu vào biến `_lastCommittedItemId`. Biến này đóng vai trò là "dấu vân tay" để đối chiếu nguồn gốc kích hoạt của các response tiếp theo.
- **Đoạn code xử lý**: [Lines 734-739](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L734-L739)

#### 2.6 `input_audio_buffer.dtmf_event_received`
- **Khi nào xảy ra?**: Khi khách hàng nhấn nút phím bấm số (DTMF - Dual Tone Multi-Frequency) trên bàn phím điện thoại (vd: bấm phím 0-9, *).
- **Dùng để làm gì?**:
  1. Tích lũy các phím bấm số vào buffer `_toolCallState._dtmfBuffer`.
  2. Phím `*` dùng để xóa nhập lại.
  3. Khi gom đủ 11 chữ số mã danh bộ $\rightarrow$ lưu mã danh bộ và gọi hàm `_speakVerbatim()` ép bot đọc câu hỏi xác nhận lại với khách.
- **Đoạn code xử lý**: [Lines 526-563](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L526-L563)

#### 2.7 `conversation.item.input_audio_transcription.completed`
- **Khi nào xảy ra?**: Khi mô hình Whisper/transcribe chuyển đổi xong đoạn audio người gọi nói thành văn bản text.
- **Dùng để làm gì?**:
  1. Tích lũy token usage cho mô hình transcription.
  2. Lọc bỏ **Prompt Echo** (trường hợp im lặng/nhiễu làm mô hình trả về chính câu lệnh prompt).
  3. Nếu là lời nói THẬT của khách: ghi log lượt khách, bật cờ `_unansweredRealTurn = true`, trích xuất số cho trọng tài danh bộ, xử lý từ ngữ khẳng định/phủ định.
  4. Nếu là Prompt Echo (nhiễu): Kiểm tra nếu `_responseActive === true` và `_activeResponseTriggerItemId === _echoItemId` và `!_unansweredRealTurn` $\rightarrow$ phát lệnh `response.cancel` để hủy câu nói thừa của bot, sau đó gọi `_reAssertDanhBoStep()`.
- **Đoạn code xử lý**: [Lines 565-691](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L565-L691)

#### 2.8 `conversation.item.input_audio_transcription.failed`
- **Khi nào xảy ra?**: Khi tiến trình nhận dạng giọng nói thành văn bản bị lỗi.
- **Dùng để làm gì?**: Ghi lại log lỗi `transcription_failed` vào timeline conversation logger.
- **Đoạn code xử lý**: [Lines 743-747](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L743-L747)

---

### 🤖 Nhóm Phản Hồi Từ Mô Hình AI (Model Response)

#### 2.9 `response.created`
- **Khi nào xảy ra?**: Ngay khi OpenAI bắt đầu khởi tạo một response để trả lời (do VAD kích hoạt tự động hoặc do code gọi `response.create`).
- **Dùng để làm gì?**:
  1. Cập nhật biến trạng thái `_responseActive = true`.
  2. Phân loại nguồn gốc response: Nếu `_pendingCodeResponse === true` $\rightarrow$ trigger = `null` (do code tạo); ngược lại trigger = `_lastCommittedItemId` (do VAD kích hoạt từ audio).
- **Đoạn code xử lý**: [Lines 347-362](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L347-L362)

#### 2.10 `response.done`
- **Khi nào xảy ra?**: Khi OpenAI hoàn thành trọn vẹn việc sinh phản hồi (hoặc phản hồi bị ngắt/hủy/lỗi).
- **Dùng để làm gì?**:
  1. Cập nhật trạng thái `_responseActive = false` và reset `_activeResponseTriggerItemId = null`.
  2. Nếu response thành công trọn vẹn (`status === "completed"`), reset `_unansweredRealTurn = false`.
  3. Tích lũy số lượng token sử dụng (Input, Output, Audio tokens) để tính chi phí cuộc gọi.
  4. Duyệt danh sách `output[]` tìm các **Function Calls (Tool Calls)**:
     - Gọi hàm nghiệp vụ `dispatchTool(name, args)`.
     - Lưu thông tin ticket vào DB nếu là `create_ticket`.
     - Gửi kết quả tool call trở lại OpenAI qua event `conversation.item.create`.
     - Xử lý các action đặc biệt: `end_call` (chờ bot nói lời tạm biệt rồi cúp máy), `transfer_to_agent` (chuyển cuộc gọi sang tổng đài viên), hoặc yêu cầu bot đọc kết quả tra cứu cho khách.
- **Đoạn code xử lý**: [Lines 367-518](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L367-L518)

#### 2.11 `conversation.item.done` & `response.audio_transcript.done`
- **Khi nào xảy ra?**: Khi một item hội thoại hoàn thành hoặc khi văn bản phiên âm audio câu nói của AI đã được tạo xong.
- **Dùng để làm gì?**: Trích xuất đoạn văn bản text câu trả lời của AI và lưu vào Conversation Logger (`logger.flushAI`) để hoàn thiện nhật ký hội thoại 2 chiều (Khách - AI).
- **Đoạn code xử lý**: [Lines 694-714](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L694-L714)

#### 2.12 `error`
- **Khi nào xảy ra?**: Trả về các lỗi từ phía OpenAI API (vd: Invalid API Key, Rate Limit, Session Timeout,...).
- **Dùng để làm gì?**: Log lỗi chi tiết vào hệ thống logger.
- **Đoạn code xử lý**: [Lines 749-753](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L749-L753)

---

## 📤 NHÓM 3: Lệnh Client Gửi Lên OpenAI Realtime API (Client-to-Server)

Đây là các sự kiện (JSON payload) do ứng dụng Node.js gửi lên máy chủ OpenAI thông qua `ws.send()`.

### 3.1 `session.update`
- **Khi nào phát ra?**: Ngay trong sự kiện `ws.on("open")`.
- **Dùng để làm gì?**: Cấu hình các thông số ban đầu cho session Realtime over SIP:
  - `session.type`: `"realtime"` (bắt buộc cho kết nối SIP).
  - `audio.input.turn_detection`: Cấu hình Semantic VAD (`type: "semantic_vad"`, `eagerness: "low"`, `interrupt_response: true`).
- **Ví dụ payload**:
  ```json
  {
    "type": "session.update",
    "session": {
      "type": "realtime",
      "audio": {
        "input": {
          "turn_detection": {
            "type": "semantic_vad",
            "eagerness": "low",
            "create_response": true,
            "interrupt_response": true
          }
        }
      }
    }
  }
  ```
- **Vị trí trong code**: [Lines 279-307](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L279-L307)

### 3.2 `response.create`
- **Khi nào phát ra?**:
  1. Phát câu chào mở đầu cuộc gọi ([Line 324](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L324)).
  2. Ép bot đọc kết quả tra cứu Tool Call ([Line 511](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L511)).
  3. Ép đọc câu tạm biệt khi cúp máy `end_call` ([Line 473](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L473)).
  4. Đọc lại câu thoại bước danh bộ trong `_reAssertDanhBoStep()` ([Line 135](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L135)).
  5. Đọc nguyên văn nội dung trong `_speakVerbatim()` ([Line 164](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L164)).
- **Dùng để làm gì?**: Yêu cầu OpenAI AI Model sinh âm thanh trả lời theo đúng `instructions` hướng dẫn do server quy định.

### 3.3 `response.cancel`
- **Khi nào phát ra?**: Khi hệ thống nhận diện được một **Prompt Echo** (nhiễu audio làm Whisper trả về chính câu lệnh prompt) và xác nhận response đang phát đúng do item nhiễu đó kích hoạt ([Line 666](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L666)).
- **Dùng me để làm gì?**: Ngắt ngay lập tức câu trả lời thừa/lỗi của AI đang phát ra loa điện thoại của khách hàng.

### 3.4 `conversation.item.create` (với `type: "function_call_output"`)
- **Khi nào phát ra?**: Ngay sau khi server Node.js thực thi xong một Tool Call (Function Call) thu được từ `response.done`.
- **Dùng để làm gì?**: Trả về dữ liệu kết quả thực thi tool (JSON string) cho OpenAI Model để mô hình tiếp tục suy luận và trả lời khách hàng.
- **Ví dụ payload**:
  ```json
  {
    "type": "conversation.item.create",
    "item": {
      "type": "function_call_output",
      "call_id": "call_12345",
      "output": "{\"success\": true, \"data\": {...}}"
    }
  }
  ```
- **Vị trí trong code**: [Lines 438-447](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L438-L447)

---

## 📊 Bảng Tóm Tắt Tất Cả Các Event

| Hướng | Tên Event | Khi nào xảy ra / Được phát khi nào | Mục đích chính |
| :--- | :--- | :--- | :--- |
| **Socket** | `unexpected-response` | Handshake WS bị OpenAI từ chối (Status $\neq 101$) | Log lỗi từ chối kết nối |
| **Socket** | `open` | Kết nối WebSocket mở thành công | Gửi `session.update` và hẹn giờ phát câu chào |
| **Socket** | `close` | WebSocket bị đóng | Lưu log conversation summary & usage vào DB |
| **Socket** | `error` | Lỗi kết nối ổ cắm Socket | Log lỗi & tự động retry nếu gặp HTTP 404 |
| **S $\rightarrow$ C** | `session.created` | Session Realtime được tạo phía OpenAI | Lưu Session ID |
| **S $\rightarrow$ C** | `session.updated` | Cấu hình session đã được áp dụng | Xác nhận update thành công |
| **S $\rightarrow$ C** | `input_audio_buffer.speech_started` | VAD thấy bắt đầu có tiếng nói | Log sự kiện bắt đầu nói |
| **S $\rightarrow$ C** | `input_audio_buffer.speech_stopped` | VAD thấy kết thúc tiếng nói | Log sự kiện dừng nói |
| **S $\rightarrow$ C** | `input_audio_buffer.committed` | Audio được VAD chốt thành Item | Lưu `_lastCommittedItemId` |
| **S $\rightarrow$ C** | `input_audio_buffer.dtmf_event_received` | Khách bấm phím số điện thoại | Tích lũy phím DTMF & ép đọc xác nhận danh bộ |
| **S $\rightarrow$ C** | `conversation.item.input_audio_transcription.completed` | Whisper dịch giọng nói thành Text | Lọc prompt echo, nhận câu hỏi thật, kích hoạt cancel nhiễu |
| **S $\rightarrow$ C** | `conversation.item.input_audio_transcription.failed` | Whisper dịch thoại thất bại | Log lỗi transcription |
| **S $\rightarrow$ C** | `response.created` | AI bắt đầu sinh câu trả lời | Set `_responseActive = true` & phân loại trigger |
| **S $\rightarrow$ C** | `response.done` | AI hoàn thành phản hồi | Thực thi Tool Calls, tính token usage, xử lý hangups |
| **S $\rightarrow$ C** | `conversation.item.done` | Item hội thoại hoàn thành | Trích xuất text câu AI nói để ghi log |
| **S $\rightarrow$ C** | `response.audio_transcript.done` | Audio transcript câu AI sẵn sàng | Ghi log câu AI phát ra |
| **S $\rightarrow$ C** | `error` | OpenAI phát ra thông báo lỗi | Log lỗi từ OpenAI |
| **C $\rightarrow$ S** | `session.update` | Client gửi cấu hình VAD, voice, tools | Thiết lập tham số cuộc gọi |
| **C $\rightarrow$ S** | `response.create` | Client yêu cầu AI sinh câu trả lời | Phát câu chào, kết quả tool, câu tạm biệt |
| **C $\rightarrow$ S** | `response.cancel` | Client yêu cầu hủy response | Hủy câu phát thừa do nhiễu/echo |
| **C $\rightarrow$ S** | `conversation.item.create` | Client trả kết quả Function Call | Cung cấp dữ liệu nghiệp vụ cho AI |

---
*Tài liệu được khởi tạo tự động vào ngày 24/07/2026 phục vụ mục đích tìm hiểu codebase.*
