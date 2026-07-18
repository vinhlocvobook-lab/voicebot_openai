# BÁO CÁO ĐÁNH GIÁ MÃ NGUỒN & ĐỀ XUẤT CẢI TIẾN VOICE BOT (CNTA)

Tài liệu này chứa các nhận xét, phân tích chi tiết và đề xuất cải tiến cho hệ thống Voice Bot CSKH của Công ty Cổ phần Cấp nước Trung An, dựa trên việc xem xét 4 file:
1. [system-prompt.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/system-prompt.js)
2. [tools.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/tools.js)
3. [huongdanthutuc-data.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/huongdanthutuc-data.js)
4. [session-ws.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js)

---

## 1. Đánh giá chi tiết System Prompt (`system-prompt.js`)

### 🟢 Điểm mạnh
* **Thiết lập Persona rất tốt**: Quy ước xưng hô chuẩn xác (`em` - `Quý Khách`), cấm dùng từ suồng sã hoặc gọi khách hàng là "anh/chị" hay "bạn" giúp duy trì sự chuyên nghiệp, lịch sự của tổng đài CSKH.
* **Xử lý Mã danh bộ rất kỹ lưỡng**: Việc yêu cầu model phải đọc lại mã danh bộ tách chữ số có nhịp nghỉ (ví dụ: `Năm - Hai - Bốn...`), cấm tự đếm số thành tiếng hoặc tự suy đoán/bịa số là các chỉ thị phòng thủ rất tốt cho Voice AI.
* **Quy trình thoại rõ ràng**: Định hướng tốt các bước từ chào, hỏi nhu cầu, thu thập thông tin, gọi tool, cho đến chào tạm biệt và chủ động cúp máy.
* **Giới hạn phạm vi chặt chẽ**: Phân tách rõ ràng giữa những gì AI có thể làm (4 thủ tục hành chính) và những gì phải chuyển máy (`transfer_to_agent`) hoặc ghi nhận phiếu (`create_ticket`).

### 🔴 Hạn chế & Rủi ro
* **Kích thước Prompt lớn (Token Overhead & Latency)**: System Prompt hiện tại khá dài (~300 dòng). Trong OpenAI Realtime API, toàn bộ prompt và lịch sử hội thoại sẽ được nạp lại ở mỗi lượt thoại (turn). Prompt dài làm tăng lượng *context tokens*, dẫn đến chi phí vận hành cao hơn và tăng độ trễ (latency) khi model phản hồi.
* **Trùng lặp với Logic của Tool**: Nhiều chỉ thị chi tiết về cách xử lý kết quả của tool (như việc bắt hỏi lại đối tượng hộ gia đình/doanh nghiệp, cách sửa khi khách đọc sai địa chỉ, cách đếm số người đăng ký định mức) được viết trực tiếp trong prompt. Mặc dù giúp model hiểu ngữ cảnh tốt hơn, các quy tắc này thực chất đã được xử lý deterministic ở phía tool (trả về trong các trường `doc_cho_khach`, `luu_y_cho_tro_ly`, `can_hoi_doi_tuong`). Ta có thể tối giản hóa các phần này trong prompt.
* **Quy tắc phát âm kép**: System Prompt định nghĩa các quy tắc như `VNeID` -> `"Vi-en-e-ai-đi"`, `CCCD` -> `"Căn cước công dân"`. Tuy nhiên, trong `tools.js` đã có hàm `toSpoken` thực hiện việc thay thế này trực tiếp trên chuỗi trả về. Chỉ cần giữ lại các quy tắc phát âm trong prompt cho những trường hợp model tự nói ngoài dữ liệu của tool.

---

## 2. Đánh giá Function Calling (`tools.js` & `huongdanthutuc-data.js`)

