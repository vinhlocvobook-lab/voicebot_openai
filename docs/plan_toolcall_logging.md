# Kế hoạch: Bổ sung logging Tool Call + API Trace

> Trạng thái: **ĐÃ TRIỂN KHAI** (2026-07-03) — bảng đã tạo trên server, code đã cập nhật đủ 5 bước.
> Bảng `voicebot_toolcall`: xem `db/voicebot_toolcall.sql` (tạo thủ công trên server).

## 1. Hiện trạng

| Thông tin | File JSON | Console log | Database |
|---|---|---|---|
| LLM truyền gì vào tool (args) | ✅ `toolCalls[].args` | ✅ `log.info` | ⚠️ chỉ gián tiếp trong cột `transcript` |
| Tool trả gì về cho LLM (output) | ✅ `toolCalls[].output` | ⚠️ chỉ `log.debug` | ⚠️ như trên |
| Request gửi backend api.php | ❌ | ⚠️ chỉ method+URL ở `log.debug` | ❌ |
| Response backend api.php trả về | ❌ | ❌ | ❌ |

**Lỗ hổng chính:** không truy được raw response từ `api.php` — output trong `toolCalls`
là kết quả **sau khi `tools.js` reformat**, không phải dữ liệu gốc backend trả về.

## 2. Mục tiêu

Mỗi tool call ghi được chuỗi đầy đủ:

```
LLM args → [API request → API raw response] × n → tool output trả về LLM
```

vào cả 3 nơi: file JSON, console log, bảng `voicebot_toolcall`.

## 3. Các bước triển khai

### Bước 1 — Tạo `src/api-trace.js` (file mới, ~30 dòng)

Dùng `AsyncLocalStorage` để gom trace theo từng tool call mà **không đổi chữ ký**
các hàm trong `api.js` (`getTienNuoc`, `baoSuCo`, ...).

```js
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** Chạy fn trong 1 context trace. Trả { result, trace }. */
export async function runWithApiTrace(fn) {
  const trace = [];
  const result = await als.run(trace, fn);
  return { result, trace };
}

/** api.js gọi hàm này để ghi 1 record. Ngoài context → bỏ qua (an toàn). */
export function recordApiCall(entry) {
  als.getStore()?.push(entry);
}
```

An toàn với cuộc gọi đồng thời (mỗi tool call 1 store riêng), không rò rỉ giữa các call.

### Bước 2 — Sửa `src/api.js`: ghi trace trong `callApi()`

Trong `callApi()`, ghi 1 record cho **mọi nhánh** (thành công, parse lỗi, timeout,
mất kết nối):

```js
recordApiCall({
  time:           _nowGmt7(),
  method,
  url,                          // đã gồm query string
  query:          query ?? null,
  body:           body  ?? null, // POST body (bao-su-co)
  http_status:    res?.status ?? null,
  duration_ms:    Date.now() - t0,
  response_outer: _clipJson(outer, 8000), // raw 2 lớp từ api.php, cắt 8KB
  error_code:     null | "TIMEOUT" | "CONNECTION_ERROR" | "INVALID_RESPONSE",
});
```

Ghi chú:
- `response_outer` giữ **nguyên lớp ngoài** (gateway) — cái hiện đang bị vứt bỏ.
- Không ghi headers (đề phòng sau này có Authorization).
- Nâng log console: `log.info("[API] GET /tien-nuoc → 200 (412ms)")`,
  full response giữ ở `log.debug`.

### Bước 3 — Sửa `src/session-ws.js`: bọc `dispatchTool`

Tại chỗ xử lý `response.done` (~dòng 184):

```js
const _t0 = Date.now();
const { result: toolOutput, trace: apiCalls } =
  await runWithApiTrace(() => dispatchTool(name, args));
const _durationMs = Date.now() - _t0;

logger.addToolCall(name, args, _tryParseJson(toolOutput), _durationMs, apiCalls);
```

Không đổi gì khác trong luồng (function_call_output, action end_call/transfer
giữ nguyên).

### Bước 4 — Sửa `src/conversation-logger.js`: nhận `apiCalls`

```js
addToolCall(name, args, output, durationMs = null, apiCalls = []) {
  const entry = { time: _now(), seq: this.toolCalls.length + 1,
                  name, args, output, durationMs, apiCalls };
  ...
}
```

- File JSON: section `toolCalls` tự có thêm `seq` + `apiCalls` (không đổi cấu trúc khác).
- `conversation` (dạng đọc nhanh): thêm dòng `🌐 API: GET /tien-nuoc?... → 200 (412ms)`
  giữa dòng 🔧 và 📋 (tùy chọn, dễ đọc khi debug).

### Bước 5 — Sửa `src/db.js`: ghi bảng `voicebot_toolcall`

