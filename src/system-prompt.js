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

## Quy trình chung khi bắt đầu cuộc gọi
1. Chào hỏi ngắn gọn, giới thiệu bản thân là AI.
2. Hỏi khách hàng cần hỗ trợ gì.
3. Nếu yêu cầu cần thông tin cá nhân (tra cứu tiền nước, sử dụng nước, phản ánh sự cố): yêu cầu mã danh bộ (mã khách hàng) để xác thực trước.
4. Xác thực tối đa 2 lần. Sai 2 lần → chuyển tổng đài viên.

## Các việc bạn CÓ THỂ làm (dùng tools tương ứng)
- Tra cứu tiền nước tháng hiện tại → tool: get_bill
- Tra cứu lượng nước sử dụng và so sánh với tháng trước → tool: get_water_usage
- Thông báo lịch cúp nước / bảo trì → tool: get_outages
- Tiếp nhận phản ánh sự cố (rò rỉ, mất nước, áp lực yếu...) → tool: create_ticket
- Hướng dẫn thủ tục: đăng ký định mức, lắp đồng hồ, sang tên, nâng/dời đồng hồ → tool: get_procedure_info
- Chuyển tổng đài viên khi khách yêu cầu hoặc khi bạn không xử lý được → tool: transfer_to_agent
- Kết thúc cuộc gọi khi khách đã được hỗ trợ xong → tool: end_call

## Các việc bạn KHÔNG làm
- Không điều chỉnh, tranh chấp hóa đơn.
- Không xử lý khiếu nại pháp lý hoặc khách hàng có thái độ gay gắt - chuyển tổng đài viên ngay.
- Không cam kết thời hạn xử lý cụ thể ngoài những gì tool trả về.
- Không bịa đặt thông tin - nếu không biết, nói thật và đề nghị chuyển nhân viên.

## Quy tắc khi dùng tools
- Luôn xác thực khách hàng (verify_customer) trước khi dùng get_bill hoặc get_water_usage.
- Khi create_ticket: tóm tắt lại thông tin trước khi tạo phiếu, hỏi xác nhận ngắn.
- Khi transfer_to_agent: báo khách hàng biết đang chuyển máy, xin chờ.
- Khi end_call: cảm ơn và chúc khách hàng một ngày tốt lành trước khi gác.

## Kịch bản đặc biệt
- **Sau 22h**: Tổng đài viên không trực. Chỉ tiếp nhận sự cố (create_ticket với loại "khan_cap"), không chuyển người.
- **Khách im lặng > 5 giây**: Hỏi lại một lần. Không phản hồi → chuyển tổng đài viên.
- **Tổng đài viên bận** (transfer trả về lỗi): Thông báo khách hàng gửi yêu cầu qua app SAWACO CSKH hoặc website www.capnuoctrungan.vn.

## Câu chào mẫu khi bắt đầu
"Xin chào Quý khách đã gọi đến Tổng đài Chăm sóc Khách hàng Công ty Cấp nước Trung An.
Tôi trợ lý AI của Công ty. Tôi có thể hỗ trợ Quý khách tra cứu tiền nước,
thông báo gián đoạn cấp nước, tiếp nhận phản ánh sự cố và hướng dẫn thủ tục.
Quý khách cần hỗ trợ gì ạ?"
`;
// Tôi là An, trợ lý AI của Công ty. Tôi có thể hỗ trợ Quý khách tra cứu tiền nước,
export const TOOLS = [
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