### 🟢 Điểm mạnh
* **Xử lý tham số đầu vào rất tốt (Robust Argument Normalization)**:
  * Hàm `normalizeProcedureArgs` giải quyết triệt để vấn đề model gọi sai tên tham số (ví dụ: gửi `loại_thu_tuc` có dấu thay vì `loai_thu_tuc`), gửi key dạng boolean flag, hoặc gửi giá trị bị lệch. Đây là phần xử lý rất xuất sắc.
  * Hàm `checkDanhBo` kiểm tra độ dài mã danh bộ (11 số) bằng code để chặn việc model tự đếm sai, giúp bảo vệ API backend.
* **Tối ưu hóa phát âm cho TTS**:
  * Hàm `docTienVN` chuyển số tiền thành chữ viết tự nhiên giúp bộ đọc TTS không bị đọc sai dấu chấm hàng nghìn (ví dụ: `1.180.266 đồng` thành `"một nghìn..."`).
  * Hàm `toSpoken` giúp chuyển đổi các từ viết tắt và địa chỉ phức tạp sang dạng phiên âm dễ đọc (ví dụ: `www.capnuoctrungan.vn` thành `"vê kép vê kép..."`).
* **Đưa business logic phức tạp về phía Code**:
  * Việc so khớp danh sách giấy tờ khách đã có với yêu cầu thủ tục (`check_missing_docs`) được xử lý bằng code (hàm `docMatches`) thay vì để model tự suy luận. Điều này giúp loại bỏ hoàn toàn việc model tự đếm thiếu hoặc đối chiếu sai lệch giấy tờ.
* **Cơ chế dẫn dắt model bằng Tool Output (`luu_y_cho_tro_ly`)**:
  * Việc trả về trường kịch bản `doc_cho_khach` (yêu cầu đọc nguyên văn) và `luu_y_cho_tro_ly` (chỉ thị nội bộ không được đọc) giúp kiểm soát chặt chẽ những gì AI sẽ nói, tránh việc model tự tóm tắt làm mất thông tin địa chỉ văn phòng.

### 🔴 Hạn chế & Rủi ro
* **Thuật toán so khớp giấy tờ (`docMatches`) đơn giản**:
  * Hàm `docMatches` chỉ sử dụng so khớp chuỗi cơ bản (`doc.includes(cus)`) kết hợp với một vài alias cứng và kiểm tra bigram 2 từ. Nếu khách hàng dùng các từ ngữ đặc biệt hoặc mô tả rất dài/lệch chuẩn, hệ thống có thể nhận diện sai hoặc bỏ sót giấy tờ.
* **Thông báo lỗi API robot**:
  * Khi API gặp lỗi, `tools.js` trả về thông báo lỗi chung chung: `{"success": false, "message": "Đã xảy ra lỗi hệ thống. Vui lòng thử lại."}`. Nếu model đọc nguyên văn câu này, trải nghiệm thoại sẽ rất cứng nhắc.

---

## 3. Đánh giá WebSocket Session Lifecycle (`session-ws.js`)

### 🟢 Điểm mạnh
* **Sử dụng Semantic VAD hiện đại**: Việc chuyển cấu hình sang `"type": "semantic_vad"` với `"eagerness": "low"` giúp giảm đáng kể hiện tượng AI ngắt lời khách hàng khi họ đang dừng lại suy nghĩ hoặc ngập ngừng.
* **Cơ chế chống Prompt Echo xuất sắc**:
  * Phát hiện và chặn hiện tượng Whisper nhận diện sai nhiễu/echo thành câu prompt và kích hoạt AI tự trả lời bằng cách kiểm tra `_isPromptEcho` qua "chữ ký" prompt (`_sig.length >= 20`).
  * Việc chủ động gửi lệnh `response.cancel` khi phát hiện echo giúp dập tắt ngay các câu trả lời thừa của AI ("Dạ, em nghe rõ...").

### 🔴 Các lỗi nghiêm trọng & Rủi ro hoạt động

