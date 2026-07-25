# Tài Liệu Về Các Biến Quản Lý Trạng Thái Session WebSocket trong `session-ws.js`

Tài liệu này giải thích chi tiết mục đích, nơi cài đặt giá trị và vị trí sử dụng của 5 biến quản lý trạng thái luồng hội thoại trong file [`session-ws.js`](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js):

1. `_responseActive`
2. `_lastCommittedItemId`
3. `_activeResponseTriggerItemId`
4. `_pendingCodeResponse`
5. `_unansweredRealTurn`

---

## 💡 Tổng Quan Bài Toán Cần Giải Quyết

Trong hệ thống Voice Bot kết nối qua OpenAI Realtime API (WebSocket over SIP):
- **Server VAD / Semantic VAD**: OpenAI sẽ tự động phát hiện giọng nói hoặc tiếng ồn (echo/noise từ mạng SIP) và phát sinh câu phản hồi (`response.created`).
- **Prompt Echo & Nhiễu mạng**: gpt-4o-mini-transcribe có thể dội lại chính transcription prompt khi gặp audio im lặng/nhiễu. Khi đó OpenAI tự sinh response giả ("Dạ em nghe rõ rồi ạ...").
- **Hủy response sai lầm (Cancel race condition)**: Nếu hủy response không cẩn thận khi phát hiện nhiễu, hệ thống có thể hủy nhầm câu trả lời cho lượt nói THẬT của khách hàng (khiến bot bị câm 20-30 giây).

5 biến bên dưới tạo thành một **State Machine phòng thủ**, giúp nhận diện chính xác nguồn gốc từng response và bảo vệ trải nghiệm cuộc gọi của khách hàng.

---

## 1. Biến `_responseActive`

### 🎯 Công dụng
- Cờ dạng `boolean` theo dõi xem OpenAI Realtime API có đang trong quá trình sinh hoặc phát phản hồi audio/text hay không.
- **Mục đích**:
  1. Biết được bot đang bận nói hay đang rảnh.
  2. Guard cho các hàm đọc tin nhắn cố định (`_reAssertDanhBoStep`, `_speakVerbatim`) để hoãn lại/retry, tránh bị lỗi `conversation_already_has_active_response`.
  3. Xác định xem có response nào đang chạy để gửi lệnh `response.cancel` khi gặp nhiễu/echo hay không.

### 📍 Cài đặt value ở đâu?
- **Khởi tạo**: Line [56](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L56):
  ```javascript
  let _responseActive = false;
  ```
- **Set thành `true`**: Line [349](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L349) khi nhận sự kiện `response.created`:
  ```javascript
  case "response.created":
    _responseActive = true;
  ```
- **Set thành `false`**: Line [369](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L369) khi nhận sự kiện `response.done`:
  ```javascript
  case "response.done":
    _responseActive = false;
  ```

### 🔍 Sử dụng ở đâu?
- Line [131](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L131) trong `_reAssertDanhBoStep`: `if (_hungUp || _transferred || _responseActive) return;` (Hoãn đọc lại nếu bot đang bận nói).
- Line [157](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L157) trong `_speakVerbatim`: `if (_responseActive) { ... setTimeout(...) }` (Retry sau 1.2s nếu bot đang bận nói).
- Line [656](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L656) trong handler `conversation.item.input_audio_transcription.completed` khi gặp prompt echo: `if (_responseActive && !_hungUp && !_transferred)` (Chỉ cancel khi thực sự có response đang chạy).

---

## 2. Biến `_lastCommittedItemId`

### 🎯 Công dụng
- Lưu lại `item_id` của đoạn audio buffer gần nhất vừa được OpenAI Server VAD chốt (commit).
- Đóng vai trò là "dấu vân tay" để đối chiếu: khi một response mới được tạo ra từ VAD, code biết chính xác đoạn audio nào vừa kích hoạt nó.

### 📍 Cài đặt value ở đâu?
- **Khởi tạo**: Line [64](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L64):
  ```javascript
  let _lastCommittedItemId = null;
  ```
