/**
 * api-trace.js
 * Gom trace request/response backend API theo TỪNG tool call, dùng AsyncLocalStorage.
 *
 * Cách dùng:
 *   - session-ws.js bọc dispatchTool:  runWithApiTrace(() => dispatchTool(...))
 *   - api.js gọi recordApiCall(entry) trong callApi() ở mọi nhánh.
 *
 * An toàn với cuộc gọi đồng thời: mỗi context 1 store riêng, không lẫn giữa các call.
 * recordApiCall() gọi ngoài context (không có store) sẽ bỏ qua — không lỗi.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/**
 * Chạy fn trong 1 context trace mới.
 * @param {Function} fn - async function cần theo dõi (vd dispatchTool)
 * @returns {Promise<{result:any, trace:Array}>} kết quả fn + mảng trace API đã gom
 */
export async function runWithApiTrace(fn) {
  const trace = [];
  const result = await als.run(trace, fn);
  return { result, trace };
}

/**
 * Ghi 1 record API vào trace của context hiện tại (nếu có).
 * @param {object} entry - { time, method, url, query, body, http_status, duration_ms, response_outer, error_code }
 */
export function recordApiCall(entry) {
  try {
    als.getStore()?.push(entry);
  } catch { /* không được ảnh hưởng luồng gọi API */ }
}
