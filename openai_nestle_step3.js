require('dotenv').config();
const { Headers } = require('node-fetch');
if (typeof globalThis.Headers === 'undefined') {
    globalThis.Headers = Headers;
}
const crypto = require('crypto');
if (typeof globalThis.crypto === 'undefined' && crypto.webcrypto) {
    globalThis.crypto = crypto.webcrypto;
}
const fetch = require('node-fetch');
const { OpenAI } = require('openai');
const WebSocket = require('ws');
const express = require("express");
const axios = require('axios');
const router = require("express").Router();

// --- CẤU HÌNH API KEY ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;

if (!OPENAI_API_KEY || !OPENAI_WEBHOOK_SECRET) {
    console.error("❌ Lỗi: Thiếu OPENAI_API_KEY hoặc OPENAI_WEBHOOK_SECRET trong file .env");
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    fetch: fetch
});

const AUTH_HEADER = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`
};

// ==========================================
// 0. DATA: Danh sách 17 lô sữa Nestlé NAN bị thu hồi
// ==========================================
const RECALLED_BATCHES = [
    // NAN INFINIPRO A2 (Bước 1) - 400g
    { code: "51240017A1", product: "NAN INFINIPRO A2 (Số 1) 400g", exp: "24/04/2027" },
    { code: "51590017A3", product: "NAN INFINIPRO A2 (Số 1) 400g", exp: "29/05/2027" },
    { code: "52520017A2", product: "NAN INFINIPRO A2 (Số 1) 400g", exp: "30/08/2027" },
    { code: "52810017A1", product: "NAN INFINIPRO A2 (Số 1) 400g", exp: "28/09/2027" },

    // NAN INFINIPRO A2 (Bước 1, 2, 3) - 800g
    { code: "51250017C2", product: "NAN INFINIPRO A2 (Số 1) 800g", exp: "25/04/2027" },
    { code: "51610017C1", product: "NAN INFINIPRO A2 (Số 1) 800g", exp: "31/05/2027" },
    { code: "51250017C3", product: "NAN INFINIPRO A2 (Số 2) 800g", exp: "25/04/2027" },
    { code: "51250017C4", product: "NAN INFINIPRO A2 (Số 3) 800g", exp: "25/04/2027" },

    // NAN OPTIPRO PLUS (Bước 1) - 800g & 400g
    { code: "51560017C1", product: "NAN OPTIPRO PLUS (Số 1) 800g", exp: "26/05/2027" },
    { code: "51700017C1", product: "NAN OPTIPRO PLUS (Số 1) 800g", exp: "09/06/2027" },
    { code: "51540017A3", product: "NAN OPTIPRO PLUS (Số 1) 400g", exp: "24/05/2027" },
    { code: "51940017A1", product: "NAN OPTIPRO PLUS (Số 1) 400g", exp: "03/07/2027" },
    { code: "51720017A1", product: "NAN OPTIPRO PLUS (Số 1) 400g", exp: "11/06/2027" },

    // NAN OPTIPRO PLUS (Bước 2) - 800g & 400g
    { code: "51560017C2", product: "NAN OPTIPRO PLUS (Số 2) 800g", exp: "26/05/2027" },
    { code: "51700017C2", product: "NAN OPTIPRO PLUS (Số 2) 800g", exp: "09/06/2027" },
    { code: "51540017A5", product: "NAN OPTIPRO PLUS (Số 2) 400g", exp: "24/05/2027" },
    { code: "51720017A2", product: "NAN OPTIPRO PLUS (Số 2) 400g", exp: "11/06/2027" }
];

// ==========================================
// 1. ĐỊNH NGHĨA TOOLS
// ==========================================

// Tool 1: Kiểm tra mã lô
const checkLotCodeTool = {
    type: 'function',
    name: 'checkRecallStatus',
    description: 'Dùng để kiểm tra ngay lập tức xem Mã lô (Lot Code) khách hàng cung cấp có nằm trong danh sách 17 lô sữa bị thu hồi hay không.',
    parameters: {
        type: 'object',
        properties: {
            inputCode: {
                type: 'string',
                description: 'Mã lô sản phẩm khách hàng đọc (bao gồm chữ và số). Ví dụ: 51240017A1',
            }
        },
        required: ['inputCode'],
    },
};

// Tool 2: Lưu thông tin ĐỔI TRẢ (Quan trọng)
const saveProductReturnInfoTool = {
    type: 'function',
    name: 'saveProductReturnInfo',
    description: `Lưu thông tin khách hàng và các sản phẩm cần đổi trả. Yêu cầu đặc biệt: Do sáp nhập đơn vị hành chính, cần hỏi rõ tên Phường/Xã/Quận mới và cũ.`,
    parameters: {
        type: 'object',
        properties: {
            cust_name: { type: 'string', description: 'Tên khách hàng.' },
            phone_number: { type: 'string', description: 'Số điện thoại.' },
            cccd: { type: 'string', description: 'Số Căn cước công dân (CCCD)/Chứng Minh Nhân Dân (CMND).' },
            area: { type: 'string', description: 'Khu vực khách hàng.' },

            // --- CẶP ĐỊA CHỈ (QUAN TRỌNG) ---
            address_new_standard: {
                type: 'string',
                description: 'Địa chỉ đầy đủ theo tên tỉnh/thành phố, phường MỚI (Sau khi sáp nhập).'
            },
            address_old_ref: {
                type: 'string',
                description: 'Tên tỉnh/thành phố, Phường/Xã/Quận CŨ (Trước khi sáp nhập) để tham chiếu tìm đường.'
            },
            health_status: { type: 'string', description: 'Ghi chú nếu bé có dấu hiệu sức khỏe (Nôn, sốt, tiêu chảy...) hoặc ghi "Bình thường".' },
            // --- DANH SÁCH SẢN PHẨM ---
            products: {
                type: 'array',
                description: 'Danh sách các sản phẩm cần đổi trả.',
                items: {
                    type: 'object',
                    properties: {
                        product_type: { type: 'string', enum: ["NAN A2", "NAN Optipro", "Khác"], description: 'Loại sữa.' },
                        product_lot_code: { type: 'string', description: 'Mã lô. (mã sản phẩm)' },
                        product_used_status: { type: 'string', enum: ["Đã sử dụng", "Chưa sử dụng"], description: 'Trạng thái sử dụng.' },
                        product_quantity: { type: 'string', description: 'Số lượng.' },
                    },
                    required: ['product_type', 'product_lot_code', 'product_quantity']
                }
            },

            return_method: { type: 'string', description: 'Phương thức đổi/trả.' },
            note: { type: 'string', description: 'Ghi chú đường đi (gần chợ, trường học...).' }
        },
        // Bắt buộc phải hỏi địa chỉ mới
        required: ['cust_name', 'phone_number', 'address_new_standard', 'products'],
    },
};

// Tool 3: Lưu thông tin hỗ trợ chung
const saveInfoTool = {
    type: 'function',
    name: 'saveRecallInfo',
    description: `Lưu thông tin khách hàng có vấn đề khác cần liên hệ hỗ trợ (không phải đổi trả trực tiếp).`,
    parameters: {
        type: 'object',
        properties: {
            cust_name: { type: 'string', description: 'Tên khách hàng.' },
            cust_cccd: { type: 'string', description: 'Số CCCD/CMND.' },
            cust_area: { type: 'string', description: 'Khu vực khách hàng.' },
            cust_address: { type: 'string', description: 'Địa chỉ khách hàng.' },
            phone_number: { type: 'string', description: 'Số điện thoại liên hệ.' },
            cust_message: { type: 'string', description: 'Lời nhắn hoặc vấn đề của khách hàng.' },
        },
        required: ['cust_name', 'phone_number', 'cust_message'],
    },
};

// Tool 4: Gác máy
const hangUpCallTool = {
    type: 'function',
    name: 'hangUpCallFunc',
    description: 'Dùng để kết thúc cuộc gọi. Chỉ gọi khi khách hàng xác nhận không cần thêm trợ giúp hoặc nói lời tạm biệt.',
    parameters: { type: 'object', properties: {}, required: [] },
};

// ==========================================
// 2. SYSTEM PROMPT
// ==========================================

const gptModel = "gpt-realtime"; // Sử dụng model ổn định cho Realtime

const nestleInstructions = `
### VAI TRÒ
Bạn là Trợ lý AI hỗ trợ khách hàng của Nestlé Việt Nam.
Bối cảnh: Hiện tại đang có đợt thu hồi tự nguyện 17 lô sữa NAN (Infinipro A2 và Optipro Plus). Tuy nhiên, khách hàng vẫn có thể gọi điện vì các vấn đề hỗ trợ thông thường khác.