- **Cập nhật giá trị**: Line [736](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L736) khi nhận sự kiện `input_audio_buffer.committed`:
  ```javascript
  case "input_audio_buffer.committed":
    _lastCommittedItemId = event.item_id ?? null;
  ```

### 🔍 Sử dụng ở đâu?
- Line [357](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L357) trong handler `response.created`:
  ```javascript
  if (_pendingCodeResponse) {
    _activeResponseTriggerItemId = null;
    _pendingCodeResponse = false;
  } else {
    _activeResponseTriggerItemId = _lastCommittedItemId; // Gán item audio vừa commit làm nguồn kích hoạt
  }
  ```

---

## 3. Biến `_activeResponseTriggerItemId`

### 🎯 Công dụng
- Lưu `item_id` của đoạn audio đã kích hoạt **response đang chạy hiện tại**.
- **Giá trị**:
  - `item_id` cụ thể: nếu response do VAD kích hoạt từ đoạn audio đó.
  - `null`: nếu response do phía Node.js chủ động gửi lệnh `response.create` (câu chào, đọc kết quả tool, tạm biệt,...).
- **Mục đích**: Giải quyết bài toán hủy nhầm response. Khi transcript echo của một lượt nhiễu gửi về (thường bị trễ vài giây), code chỉ hủy response nếu `_activeResponseTriggerItemId` **bằng đúng** `item_id` của đoạn echo đó (`_activeResponseTriggerItemId === _echoItemId`).

### 📍 Cài đặt value ở đâu?
- **Khởi tạo**: Line [65](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L65):
  ```javascript
  let _activeResponseTriggerItemId = null;
  ```
- **Gán giá trị**: Line [354-357](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L354-L357) khi nhận sự kiện `response.created`:
  ```javascript
  if (_pendingCodeResponse) {
    _activeResponseTriggerItemId = null;
  } else {
    _activeResponseTriggerItemId = _lastCommittedItemId;
  }
  ```
- **Reset về `null`**: Line [370](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L370) khi nhận sự kiện `response.done`:
  ```javascript
  _activeResponseTriggerItemId = null;
  ```

### 🔍 Sử dụng ở đâu?
- Line [360](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L360): Ghi log event `response_created` kèm thông tin trigger item để hỗ trợ truy vết.
- Line [663](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L663) trong handler prompt echo:
  ```javascript
  const _itemMatch = !!_echoItemId && _activeResponseTriggerItemId === _echoItemId;
  ```
- Line [678](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L678): Ghi log thông báo bỏ qua cancel nếu `_echoItemId` không trùng với `_activeResponseTriggerItemId`.

---

## 4. Biến `_pendingCodeResponse`

### 🎯 Công dụng
- Cờ dạng `boolean` đánh dấu: *"Code Node.js vừa phát một lệnh `response.create` đi"*.
- **Mục đích**: Khi OpenAI trả về sự kiện `response.created`, cờ này thông báo cho handler biết response đó được tạo ra từ code chứ không phải từ VAD, từ đó đặt `_activeResponseTriggerItemId = null` và hạ cờ `_pendingCodeResponse = false`.

### 📍 Cài đặt value ở đâu?
- **Khởi tạo**: Line [66](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L66):
  ```javascript
  let _pendingCodeResponse = false;
  ```
- **Bật `true` (Trước khi gửi `response.create`)**:
  1. Line [134](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L134) trong `_reAssertDanhBoStep()` (đọc lại bước xác nhận danh bộ).
  2. Line [163](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L163) trong `_speakVerbatim()` (ép bot đọc nguyên văn).
  3. Line [323](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L323) khi gửi câu chào mở đầu cuộc gọi.
  4. Line [472](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L472) trong `end_call` (gửi câu cảm ơn/tạm biệt cố định).
  5. Line [510](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L510) khi trả kết quả của Tool Call cho bot đọc.
