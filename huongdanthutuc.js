/**
 * huongdanthutuc.js
 * Dữ liệu thủ tục hành chính – Công ty Cấp nước Trung An
 * Dùng cho AI Voice Bot tra cứu và đọc hướng dẫn cho khách hàng.
 */

// ─── Thông tin chung ─────────────────────────────────────────────────────────

export const SUBMISSION_CHANNELS = {
  app: {
    name: "App SAWACO CSKH",
    description: "Đăng ký trực tuyến qua ứng dụng SAWACO CSKH trên điện thoại di động",
  },
  website: {
    name: "Website Công ty",
    url: "www.capnuoctrungan.vn",
    description: "Đăng ký trực tuyến qua website và thực hiện theo hướng dẫn",
  },
  offices: [
    {
      id: "office_1",
      address: "873A Quang Trung, phường An Hội Tây, TP.HCM",
    },
    {
      id: "office_2",
      address: "540 Hà Huy Giáp, phường An Phú Đông, TP.HCM",
    },
  ],
};

export const AI_TRANSFER_PROMPT =
  'Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói "Gặp tổng đài viên" hoặc "Gặp người thật".';

// ─── Thủ tục ─────────────────────────────────────────────────────────────────

export const PROCEDURES = {
  /**
   * Thủ tục 1: Đăng ký định mức nước
   */
  dinhMucNuoc: {
    id: "dinh_muc_nuoc",
    title: "Đăng ký định mức nước",
    shortTitle: "Định mức nước",
    purpose: "Đăng ký số nhân khẩu để được tính định mức nước sinh hoạt theo quy định.",
    intentKeywords: ["định mức", "nhân khẩu", "hộ khẩu nước", "đăng ký định mức"],
    cases: [
      {
        id: "thuong_tru_hcm",
        label: "Có hộ khẩu thường trú tại TP.HCM",
        condition: "Khách hàng có hộ khẩu thường trú tại TP.HCM",
        requiredDocs: {
          note: "Cung cấp MỘT TRONG CÁC giấy tờ sau tại nơi đăng ký định mức nước",
          options: [
            "Photo CCCD hoặc Giấy khai sinh (có số định danh cá nhân) của tất cả nhân khẩu cần đăng ký",
            "Nếu chưa có CCCD: 'Thông báo số định danh cá nhân và thông tin trong CSDL quốc gia về dân cư' (xin tại Công an phường/xã/thị trấn)",
            "Ứng dụng VNeID hiển thị thông tin nơi thường trú và các thành viên hộ gia đình",
          ],
        },
      },
      {
        id: "khong_thuong_tru_hcm",
        label: "Không có hộ khẩu thường trú tại TP.HCM",
        condition: "Khách hàng không có hộ khẩu thường trú tại TP.HCM",
        requiredDocs: {
          note: "Cung cấp MỘT TRONG CÁC giấy tờ sau tại nơi đăng ký định mức nước",
          options: [
            "Xác nhận tạm trú tại địa chỉ đăng ký (có đóng dấu cơ quan thẩm quyền) VÀ photo CCCD của tất cả nhân khẩu",
            "Ứng dụng VNeID hiển thị thông tin nơi ở hiện tại của các nhân khẩu tại địa chỉ đăng ký",
          ],
        },
      },
    ],
    submissionChannels: ["app", "website", "offices"],
    voiceScript: {
      intro:
        "Chào Anh/Chị, sau đây là các hướng dẫn cần thiết khi đăng ký định mức nước. Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật' bất cứ lúc nào nhé.",
      outro:
        "Trên đây là thủ tục Đăng ký định mức nước. Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật' bất cứ lúc nào nhé.",
    },
  },

  /**
   * Thủ tục 2: Đăng ký lắp đặt đồng hồ nước
   */
  lapDatDongHo: {
    id: "lap_dat_dong_ho",
    title: "Đăng ký lắp đặt đồng hồ nước",
    shortTitle: "Lắp đặt đồng hồ nước",
    purpose: "Đăng ký gắn đồng hồ nước mới tại địa chỉ sử dụng nước.",
    intentKeywords: ["lắp đồng hồ", "gắn đồng hồ", "đăng ký nước mới", "lắp mới", "đăng ký lắp"],
    docNote: "Giấy tờ yêu cầu bản sao y còn hiệu lực trong vòng 6 tháng hoặc có bản chính để đối chiếu.",
    cases: [
      {
        id: "ho_gia_dinh",
        label: "Hộ gia đình",
        condition: "Khách hàng là hộ gia đình",
        requiredDocs: {
          note: "Cung cấp MỘT TRONG CÁC giấy tờ sau",
          options: [
            "Giấy chứng nhận quyền sở hữu nhà ở / quyền sử dụng đất ở",
            "Hợp đồng chuyển quyền sở hữu nhà (lập tại cơ quan công chứng hoặc UBND quận/huyện, đã nộp lệ phí trước bạ và đăng ký)",
            "Giấy cấp nhà trong nội bộ cơ quan hoặc quyết định cấp nhà của cơ quan thẩm quyền",
            "Hợp đồng thuê nhà dài hạn của Nhà nước (cá nhân hoặc tổ chức)",
            "Giấy phép xây dựng nhà",
            "Giấy cấp số nhà của cơ quan thẩm quyền cấp quận/huyện",
            "Quyết định hoặc bản án có hiệu lực của Tòa án công nhận quyền sở hữu/sử dụng/thừa kế nhà",
            "Giấy xác nhận tạm trú của Công an phường/xã",
            "Giấy xác nhận tạm trú của Tổ trưởng khu phố (nhà ở ổn định, không tranh chấp)",
            "Quyết định giao đất của cơ quan chức năng cho chủ đầu tư (khi đang xây dựng, chưa chuyển nhượng)",
          ],
        },
      },
      {
        id: "doanh_nghiep_so_huu",
        label: "Doanh nghiệp – địa chỉ thuộc sở hữu",
        condition: "Doanh nghiệp, địa chỉ lắp đồng hồ thuộc quyền sở hữu của công ty/tổ chức",
        requiredDocs: {
          note: "Cung cấp ĐẦY ĐỦ các giấy tờ sau",
          required: [
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất / quyền sở hữu nhà ở và tài sản gắn liền với đất",
            "Bản sao có chứng thực giấy phép kinh doanh và mã số thuế",
          ],
        },
      },
      {
        id: "doanh_nghiep_thue",
        label: "Doanh nghiệp – địa chỉ đi thuê",
        condition: "Doanh nghiệp, địa chỉ lắp đồng hồ do công ty/tổ chức thuê",
        requiredDocs: {
          note: "Cung cấp ĐẦY ĐỦ các giấy tờ sau",
          required: [
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất / quyền sở hữu nhà ở",
            "Bản sao có chứng thực giấy phép kinh doanh và mã số thuế",
            "Bản sao có chứng thực hợp đồng thuê mặt bằng/nhà đất",
            "Giấy cam kết của bên cho thuê (xem chi tiết bên dưới)",
          ],
          details: {
            giayCamKet: {
              label: "Giấy cam kết của bên cho thuê",
              content: [
                "Đồng ý để bên thuê đứng tên gắn đồng hồ nước",
                "Cam kết thanh toán hóa đơn tiền nước còn nợ nếu bên thuê di dời mà chưa thanh toán",
              ],
              xacNhan: {
                caNhan: "Xác nhận của UBND phường/xã nơi thuê mặt bằng (nếu chủ là cá nhân)",
                toChuc: "Chữ ký đại diện pháp luật + con dấu (nếu chủ là tổ chức/công ty)",
              },
              alternative:
                "Nếu không có giấy cam kết, có thể thay bằng tiền ký quỹ 20.000.000 đồng (hai mươi triệu đồng)",
            },
          },
        },
      },
    ],
    submissionChannels: ["app", "website", "offices"],
    voiceScript: {
      intro:
        "Chào Anh/Chị, sau đây là các hướng dẫn cần thiết khi đăng ký lắp đặt đồng hồ nước. Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật' bất cứ lúc nào nhé.",
      outro:
        "Trên đây là thủ tục Đăng ký lắp đặt đồng hồ nước. Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật' bất cứ lúc nào nhé.",
    },
  },

  /**
   * Thủ tục 3: Sang tên đồng hồ nước
   */
  sangTenDongHo: {
    id: "sang_ten_dong_ho",
    title: "Sang tên đồng hồ nước",
    shortTitle: "Sang tên đồng hồ",
    purpose: "Thay đổi tên chủ hợp đồng sử dụng nước sang chủ sở hữu/người sử dụng mới.",
    intentKeywords: ["sang tên", "đổi tên", "chuyển tên đồng hồ", "sang tên đồng hồ"],
    cases: [
      {
        id: "ho_gia_dinh",
        label: "Hộ gia đình",
        condition: "Khách hàng là hộ gia đình",
        requiredDocs: {
          note: "Chuẩn bị ĐẦY ĐỦ các giấy tờ sau",
          required: [
            "Hóa đơn tiền nước kỳ mới nhất tại nơi đăng ký",
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất / quyền sở hữu nhà ở",
          ],
          conditional: [
            {
              condition: "Địa chỉ thay đổi so với địa chỉ trên hóa đơn",
              doc: "Bản sao có chứng thực giấy chứng nhận số nhà",
            },
            {
              condition: "Có nhu cầu đăng ký thêm định mức nước",
              doc: "Hồ sơ đăng ký định mức nước (xem Thủ tục 1)",
            },
          ],
        },
      },
      {
        id: "doanh_nghiep",
        label: "Doanh nghiệp",
        condition: "Khách hàng là doanh nghiệp/tổ chức",
        requiredDocs: {
          note: "Chuẩn bị ĐẦY ĐỦ các giấy tờ sau",
          required: [
            "Hóa đơn tiền nước kỳ mới nhất tại nơi đăng ký",
            "Bản sao có chứng thực giấy chứng nhận quyền sử dụng đất / quyền sở hữu nhà ở",
            "Bản sao có chứng thực giấy chứng nhận đăng ký kinh doanh",
          ],
          conditional: [
            {
              condition: "Địa chỉ đang thuê",
              doc: "Bản sao có chứng thực hợp đồng thuê nhà / giấy cam kết của chủ nhà",
            },
            {
              condition: "Có yêu cầu xuất hóa đơn",
              doc: "Công văn yêu cầu nội dung xuất hóa đơn",
            },
          ],
        },
      },
    ],
    submissionChannels: ["app", "website", "offices"],
    voiceScript: {
      intro:
        "Chào Anh/Chị, sau đây là các hướng dẫn cần thiết khi đăng ký sang tên đồng hồ nước. Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật' bất cứ lúc nào nhé.",
      outro:
        "Trên đây là thủ tục Đăng ký sang tên đồng hồ nước. Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật' bất cứ lúc nào nhé.",
    },
  },

  /**
   * Thủ tục 4: Nâng/Dời đồng hồ nước
   */
  nangDoiDongHo: {
    id: "nang_doi_dong_ho",
    title: "Nâng/Dời đồng hồ nước",
    shortTitle: "Nâng/Dời đồng hồ",
    purpose: "Thay đổi vị trí hoặc nâng cấp đồng hồ nước hiện có.",
    intentKeywords: ["nâng đồng hồ", "dời đồng hồ", "di dời đồng hồ", "nâng cấp đồng hồ", "dời đồng hồ nước"],
    cases: [
      {
        id: "default",
        label: "Tất cả trường hợp",
        condition: "Mọi trường hợp",
        requiredDocs: {
          note: "Thủ tục này không yêu cầu giấy tờ trước. Khách hàng đăng ký qua một trong các kênh bên dưới, nhân viên sẽ liên hệ tư vấn và hướng dẫn cụ thể.",
          required: [],
        },
      },
    ],
    submissionChannels: ["app", "website", "offices"],
    voiceScript: {
      intro:
        "Chào Anh/Chị, Anh/Chị có thể đăng ký Nâng/Dời đồng hồ nước qua các kênh sau. Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật'.",
      outro:
        "Anh/Chị có thể yêu cầu gặp nhân viên để tư vấn trực tiếp bất cứ lúc nào, chỉ cần nói 'Gặp tổng đài viên' hoặc 'Gặp người thật' bất cứ lúc nào nhé.",
    },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Tìm thủ tục theo keyword người dùng nói.
 * @param {string} userInput - Nội dung khách hàng nói (lowercase)
 * @returns {Object|null} - Thủ tục phù hợp hoặc null nếu không tìm thấy
 */
export function findProcedureByIntent(userInput) {
  const input = userInput.toLowerCase();
  for (const procedure of Object.values(PROCEDURES)) {
    if (procedure.intentKeywords.some((kw) => input.includes(kw))) {
      return procedure;
    }
  }
  return null;
}

/**
 * Lấy script giới thiệu thủ tục (dùng cho TTS).
 * @param {string} procedureId - ID thủ tục (vd: "dinh_muc_nuoc")
 * @returns {string} - Câu intro cho AI đọc
 */
export function getProcedureIntro(procedureId) {
  const procedure = Object.values(PROCEDURES).find((p) => p.id === procedureId);
  return procedure?.voiceScript?.intro ?? "Xin lỗi, tôi không tìm thấy thủ tục này.";
}

/**
 * Lấy danh sách giấy tờ cho một case cụ thể (dùng để AI đọc từng mục).
 * @param {string} procedureId - ID thủ tục
 * @param {string} caseId - ID trường hợp (vd: "ho_gia_dinh")
 * @returns {string[]} - Mảng các giấy tờ cần chuẩn bị
 */
export function getRequiredDocs(procedureId, caseId) {
  const procedure = Object.values(PROCEDURES).find((p) => p.id === procedureId);
  if (!procedure) return [];
  const matchedCase = procedure.cases.find((c) => c.id === caseId);
  if (!matchedCase) return [];
  const docs = matchedCase.requiredDocs;
  return [
    ...(docs.required ?? []),
    ...(docs.options ?? []),
    ...(docs.conditional?.map((c) => `${c.doc} (khi: ${c.condition})`) ?? []),
  ];
}

/**
 * Lấy thông tin kênh nộp hồ sơ dưới dạng text để AI đọc.
 * @returns {string}
 */
export function getSubmissionChannelsText() {
  const { app, website, offices } = SUBMISSION_CHANNELS;
  const officeList = offices.map((o) => o.address).join("; ");
  return (
    `Anh/Chị có thể nộp hồ sơ qua các kênh sau: ` +
    `Một là qua ${app.name} trên điện thoại. ` +
    `Hai là qua website ${website.url}. ` +
    `Ba là nộp trực tiếp tại văn phòng giao dịch: ${officeList}.`
  );
}

// ─── Export toàn bộ dưới dạng mảng (tiện dùng khi cần iterate) ──────────────

export const PROCEDURES_LIST = Object.values(PROCEDURES);
