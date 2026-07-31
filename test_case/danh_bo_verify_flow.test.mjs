/**
 * danh_bo_verify_flow.test.mjs
 * Dựng lại nguyên kịch bản cuộc gọi hỏng rtc_u2_E5eDfB96UnJE6iDWfPbRX (26/07/2026)
 * để kiểm chứng LUỒNG XÁC MINH mới (§2.3 kế hoạch v3).
 *
 * `fetch` toàn cục được giả lập: không gọi mạng, không cần .env thật.
 *   - API /thong-tin-khach-hang: chỉ 22023251775 là tồn tại.
 *   - gpt-5.1: trả đúng những gì model thật đã trả trong log cuộc gọi.
 *
 * Chạy:  node test_case/danh_bo_verify_flow.test.mjs
 */

process.env.TONGDAI_API_BASE = "http://mock.local/api.php";
process.env.OPENAI_API_KEY = "sk-test";
process.env.LOG_LEVEL = "error"; // gọn output test

import assert from "node:assert/strict";

const DANH_BO_DUNG = "22023251775";
const TON_TAI = new Set([DANH_BO_DUNG]);

/** Điều khiển câu trả lời của gpt-5.1 cho từng test. */
let arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.2, ly_do: "mock" };
let arbiterCalls = 0;
let apiCalls = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes("api.openai.com")) {
    arbiterCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(arbiterVerdict) } }],
        usage: { total_tokens: 100 },
      }),
      text: async () => "",
    };
  }

  // Backend nghiệp vụ
  const parsed = new URL(u);
  const danhba = parsed.searchParams.get("danhba");
  const co = TON_TAI.has(danhba);

  // /trang-thai-thanh-toan → dữ liệu hoá đơn
  if (parsed.pathname.includes("trang-thai-thanh-toan") || parsed.search.includes("trang-thai")) {
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        success: true,
        data: co
          ? { success: true, data: [{ Ky: 7, Nam: 2026, SanLuong: 18, TongTien: 309700, TrangThaiThanhToan: "Chưa thanh toán" }] }
          : { success: false, data: [], error_code: "CUSTOMER_NOT_FOUND", message: "Không tìm thấy khách hàng" },
      }),
    };
  }

  // /thong-tin-khach-hang → kiểm tra tồn tại
  apiCalls.push(danhba);
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      success: true,
      data: {
        success: co,
        data: co ? [{ danhBa: danhba, hoTen: "NGUYEN VAN A" }] : [],
        message: co ? "OK" : "Không tìm thấy khách hàng",
        error_code: co ? null : "CUSTOMER_NOT_FOUND",
      },
    }),
  };
};

const { noteDanhBoTranscript, startDanhBoRequest, verifyDanhBoFromSession, ensureDanhBoSession, dispatchTool, noteDanhBoRejected } =
  await import("../src/tools.js");

const _logStub = { addEvent() { }, markDanhBoStarted() { }, setDanhBoRequestCount() { }, markDanhBoResolved() { } };

