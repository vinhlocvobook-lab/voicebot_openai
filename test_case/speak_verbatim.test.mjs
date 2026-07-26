/**
 * speak_verbatim.test.mjs
 * Kiểm chứng logic "bot có đọc ĐÚNG câu code yêu cầu không" (đợt 4 — 26/07/2026).
 *
 * Bản chất lỗi (cuộc rtc_u2_E5i8v8eJhYoeHOlPEIgiW): hệ thống chốt đúng mã danh bộ
 * trong 5 giây, code gửi câu đọc lại xác nhận, nhưng bot LẶP LẠI câu chờ cũ
 * ("Dạ, em ghi nhận rồi ạ, chờ em một chút") vì `function_call_output` còn nằm
 * trong hội thoại kèm chỉ dẫn đọc nguyên văn. Khách không bao giờ nghe câu xác
 * nhận → cúp máy.
 *
 * File này test THUẦN LOGIC so khớp (bản sao đúng của hàm trong session-ws.js),
 * không cần mở WebSocket.
 *
 * Chạy:  node test_case/speak_verbatim.test.mjs
 */

import assert from "node:assert/strict";

// ── Bản sao logic từ session-ws.js ──────────────────────────────────────────
const _VI_DIGIT_W = {
  khong: "0", linh: "0", le: "0", mot: "1", hai: "2", ba: "3", bon: "4", tu: "4",
  nam: "5", lam: "5", sau: "6", bay: "7", tam: "8", chin: "9",
};
const _deAccent = (s) => String(s ?? "").normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

const _extractDigitRuns = (text) => {
  const runs = [];
  for (const m of String(text).matchAll(/\d[\d\s.\-]*\d/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 4) runs.push(d);
  }
  let cur = "";
  for (const tok of _deAccent(text).split(/[^a-z]+/)) {
    if (tok && tok in _VI_DIGIT_W) cur += _VI_DIGIT_W[tok];
    else { if (cur.length >= 4) runs.push(cur); cur = ""; }
  }
  if (cur.length >= 4) runs.push(cur);
  return runs;
};
const _normTxt = (x) => String(x ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const _speakCore = (text) => {
  const runs = _extractDigitRuns(text);
  if (runs.length) return runs.join("|");
  return _normTxt(text).slice(0, 24);
};
const _spokenMatchesCore = (spoken, core) => {
  if (/^[\d|]+$/.test(core)) {
    const runs = _extractDigitRuns(spoken).join("|");
    return runs.length > 0 && (runs.includes(core) || core.includes(runs));
  }
  return _normTxt(spoken).includes(core);
};

// ── Test ────────────────────────────────────────────────────────────────────
let passed = 0;
const test = (ten, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${ten}`); }
  catch (e) { console.error(`  ✗ ${ten}\n      ${e.message}`); process.exitCode = 1; }
};

console.log("\n[Kiểm chứng lời bot] cuộc rtc_u2_E5i8v8eJhYoeHOlPEIgiW");

const CAU_XAC_NHAN =
  "Dạ, em đọc lại mã danh bộ để Quý Khách kiểm tra: Hai - Hai - Không - Hai - Ba - " +
  "Hai - Năm - Một - Bảy - Bảy - Năm. Quý Khách xác nhận giúp em có đúng không ạ?";
const CAU_CHO = "Dạ, em ghi nhận rồi ạ, Quý Khách chờ em một chút.";

test("dấu hiệu của câu xác nhận chính là dãy 11 số đọc thành chữ", () => {
  assert.equal(_speakCore(CAU_XAC_NHAN), "22023251775");
});

test("BẮT ĐƯỢC lỗi thật: bot lặp câu chờ thay vì đọc câu xác nhận", () => {
  const core = _speakCore(CAU_XAC_NHAN);
  assert.equal(_spokenMatchesCore(CAU_CHO, core), false,
    "phải phát hiện bot nói KHÁC để còn gửi lại");
});

test("bot đọc đúng câu xác nhận → coi là khớp, không gửi lại", () => {
  const core = _speakCore(CAU_XAC_NHAN);
  assert.equal(_spokenMatchesCore(CAU_XAC_NHAN, core), true);
});

test("bot đọc dãy số dạng chữ số thay vì chữ → vẫn coi là khớp", () => {
  const core = _speakCore(CAU_XAC_NHAN);
  assert.equal(_spokenMatchesCore("Dạ, mã danh bộ là 22023251775, đúng không ạ?", core), true);
});

test("bot đọc SAI một chữ số → KHÔNG khớp, phải gửi lại", () => {
  const core = _speakCore(CAU_XAC_NHAN);
  assert.equal(_spokenMatchesCore("Dạ, mã danh bộ là 22023251175, đúng không ạ?", core), false);
});

test("câu KHÔNG có số → so khớp bằng phần đầu văn bản", () => {
  const cau = "Dạ, em đang nghe ạ.";
  const core = _speakCore(cau);
  assert.equal(_spokenMatchesCore("Dạ, em đang nghe ạ.", core), true);
  assert.equal(_spokenMatchesCore("Dạ, em kiểm tra ngay cho Quý Khách nhé.", core), false);
});

test("câu mời bấm phím → nhận diện đúng, không lẫn với câu khác", () => {
  const cau = "Dạ, em xin lỗi Quý Khách, đường truyền bên em vẫn chưa nghe trọn vẹn được mã danh bộ ạ.";
  const core = _speakCore(cau);
  assert.equal(_spokenMatchesCore(cau, core), true);
  assert.equal(_spokenMatchesCore(CAU_CHO, core), false);
});

console.log(`\nKết quả: ${passed} test đạt${process.exitCode ? " — CÓ TEST HỎNG" : ""}\n`);
