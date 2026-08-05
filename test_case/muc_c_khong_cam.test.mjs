/**
 * muc_c_khong_cam.test.mjs
 * MỨC C (26/07/2026 đợt 5): trong giai đoạn thu mã danh bộ, model bị khoá
 * (`create_response: false`) nên KHÔNG tự sinh response. Toàn bộ lời thoại do CODE
 * phát. Rủi ro lớn nhất là **bot câm**: khách nói xong rồi ngồi nghe im lặng.
 *
 * File này kiểm tra BẢNG QUYẾT ĐỊNH của session-ws: mọi loại lượt khách nói khi
 * đang ở chế độ `digits` đều phải rơi vào ĐÚNG MỘT nhánh CÓ phát lời.
 *
 * Chạy:  node test_case/muc_c_khong_cam.test.mjs
 */

import assert from "node:assert/strict";

// ── Bản sao logic phân nhánh từ session-ws.js ───────────────────────────────
const _DIGIT_WORD_RE = /(?:không|một|mốt|hai|ba|bốn|tư|năm|lăm|sáu|bảy|tám|chín|mươi|mười)(?=\s|$|[,.!?])/gi;
const _looksLikeDigitTurn = (t) => {
  const s = String(t);
  if ((s.match(/\d/g) || []).length >= 3) return true;
  return (s.match(_DIGIT_WORD_RE) || []).length >= 3;
};
const _KHANG_DINH_RE = /(đúng|chính xác|chuẩn|phải rồi|vâng|dạ đúng|\bok\b|\boke\b|\bđược\b|yes)/i;
// [fix 30/07/2026] \bờ\b/\bừ\b khớp NHẦM bên trong từ khác vì JS coi ký tự có
// dấu là non-word (vd "dời" = d+ờ+i vẫn khớp \bờ\b). Chỉ tính là xác nhận khi
// "ừ"/"ừm"/"ờ" là CẢ MỘT TỪ riêng trong câu ngắn — xem session-ws.js.
const _KHANG_DINH_TU_DON_RE = /^(ừ+|ừm|ờ+)$/i;
const _PHU_DINH_RE = /(không đúng|chưa đúng|sai rồi|\bsai\b|chưa phải|không phải)/i;
// [fix 31/07/2026 đợt 12] Câu DÀI có dấu "?" gần như chắc chắn không phải xác
// nhận thuần (khách đang hỏi chuyện khác) dù lỡ chứa "vâng"/"được" — xem
// session-ws.js.
const _isAffirmative = (t) => {
  const s = String(t).trim();
  if (_PHU_DINH_RE.test(s)) return false;
  if (/\?/.test(s)) return false;
  if (_KHANG_DINH_RE.test(s)) return true;
  const tokens = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 2 && tokens.some((tok) => _KHANG_DINH_TU_DON_RE.test(tok));
};
const _XIN_NHAC_LAI_RE = /((đọc|nói|nhắc)\s+lại|chưa nghe rõ|nghe không rõ|không nghe rõ|nói gì)/i;

/**
 * Trả về nhánh sẽ xử lý lượt khách nói. `"KHONG_AI_XU_LY"` = bot sẽ câm.
 * @param {string} khText
 * @param {{dangChoXacNhan:boolean, vadMode:"digits"|"normal"}} state
 */
function nhanhXuLy(khText, { dangChoXacNhan, vadMode, coCauDangCho = true, dangXacMinh = false }) {
  const seXuLyXacNhan = dangChoXacNhan && _isAffirmative(khText);
  const seXuLyPhuDinh = dangChoXacNhan && _PHU_DINH_RE.test(khText);
  const laLuotDocSo = !seXuLyXacNhan && !seXuLyPhuDinh && _looksLikeDigitTurn(khText);

  if (laLuotDocSo) return "GOM_SO";                       // đường nền sẽ phát lời
  if (seXuLyXacNhan) return "XAC_NHAN";                   // → _requestModelReply
  if (seXuLyPhuDinh) return "PHU_DINH";                   // → _maybeVerifyDanhBo phát lời
  if (_XIN_NHAC_LAI_RE.test(khText) && coCauDangCho) return "NHAC_LAI"; // → đọc lại câu đang chờ
  // Đang xác minh / sắp đọc câu xác nhận → GIỮ KHOÁ, đường nền sẽ phát lời.
  if (vadMode === "digits" && dangXacMinh) return "GIU_KHOA";
  if (vadMode === "digits") return "DOI_CHU_DE";          // → mở khoá + _requestModelReply
  return "MODEL_TU_TRA_LOI";                              // model chưa bị khoá
}