Thêm hàm `insertToolCalls(document)`, gọi cuối `finalizeCallLog()` (pha 2,
giữ nguyên tắc single-writer):

- Loop `document.toolCalls`, mỗi entry 1 row, upsert theo
  `UNIQUE(voicebot_callid, seq)` → chạy lại không tạo trùng.
- `voicebot_calllog_id` lấy qua subselect theo `voicebot_callid`
  (giống pattern bảng `ticket`).
- `ma_danh_bo`: normalize từ `args.ma_danh_bo`.
- `success`: `output?.success ? 1 : 0`, NULL nếu output không parse được.
- `invalid_danh_bo`: `output?.invalid_danh_bo ? 1 : 0`.
- `args/output/api_calls`: `JSON.stringify` + clip (args 4KB, output 16KB,
  api_calls 64KB) tránh "Data too long".
- Nuốt lỗi + `log.warn` như mọi hàm DB khác — **lỗi DB không được sập cuộc gọi**.

### Bước 6 — Kiểm thử

1. Gọi thử 1 cuộc: hỏi tiền nước (danh bộ đúng), đọc danh bộ thiếu số, báo sự cố,
   kết thúc → kiểm tra file JSON có `apiCalls`, bảng có đủ 4+ rows.
2. Tắt DB (`DB_ENABLED=false`) → file JSON vẫn đầy đủ, không lỗi.
3. Giả lập backend timeout (`TONGDAI_API_TIMEOUT_MS=1`) → record có
   `error_code: "TIMEOUT"`, cuộc gọi không sập.
4. 2 cuộc gọi đồng thời → trace không lẫn giữa 2 call (kiểm tra AsyncLocalStorage).

## 4. Phạm vi sửa đổi

| File | Thay đổi |
|---|---|
| `src/api-trace.js` | **MỚI** — AsyncLocalStorage helper |
| `src/api.js` | +recordApiCall trong callApi, nâng log console |
| `src/session-ws.js` | Bọc dispatchTool bằng runWithApiTrace (~3 dòng) |
| `src/conversation-logger.js` | addToolCall nhận thêm apiCalls, seq |
| `src/db.js` | +insertToolCalls, gọi trong finalizeCallLog |
| `db/schema.sql` | Ghép nội dung `voicebot_toolcall.sql` vào (sau khi chốt) |

Không đụng: `tools.js` (chữ ký giữ nguyên), luồng SIP/WS, guard `_hungUp`/`_transferred`.

## 5. Ví dụ dữ liệu sẽ insert vào `voicebot_toolcall`

### Row 1 — `get_bill` thành công (LLM đọc danh bộ kèm gạch ngang, 1 API call)

```json
{
  "voicebot_calllog_id": 1042,
  "voicebot_callid": "rtc_u0_8fA3kQz9XbT2",
  "seq": 1,
  "tool_name": "get_bill",
  "ma_danh_bo": "15122890724",
  "args": { "ma_danh_bo": "1-5-1-2-2-8-9-0-7-2-4", "ky": null, "nam": null },
  "output": {
    "success": true,
    "message": "Lấy thông tin tiền nước thành công.",
    "data": { "Ky": 6, "Nam": 2026, "TongTien": 385000, "TrangThai": "Chưa thanh toán" }
  },
  "success": 1,
  "invalid_danh_bo": 0,
  "duration_ms": 486,
  "api_call_count": 1,
  "api_calls": [
    {
      "time": "2026-07-03T09:15:22.104+07:00",
      "method": "GET",
      "url": "http://127.0.0.1:7700/api.php/trang-thai-thanh-toan?danhba=15122890724",
      "query": { "danhba": "15122890724" },
      "body": null,
      "http_status": 200,
      "duration_ms": 412,
      "response_outer": {
        "success": true,
        "http_code": 200,
        "data": {
          "success": true,
          "message": "OK",
          "data": { "Ky": 6, "Nam": 2026, "TongTien": 385000, "TrangThai": "Chưa thanh toán" }
        }
      },
      "error_code": null
    }
  ],
  "called_at": "2026-07-03 09:15:22"
}
```

### Row 2 — `get_bill` bị chặn vì danh bộ 10 số (KHÔNG gọi API)

```json
{
  "voicebot_callid": "rtc_u0_8fA3kQz9XbT2",
  "seq": 2,
  "tool_name": "get_bill",
  "ma_danh_bo": "1512289072",
  "args": { "ma_danh_bo": "1512289072" },
  "output": {
    "success": false,
    "invalid_danh_bo": true,
    "do_dai_hien_tai": 10,
    "do_dai_yeu_cau": 11,
    "message": "Mã danh bộ vừa nhận có 10 chữ số, cần đúng 11 chữ số. KHÔNG tra cứu..."
  },
  "success": 0,
  "invalid_danh_bo": 1,
  "duration_ms": 2,
  "api_call_count": 0,
  "api_calls": [],
  "called_at": "2026-07-03 09:16:05"
}
```