### NHIỆM VỤ CHÍNH
Nhiệm vụ của bạn là lắng nghe, phân loại nhu cầu khách hàng và xử lý theo đúng quy trình sau:

#### BƯỚC 1: PHÂN LOẠI NHU CẦU & SÀNG LỌC
- Sau khi chào, lắng nghe xem khách hàng cần gì.
- **Trường hợp A (Khẩn cấp):** Khách gọi vì lo lắng sản phẩm lỗi, muốn đổi trả, hoặc đề cập đến vụ thu hồi sữa. -> Chuyển ngay sang **QUY TRÌNH THU HỒI**.
- **Trường hợp B (Thông thường):** Khách hỏi mua hàng, khiếu nại dịch vụ, hỏi cách pha sữa, khuyến mãi... -> Chuyển sang **QUY TRÌNH HỖ TRỢ CHUNG**.

---

#### QUY TRÌNH 1: THU HỒI SẢN PHẨM (Ưu tiên cao)
1. **Sàng lọc y tế (BẮT BUỘC):** Hỏi ngay: "Bé nhà mình có đang gặp vấn đề sức khỏe nào như nôn trớ, tiêu chảy hay sốt không ạ?"
   - Nếu CÓ: Khuyên khách đưa bé đến cơ sở y tế gần nhất trước, cam kết công ty sẽ chịu trách nhiệm nếu do sản phẩm.
   - Nếu KHÔNG: Tiếp tục bước kiểm tra.
