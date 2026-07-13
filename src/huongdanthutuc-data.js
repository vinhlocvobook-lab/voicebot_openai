/**
 * huongdanthutuc-data.js
 * Dữ liệu thủ tục hành chính cho tool get_procedure_info.
 * [11/07/2026] Cập nhật theo docs/huongdanthutuc_20260711.md (kịch bản chính thức):
 * - Định mức nước: phân theo CCCD TP.HCM / CCCD tỉnh khác (CT07/CT08/VNeID).
 * - Gắn đồng hồ hộ gia đình: CCCD chính chủ + 1 trong 3 giấy tờ (rút gọn từ 10).
 * - Gắn đồng hồ & sang tên cho DOANH NGHIỆP: chuyển tổng đài viên (transferToAgent).
 * - Website www.capnuoctrungan.vn chỉ là kênh đăng ký của thủ tục nâng/dời.
 * - Thủ tục NGOÀI danh sách này: chuyển tổng đài viên hoặc tạo phiếu (xử lý ở tools.js).
 *
 * Quy ước requiredDocs:
 * - required: cần ĐẦY ĐỦ tất cả.
 * - options:  chỉ cần MỘT trong số đó.
 * - optional: giấy tờ bổ sung TÙY TRƯỜNG HỢP (không bắt buộc).
 * - note:     chỉ đọc khi không có 3 danh sách trên.
 * Case có transferToAgent: true → không hướng dẫn giấy tờ, mời chuyển tổng đài viên/tạo phiếu.
 */

export const PROCEDURES = {
  dinh_muc_nuoc: {
    id: "dinh_muc_nuoc",
    title: "Đăng ký định mức nước",
    purpose: "Đăng ký số nhân khẩu để được tính định mức nước sinh hoạt theo quy định.",
    // Thủ tục CHỈ dành cho hộ gia đình — tools.js dùng field này để chặn khi
    // khách hỏi cho doanh nghiệp/công ty.
    apDung: "ho_gia_dinh",
    // [11/07/2026] Quy định đối tượng — đồng bộ với huongdanthutuc_20260711.md.
    // Trả về cho AI qua field "quy_dinh" để trả lời "ai được đăng ký / được mấy người".
    quyDinh:
      "Thủ tục đăng ký định mức nước CHỈ áp dụng cho hộ gia đình, KHÔNG áp dụng " +
      "cho doanh nghiệp hay công ty. " +
      "Người có CCCD tại TP.HCM (không tính khu vực Bình Dương và Vũng Tàu cũ) chỉ cần " +
      "bản photo CCCD. Người có CCCD ở tỉnh khác cần Xác nhận cư trú CT07 hoặc CT08, " +
      "hoặc thông tin cư trú trên VNeID tại địa chỉ muốn đăng ký. " +
      "Người KHÔNG chứng minh được cư trú tại địa chỉ thì KHÔNG được tính định mức. " +
      "Số người đăng ký được = số người có giấy tờ chứng minh. " +
      "Ví dụ: nhà 8 người, 4 có CCCD TP.HCM, 2 có xác nhận cư trú CT07/CT08 đầy đủ, " +
      "2 không có giấy tờ cư trú → đăng ký được 6 người; 2 người còn lại nên đăng ký " +
      "cư trú trước rồi bổ sung sau.",
    cases: [
      {
        id: "cccd_tphcm",
        label: "Có CCCD tại TP.HCM (không tính khu vực Bình Dương và Vũng Tàu cũ)",
        requiredDocs: {
          required: ["Bản photo Căn cước công dân (CCCD)"],
        },
      },
      {
        id: "cccd_tinh_khac",
        label: "Có CCCD ở tỉnh khác",
        requiredDocs: {
          note: "Cung cấp một trong các giấy tờ sau, tại địa chỉ muốn đăng ký",
          options: [
            "Xác nhận cư trú CT07 hoặc CT08 tại địa chỉ muốn đăng ký",
            "Thông tin cư trú trên ứng dụng VNeID tại địa chỉ muốn đăng ký",
          ],
        },
      },
    ],
  },

  lap_dat_dong_ho: {
    id: "lap_dat_dong_ho",
    title: "Đăng ký lắp đặt đồng hồ nước",
    purpose:
      "Đăng ký gắn đồng hồ nước mới tại địa chỉ sử dụng nước. " +
      "Giấy tờ cần sao y còn hiệu lực trong vòng 6 tháng hoặc có bản chính để đối chiếu.",
    cases: [
      {
        id: "ho_gia_dinh",
        label: "Hộ gia đình",
        requiredDocs: {
          required: ["Căn cước công dân (CCCD) chính chủ"],
          options: [
            "Giấy chứng nhận quyền sở hữu nhà ở, quyền sử dụng đất ở",
            "Hợp đồng chuyển quyền sở hữu nhà lập tại cơ quan Nhà nước nơi có căn nhà tọa lạc, đã nộp lệ phí trước bạ và đăng ký",
            "Giấy phép xây dựng nhà",
          ],
        },
      },
      {
        // [11/07/2026] Doanh nghiệp đăng ký gắn đồng hồ → chuyển tổng đài viên.
        id: "doanh_nghiep",
        label: "Doanh nghiệp, công ty",
        transferToAgent: true,
      },
    ],
  },

  sang_ten_dong_ho: {
    id: "sang_ten_dong_ho",
    title: "Sang tên đồng hồ nước",
    purpose: "Thay đổi tên chủ hợp đồng sử dụng nước sang chủ sở hữu mới.",
    cases: [
      {
        id: "ho_gia_dinh",
        label: "Hộ gia đình",
        requiredDocs: {
          required: [
            "Số danh bạ đồng hồ nước tại nơi đăng ký",
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất / quyền sở hữu nhà ở và tài sản khác gắn liền với đất",
          ],
          optional: [
            "Bản sao có chứng thực giấy chứng nhận số nhà (nếu địa chỉ có thay đổi so với địa chỉ trên hóa đơn tiền nước)",
            "Hồ sơ đăng ký định mức nước (nếu có nhu cầu)",
          ],
        },
      },
      {
        // [11/07/2026] Doanh nghiệp sang tên → chuyển tổng đài viên.
        id: "doanh_nghiep",
        label: "Doanh nghiệp, công ty",
        transferToAgent: true,
      },
    ],
  },

  nang_doi_dong_ho: {
    id: "nang_doi_dong_ho",
    title: "Nâng/Dời đồng hồ nước",
    purpose:
      "Thay đổi vị trí hoặc nâng cấp đồng hồ nước hiện có. " +
      "Không cần chuẩn bị giấy tờ trước — đăng ký qua các kênh, nhân viên sẽ liên hệ hướng dẫn.",
    // [11/07/2026] Kênh website chỉ áp dụng cho thủ tục này (theo tài liệu mới).
    channels:
      "Đăng ký qua: app SAWACO CSKH, website www.capnuoctrungan.vn, hoặc trực tiếp tại " +
      "văn phòng 873A Quang Trung, phường An Hội Tây, TP.HCM hoặc 540 Hà Huy Giáp, phường An Phú Đông, TP.HCM.",
    cases: [
      {
        id: "default",
        label: "Mọi trường hợp",
        requiredDocs: {
          note: "Không cần chuẩn bị giấy tờ trước",
        },
      },
    ],
  },
};