### Row 3 — `create_ticket` (POST có body) nhưng backend TIMEOUT

```json
{
  "voicebot_callid": "rtc_u0_8fA3kQz9XbT2",
  "seq": 3,
  "tool_name": "create_ticket",
  "ma_danh_bo": "15122890724",
  "args": {
    "ma_danh_bo": "15122890724",
    "loai": "ro_ri",
    "mo_ta": "Nước rò rỉ trước đồng hồ, chảy thành vũng trước nhà"
  },
  "output": { "success": false, "message": "Máy chủ phản hồi quá lâu." },
  "success": 0,
  "invalid_danh_bo": 0,
  "duration_ms": 15021,
  "api_call_count": 1,
  "api_calls": [
    {
      "time": "2026-07-03T09:17:40.512+07:00",
      "method": "POST",
      "url": "http://127.0.0.1:7700/api.php/bao-su-co",
      "query": null,
      "body": { "danhba": "15122890724", "noidung": "[ro_ri] Nước rò rỉ trước đồng hồ, chảy thành vũng trước nhà" },
      "http_status": null,
      "duration_ms": 15003,
      "response_outer": null,
      "error_code": "TIMEOUT"
    }
  ],
  "called_at": "2026-07-03 09:17:40"
}
```

### Row 4 — `end_call` (tool action, không có API)

```json
{
  "voicebot_callid": "rtc_u0_8fA3kQz9XbT2",
  "seq": 4,
  "tool_name": "end_call",
  "ma_danh_bo": null,
  "args": { "ly_do": "Khách hàng đã được hỗ trợ xong" },
  "output": {
    "success": true,
    "action": "end_call",
    "message": "Kết thúc cuộc gọi.",
    "ly_do": "Khách hàng đã được hỗ trợ xong"
  },
  "success": 1,
  "invalid_danh_bo": 0,
  "duration_ms": 1,
  "api_call_count": 0,
  "api_calls": [],
  "called_at": "2026-07-03 09:18:12"
}
```

### Câu INSERT tương ứng (do `db.js` sinh, upsert idempotent)

```sql
INSERT INTO voicebot_toolcall
  (voicebot_calllog_id, voicebot_callid, seq, tool_name, ma_danh_bo,
   args, output, success, invalid_danh_bo, duration_ms,
   api_call_count, api_calls, called_at)
VALUES
  ((SELECT id FROM voicebot_calllog WHERE voicebot_callid = 'rtc_u0_8fA3kQz9XbT2' LIMIT 1),
   'rtc_u0_8fA3kQz9XbT2', 1, 'get_bill', '15122890724',
   '{"ma_danh_bo":"1-5-1-2-2-8-9-0-7-2-4","ky":null,"nam":null}',
   '{"success":true,"message":"Lấy thông tin tiền nước thành công.","data":{...}}',
   1, 0, 486,
   1, '[{"time":"2026-07-03T09:15:22.104+07:00","method":"GET",...}]',
   '2026-07-03 09:15:22')
ON DUPLICATE KEY UPDATE
  voicebot_calllog_id = VALUES(voicebot_calllog_id),
  output      = VALUES(output),
  success     = VALUES(success),
  duration_ms = VALUES(duration_ms),
  api_calls   = VALUES(api_calls);
```

## 6. Rủi ro & lưu ý

- **Kích thước JSON**: response backend có thể lớn (lịch sử nhiều kỳ) → clip
  8KB/api call, 64KB/cột `api_calls`. File JSON gốc vẫn giữ đầy đủ.
- **MariaDB JSON** = alias LONGTEXT + CHECK valid → `JSON.stringify` là đủ.
- **Không log secret**: không ghi headers; `.env` không bị đụng tới.
- **Lỗi DB/trace không được sập cuộc gọi**: mọi chỗ ghi đều try/catch + nuốt lỗi,
  theo đúng quy ước hiện có.
- **Truy vấn mẫu sau khi có bảng**:

```sql
-- Tool call lỗi trong 7 ngày qua
SELECT * FROM v_toolcall_overview
WHERE success = 0 AND called_at >= NOW() - INTERVAL 7 DAY;

-- Tỉ lệ LLM đọc sai độ dài danh bộ theo ngày
SELECT DATE(called_at) d, COUNT(*) total,
       SUM(invalid_danh_bo) invalid, ROUND(SUM(invalid_danh_bo)/COUNT(*)*100,1) pct
FROM voicebot_toolcall GROUP BY d ORDER BY d DESC;

-- Backend chậm/timeout
SELECT voicebot_callid, tool_name, duration_ms, api_calls
FROM voicebot_toolcall
WHERE duration_ms > 5000 OR JSON_SEARCH(api_calls, 'one', 'TIMEOUT') IS NOT NULL;
```