2. **Kiểm tra Mã lô:**
   - Yêu cầu khách đọc Mã lô (Lot Code) dưới đáy lon.
   - Gọi hàm \`checkRecallStatus\` để kiểm tra.
   - Nếu kết quả là **SAFE**: Giải thích rõ ràng để khách yên tâm. Nếu khách vẫn muốn trả, chuyển sang bước thu thập.
   - Nếu kết quả là **DANGER**: Trấn an khách và chuyển sang bước thu thập.
3. **Thu thập thông tin đổi trả:**
   - Sử dụng hàm \`saveProductReturnInfo\`.
   - Hỏi đầy đủ các trường thông tin trong hàm (Tên đầy đủ, Số điện thoại, Địa chỉ, Loại sữa, Mã lô (số lô), Số lượng...).
   - Cam kết: "Nhân viên sẽ liên hệ và đến tận nhà để thu hồi sản phẩm trong 3-7 ngày".

4. **THU THẬP ĐỊA CHỈ (Rất quan trọng):**
   - Khi hỏi địa chỉ, hãy giải thích khéo léo: "Do hiện tại nhiều Phường, Xã mới sáp nhập, để nhân viên giao nhận tìm nhà chính xác nhất, anh/chị vui lòng đọc giúp em cả **Tên Phường/Xã Mới** và **Tên Quận/Phường/Xã Cũ** được không ạ?"
   - **Yêu cầu bắt buộc:** Phải cố gắng lấy được cả 2 thông tin:
     + \`address_new_standard\`: Ví dụ "Số 10, Đường A, Phường An Phú (Mới)".
     + \`address_old_ref\`: Ví dụ "Khu vực Quận Bình Tân cũ".
   - Nếu khách nói "Vẫn tên cũ thôi", hãy xác nhận lại: "Dạ, tức là khu mình không bị đổi tên đúng không ạ?".
---

#### QUY TRÌNH 2: HỖ TRỢ CHUNG (Trường hợp còn lại)
1. **Tiếp nhận:** Lắng nghe vấn đề của khách hàng (khiếu nại, tư vấn, mua hàng...).
2. **Ghi nhận:** Thông báo rằng bạn là trợ lý ảo và sẽ ghi nhận lại thông tin để chuyên viên gọi lại.
3. **Thu thập thông tin:**
   - Sử dụng hàm \`saveRecallInfo\` (Dùng cho hỗ trợ chung).
   - Hỏi: Tên, Số điện thoại (nếu chưa có), và Nội dung cần hỗ trợ.
4. **Cam kết:** "Dạ em đã lưu thông tin. Chuyên viên Nestlé sẽ liên hệ lại với anh/chị trong giờ làm việc sớm nhất ạ."

---

#### BƯỚC CUỐI: KẾT THÚC
- Luôn hỏi lịch sự: "Anh/chị còn cần em hỗ trợ thêm vấn đề nào khác không ạ?"
- Nếu khách nói "Không" hoặc "Tạm biệt" -> Gọi hàm \`hangUpCallFunc\` để cúp máy.

### LƯU Ý QUAN TRỌNG
- **Giọng điệu:**
  - Với Quy trình Thu hồi: Ân cần, đồng cảm, nhận trách nhiệm, nghiêm túc.
  - Với Quy trình Hỗ trợ chung: Vui vẻ, nhiệt tình, nhanh nhẹn.
- **Xử lý Mã lô:** Khi khách đọc mã gồm cả chữ và số, hãy kiên nhẫn lắng nghe. Nếu không nghe rõ, hãy nhờ khách đọc lại từng ký tự.
`;