let passed = 0;
const test = async (ten, fn) => {
  arbiterCalls = 0; apiCalls = [];
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${ten}`);
  } catch (e) {
    console.error(`  ✗ ${ten}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

console.log("\n[Luồng xác minh] dựng lại cuộc gọi rtc_u2_E5eDfB96UnJE6iDWfPbRX");

await test("KỊCH BẢN CHÍNH — khách đọc đúng 11 số liền mạch → chốt đúng mã", async () => {
  const cs = {};
  // Phiên 1: khách đọc tách 3 hơi, tổng 13 số (đúng như log 04:29:58 → 04:30:07)
  startDanhBoRequest(cs, "bot xin mã");
  noteDanhBoTranscript(cs, "Số danh bộ là 2200");
  noteDanhBoTranscript(cs, "325.");
  noteDanhBoTranscript(cs, "167775.");

  // gpt-5.1 từ chối y như thật (13 số, không ghép nổi)
  arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.2, ly_do: "13 chữ số, cần 11" };
  const r1 = await verifyDanhBoFromSession(cs);
  assert.equal(r1.action, "reread", "phiên 13 số không chốt được → phải mời đọc lại");
  assert.ok(r1.prompt, "phải có câu thoại cho khách");
  assert.ok(!/chưa có mã danh bộ/i.test(r1.prompt),
    `KHÔNG được nói "chưa có mã danh bộ" khi đã nghe 13 số. Câu thật: "${r1.prompt}"`);
  assert.equal(ensureDanhBoSession(cs).digits, "", "mời đọc lại → phiên phải reset");

  // Phiên 2 — đây chính là lượt 04:32:06 mà code CŨ đã vứt đi.
  noteDanhBoTranscript(cs, DANH_BO_DUNG);
  arbiterVerdict = { ma_danh_bo: DANH_BO_DUNG, do_tin_cay: 0.95, ly_do: "lần đọc mới nhất đủ 11 số" };
  const r2 = await verifyDanhBoFromSession(cs);

  assert.equal(r2.action, "confirm", "phải chốt được ứng viên");
  assert.equal(r2.value, DANH_BO_DUNG, "phải chốt ĐÚNG mã danh bộ");
  assert.equal(r2.by, "transcript_11");
  assert.equal(cs.danhBo.value, DANH_BO_DUNG);
  assert.equal(cs.danhBo.confirmed, false, "vẫn phải chờ khách xác nhận, không tự tra cứu");
});

await test("transcript đơn 11 số VẪN đi qua gpt-5.1 (không chốt thẳng)", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, DANH_BO_DUNG);
  arbiterVerdict = { ma_danh_bo: DANH_BO_DUNG, do_tin_cay: 0.9, ly_do: "ok" };
  await verifyDanhBoFromSession(cs);
  assert.equal(arbiterCalls, 1, "phải gọi gpt-5.1 đúng 1 lần cho lượt xác minh này");
  assert.ok(apiCalls.includes(DANH_BO_DUNG), "phải verify song song qua API");
});

await test("nghe đủ 11 số nhưng API KHÔNG có → không chốt bừa, dùng ứng viên trọng tài", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, "22003251775"); // sai 1 chữ số, không tồn tại trong hệ thống
  arbiterVerdict = { ma_danh_bo: DANH_BO_DUNG, do_tin_cay: 0.9, ly_do: "sửa 1 số" };
  const r = await verifyDanhBoFromSession(cs);
  assert.equal(r.action, "confirm");
  assert.equal(r.value, DANH_BO_DUNG, "phải lấy ứng viên trọng tài đã verify được qua API");
  assert.equal(r.by, "arbiter");
  assert.equal(cs._danhBoNeedsVerbalYes, true,
    "số do trọng tài SUY LUẬN phải bật gate xác nhận lời nói");
});

await test("nghe đủ 11 số, API không có, trọng tài cũng bí → mời đọc lại, KHÔNG chốt", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, "12345678901");
  arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.1, ly_do: "không suy ra được" };
  const r = await verifyDanhBoFromSession(cs);
  assert.equal(r.action, "reread");
  assert.equal(cs.danhBo, undefined, "tuyệt đối không được chốt số không tồn tại");
});

await test("leo thang: đọc hỏng đủ 3 lượt → mời BẤM PHÍM", async () => {
  const cs = {};
  arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.1, ly_do: "bí" };
  let cuoi;
  for (let i = 0; i < 3; i++) {
    noteDanhBoTranscript(cs, "12345678901"); // 11 số nhưng không tồn tại
    cuoi = await verifyDanhBoFromSession(cs);
  }
  assert.equal(cuoi.action, "dtmf", `lượt thứ 3 phải mời bấm phím, nhận "${cuoi.action}"`);
  assert.ok(/BẤM/.test(cuoi.prompt), "câu thoại phải mời khách bấm phím");
  assert.equal(cs._danhBoDtmfInvited, true);
});

