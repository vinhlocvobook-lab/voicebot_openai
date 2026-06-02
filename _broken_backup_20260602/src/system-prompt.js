/**
 * system-prompt.js
 * System prompt cho OpenAI Realtime session – Tổng đài CSKH Cấp nước Trung An.
 */
// ═══════════════════════════════════════════════════════════════
// PROMPT TEST MODE – chỉ test tool verify_customer
// Khi test xong, uncomment SYSTEM_PROMPT_FULL bên dưới
// ═══════════════════════════════════════════════════════════════
export const SYSTEM_PROMPT = `
Bạn là trợ lý AI của tổng đài Cấp nước Trung An, hỗ trợ cung cấp thông tin cho các yêu cầu của khách hàng. Nói tiếng Việt, rõ ràng, lịch sự.
`;





export const TOOLS = [


  {
    type: "function",
    name: "get_bill",
    description: "Tra cứu hóa đơn tiền nước tháng hiện tại của khách hàng. Phải verify_customer trước.",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: { type: "string", description: "Mã danh bộ đã xác thực" },
      },
      required: ["ma_danh_bo"],
    },
  },

  {
    type: "function",
    name: "get_outages",
    description: `
    - Mục tiêu là hỗ trợ khách hàng biết khu vực của khách hàng có đang bị gián đoạn cung cấp nước hay không. 
    - Cần hỏi thông tin số danh bộ của khách (ma_danh_bo) để kiểm tra.
    - Bạn cần đọc lại số danh bộ của Khách hàng (từng số), một cách chậm rãi và rõ ràng,  để xác nhận lại với khách hàng trước khi gọi tool.`,
    properties: {
      ma_danh_bo: { type: "string", description: "Mã danh bộ đã xác thực" },
    },
    required: ["ma_danh_bo"],
  },
  {
    type: "function",
    name: "create_ticket",
    description: "Tạo phiếu tiếp nhận phản ánh sự cố hoặc khiếu nại ban đầu.",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: {
          type: "string",
          description: "Mã danh bộ khách hàng (nếu đã xác thực, nếu không để trống)",
        },
        loai: {
          type: "string",
          enum: ["su_co", "phan_anh", "khan_cap"],
          description: "Loại phiếu: su_co (sự cố thường), phan_anh (phản ánh), khan_cap (sự cố ngoài giờ sau 22h)",
        },
        mo_ta: {
          type: "string",
          description: "Mô tả ngắn gọn vấn đề khách hàng phản ánh",
        },
        khu_vuc: {
          type: "string",
          description: "Địa chỉ hoặc khu vực xảy ra sự cố",
        },
      },
      required: ["loai", "mo_ta"],
    },
  },
  {
    type: "function",
    name: "get_procedure_info",
    description: "Lấy hướng dẫn thủ tục hành chính: đăng ký định mức nước, lắp đặt đồng hồ, sang tên, nâng/dời đồng hồ.",
    parameters: {
      type: "object",
      properties: {
        loai_thu_tuc: {
          type: "string",
          enum: ["dinh_muc_nuoc", "lap_dat_dong_ho", "sang_ten_dong_ho", "nang_doi_dong_ho"],
          description: "Loại thủ tục cần hướng dẫn",
        },
        doi_tuong: {
          type: "string",
          enum: ["ho_gia_dinh", "doanh_nghiep"],
          description: "Đối tượng áp dụng (nếu thủ tục có phân biệt)",
        },
      },
      required: ["loai_thu_tuc"],
    },
  },
  {
    type: "function",
    name: "transfer_to_agent",
    description: "Chuyển cuộc gọi sang tổng đài viên (người thật). Dùng khi khách yêu cầu hoặc vượt quá khả năng AI.",
    parameters: {
      type: "object",
      properties: {
        ly_do: {
          type: "string",
          description: "Lý do chuyển máy (để log nội bộ)",
        },
      },
      required: ["ly_do"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "Kết thúc cuộc gọi sau khi đã hỗ trợ xong và chào tạm biệt khách hàng.",
    parameters: {
      type: "object",
      properties: {
        ly_do: { type: "string", description: "Lý do kết thúc" },
      },
    },
  },
];
// ═══════════════════════════════════════════════════════════════
// SYSTEM_PROMPT_FULL – dùng khi đã test tool xong
// ═══════════════════════════════════════════════════════════════
export const SYSTEM_PROMPT_FULL = `
Bạn là trợ lý AI của Tổng đài Chăm sóc Khách hàng - Công ty Cổ phần Cấp nước Trung An.
Bạn nói tiếng Việt, giọng thân thiện, lịch sự và rõ ràng.

## Quy trình khi bắt đầu cuộc gọi
1. Chào hỏi ngắn gọn, giới thiệu bản thân là AI.
2. Hỏi khách hàng cần hỗ trợ gì.
3. Nếu yêu cầu cần thông tin cá nhân: yêu cầu mã danh bộ (11 chữ số) để xác thực.
4. Xác thực tối đa 2 lần. Sai 2 lần → chuyển tổng đài viên.

## Các việc bạn CÓ THỂ làm
- Tra cứu tiền nước → verify_customer rồi get_bill
- Tra cứu lượng nước → verify_customer rồi get_water_usage
- Thông báo cúp nước → get_outages (không cần xác thực)
- Tiếp nhận sự cố → create_ticket
- Hướng dẫn thủ tục → get_procedure_info (không cần xác thực)
- Chuyển tổng đài viên → transfer_to_agent
- Kết thúc cuộc gọi → end_call

## Quy tắc quan trọng
- Luôn verify_customer trước get_bill và get_water_usage.
- Mã danh bộ là chuỗi 11 chữ số. Nếu khách đọc từng số, ghép lại trước khi gọi tool.
- Không bịa đặt thông tin. Không tranh chấp hóa đơn.
- Sau 22h: không chuyển tổng đài viên, chỉ nhận sự cố khẩn cấp.
`;
// Tôi là An, trợ lý AI của Công ty. Tôi có thể hỗ trợ Quý khách tra cứu tiền nước,
export const TOOLS_FULL = [
  {
    type: "function",
    name: "verify_customer",
    description: "Xác thực khách hàng bằng mã danh bộ (mã khách hàng). Phải gọi trước khi tra cứu dữ liệu cá nhân.",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: {
          type: "string",
          description: "Mã danh bộ (số danh bộ) do khách cung cấp. Đây là chuỗi gồm đúng 11 chữ số, ví dụ: 12345678901. Nếu khách đọc từng chữ số, hãy ghép lại thành chuỗi 11 số trước khi truyền vào.",
        },
      },
      required: ["ma_danh_bo"],
    },
  },
  {
    type: "function",
    name: "get_bill",
    description: "Tra cứu hóa đơn tiền nước tháng hiện tại của khách hàng. Phải verify_customer trước.",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: { type: "string", description: "Mã danh bộ đã xác thực" },
      },
      required: ["ma_danh_bo"],
    },
  },
  {
    type: "function",
    name: "get_water_usage",
    description: "Tra cứu lượng nước sử dụng và so sánh với tháng trước. Phải verify_customer trước.",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: { type: "string", description: "Mã danh bộ đã xác thực" },
      },
      required: ["ma_danh_bo"],
    },
  },
  {
    type: "function",
    name: "get_outages",
    description: "Lấy danh sách thông báo gián đoạn cung cấp nước / lịch cúp nước bảo trì hiện tại.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "create_ticket",
    description: "Tạo phiếu tiếp nhận phản ánh sự cố hoặc khiếu nại ban đầu.",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: {
          type: "string",
          description: "Mã danh bộ khách hàng (nếu đã xác thực, nếu không để trống)",
        },
        loai: {
          type: "string",
          enum: ["su_co", "phan_anh", "khan_cap"],
          description: "Loại phiếu: su_co (sự cố thường), phan_anh (phản ánh), khan_cap (sự cố ngoài giờ sau 22h)",
        },
        mo_ta: {
          type: "string",
          description: "Mô tả ngắn gọn vấn đề khách hàng phản ánh",
        },
        khu_vuc: {
          type: "string",
          description: "Địa chỉ hoặc khu vực xảy ra sự cố",
        },
      },
      required: ["loai", "mo_ta"],
    },
  },
  {
    type: "function",
    name: "get_procedure_info",
    description: "Lấy hướng dẫn thủ tục hành chính: đăng ký định mức nước, lắp đặt đồng hồ, sang tên, nâng/dời đồng hồ.",
    parameters: {
      type: "object",
      properties: {
        loai_thu_tuc: {
          type: "string",
          enum: ["dinh_muc_nuoc", "lap_dat_dong_ho", "sang_ten_dong_ho", "nang_doi_dong_ho"],
          description: "Loại thủ tục cần hướng dẫn",
        },
        doi_tuong: {
          type: "string",
          enum: ["ho_gia_dinh", "doanh_nghiep"],
          description: "Đối tượng áp dụng (nếu thủ tục có phân biệt)",
        },
      },
      required: ["loai_thu_tuc"],
    },
  },
  {
    type: "function",
    name: "transfer_to_agent",
    description: "Chuyển cuộc gọi sang tổng đài viên (người thật). Dùng khi khách yêu cầu hoặc vượt quá khả năng AI.",
    parameters: {
      type: "object",
      properties: {
        ly_do: {
          type: "string",
          description: "Lý do chuyển máy (để log nội bộ)",
        },
      },
      required: ["ly_do"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "Kết thúc cuộc gọi sau khi đã hỗ trợ xong và chào tạm biệt khách hàng.",
    parameters: {
      type: "object",
      properties: {
        ly_do: { type: "string", description: "Lý do kết thúc" },
      },
    },
  },
];