const callAccept = {
    "type": "realtime",
    "instructions": nestleInstructions,
    "model": gptModel,
    "tools": [checkLotCodeTool, saveProductReturnInfoTool, saveInfoTool, hangUpCallTool],
    "audio": { "input": { "transcription": { "model": "gpt-4o-mini-transcribe", "language": "vi" } } }
};

// ==========================================
// 3. CÁC HÀM XỬ LÝ (MOCK DATABASE)
// ==========================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Hàm 1: Logic kiểm tra mã lô
 */
async function checkRecallStatus(inputCode) {
    console.log(`🔍 [CHECK] Đang kiểm tra mã lô: "${inputCode}"`);

    if (!inputCode) return "Vui lòng đọc mã lô để kiểm tra.";

    // Chuẩn hóa: Xóa ký tự đặc biệt, chuyển in hoa
    const cleanCode = inputCode.toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    console.log(`   -> Mã chuẩn hóa: ${cleanCode}`);

    const foundItem = RECALLED_BATCHES.find(item => item.code === cleanCode);

    if (foundItem) {
        return JSON.stringify({
            status: "DANGER",
            message: `CẢNH BÁO: Mã ${cleanCode} nằm trong danh sách THU HỒI. Sản phẩm: ${foundItem.product}, HSD: ${foundItem.exp}. Khuyên khách NGƯNG SỬ DỤNG NGAY.`
        });
    } else {
        return JSON.stringify({
            status: "SAFE",
            message: `Mã ${cleanCode} KHÔNG nằm trong danh sách thu hồi. Sản phẩm an toàn. Trấn an khách hàng.`
        });
    }
}

/**
 * Hàm 2: Logic lưu phiếu đổi trả (Giả lập)
 */
/**
 * Hàm 2: Logic lưu phiếu đổi trả (Đã sửa để khớp với Tool mới)
 */