await test("guard: đã có ứng viên đang chờ (vd DTMF) → không chen ngang", async () => {
  const cs = { danhBo: { value: DANH_BO_DUNG, confirmed: false } };
  noteDanhBoTranscript(cs, "99999999999");
  const r = await verifyDanhBoFromSession(cs);
  assert.equal(r.action, "none");
  assert.equal(arbiterCalls, 0, "không được gọi gpt-5.1 khi đã có ứng viên đang chờ");
  assert.equal(cs.danhBo.value, DANH_BO_DUNG, "ứng viên đang chờ phải giữ nguyên");
});

await test("trọng tài tin cậy THẤP nhưng API xác nhận có thật → vẫn đề xuất", async () => {
  // Ca thật cuộc rtc_u1_E5hSj6jwK5jeMHvCZV7yx: gpt-5.1 suy ra ĐÚNG mã nhưng tự
  // chấm 0.4 vì phải ghép qua nhiều mảnh → ngưỡng cứng 0.7 loại thẳng.
  const cs = {};
  noteDanhBoTranscript(cs, "2202");
  noteDanhBoTranscript(cs, "3251775.");
  arbiterVerdict = { ma_danh_bo: DANH_BO_DUNG, do_tin_cay: 0.4, ly_do: "ghép nhiều mảnh" };
  const r = await verifyDanhBoFromSession(cs);
  assert.equal(r.action, "confirm", "API đã xác nhận số có thật thì không được loại vì conf thấp");
  assert.equal(r.value, DANH_BO_DUNG);
});

await test("tin cậy thấp mà API KHÔNG xác nhận → vẫn loại", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, "2202");
  arbiterVerdict = { ma_danh_bo: "99999999999", do_tin_cay: 0.4, ly_do: "đoán" };
  const r = await verifyDanhBoFromSession(cs);
  assert.notEqual(r.action, "confirm");
});

await test("fetchBilling trả ma_danh_bo thật, KHÔNG để lọt chữ 'undefined'", async () => {
  // Bug thật: message "Mã danh bộ undefined, Kỳ 7/2026: 18 m³..." làm model kết
  // luận tra cứu hỏng và nói với khách là mã sai, dù tool đã trả success.
  const cs = { _logger: _logStub, danhBo: { value: DANH_BO_DUNG, confirmed: true } };
  const out = JSON.parse(await dispatchTool("get_water_usage", {}, cs));
  assert.equal(out.success, true);
  assert.ok(!/undefined/.test(out.message), `message không được chứa "undefined": ${out.message}`);
  // Handler KHÔNG còn đọc lại mã danh bộ trong mỗi câu trả lời (đỡ rườm rà cho
  // khách), nhưng fetchBilling vẫn phải trả ma_danh_bo — nếu thiếu, chuỗi
  // "Mã danh bộ undefined" quay lại và model sẽ tưởng tra cứu hỏng.
  assert.ok(out.message.length > 0, "phải có nội dung trả cho khách");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Đọc tách nhiều hơi] dựng lại cuộc rtc_u2_E5hhmAHqS8cDGvUnCph0x");

await test("CHƯA đủ 11 số → KHÔNG gọi trọng tài, KHÔNG reset phiên", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, "Số danh bộ là 2202"); // 4/11
  const r = await verifyDanhBoFromSession(cs);   // mặc định: không chấp nhận thiếu số
  assert.equal(r.action, "chua_du_so", "mới 4/11 số thì phải chờ, không phán quyết");
  assert.equal(arbiterCalls, 0, "không được đốt token gpt-5.1 khi biết chắc là thiếu số");
  assert.equal(ensureDanhBoSession(cs).digits, "2202", "số đã gom phải được GIỮ NGUYÊN");
  assert.equal(ensureDanhBoSession(cs).requestNo, 1, "không được mở lượt yêu cầu mới");
});

