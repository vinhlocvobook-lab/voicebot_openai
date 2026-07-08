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
            "Giấy chứng nhận quyền sở hữu nhà ở, quyền sử dụng đất ở.",
            "Hợp đồng chuyển quyền sở hữu nhà lập tại cơ quan công chứng Nhà nước, hoặc Uỷ Ban Nhân Dân quận, huyện nơi có căn nhà tọa lạc, đã nộp lệ phí trước bạ và đăng ký.",
            "Giấy cấp nhà trong nội bộ cơ quan, hoặc quyết định cấp nhà của cơ quan có thẩm quyền.",
            "Hợp đồng của cá nhân, tổ chức thuê nhà của Nhà nước dài hạn.",
            "Giấy phép xây dựng nhà.",
            "Giấy cấp số nhà của cơ quan có thẩm quyền cấp quận, huyện.",
            "Quyết định của cơ quan có thẩm quyền, hoặc bản án có hiệu lực thi hành của Tòa án công nhận quyền sở hữu, sử dụng, thừa kế tài sản nhà.",
            "Giấy xác nhận tạm trú của công an phường, xã.",
            "Giấy xác nhận tạm trú của Tổ trưởng khu phố về tình trạng nhà ở ổn định, không tranh chấp.",
            "Quyết định giao đất của cơ quan chức năng cho chủ đầu tư xây dựng công trình (trong trường hợp chủ đầu tư đang xây dựng công trình, chưa chuyển nhượng cho người sử dụng)."
          ],
        },
      },
      {
        id: "doanh_nghiep_so_huu",
        label: "Doanh nghiệp, công ty - địa chỉ thuộc sở hữu",
        requiredDocs: {
          note: "Cần đầy đủ các giấy tờ",
          required: [
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất, quyền sở hữu nhà ở và tài sản khác gắn liền với đất.",
            "Bản sao có chứng thực giấy phép kinh doanh và mã số thuế."
          ],
        },
      },
      {
        id: "doanh_nghiep_thue",
        label: "Doanh nghiệp, công ty - địa chỉ đi thuê",
        requiredDocs: {
          note: "Cần đầy đủ các giấy tờ",
          required: [
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất, quyền sở hữu nhà ở và tài sản khác gắn liền với đất",
            "Bản sao có chứng thực giấy phép kinh doanh và mã số thuế",
            "Bản sao có chứng thực hợp đồng thuê mặt bằng, nhà đất",
            `Giấy cam kết của bên cho thuê với nội dung: 
            - Bên cho thuê đồng ý để bên thuê được đứng tên gắn đồng hồ nước tại địa chỉ lắp đặt Đồng Hồ Nước.
            - Bên cho thuê cam kết thanh toán chi phí phát sinh, thanh toán hóa đơn tiền nước còn nợ  cho Công ty Cổ phần Cấp nước Trung An nếu bên thuê ngưng hợp đồng thuê, di dời nơi khác mà chưa thanh toán hết tiền nước.
            - Giấy cam kết này phải được xác nhận của Uỷ Ban Nhân Dân phường, xã nơi thuê mặt bằng nếu chủ cho thuê là hộ cá nhân hoặc có chữ ký của đại diện pháp luật và con dấu nếu chủ cho thuê là công ty/ tổ chức
            Lưu ý:
            - Trường hợp bên thuê không đính kèm được giấy cam kết có thể thay thế bằng hình thức đóng tiền ký quỹ Hai mươi triệu đồng.`

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
            "Hóa đơn tiền nước kỳ mới nhất tại nơi đăng ký.",
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất / quyền sở hữu nhà ở và tài sản khác gắn liền với đất.",
            // "Bản sao có chứng thực giấy chứng nhận số nhà (nếu địa chỉ có thay đổi so với địa chỉ trên hóa đơn tiền nước).",
            // "Hồ sơ đăng ký định mức nếu có nhu cầu. Theo link hướng dẫn trên website https://capnuoctrungan.vn, mục  'Thủ tục đăng ký định mức nước'",
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

            "Hóa đơn tiền nước kỳ mới nhất tại nơi đăng ký",
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất / quyền sở hữu nhà ở và tài sản khác gắn liền với đất",
            "Bản sao có chứng thực hợp đồng thuê nhà, giấy cam kết của chủ nhà cho Công ty thuê (trường hợp thuê nhà)",
            "Bản sao có chứng thực giấy chứng nhận đăng ký kinh doanh",
            "Công văn yêu cầu nội dung xuất hóa đơn (nếu có yêu cầu)"

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
