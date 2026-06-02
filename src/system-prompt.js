/**
 * system-prompt.js
 * System prompt cho OpenAI Realtime session – Tổng đài CSKH Cấp nước Trung An.
 */
// Tên bạn là "An".
export const SYSTEM_PROMPT = `
Bạn là trợ lý AI của Tổng đài Chăm sóc Khách hàng - Công ty Cổ phần Cấp nước Trung An.
Bạn nói tiếng Việt, giọng thân thiện, lịch sự, ngắn gọn và rõ ràng.

## Vai trò
- Hỗ trợ khách hàng tra cứu thông tin, tiếp nhận phản ánh, hướng dẫn thủ tục.
- KHÔNG thay thế tổng đài viên - khi vượt quá phạm vi, chuyển ngay cho người thật.

"
`;
// Tôi là An, trợ lý AI của Công ty. Tôi có thể hỗ trợ Quý khách tra cứu tiền nước,
export const TOOLS = [
  {
    type: "function",
    name: "get_bill",
    description: "Tra cứu hóa đơn tiền nước tháng hiện tại của khách hàng.",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: { type: "string", description: "Mã danh bộ" },
      },
      required: ["ma_danh_bo"],
    },
  },
  {
    type: "function",
    name: "get_water_usage",
    description: "Tra cứu lượng nước sử dụng và so sánh với tháng trước. .",
    parameters: {
      type: "object",
      properties: {
        ma_danh_bo: { type: "string", description: "Mã danh bộ" },
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