await test("KỊCH BẢN ĐỌC 3 HƠI — gom trọn rồi mới chốt, không cắt ngang", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, "Số danh bộ là 2202");   // 4/11
  assert.equal((await verifyDanhBoFromSession(cs)).action, "chua_du_so");
  noteDanhBoTranscript(cs, "Ba hai năm một.");      // 8/11
  assert.equal((await verifyDanhBoFromSession(cs)).action, "chua_du_so");
  assert.equal(ensureDanhBoSession(cs).requestNo, 1, "suốt quá trình chỉ là MỘT lượt yêu cầu");

  noteDanhBoTranscript(cs, "7755.");                // 12/11 → đủ, chốt
  arbiterVerdict = { ma_danh_bo: DANH_BO_DUNG, do_tin_cay: 0.8, ly_do: "ghép 3 hơi" };
  const r = await verifyDanhBoFromSession(cs);
  assert.equal(r.action, "confirm", "gom đủ 3 hơi rồi thì phải chốt được");
  assert.equal(r.value, DANH_BO_DUNG);
});

await test("khách đang đọc dở: tool chỉ báo 'em đang nghe', KHÔNG hướng dẫn đọc tiếp", async () => {
  // Khách không biết hệ thống nghe được tới đâu, mà chỗ nối giữa hai hơi đọc lại
  // đúng là chỗ ASR hay sai nhất → tuyệt đối không hỏi "đọc tiếp từ số nào".
  const cs = { _logger: _logStub };
  noteDanhBoTranscript(cs, "2263251"); // 7/11
  const out = JSON.parse(await dispatchTool("get_payment_status", { ma_danh_bo: "13432" }, cs));
  assert.equal(out.dang_gom_so, true);
  assert.ok(!/đọc tiếp/i.test(out.doc_cho_khach), `KHÔNG được bảo đọc tiếp: "${out.doc_cho_khach}"`);
  assert.ok(!/đọc lại/i.test(out.doc_cho_khach), `KHÔNG được bảo đọc lại: "${out.doc_cho_khach}"`);
  assert.equal(ensureDanhBoSession(cs).digits, "2263251", "số đã gom phải còn nguyên");
});

await test("khách ngưng đọc mà vẫn thiếu số → mời đọc lại TRỌN VẸN (reset phiên)", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, "2263251"); // 7/11
  arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.1, ly_do: "thiếu số" };
  const r = await verifyDanhBoFromSession(cs, { chapNhanThieuSo: true });
  assert.equal(r.action, "reread");
  assert.ok(/đọc lại đầy đủ/i.test(r.prompt), `phải mời đọc lại TRỌN VẸN: "${r.prompt}"`);
  assert.equal(ensureDanhBoSession(cs).digits, "", "sang lượt mới → phiên reset");
  assert.equal(ensureDanhBoSession(cs).requestNo, 2);
});

await test("nhiều lần đọc ĐẦY ĐỦ đều được giữ trong biến 1 cho trọng tài đối chiếu", async () => {
  const cs = {};
  // Dùng các dãy KHÔNG có trong hệ thống để chắc chắn rơi vào nhánh mời đọc lại.
  noteDanhBoTranscript(cs, "12345678901");  // lần đọc 1
  arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.1, ly_do: "bí" };
  const r0 = await verifyDanhBoFromSession(cs, { chapNhanThieuSo: true });
  assert.equal(r0.action, "reread", "không chốt được → phải sang lượt đọc lại");
  noteDanhBoTranscript(cs, "12345678101");  // lần đọc 2 (lệch 1 vị trí)
  noteDanhBoTranscript(cs, "12345678701");  // lần đọc 3

  assert.equal(cs._danhBoTranscripts.length, 3,
    "cả 3 lần đọc đầy đủ phải còn trong kho quan sát để gpt-5.1 bỏ phiếu theo vị trí");
  assert.equal(ensureDanhBoSession(cs).turns.length, 2, "biến 2 chỉ chứa lượt của phiên hiện tại");
});