> [!CAUTION]
> ### 1. Lỗi gửi `response.create` lặp lại khi gọi nhiều Tool đồng thời (Parallel Tool Calls)
> Trong `session-ws.js` từ dòng 201-294, khi xử lý `response.done`, code lặp qua từng item trong output:
> ```javascript
> for (const item of output) {
>   if (item?.type !== "function_call") continue;
>   ...
>   const { result: toolOutput } = await runWithApiTrace(...);
>   ...
>   ws.send(JSON.stringify({
>     type: "conversation.item.create",
>     item: { type: "function_call_output", call_id: toolCallId, output: toolOutput }
>   }));
>   ...
>   if (action !== "end_call" && action !== "transfer_to_agent") {
>     ws.send(JSON.stringify({
>       type: "response.create",
>       response: { instructions: _instructions }
>     }));
>   }
> }
> ```
> **Vấn đề**: Nếu khách hàng hỏi một câu phức tạp kích hoạt nhiều tool cùng lúc (ví dụ: *"Xem hộ tôi tiền nước và lịch cúp nước luôn"* -> gọi `get_bill` và `get_outages` song song):
> 1. Vòng lặp chạy qua Tool 1: Gửi `conversation.item.create` (kết quả 1), sau đó gửi `response.create` (bắt đầu sinh phản hồi).
> 2. Vòng lặp chạy qua Tool 2: Gửi `conversation.item.create` (kết quả 2), sau đó lại gửi `response.create` (yêu cầu sinh phản hồi tiếp).
>
> **Hậu quả**: OpenAI sẽ ném lỗi `response_already_active` ở lệnh `response.create` thứ hai. Phản hồi của AI có thể bị gián đoạn, bị ngắt quãng hoặc bỏ sót hoàn toàn thông tin của tool thứ hai.

> [!WARNING]
> ### 2. Thời gian Delay chuyển máy quá ngắn gây ngắt tiếng đột ngột
> Trong hàm `_handleTransfer` (dòng 476):
> ```javascript
> await new Promise((r) => setTimeout(r, 2000));
> await callOps.refer(callId, agentUri);
> ```
> **Vấn đề**: Thông báo chuyển máy cho khách hàng là: *"Đang chuyển máy cho tổng đài viên, Quý khách vui lòng chờ trong giây lát."*. Câu này dài 16 từ, ở tốc độ nói tự nhiên mất ít nhất **4 đến 5 giây** để phát âm hết.
>
> **Hậu quả**: Với delay chỉ 2 giây (`setTimeout(r, 2000)`), lệnh SIP REFER sẽ được gửi đi khi AI mới đọc được khoảng 1/3 câu (ví dụ: *"Đang chuyển máy cho t..."* -> ngắt kết nối đột ngột để chuyển tiếp cuộc gọi). Khách hàng sẽ bị hẫng và cảm giác cuộc gọi bị lỗi.

---

## 4. Đề xuất cải tiến cụ thể

### 🛠️ Đề xuất 1: Sửa lỗi Parallel Tool Calls & Tăng Delay chuyển máy trong `session-ws.js`

Dưới đây là đề xuất chỉnh sửa logic xử lý `response.done` trong [session-ws.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/session-ws.js) để gom các tool calls và trì hoãn lệnh `response.create` thích hợp, đồng thời tăng delay chuyển tiếp:

```diff
<<<<
        const output = event?.response?.output;
        if (!Array.isArray(output) || output.length === 0) break;

        for (const item of output) {
          if (item?.type !== "function_call") continue;

          const toolCallId = item.call_id;
          const name = item.name;
          const argsStr = item.arguments;
          log.info(`[WS][${callId}] Tool call: ${name}(${argsStr})`);

          let args = {};
          try { args = JSON.parse(argsStr); } catch { /* ignore */ }

          // Gọi handler trong context trace API (gom request/response backend
          // phát sinh trong tool call này) và gửi kết quả tool về cho OpenAI.
          const _t0 = Date.now();
          const { result: toolOutput, trace: apiCalls } =
            await runWithApiTrace(() => dispatchTool(name, args));
          const _durationMs = Date.now() - _t0;
          log.debug(`[WS][${callId}] Tool output (${_durationMs}ms): ${toolOutput}`);

          // Ghi đầu vào / đầu ra của function tool + trace API vào log
          try {
            logger.addToolCall(name, args, _tryParseJson(toolOutput), _durationMs, apiCalls);
          } catch { /* ignore */ }

          let result = {};
          try { result = JSON.parse(toolOutput); } catch { /* ignore */ }
          const action = result.action;

          // Lưu phiếu ticket nội bộ mỗi khi tạo phiếu (đối soát với remote).
          // Fire-and-forget, lỗi DB không ảnh hưởng luồng cuộc gọi.
          if (name === "create_ticket") {
            insertTicket({
              callId,
              customerTel: callOps.asteriskData?.phoneNumber ?? callOps.tel,
              args,
              output: result,
            });
          }

          console.log({ name, toolOutput: JSON.parse(toolOutput), callId });
          // Luôn gửi function_call_output về OpenAI (mỗi call_id cần đúng 1 output)
          ws.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: toolCallId,
                output: toolOutput,
              },
            })
          );

          if (action === "end_call") {
            // KHÔNG gửi response.create: model đã nói lời tạm biệt ngay trong response
            // chứa end_call → gửi thêm sẽ gây lỗi conversation_already_has_active_response.
            logger.setOutcome("completed");
            logger.addEvent("end_call", result.ly_do || null);
            if (!_hungUp) {
              _hungUp = true;
              // Delay để AI kịp nói lời tạm biệt trước khi cúp máy
              setTimeout(() => callOps.hangup(callId), 5000);
            } else {
              logger.addEvent("end_call_duplicate_ignored", "đã lên lịch cúp máy");
            }
          } else if (action === "transfer_to_agent") {
            // Tương tự: không gửi response.create (model đã thông báo chuyển máy)
            logger.setOutcome("transferred");
            logger.addEvent("transfer_to_agent", result.ly_do || null);
            if (!_transferred) {
              _transferred = true;
              await _handleTransfer(callId, callOps, result.ly_do);
            } else {
              logger.addEvent("transfer_duplicate_ignored", null);
            }
          } else {
            // Tool dữ liệu thông thường → yêu cầu AI đọc kết quả cho khách
            // [debug 08/07/2026] ghi event để phân biệt response do code chủ động
            // tạo (tool_result/greeting) với response do VAD kích hoạt
            // [14/07/2026] Kết quả có "doc_cho_khach" → ép đọc NGUYÊN VĂN bằng
            // instructions của response (cùng cơ chế với câu chào — cách duy nhất
            // mini tuân thủ 100%). Cuộc E1Nof3VRCX1u0hVwBoueJ: dù luu_y ghi "CẤM
            // tóm tắt", model vẫn tự tóm tắt làm sai logic + rơi 2 địa chỉ.
            const _instructions = result?.doc_cho_khach
              ? "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, " +
              "không tóm tắt, không diễn giải lại: \"" + result.doc_cho_khach + "\""
              : "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được.";
            logger.addEvent("response_create_sent", `tool_result: ${name}`);
            console.log({ _instructions });
            ws.send(JSON.stringify({
              type: "response.create",
              response: { instructions: _instructions },
            }));
          }
        }
====
        const output = event?.response?.output;
        if (!Array.isArray(output) || output.length === 0) break;

        // Lưu danh sách các tool calls cần xử lý trong turn này
        const toolCalls = output.filter(item => item?.type === "function_call");
        if (toolCalls.length === 0) break;

        let hasEndCall = false;
        let hasTransfer = false;
        let lastInstructions = null;
        let lastResult = null;

        // Bước 1: Thực thi song song hoặc tuần tự tất cả các tool calls và gửi kết quả về OpenAI
        for (const item of toolCalls) {
          const toolCallId = item.call_id;
          const name = item.name;
          const argsStr = item.arguments;
          log.info(`[WS][${callId}] Tool call: ${name}(${argsStr})`);

          let args = {};
          try { args = JSON.parse(argsStr); } catch { /* ignore */ }

          const _t0 = Date.now();
          const { result: toolOutput, trace: apiCalls } =
            await runWithApiTrace(() => dispatchTool(name, args));
          const _durationMs = Date.now() - _t0;
          log.debug(`[WS][${callId}] Tool output (${_durationMs}ms): ${toolOutput}`);

          try {
            logger.addToolCall(name, args, _tryParseJson(toolOutput), _durationMs, apiCalls);
          } catch { /* ignore */ }

          let result = {};
          try { result = JSON.parse(toolOutput); } catch { /* ignore */ }
          lastResult = result;
          const action = result.action;

          if (name === "create_ticket") {
            insertTicket({
              callId,
              customerTel: callOps.asteriskData?.phoneNumber ?? callOps.tel,
              args,
              output: result,
            });
          }

          console.log({ name, toolOutput: JSON.parse(toolOutput), callId });
          
          // Gửi conversation.item.create cho từng tool
          ws.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: toolCallId,
                output: toolOutput,
              },
            })
          );

          if (action === "end_call") {
            hasEndCall = true;
          } else if (action === "transfer_to_agent") {
            hasTransfer = true;
          } else {
            // Tích lũy instructions nếu có nhiều tool, ưu tiên tool có nội dung cụ thể
            if (result?.doc_cho_khach) {
              lastInstructions = "Đọc CHÍNH XÁC từng từ đoạn sau cho khách, không thêm bớt, " +
                "không tóm tắt, không diễn giải lại: \"" + result.doc_cho_khach + "\"";
            }
          }
        }

        // Bước 2: Đưa ra quyết định hành động cuối cùng sau khi đã nạp hết các kết quả tool
        if (hasEndCall) {
          logger.setOutcome("completed");
          logger.addEvent("end_call", lastResult?.ly_do || null);
          if (!_hungUp) {
            _hungUp = true;
            setTimeout(() => callOps.hangup(callId), 5000);
          }
        } else if (hasTransfer) {
          logger.setOutcome("transferred");
          logger.addEvent("transfer_to_agent", lastResult?.ly_do || null);
          if (!_transferred) {
            _transferred = true;
            await _handleTransfer(callId, callOps, lastResult?.ly_do);
          }
        } else {
          // Chỉ gửi response.create DUY NHẤT một lần cho toàn bộ các tool calls
          const _instructions = lastInstructions || "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được.";
          logger.addEvent("response_create_sent", `tool_results_processed: count=${toolCalls.length}`);
          console.log({ _instructions });
          ws.send(JSON.stringify({
            type: "response.create",
            response: { instructions: _instructions },
          }));
        }
>>>>
```