const CO_PHAT_LOI = new Set(["GOM_SO", "XAC_NHAN", "PHU_DINH", "NHAC_LAI", "GIU_KHOA", "DOI_CHU_DE", "MODEL_TU_TRA_LOI"]);

let passed = 0;
const test = (ten, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${ten}`); }
  catch (e) { console.error(`  ✗ ${ten}\n      ${e.message}`); process.exitCode = 1; }
};

console.log("\n[MỨC C] không lượt khách nào được rơi vào im lặng");

const CAC_LUOT = [
  // [câu khách nói, đang chờ xác nhận?, nhánh kỳ vọng]
  ["Mã danh bộ là 2202 3251 775.", false, "GOM_SO"],
  ["2263251.", false, "GOM_SO"],
  ["Bảy bảy năm.", false, "GOM_SO"],
  ["Xin lỗi, cho tôi hỏi về thủ tục sang tên đồng hồ nước.", false, "DOI_CHU_DE"],
  ["Alo, em còn nghe không?", false, "DOI_CHU_DE"],
  ["Xin chào.", false, "DOI_CHU_DE"],
  ["Đúng rồi", true, "XAC_NHAN"],
  ["Dạ đúng ạ", true, "XAC_NHAN"],
  ["Sai rồi em", true, "PHU_DINH"],
  ["Không đúng, không phải, không phải số đó", true, "PHU_DINH"],
  // "vâng" khi KHÔNG có ứng viên nào đang chờ → phải rơi vào nhánh đổi chủ đề,
  // KHÔNG được im lặng (kẽ hở này từng khiến khách chờ 15 giây tới lưới an toàn).
  ["Vâng", false, "DOI_CHU_DE"],
  ["Ừ", false, "DOI_CHU_DE"],
];

for (const [cau, dangCho, kyVong] of CAC_LUOT) {
  test(`"${cau.slice(0, 42)}"${dangCho ? " [đang chờ xác nhận]" : ""} → ${kyVong}`, () => {
    const nhanh = nhanhXuLy(cau, { dangChoXacNhan: dangCho, vadMode: "digits" });
    assert.equal(nhanh, kyVong);
    assert.ok(CO_PHAT_LOI.has(nhanh), `nhánh "${nhanh}" KHÔNG phát lời → bot sẽ câm`);
  });
}

test("phủ định lẫn nhiều chữ 'không' KHÔNG bị nhầm thành lượt đọc số", () => {
  const cau = "Dạ không, không phải, không đúng";
  assert.equal(_looksLikeDigitTurn(cau), true, "bộ lọc thô vẫn khớp — đó là lý do cần guard");
  assert.equal(nhanhXuLy(cau, { dangChoXacNhan: true, vadMode: "digits" }), "PHU_DINH",
    "guard phải chặn, không được đẩy câu phủ định vào kho quan sát danh bộ");
});

test("'Đọc lại đi' là xin nhắc lại, KHÔNG phải đổi chủ đề", () => {
  // Cuộc rtc_u2_E66X1bhQIrBrwtqeHkOau: câu này bị xếp vào "đổi chủ đề" nên code
  // nhờ model tự trả lời, model lại nói câu chờ cũ → bế tắc rồi khách cúp máy.
  assert.equal(nhanhXuLy("Đọc lại đi.", { dangChoXacNhan: false, vadMode: "digits" }), "NHAC_LAI");
  assert.equal(nhanhXuLy("Em nói lại giúp anh", { dangChoXacNhan: false, vadMode: "digits" }), "NHAC_LAI");
  assert.equal(nhanhXuLy("Anh chưa nghe rõ", { dangChoXacNhan: false, vadMode: "digits" }), "NHAC_LAI");
});

test("xin nhắc lại khi CHƯA có câu nào đang chờ → về nhánh đổi chủ đề", () => {
  assert.equal(nhanhXuLy("Đọc lại đi.", { dangChoXacNhan: false, vadMode: "digits", coCauDangCho: false }),
    "DOI_CHU_DE");
});

test("câu lạ chen vào lúc ĐANG XÁC MINH → GIỮ KHOÁ, không thả model ra", () => {
  // Cuộc rtc_u2_E67HNE1dTVDUT80s4XixB: khách vừa đọc xong 11 số, đường nền đang
  // chạy, lọt vào hai chữ "đồng hồ" → code mở khoá model → 2 giây sau trọng tài
  // chốt đúng mã nhưng model đã được thả ra và nói "ví dụ: 22082351" → hỏng.
  assert.equal(nhanhXuLy("đồng hồ", { dangChoXacNhan: false, vadMode: "digits", dangXacMinh: true }),
    "GIU_KHOA");
  // Không đang xác minh thì vẫn phải trả lời khách bình thường.
  assert.equal(nhanhXuLy("đồng hồ", { dangChoXacNhan: false, vadMode: "digits", dangXacMinh: false }),
    "DOI_CHU_DE");
});

test("khi model CHƯA bị khoá thì câu ngoài luồng để model tự trả lời", () => {
  assert.equal(nhanhXuLy("Cho hỏi thủ tục sang tên", { dangChoXacNhan: false, vadMode: "normal" }),
    "MODEL_TU_TRA_LOI");
});

test("câu KHÔNG liên quan chứa 'ờ'/'ừ' lẫn trong từ khác KHÔNG bị coi là xác nhận", () => {
  // Cuộc rtc_u1_E7L7Y2XD6JGGx1oQkIjAj: khách đang được hỏi "có đúng không" thì
  // trả lời "Mình muốn nâng dời đồng hồ." (một yêu cầu KHÁC, xin dời đồng hồ
  // nước) — nhưng bị chốt confirmed=true vì chữ "dời" chứa "ờ", và \bờ\b của JS
  // khớp nhầm ở cả hai đầu "ờ" (coi ký tự có dấu là non-word). Phải rơi vào
  // "DOI_CHU_DE" (đổi chủ đề), KHÔNG PHẢI "XAC_NHAN".
  assert.equal(
    nhanhXuLy("Mình muốn nâng dời đồng hồ.", { dangChoXacNhan: true, vadMode: "digits" }),
    "DOI_CHU_DE",
    "phải KHÔNG coi là xác nhận — 'dời' chỉ tình cờ chứa chữ 'ờ'"
  );
  // Các từ phổ biến khác có cùng rủi ro: "từ", "giờ", "chờ", "sợ".
  for (const cau of ["Từ hôm qua nhà tôi mất nước.", "Mấy giờ có nước lại vậy em?", "Chờ chút anh nói."]) {
    assert.notEqual(
      nhanhXuLy(cau, { dangChoXacNhan: true, vadMode: "digits" }),
      "XAC_NHAN",
      `"${cau}" không phải câu xác nhận, không được rơi vào XAC_NHAN`
    );
  }
});

test("'Ừ'/'Ờ' đứng riêng MỘT MÌNH vẫn được coi là xác nhận khi đang chờ", () => {
  assert.equal(nhanhXuLy("Ừ.", { dangChoXacNhan: true, vadMode: "digits" }), "XAC_NHAN");
  assert.equal(nhanhXuLy("Ờ, đúng đó.", { dangChoXacNhan: true, vadMode: "digits" }), "XAC_NHAN");
});

test("câu DÀI mở đầu bằng 'Vâng,' nhưng thực ra đang hỏi chuyện KHÁC → KHÔNG tính là xác nhận", () => {
  // Cuộc rtc_u1_E7Z0LRZnTro02qMeeISyy: khách nói "Vâng, cho mình hỏi giờ mình lên
  // đăng ký định mức nước hai nhân khẩu được không ạ?" ngay sau khi bot mời bấm
  // DTMF (không hề đọc lại số để khách xác nhận) — nhưng bị `_KHANG_DINH_RE` khớp
  // chữ "Vâng"/"được" ở giữa câu nên ghi nhận nhầm thành "danh_bo_verbal_confirm".
  // May mắn số đang chờ đúng nên không lộ sai dữ liệu, nhưng đúng lỗ hổng mà gate
  // xác nhận lời nói được dựng lên để chặn — câu có dấu "?" không được tính là
  // xác nhận thuần.
  assert.equal(
    _isAffirmative("Vâng, cho mình hỏi giờ mình lên đăng ký định mức nước hai nhân khẩu được không ạ?"),
    false,
    "câu có dấu '?' không được tính là xác nhận dù chứa 'vâng'/'được'"
  );
  // Xác nhận thật (ngắn, không có câu hỏi kèm theo) vẫn phải hoạt động bình thường.
  assert.equal(_isAffirmative("Vâng, đúng rồi ạ."), true);
  assert.equal(_isAffirmative("Dạ đúng số đó."), true);
});

console.log(`\nKết quả: ${passed} test đạt${process.exitCode ? " — CÓ TEST HỎNG" : ""}\n`);
