/**
 * huongdanthutuc-data.js
 * Re-export PROCEDURES từ huongdanthutuc.js để dùng trong CommonJS/ESM context.
 * (Tách riêng để tools.js import được mà không phụ thuộc vào file gốc)
 */

export const PROCEDURES = {
  dinh_muc_nuoc: {
    id: "dinh_muc_nuoc",
    title: "Đăng ký định mức nước",
    purpose: "Đăng ký số nhân khẩu để được tính định mức nước sinh hoạt theo quy định.",
    cases: [
      {
        id: "thuong_tru_hcm",
        label: "Có hộ khẩu thường trú tại TP.HCM",
        requiredDocs: {
          note: "Cung cấp một trong các giấy tờ sau",
          options: [
            "Photo Căn cước công dân hoặc giấy khai sinh (có số định danh cá nhân) của tất cả nhân khẩu",
            "Ứng dụng 'Vi eN i ai Đi'  hiển thị thông tin nơi thường trú của tất cả thành viên",
            "Nếu chưa có Căn cước công dân: 'Thông báo số định danh cá nhân' từ Công an phường/xã",
          ],
        },
      },
      {
        id: "khong_thuong_tru_hcm",
        label: "Không có hộ khẩu thường trú tại TP.HCM",
        requiredDocs: {
          note: "Cung cấp một trong các giấy tờ sau",
          options: [
            "Xác nhận tạm trú có đóng dấu cơ quan thẩm quyền và photo Căn cước công dân hoặc giấy khai sinh (có số định danh cá nhân) của tất cả nhân khẩu",
            "Ứng dụng 'Vi eN i ai Đi' hiển thị nơi ở hiện tại của các nhân khẩu tại địa chỉ đăng ký",
          ],
        },
      },
    ],
  },

  lap_dat_dong_ho: {
    id: "lap_dat_dong_ho",
    title: "Đăng ký lắp đặt đồng hồ nước",
    purpose: "Đăng ký gắn đồng hồ nước mới tại địa chỉ sử dụng nước. Giấy tờ cần sao y còn hiệu lực trong 6 tháng hoặc có bản chính đối chiếu.",
    cases: [
      {
        id: "ho_gia_dinh",
        label: "Hộ gia đình",
        requiredDocs: {
          note: "Cung cấp một trong các giấy tờ sau",
          options: [
            "Giấy chứng nhận quyền sở hữu nhà ở hoặc quyền sử dụng đất ở",
            "Giấy phép xây dựng nhà",
            "Giấy cấp số nhà của cơ quan thẩm quyền quận/huyện",
            "Giấy xác nhận tạm trú của Công an phường/xã hoặc Tổ trưởng khu phố",
            "Hợp đồng chuyển quyền sở hữu nhà có công chứng và đã nộp lệ phí trước bạ",
          ],
        },
      },
      {
        id: "doanh_nghiep_so_huu",
        label: "Doanh nghiệp - địa chỉ thuộc sở hữu",
        requiredDocs: {
          note: "Cần đầy đủ các giấy tờ",
          required: [
            "Bản sao chứng thực giấy chứng nhận quyền sử dụng đất/sở hữu nhà",
            "Bản sao chứng thực giấy phép kinh doanh và mã số thuế",
          ],
        },
      },
      {
        id: "doanh_nghiep_thue",
        label: "Doanh nghiệp - địa chỉ đi thuê",
        requiredDocs: {
          note: "Cần đầy đủ các giấy tờ",
          required: [
            "Bản sao chứng thực giấy chứng nhận quyền sử dụng đất/sở hữu nhà",
            "Bản sao chứng thực giấy phép kinh doanh và mã số thuế",
            "Bản sao chứng thực hợp đồng thuê mặt bằng",
            "Giấy cam kết của bên cho thuê (hoặc ký quỹ 20 triệu đồng thay thế)",
          ],
        },
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
            "Hóa đơn tiền nước kỳ mới nhất",
            "Bản sao chứng thực giấy chứng nhận quyền sử dụng đất/sở hữu nhà",
          ],
          options: [
            "Bản sao chứng thực giấy chứng nhận số nhà (nếu địa chỉ thay đổi)",
            "Hồ sơ đăng ký định mức nước (nếu có nhu cầu)",
          ],
        },
      },
      {
        id: "doanh_nghiep",
        label: "Doanh nghiệp",
        requiredDocs: {
          required: [
            "Hóa đơn tiền nước kỳ mới nhất",
            "Bản sao chứng thực giấy chứng nhận quyền sử dụng đất/sở hữu nhà",
            "Bản sao chứng thực giấy chứng nhận đăng ký kinh doanh",
          ],
          options: [
            "Hợp đồng thuê nhà và giấy cam kết của chủ nhà (nếu đang thuê)",
            "Công văn yêu cầu xuất hóa đơn (nếu có)",
          ],
        },
      },
    ],
  },

  nang_doi_dong_ho: {
    id: "nang_doi_dong_ho",
    title: "Nâng/Dời đồng hồ nước",
    purpose: "Thay đổi vị trí hoặc nâng cấp đồng hồ nước hiện có. Không cần giấy tờ trước - đăng ký qua các kênh, nhân viên sẽ liên hệ hướng dẫn.",
    cases: [
      {
        id: "default",
        label: "Mọi trường hợp",
        requiredDocs: {
          note: "Không cần chuẩn bị giấy tờ trước. Đăng ký qua app 'SA QUA CÔ' 'Cê ét ka hát', website www chấm capnuoctrungan chấm 'vi en', hoặc đến văn phòng giao dịch.",
          required: [],
          options: [],
        },
      },
    ],
  },
};