*Đồng thời, cập nhật hàm chuyển máy `_handleTransfer` để tăng delay chờ đọc hết câu chào trước khi REFER:*

```diff
<<<<
async function _handleTransfer(callId, callOps, lyDo) {
  const agentUri = process.env.AGENT_QUEUE_URI;
  if (!agentUri) {
    log.warn(`[WS][${callId}]AGENT_QUEUE_URI chưa cấu hình, không thể chuyển máy`);
    return;
  }

  log.info(`[WS][${callId}]Chuyển máy → ${agentUri}(lý do: ${lyDo})`);

  // Delay nhỏ để AI nói xong câu thông báo chuyển máy
  await new Promise((r) => setTimeout(r, 2000));

  try {
    await callOps.refer(callId, agentUri);
    log.info(`[WS][${callId}] Refer thành công`);
  } catch (err) {
    log.error(`[WS][${callId}] Refer thất bại: `, err.message);
  }
}
====
async function _handleTransfer(callId, callOps, lyDo) {
  const agentUri = process.env.AGENT_QUEUE_URI;
  if (!agentUri) {
    log.warn(`[WS][${callId}]AGENT_QUEUE_URI chưa cấu hình, không thể chuyển máy`);
    return;
  }

  log.info(`[WS][${callId}]Chuyển máy → ${agentUri}(lý do: ${lyDo})`);

  // Tăng delay lên 5 giây để AI đọc hoàn chỉnh câu thông báo chuyển tiếp máy trước khi chuyển SIP
  await new Promise((r) => setTimeout(r, 5000));

  try {
    await callOps.refer(callId, agentUri);
    log.info(`[WS][${callId}] Refer thành công`);
  } catch (err) {
    log.error(`[WS][${callId}] Refer thất bại: `, err.message);
  }
}
>>>>
```