await test("khách đọc thêm trong lúc trọng tài chạy → bỏ phán quyết lỗi thời", async () => {
  const cs = {};
  noteDanhBoTranscript(cs, "12345678901"); // 11 số, đủ để chạy verify
  arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.1, ly_do: "bí" };
  const p = verifyDanhBoFromSession(cs);
  noteDanhBoTranscript(cs, "999");         // khách đọc thêm ngay lúc đang chờ
  const r = await p;
  assert.equal(r.action, "none", "phán quyết dựa trên dữ liệu cũ phải bị bỏ");
  assert.equal(ensureDanhBoSession(cs).requestNo, 1, "không được reset phiên vì kết quả cũ");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Chỉ dẫn tồn dư] cuộc rtc_u2_E66xM4TYW8qxz07ijdLzB");

await test("`message` của luồng danh bộ KHÔNG được ra lệnh đọc nguyên văn", async () => {
  // `message` nằm lại VĨNH VIỄN trong hội thoại (nội dung function_call_output).
  // Nếu nó chứa 'Đọc NGUYÊN VĂN "doc_cho_khach"' thì model bám vào đó ở MỌI lượt
  // sau: cuộc E66xM4TY đã chốt đúng mã, code gửi câu đọc lại xác nhận, model vẫn
  // đòi khách "đọc lại mã danh bộ" 3 lượt liền rồi khách cúp máy.
  // Cuộc E66uZSbb (không có tool call nào trong giai đoạn thu số) thì đọc đúng ngay.
  const cs = { _logger: _logStub };
  const cacPayload = [];

  cacPayload.push(JSON.parse(await dispatchTool("get_bill", { ma_danh_bo: "" }, cs)));   // xin số
  noteDanhBoTranscript(cs, "2202");
  cacPayload.push(JSON.parse(await dispatchTool("get_bill", { ma_danh_bo: "2202" }, cs))); // đang gom
  noteDanhBoTranscript(cs, "3251775");
  cacPayload.push(JSON.parse(await dispatchTool("get_bill", { ma_danh_bo: "" }, cs)));   // đang xác minh

  for (const p of cacPayload) {
    assert.ok(p.message, "payload nào cũng phải có message");
    assert.ok(!/đọc nguyên văn/i.test(p.message),
      `message KHÔNG được ra lệnh đọc nguyên văn (nó tồn dư mãi trong hội thoại): "${p.message}"`);
    assert.ok(/hệ thống (sẽ )?tự/i.test(p.message),
      `message phải nói rõ hệ thống tự phát câu thoại: "${p.message}"`);
  }
});