- **Tắt `false`**: Line [355](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L355) trong `response.created`:
  ```javascript
  if (_pendingCodeResponse) {
    _activeResponseTriggerItemId = null;
    _pendingCodeResponse = false;
  }
  ```

### 🔍 Sử dụng ở đâu?
- Line [353-355](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L353-L355) trong handler `response.created` để phân biệt nguồn gốc response.

---

## 5. Biến `_unansweredRealTurn`

### 🎯 Công dụng
- Cờ dạng `boolean` theo dõi: *"Liệu hiện tại có một lượt phát biểu THẬT của khách chưa có phản hồi hoàn chỉnh hay không"*.
- **Giải quyết bài toán Semantic VAD Interrupt**:
  - Khi khách hỏi một câu thật, nhưng ngay sau đó bị chèn tiếng ồn nhẹ, Semantic VAD có thể tự động ngắt response cũ và tạo response mới gán với `item_id` của tiếng ồn.
  - Tuy nhiên, OpenAI Model vẫn dùng response mới đó để **trả lời câu hỏi THẬT** của khách.
  - Nếu chỉ kiểm tra `_itemMatch`, code sẽ thấy `item_id` trùng nhiễu và gửi lệnh `response.cancel`, làm ngắt mất câu trả lời thật khiến bot bị "câm".
  - Nhờ có `_unansweredRealTurn = true`, lệnh cancel bị **CHẶN LẠI**, bảo vệ câu trả lời thật của bot.

### 📍 Cài đặt value ở đâu?
- **Khởi tạo**: Line [75](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L75):
  ```javascript
  let _unansweredRealTurn = false;
  ```
- **Bật thành `true`**: Line [603](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L603) khi nhận được transcript phát biểu thật của khách (có văn bản và không phải prompt echo):
  ```javascript
  if (khText && !_isPromptEcho) {
    ...
    _unansweredRealTurn = true;
  }
  ```
- **Reset thành `false`**: Line [374](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L374) khi response hoàn thành trọn vẹn (`response.done` với `status === "completed"`):
  ```javascript
  if (event?.response?.status === "completed") _unansweredRealTurn = false;
  ```

### 🔍 Sử dụng ở đâu?
- Line [664](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L664) trong điều kiện kiểm tra hủy response echo:
  ```javascript
  if (_itemMatch && !_unansweredRealTurn) {
    ws.send(JSON.stringify({ type: "response.cancel" }));
  }
  ```
- Line [679](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L679) trong log chi tiết lý do không hủy response:
  ```javascript
  : `item trùng nhưng còn lượt khách thật chưa được trả lời (_unansweredRealTurn)`
  ```

---

## 6. Hàm `_reAssertDanhBoStep`

### 🎯 Công dụng & Ngữ cảnh ra đời
- **Ngữ cảnh**: Khi bot đang ở trong quy trình đọc lại mã danh bộ để nhờ khách xác nhận (ví dụ: *"Mã danh bộ của Quý khách là 12345678901, đúng không ạ?"*), nếu phát sinh tiếng ồn hoặc prompt echo từ đường truyền SIP, hệ thống sẽ gửi lệnh `response.cancel` để hủy response nhiễu đó.
- **Vấn đề phát sinh**: Việc hủy response đột ngột có thể khiến câu nói của bot bị **cắt dở chừng** (ví dụ bot mới chỉ kịp nói: *"Dạ... đọc giúp em nguyên văn: Hai"*). Sự kiện này làm cho đoạn chat context bị sai lệch — OpenAI Model lầm tưởng số *"Hai"* là do khách vừa đọc, nên tự bịa tiếp lời thoại mà không gọi tool `confirm_danh_bo` nữa, làm khách mất kiên nhẫn và cúp máy.
- **Giải pháp của `_reAssertDanhBoStep(lyDo)`**: Sau khi hủy thành công response do nhiễu, hàm này sẽ tự động **kéo cuộc gọi về đúng nhịp State Machine** bằng cách phát lại CHÍNH XÁC câu thoại của bước danh bộ đang chờ (`_toolCallState._danhBoLastPrompt`).