---

### 🛠️ Đề xuất 2: Rút gọn System Prompt và cấu trúc lại bằng XML Tags

Để tối ưu hóa chi phí token và tính ổn định khi dẫn đường cho model, đề xuất viết lại cấu trúc System Prompt sử dụng các khối thẻ XML như `<rules>`, `<scope>` để tăng tính tuân thủ và dễ bảo trì:

```javascript
export const SYSTEM_PROMPT = `
# VAI TRÒ
Bạn là Trợ lý AI tổng đài CSKH Công ty CP Cấp nước Trung An. Xưng "em", gọi khách "Quý Khách". KHÔNG dùng "anh/chị", "bạn".

<opening_greeting>
Alo ... Xin chào Quý Khách, Cảm ơn Quý Khách đã gọi đến Tổng đài Công ty Cổ phần Cấp nước Trung An. Em là Trợ lý Ảo Ây Ai, Quý khách cần em hỗ trợ gì ạ?
</opening_greeting>

# QUY TẮC PHÁT ÂM & THOẠI
- Nói rõ ràng, tự nhiên. Tránh dùng từ cảm thán ("Tuyệt vời", "Ok") hoặc từ suồng sã.
- Không tự nhận xét về câu trả lời của chính mình.
- Khách yêu cầu "nói lại/đọc lại" -> đọc lại chậm và rõ hơn, không cúp máy.
- Khách im lặng: Chờ đợi. Chỉ hỏi "Quý Khách còn nghe máy không ạ?" nếu im lặng quá lâu (tối đa 1 lần).
- Âm thanh không rõ (nhiễu, tạp âm) -> Im lặng chờ, không chào lại lần 2.
- Cách phát âm: VNeID đọc là "Vi-en-e-ai-đi"; CCCD đọc là "Căn cước công dân"; SAWACO CSKH đọc là "Sa-qua-cô Xê-ét-ka-hát"; www.capnuoctrungan.vn đọc là "vê kép vê kép vê kép chấm cấp nước trung an chấm vi-en".

# PHẠM VI NGHIỆP VỤ & HÀNH ĐỘNG
- Hỗ trợ: tiền nước, trạng thái thanh toán, sản lượng nước, so sánh sản lượng, sự cố cúp nước, hướng dẫn 4 thủ tục hành chính.
- Ngoài phạm vi (Giải thích cách tính giá nước, biểu giá bậc thang...) -> Báo không hỗ trợ và mời khách chuyển tổng đài viên (transfer_to_agent) hoặc tạo phiếu (create_ticket).

# QUY TRÌNH TRA CỨU MÃ DANH BỘ (11 CHỮ SỐ)
- Khách đọc mã -> ĐỌC LẠI NGAY tách từng chữ số để khách xác nhận (ví dụ: Năm - Hai - Bốn...), rồi tra cứu.
- Xác nhận ĐÚNG -> Gọi tool ngay.
- Khách báo sai hoặc hệ thống báo invalid -> Hỏi lại số hoặc nhờ đọc lại từ đầu.
- Khách không có danh bộ -> Gợi ý nơi tìm (hóa đơn, hợp đồng) 1 lần. Nếu không có -> Đề xuất chuyển tổng đài viên hoặc tạo phiếu.