async function saveProductReturnInfo(data) {
    console.log("\n========================================");
    console.log("🇻🇳 [MOCK DB] LƯU PHIẾU THU HỒI (FINAL)");
    console.log("========================================");
    console.log(`👤 Khách hàng   : ${data.cust_name || "N/A"} | SĐT: ${data.phone_number || "N/A"}`);
    console.log(`🆔 CCCD/CMND    : ${data.cccd || "N/A"}`); // Lưu ý: Trong Tool bạn đặt là 'cccd', không phải 'cust_cccd'
    console.log(`🏠 Khu vực      : ${data.area || "N/A"}`);
    console.log(`🏥 Sức khỏe     : ${data.health_status || "Bình thường"}`);

    // --- LOGIC ĐỊA CHỈ KÉP ---
    console.log("📍 ĐỊA CHỈ THU HỒI:");
    console.log(`   ✅ Đ/C MỚI (Xe đến) : ${data?.address_new_standard}`);

    if (data?.address_old_ref) {
        console.log(`   🏚️ Đ/C CŨ (Tham chiếu): ${data?.address_old_ref}`);
    } else {
        console.log(`   ⚠️ Note: Khách không cung cấp địa chỉ cũ.`);
    }

    if (data.note) {
        console.log(`   📝 Chỉ dẫn đường      : ${data?.note}`);
    }

    // --- SẢN PHẨM (Xử lý mảng) ---
    if (data.products && Array.isArray(data.products) && data.products.length > 0) {
        console.log("📦 DANH SÁCH HÀNG HÓA:");
        data.products.forEach((item, i) => {
            console.log(`   [${i + 1}] ${item?.product_type} | Lô: ${item?.product_lot_code} | SL: ${item?.product_quantity}`);
            if (item?.product_used_status) console.log(`       -> Trạng thái: ${item?.product_used_status}`);
            console.log(`       -> NSX: ${item?.product_production_date}`);
            console.log(`       -> HSD: ${item?.product_expiry_date}`);
        });
    } else {
        console.log("⚠️ CẢNH BÁO: Không có dữ liệu sản phẩm nào được gửi về!");
    }

    console.log(`🔄 Phương thức: ${data?.return_method}`);
    console.log("========================================\n");

    await delay(500);
    // Tính tổng số lượng để phản hồi cho tự nhiên
    const totalQty = data.products ? data.products.reduce((acc, curr) => acc + parseInt(curr.product_quantity || 0), 0) : 0;
    return `Đã lưu phiếu thu hồi thành công tại địa chỉ ${data.address_new_standard}. Tổng số lượng: ${totalQty} sản phẩm.`;
}
async function saveProductReturnInfo_old1(data) {
    console.log("\n========================================");
    console.log("🇻🇳 [MOCK DB] LƯU PHIẾU THU HỒI (ĐỊA CHỈ SÁP NHẬP)");
    console.log("========================================");
    console.log(`👤 Khách hàng   : ${data?.cust_name} | SĐT: ${data?.phone_number}`);
    console.log(`🆔 CCCD        : ${data?.cust_cccd}`);
    console.log(`🏠 Khu vực     : ${data?.area}`);
    console.log(`🏥 Sức khỏe    : ${data?.health_status}`);

    // --- LOGIC ĐỊA CHỈ KÉP ---
    console.log("📍 ĐỊA CHỈ THU HỒI:");
    console.log(`   ✅ Theo tên MỚI : ${data?.address_new_standard}`);

    if (data?.address_old_ref) {
        console.log(`   phụ lục (Tên CŨ) : ${data?.address_old_ref}`);
    } else {
        console.log(`   ⚠️ Cảnh báo     : Khách chưa cung cấp tên Phường/Xã cũ.`);
    }

    // --- SẢN PHẨM ---
    if (data.products && Array.isArray(data.products)) {
        console.log("📦 HÀNG HÓA:");
        data.products.forEach((item, i) => {
            console.log(`   ${i + 1}. ${item?.product_type} - Lô: ${item?.product_lot_code} - SL: ${item?.product_quantity} `);
            console.log(`   NSX: ${item?.product_production_date} - HSD: ${item?.product_expiry_date}`);
            console.log(`   Tình trạng sử dụng: ${item?.product_used_status}`);
        });
    }
    console.log("========================================\n");

    await delay(500);
    return `Đã lưu thông tin thu hồi thành công.`;
}
async function saveProductReturnInfo_old(data) {
    // data là object chứa tất cả tham số
    console.log("\n========================================");
    console.log("📝 [MOCK DB] LƯU PHIẾU ĐỔI TRẢ THÀNH CÔNG");
    console.log("========================================");
    console.log(`👤 Khách hàng  : ${data.cust_name} (${data.phone_number})`);
    console.log(`🏠 Địa chỉ     : ${data.cust_address}`);
    console.log(`🆔 CCCD        : ${data.cust_cccd}`);
    console.log(`🍼 Sản phẩm    : ${data.product_type} - Lô: ${data.product_lot_code}`);
    console.log(`📅 NSX/HSD     : ${data.product_production_date} - ${data.product_expiry_date}`);
    console.log(`📦 Số lượng    : ${data.product_quantity}`);
    console.log(`🔄 Hình thức   : ${data.return_method}`);
    console.log(`🏥 Sức khỏe    : ${data.health_status}`);
    console.log(`📝 Ghi chú     : ${data.note}`);
    console.log("========================================\n");

    await delay(500); // Giả lập độ trễ DB
    return `Đã lưu phiếu đổi trả cho lô ${data.product_lot_code} thành công.`;
}