### 📍 Đoạn code định nghĩa
- Lines [126-149](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L126-L149):
  ```javascript
  const _reAssertDanhBoStep = (lyDo) => {
    const _prompt = _toolCallState._danhBoLastPrompt;
    if (!_prompt) return;
    if (_hungUp || _transferred) return;
    setTimeout(() => {
      if (_hungUp || _transferred || _responseActive) return;
      if (!_toolCallState._danhBoLastPrompt) return; // đã chốt danh bộ trong lúc chờ
      try {
        _pendingCodeResponse = true;
        ws.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, không diễn giải lại, " +
              "KHÔNG nhắc lại bất kỳ chữ số nào ngoài đoạn này: \"" + _prompt + "\"",
          },
        }));
        logger.addEvent("danh_bo_step_reasserted", `${lyDo} — đọc lại bước đang chờ`);
        console.log(`[${callId}]:`, "danh_bo_step_reasserted", lyDo);
      } catch (e) {
        log.warn(`[WS][${callId}] không gửi được response.create kéo lại bước danh bộ: `, e.message);
      }
    }, 900); // chờ cancel hoàn tất (response.done về) rồi mới tạo response mới
  };
  ```

### ⚙️ Cơ chế hoạt động & Guard
1. **Trễ 900ms (`setTimeout`)**: Chờ cho lệnh cancellation trước đó hoàn tất trọn vẹn và sự kiện `response.done` gửi về WebSocket.
2. **Kiểm tra trạng thái cuộc gọi**: Nếu cuộc gọi đã cúp (`_hungUp`), đã chuyển máy (`_transferred`), bot đang nói câu khác (`_responseActive`), hoặc bước danh bộ đã được xác nhận xong (`!_danhBoLastPrompt`), hàm sẽ lặng lẽ hủy bỏ.
3. **Ép đọc chính xác**: Đánh dấu `_pendingCodeResponse = true` và gửi `response.create` kèm chỉ dẫn khắt khe ép model đọc nguyên văn `_prompt` cũ.

### 🔍 Được sử dụng ở đâu?
- Line [669](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L669): Được gọi ngay trong handler prompt echo sau khi phát hiện nhiễu và gửi lệnh `response.cancel`:
  ```javascript
  ws.send(JSON.stringify({ type: "response.cancel" }));
  logger.addEvent("response_cancel_sent", `hủy response do prompt echo...`);
  _reAssertDanhBoStep("sau khi hủy response do prompt echo");
  ```

---

## 7. Hàm `_speakVerbatim`

### 🎯 Công dụng & Ngữ cảnh ra đời
- **Mục đích**: Ép bot nói **NGUYÊN VĂN 100%** một nội dung văn bản cụ thể do phía server chỉ định (dùng khi đọc câu chào, đọc xác nhận mã danh bộ từ phím DTMF hoặc từ Co-Pilot).
- **Vấn đề race condition**: Nếu phía server muốn phát tin nhắn (ví dụ khi khách vừa bấm xong 11 số phím DTMF) nhưng bot **vẫn đang bận phát audio cũ** (`_responseActive === true`), gửi ngay `response.create` sẽ bị OpenAI từ chối với lỗi: `conversation_already_has_active_response`.
- **Giải pháp của `_speakVerbatim(text, tag, attempt = 0)`**: Tích hợp cơ chế **tự động retry nhiều lần (polling wait với khoảng nghỉ 1.2s)**. Hàm chờ bot nói xong câu hiện tại rồi mới gửi tin nhắn mới.