# QUY TRÌNH HƯỚNG DẪN THỦ TỤC HÀNH CHÍNH
- Chỉ hỗ trợ 4 thủ tục: dinh_muc_nuoc, lap_dat_dong_ho, sang_ten_dong_ho, nang_doi_dong_ho.
- Khách hỏi thủ tục -> Gọi get_procedure_info ngay (Không cần hỏi danh bộ).
- Đọc NGUYÊN VĂN trường "doc_cho_khach" trong kết quả trả về của tool. CẤM tóm tắt, CẤM đổi địa chỉ văn phòng.
- Khách hỏi cần gì thêm hoặc đã có một số giấy tờ -> Gọi check_missing_docs với danh sách giay_to_da_co. Đọc nguyên văn kết quả phần "doc_cho_khach".
- Doanh nghiệp yêu cầu gắn/sang tên đồng hồ -> Báo chuyển tổng đài viên và gọi transfer_to_agent.

# KẾT THÚC VÀ CHUYỂN MÁY
- Khách chào tạm biệt/hết nhu cầu -> Nói lời chào tạm biệt ngắn gọn rồi gọi ngay end_call.
- Khách yêu cầu gặp người thật hoặc sự cố ngoài khả năng -> Gọi transfer_to_agent.
`;
```

---

### 🛠️ Đề xuất 3: Nâng cấp hàm So khớp Giấy tờ (`docMatches`) trong `tools.js`

Để hạn chế bỏ sót khi khách hàng sử dụng các từ đồng nghĩa khác nhau, có thể mở rộng danh sách `DOC_ALIASES` phong phú hơn trong [tools.js](file:///Users/vovinhloc/myworking/customer/cnta/voice_bot/voice_bot/src/tools.js):

```javascript
const DOC_ALIASES = [
  { keys: ["so hong", "so do", "giay to nha dat", "quyen su dung dat", "so huu nha"], target: "giay chung nhan quyen" },
  { keys: ["hop dong mua ban", "giay mua ban", "chuyen nhuong", "sang nhuong"], target: "hop dong chuyen quyen so huu" },
  { keys: ["giay phep", "phep xay dung", "giay phep cat nha"], target: "giay phep xay dung" },
  { keys: ["xac nhan cu tru", "giay xac nhan", "ct07", "ct 07", "tam tru", "thuong tru"], target: "xac nhan cu tru" },
  { keys: ["vneid", "dinh danh", "vi en e ai di"], target: "vneid" },
  { keys: ["can cuoc", "cccd", "chung minh"], target: "can cuoc cong dan" }
];
```

---

### 🛠️ Đề xuất 4: Mềm mại hóa phản hồi lỗi trong `tools.js`

Thay vì trả về thông báo lỗi hệ thống thô cứng cho AI đọc, hãy hướng dẫn AI một cách thân thiện hoặc đề xuất chuyển máy nếu backend gặp sự cố:

```javascript
// Thay đổi trong các hàm bắt catch lỗi của dispatchTool hoặc handlers
catch (err) {
  console.error(`[Tool] Lỗi khi xử lý "${name}":`, err.message);
  return JSON.stringify({ 
    success: false, 
    action: "transfer_to_agent", // Gợi ý chuyển máy luôn
    ly_do: "Lỗi hệ thống khi gọi tool: " + err.message,
    doc_cho_khach: "Dạ, hệ thống tra cứu của em đang gặp chút sự cố kết nối. Em xin phép chuyển cuộc gọi sang tổng đài viên để hỗ trợ trực tiếp cho Quý Khách nhé."
  });
}
```
Khi đó, model sẽ đọc câu thoại xin lỗi lịch sự và đồng thời chuyển cuộc gọi cho tổng đài viên thực tế, tránh làm gián đoạn cuộc gọi.