/**
 * Hàm 3: Logic lưu thông tin hỗ trợ khác (Giả lập)
 */
async function saveRecallInfo(data) {
    console.log("\n----------------------------------------");
    console.log("☎️ [MOCK DB] LƯU YÊU CẦU HỖ TRỢ CHUNG");
    console.log(`👤 Khách hàng: ${data.cust_name} - ${data.phone_number}`);
    console.log(`💬 Lời nhắn  : ${data.cust_message}`);
    console.log("----------------------------------------\n");

    await delay(300);
    return "Đã ghi nhận yêu cầu hỗ trợ thành công.";
}

// Các hàm điều khiển cuộc gọi
async function answerCall(callId) {
    const acceptUrl = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
    let accepted = false;
    for (let i = 0; i < 3; i++) {
        try {
            await axios.post(acceptUrl, callAccept, { headers: AUTH_HEADER });
            console.log(`📞 [${callId}] Đã chấp nhận cuộc gọi.`);
            accepted = true;
            break;
        } catch (error) {
            console.error(`⚠️ [${callId}] Lỗi accept call:`, error.message);
            await delay(1000);
        }
    }
    return accepted;
}

async function hangupCall(callId) {
    const hangupUrl = `https://api.openai.com/v1/realtime/calls/${callId}/hangup`;
    try {
        await axios.post(hangupUrl, {}, { headers: AUTH_HEADER });
        console.log(`📴 [${callId}] Đã gác máy.`);
    } catch (error) {
        console.error(`⚠️ [${callId}] Lỗi gác máy:`, error.message);
    }
}

// ==========================================
// 4. WEBSOCKET TASK (Xử lý Realtime)
// ==========================================

