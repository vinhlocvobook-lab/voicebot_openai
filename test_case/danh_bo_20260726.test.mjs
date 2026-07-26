/**
 * danh_bo_20260726.test.mjs
 * Test tự động cho đợt sửa 26/07/2026 (kế hoạch v3 — docs/fix_plan/ke_hoach_v3_danh_bo_20260726.md).
 *
 * Chạy:  node test_case/danh_bo_20260726.test.mjs
 * Không cần .env, không gọi mạng — chỉ kiểm tra phần logic thuần.
 *
 * Dữ liệu dựng lại từ cuộc gọi thật rtc_u2_E5eDfB96UnJE6iDWfPbRX (26/07 04:29–04:32),
 * mã danh bộ ĐÚNG là 22023251775.
 */

import assert from "node:assert/strict";
import {
  classifyModelArg,
  ensureDanhBoSession,
  startDanhBoRequest,
  noteDanhBoTranscript,
  danhBoSessionDigits,
} from "../src/tools.js";

let passed = 0;
const test = (ten, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${ten}`);
  } catch (e) {
    console.error(`  ✗ ${ten}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] classifyModelArg — phát hiện model bịa số (§4.1 kế hoạch v3)");

test("R1 — phiên chưa có chữ số nào thì mọi arg đều là BỊA (ca 725625)", () => {
  const r = classifyModelArg("725625", "");
  assert.equal(r.verdict, "bia");
  assert.equal(r.rule, "R1");
});

test("R4 — arg lệch quá xa mọi cửa sổ trong phiên là BỊA (ca 320325175)", () => {
  // Phiên gồm 5 lượt khách đọc, ghép lại theo đúng log cuộc gọi thật.
  const phien = "2200" + "325" + "167775" + "31717575" + "0223251775";
  const r = classifyModelArg("320325175", phien);
  assert.equal(r.verdict, "bia", `kỳ vọng BỊA, nhận ${r.verdict} (d=${r.distance})`);
  assert.equal(r.rule, "R4");
});

test("R2 — arg trùng khít một đoạn khách đã đọc → nghe đúng", () => {
  const r = classifyModelArg("22023251775", "Xin chào 22023251775".replace(/\D/g, ""));
  assert.equal(r.verdict, "nghe_dung");
  assert.equal(r.rule, "R2");
});

test("R3 — arg sai 1 chữ số so với số khách đọc → nghe lệch, vẫn giữ làm quan sát", () => {
  const r = classifyModelArg("22023251771", "22023251775"); // lệch chữ số cuối
  assert.equal(r.verdict, "nghe_lech");
  assert.equal(r.rule, "R3");
  assert.equal(r.distance, 1);
});

test("arg rỗng → 'empty', không tính là bịa", () => {
  assert.equal(classifyModelArg("", "22023251775").verdict, "empty");
  assert.equal(classifyModelArg(null, "22023251775").verdict, "empty");
});

test("số điện thoại khách đọc không bị nhận nhầm thành nghe-đúng", () => {
  const r = classifyModelArg("0967777637", "22023251775");
  assert.equal(r.verdict, "bia");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] Hai biến tích luỹ (§2 kế hoạch v3)");

test("biến 2 chỉ đếm số của LƯỢT YÊU CẦU hiện tại, biến 1 giữ toàn cuộc gọi", () => {
  const cs = {};
  startDanhBoRequest(cs, "test");
  noteDanhBoTranscript(cs, "Số danh bộ là 2200");
  noteDanhBoTranscript(cs, "325.");
  noteDanhBoTranscript(cs, "167775.");
  assert.equal(danhBoSessionDigits(cs), 13, "phiên 1 phải có 13 chữ số");

  // Bot mời đọc lại → sang phiên mới, biến 2 về 0 nhưng biến 1 giữ nguyên.
  startDanhBoRequest(cs, "mời đọc lại");
  assert.equal(danhBoSessionDigits(cs), 0, "phiên mới phải bắt đầu từ 0");
  assert.equal(cs._danhBoTranscripts.length, 3, "biến 1 phải giữ đủ 3 lượt cũ");

  // Đây chính là lượt 04:32:06 của cuộc gọi thật — khách đọc đúng, liền mạch.
  noteDanhBoTranscript(cs, "22023251775");
  assert.equal(danhBoSessionDigits(cs), 11, "phiên mới phải ra đúng 11 số");
  assert.equal(cs._danhBoTranscripts.length, 4);
});

test("requestNo KHÔNG tăng khi lượt trước chưa nghe được chữ số nào", () => {
  const cs = {};
  startDanhBoRequest(cs, "lần 1");               // khách chưa nói gì
  startDanhBoRequest(cs, "model gọi tool lần 2");
  startDanhBoRequest(cs, "model gọi tool lần 3");
  assert.equal(ensureDanhBoSession(cs).requestNo, 1,
    "3 tool call liên tiếp mà khách chưa nói → vẫn chỉ là 1 lượt yêu cầu");
});

test("requestNo tăng khi lượt trước ĐÃ nghe được số nhưng không chốt được", () => {
  const cs = {};
  startDanhBoRequest(cs, "lần 1");
  noteDanhBoTranscript(cs, "2200");
  startDanhBoRequest(cs, "mời đọc lại");
  assert.equal(ensureDanhBoSession(cs).requestNo, 2);
});

test("khách đọc mà chưa có lượt yêu cầu nào → tự mở lượt #1", () => {
  const cs = {};
  noteDanhBoTranscript(cs, "22023251775");
  assert.equal(ensureDanhBoSession(cs).requestNo, 1);
  assert.equal(danhBoSessionDigits(cs), 11);
});

test("biến 1 bị chặn ở 20 phần tử, không phình vô hạn", () => {
  const cs = {};
  for (let i = 0; i < 30; i++) noteDanhBoTranscript(cs, `123${i}`);
  assert.equal(cs._danhBoTranscripts.length, 20);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\nKết quả: ${passed} test đạt${process.exitCode ? " — CÓ TEST HỎNG" : ""}\n`);