### 📍 Đoạn code định nghĩa
- Lines [155-175](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L155-L175):
  ```javascript
  const _speakVerbatim = (text, tag, attempt = 0) => {
    if (_hungUp || _transferred) return;
    if (_responseActive) {
      if (attempt < 8) setTimeout(() => _speakVerbatim(text, tag, attempt + 1), 1200);
      else logger.addEvent("speak_verbatim_dropped", `${tag} — response active quá lâu`);
      return;
    }
    try {
      _pendingCodeResponse = true;
      ws.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, không diễn giải lại: \"" + text + "\"",
        },
      }));
      logger.addEvent("response_create_sent", tag);
    } catch (e) {
      log.warn(`[WS][${callId}] không gửi được response.create (${tag}): `, e.message);
    }
  };
  ```

### ⚙️ Cơ chế hoạt động & Param
- **`text`**: Chuỗi văn bản cần đọc cho khách nghe.
- **`tag`**: Nhãn mô tả sự kiện (dùng để ghi log/trace).
- **`attempt`**: Số lần đã thử lại (mặc định = `0`).
- **Cơ chế Retry**:
  - Nếu `_responseActive === true` và `attempt < 8` ($\approx$ tối đa 9.6 giây chờ): Hàm hẹn giờ thử lại sau 1200ms với `attempt + 1`.
  - Nếu thử quá 8 lần vẫn bận, ghi log `speak_verbatim_dropped` và dừng retry.
  - Khi `_responseActive === false`: Đặt `_pendingCodeResponse = true` và gửi WS event `response.create`.

### 🔍 Được sử dụng ở đâu?
1. Line [203](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L203) trong `_maybeAssembleDanhBo()`: Khi Co-Pilot (gpt-5.1) tự động gom các hơi đọc số rải rác từ transcript thành dãy 11 số và phát câu xác nhận cho khách:
   ```javascript
   _speakVerbatim(prompt, "danh_bo_proactive_assemble");
   ```
2. Line [561](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js#L561) trong handler phím bấm DTMF (`input_audio_buffer.dtmf_event_received`): Khi khách nhập đủ 11 số qua phím bàn phím điện thoại, ép bot đọc câu xác nhận số vừa bấm:
   ```javascript
   _speakVerbatim(_dtmfPrompt, "dtmf_danh_bo_confirm");
   ```

---

## 📊 Bảng Tóm Tắt Trạng Thái & Tương Tác Giữa Các Biến

| Tên biến / Hàm | Kiểu DL / Dạng | Giá trị mặc định | Sự kiện thay đổi / Trực thuộc | Vai trò chính |
| :--- | :--- | :--- | :--- | :--- |
| `_responseActive` | `boolean` | `false` | `response.created` ($\rightarrow$ `true`), `response.done` ($\rightarrow$ `false`) | Theo dõi bot bận/rảnh nói |
| `_lastCommittedItemId` | `string \| null` | `null` | `input_audio_buffer.committed` ($\rightarrow$ `item_id`) | Ghi dấu item audio VAD commit gần nhất |
| `_activeResponseTriggerItemId` | `string \| null` | `null` | `response.created` ($\rightarrow$ `item_id` hoặc `null`), `response.done` ($\rightarrow$ `null`) | Lưu ID audio trigger response hiện tại |
| `_pendingCodeResponse` | `boolean` | `false` | Code gửi `response.create` ($\rightarrow$ `true`), `response.created` ($\rightarrow$ `false`) | Phân biệt response do Code vs VAD tạo |
| `_unansweredRealTurn` | `boolean` | `false` | Transcript thật ($\rightarrow$ `true`), `response.done completed` ($\rightarrow$ `false`) | Chặn cancel khi khách chưa nhận được câu trả lời |
| `_reAssertDanhBoStep()` | `Function` | - | Được gọi sau khi `response.cancel` do prompt echo | Đọc lại đúng câu thoại bước danh bộ đang dở |
| `_speakVerbatim()` | `Function` | - | Được gọi bởi DTMF Handler / Co-Pilot Assembler | Retry chờ bot rảnh rồi ép đọc nguyên văn text |

---
*Tài liệu được cập nhật bổ sung vào ngày 24/07/2026 phục vụ mục đích tìm hiểu codebase.*