async function websocketTask(callId, initialGreeting) {
    console.log(`🔗 [${callId}] Bắt đầu kết nối WebSocket...`);
    const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${callId}`;
    const ws = new WebSocket(wsUrl, { headers: AUTH_HEADER });

    let isHangupRequested = false;

    ws.on('open', () => {
        console.log(`✅ [${callId}] WS Connected.`);
        // Gửi lời chào đầu tiên
        ws.send(JSON.stringify({
            "type": "response.create",
            "response": {
                "instructions": `Wait 1 second then say politely: '${initialGreeting}'`
            },
        }));
    });

    ws.on('message', async (message) => {
        const msg = JSON.parse(message.toString());
        const type = msg?.type;

        // Log các sự kiện quan trọng để debug
        if (type === "conversation.item.done") {
            console.log(`[OpenAi - ${type}] Câu trả lời đã được thêm vào conversation`);
            console.log(msg?.item?.content);
            if (msg?.item?.content === "undefined") {
                console.log(msg);
            }
        }
        if (type === "conversation.item.input_audio_transcription.completed") {
            console.log(`🎤 [USER]: ${msg.transcript}`);
        }

        if (type === "response.done") {
            const response_done_usage = msg?.response?.usage;
            console.log(`[${callId}] : response.done usage:`, response_done_usage);
            const output = msg?.response?.output;
            if (!output || output.length === 0) return;

            const item = output[0];

            if (item?.type === "function_call") {
                const call_id = item.call_id;
                const name = item.name;
                const argsStr = item.arguments;
                console.log(`🤖 [AI] Gọi hàm: ${name}`);

                try {
                    const args = JSON.parse(argsStr);
                    let functionResult = "";

                    switch (name) {
                        case "checkRecallStatus":
                            functionResult = await checkRecallStatus(args.inputCode);
                            break;

                        case "saveProductReturnInfo":
                            // Gọi hàm Mock DB
                            // functionResult = await saveProductReturnInfo({
                            //     cust_name: args.cust_name,
                            //     cust_cccd: args.cust_cccd || "N/A",
                            //     cust_address: args.cust_address,
                            //     phone_number: args.phone_number,
                            //     product_type: args.product_type,
                            //     product_lot_code: args.product_lot_code,
                            //     product_production_date: args.product_production_date || "N/A",
                            //     product_expiry_date: args.product_expiry_date || "N/A",
                            //     product_quantity: args.product_quantity,
                            //     return_method: args.return_method,
                            //     health_status: args.health_status || "Bình thường",
                            //     note: args.note || ""
                            // });
                            functionResult = await saveProductReturnInfo(args);
                            break;

                        case "saveRecallInfo":
                            functionResult = await saveRecallInfo({
                                cust_name: args.cust_name,
                                phone_number: args.phone_number,
                                cust_message: args.cust_message,
                                cust_cccd: args.cust_cccd,
                                cust_area: args.cust_area
                            });
                            break;

                        case "hangUpCallFunc":
                            functionResult = "System is ending the call.";
                            isHangupRequested = true;
                            break;

                        default:
                            console.warn(`⚠️ Hàm ${name} chưa được xử lý!`);
                            functionResult = "Function not implemented.";
                            break;
                    }

                    // Gửi kết quả function về lại cho AI
                    console.log(`📤 Gửi kết quả function ${name} về AI.`);
                    ws.send(JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: call_id,
                            output: functionResult
                        }
                    }));

                    // Trigger AI tạo phản hồi tiếp theo dựa trên kết quả
                    let nextInstructions = "Phản hồi lại khách hàng dựa trên kết quả vừa nhận được.";
                    if (isHangupRequested) {
                        nextInstructions = "Nói lời chào tạm biệt lịch sự và kết thúc.";
                    }

                    ws.send(JSON.stringify({
                        type: "response.create",
                        response: { instructions: nextInstructions }
                    }));

                } catch (err) {
                    console.error("❌ Lỗi xử lý function:", err);
                }
            }
        }

        if (type === "output_audio_buffer.stopped" && isHangupRequested) {
            console.log(`🔌 [${callId}] Thực hiện lệnh ngắt kết nối vật lý...`);
            await hangupCall(callId);
        }
    });

    ws.on('error', (err) => console.error(`❌ [${callId}] WS Error:`, err));
    ws.on('close', () => console.log(`🔒 [${callId}] WS Closed.`));
}

// ==========================================
// 5. SERVER SETUP
// ==========================================

// Helper: Lấy thông tin người gọi (Mock)
async function getCallerInfo(tel) {
    const mockDatabase = {
        "0909000111_1": { name: "Chị Lan", gender: "female" },
        "0909000222_2": { name: "Anh Hùng", gender: "male" }
    };
    return mockDatabase[tel] || null;
}

function generateGreeting(callerInfo) {
    let prefix = "Dạ chào anh/chị";
    if (callerInfo?.name) {
        prefix = `Dạ chào ${callerInfo.name}`;
    }
    return `${prefix}, em là trợ lý AI Nestlé. Em có thể hỗ trợ gì ạ!`;
}

// Router chính
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const event = await openai.webhooks.unwrap(req.body, req.headers, OPENAI_WEBHOOK_SECRET);

        if (event.type === "realtime.call.incoming") {
            const callId = event.data.call_id;
            const fromHeader = event.data.sip_headers.find(h => h.name === 'From');
            let callerId = "Unknown";

            if (fromHeader) {
                const match = fromHeader.value.match(/sip:([^@]+)@/);
                if (match) callerId = match[1];
            }

            console.log(`🔔 [INCOMING] Cuộc gọi mới từ: ${callerId} (Call ID: ${callId})`);

            // Phản hồi 200 OK ngay lập tức cho SIP Server
            res.sendStatus(200);

            // Bắt đầu quy trình xử lý
            const callerInfo = await getCallerInfo(callerId);
            const initialGreeting = generateGreeting(callerInfo);

            const accepted = await answerCall(callId);
            if (accepted) {
                websocketTask(callId, initialGreeting);
            }
        } else {
            // Các sự kiện khác của Webhook
            res.sendStatus(200);
        }
    } catch (error) {
        console.error("❌ Webhook Error:", error.message);
        res.status(500).send("Error");
    }
});

router.get('/webhook', (req, res) => res.json({ status: "Nestle Voice Bot is Running" }));

module.exports = router;