await test("guard: dãy khách đã BÁO SAI không được đề xuất lại", async () => {
  const cs = { _danhBoRejected: [DANH_BO_DUNG] };
  noteDanhBoTranscript(cs, DANH_BO_DUNG);
  arbiterVerdict = { ma_danh_bo: null, do_tin_cay: 0.1, ly_do: "bí" };
  const r = await verifyDanhBoFromSession(cs);
  assert.notEqual(r.action, "confirm", "không được đề xuất lại dãy đã bị bác");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Cổng tool — mức B] tool phải trả NGAY, không chặn");

await test("model bịa số khi khách chưa nói gì → trả <2s, bỏ số, KHÔNG leo thang sớm", async () => {
  const cs = { _logger: _logStub };
  const t0 = Date.now();
  const a = JSON.parse(await dispatchTool("get_payment_status", { ma_danh_bo: "725625" }, cs));
  const b = JSON.parse(await dispatchTool("get_payment_status", { ma_danh_bo: "320325175" }, cs));
  const ms = Date.now() - t0;

  assert.ok(ms < 2000, `2 tool call phải xong dưới 2s, thực tế ${ms}ms`);
  assert.equal(a.invalid_danh_bo, true);
  assert.equal(b.invalid_danh_bo, true);
  assert.ok(!b.moi_bam_phim, "khách chưa đọc số lần nào → chưa được nhảy sang bấm phím");
  assert.deepEqual(cs._danhBoReads ?? [], [], "số bịa KHÔNG được lọt vào kho quan sát của trọng tài");
  assert.equal(cs._hallucinationCount, 2);
  assert.equal(ensureDanhBoSession(cs).requestNo, 1, "gọi tool nhiều lần không được thổi phồng requestNo");
});

await test("khách ĐÃ đọc số rồi mà model vẫn bịa 2 lần → mời bấm phím", async () => {
  const cs = { _logger: _logStub };
  noteDanhBoTranscript(cs, "Số danh bộ là 2200");
  await dispatchTool("get_payment_status", { ma_danh_bo: "725625" }, cs);
  const b = JSON.parse(await dispatchTool("get_payment_status", { ma_danh_bo: "320325175" }, cs));
  assert.equal(b.moi_bam_phim, true);
});

await test("đang gom dở → tool trả dang_gom_so ngay, không hỏi lại từ đầu", async () => {
  const cs = { _logger: _logStub };
  noteDanhBoTranscript(cs, "2200325"); // 7 số
  const t0 = Date.now();
  const r = JSON.parse(await dispatchTool("get_bill", { ma_danh_bo: "2200325" }, cs));
  assert.ok(Date.now() - t0 < 2000, "không được chặn chờ khách đọc tiếp");
  assert.equal(r.dang_gom_so, true);
  assert.equal(r.da_nghe, 7);
});

await test("khách ĐỌC LẠI số trong lúc đang chờ xác nhận → mở phiên mới sạch, không tràn số", async () => {
  // Cuộc rtc_u2_E7XpOB5fmY21Hm4L28mXW (31/07/2026): sau khi bot đọc lại mã để
  // xác nhận, khách không nói "đúng/sai" mà tự đọc lại toàn bộ 11 số từ đầu.
  // Trước fix, session-ws.js cộng dồn lượt đọc lại này vào `_danhBoSession` CŨ
  // (chưa reset vì mới chuyển sang chờ xác nhận, không phải "mời đọc lại") →
  // tràn số (12 cũ + 11 mới = 23/11), rồi mô phỏng lại đây bằng chính các hàm
  // session-ws.js gọi khi coi đây là phủ định ngầm.
  const cs = { _logger: _logStub };
  startDanhBoRequest(cs, "bot xin mã");
  noteDanhBoTranscript(cs, "Số danh bộ là 2202 3251 977."); // 11 số, ứng viên ban đầu
  assert.equal(ensureDanhBoSession(cs).digits.length, 11);

  // Có ứng viên đang chờ xác nhận (mô phỏng đường nền đã chốt + đang chờ khách).
  cs.danhBo = { value: "22023251977", confirmed: false };

  // Khách đọc lại toàn bộ số (không nói đúng/sai) → session-ws.js coi là phủ
  // định ngầm: reject ứng viên cũ + mở phiên mới TRƯỚC khi ghi nhận lượt đọc.
  noteDanhBoRejected(cs);
  startDanhBoRequest(cs, "khách đọc lại trong lúc đang chờ xác nhận");
  const s = noteDanhBoTranscript(cs, "Số danh bộ là 2202 3251 775.");

  assert.equal(cs.danhBo, null, "ứng viên pending phải bị huỷ, không giữ lại số cũ");
  assert.equal(s.digits, "22023251775", "phiên MỚI chỉ chứa số vừa đọc lại, không lẫn số cũ (tránh tràn 23/11)");
  assert.equal(s.requestNo, 2, "phải tính là một lượt yêu cầu mới, đúng cảm nhận của khách");
});

console.log(`\nTổng cộng: ${passed} test đạt${process.exitCode ? " — CÓ TEST HỎNG" : ""}\n`);
