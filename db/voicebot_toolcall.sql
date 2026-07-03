-- =============================================================================
--  VOICEBOT_TOOLCALL — 1 dòng / 1 function call của LLM trong cuộc gọi
--
--  Mục đích:
--    - Truy vết LLM đã truyền GÌ vào tool (args) và tool trả về GÌ (output).
--    - Truy vết request/response khi tool gọi backend api.php (api_calls).
--
--  Quy ước (khớp db/schema.sql):
--    - InnoDB, utf8mb4_unicode_ci; DATETIME theo giờ VN (GMT+7).
--    - Ghi ở PHA 2 (finalizeCallLog) từ document.toolCalls — single writer = bot.
--    - Idempotent nhờ UNIQUE(voicebot_callid, seq) + ON DUPLICATE KEY UPDATE.
--    - File JSON gốc vẫn là nguồn đầy đủ; bảng này để tra cứu/thống kê nhanh.
-- =============================================================================

CREATE TABLE IF NOT EXISTS voicebot_toolcall (
  id                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,

  -- Liên kết cuộc gọi
  voicebot_calllog_id BIGINT UNSIGNED   NULL     COMMENT 'FK voicebot_calllog.id',
  voicebot_callid     VARCHAR(128)      NOT NULL COMMENT 'OpenAI call ID (lưu thẳng để tiện đối chiếu)',
  seq                 SMALLINT UNSIGNED NOT NULL COMMENT 'Thứ tự tool call trong cuộc gọi: 1,2,3...',

  -- Function call của LLM
  tool_name           VARCHAR(64)       NOT NULL COMMENT 'get_bill, get_water_usage, create_ticket, end_call...',
  ma_danh_bo          VARCHAR(20)       NULL     COMMENT 'Trích từ args (đã normalize) — khóa tra cứu',
  args                JSON              NULL     COMMENT 'Arguments LLM truyền vào (đã parse JSON)',
  output              JSON              NULL     COMMENT 'Kết quả tool trả về cho LLM (đã parse JSON)',
  success             TINYINT(1)        NULL     COMMENT '1/0 theo output.success; NULL nếu không xác định',
  invalid_danh_bo     TINYINT(1)        NOT NULL DEFAULT 0 COMMENT '1 = bị chặn bởi checkDanhBo, không gọi API',
  duration_ms         INT UNSIGNED      NULL     COMMENT 'Thời gian xử lý toàn bộ tool (ms)',

  -- Trace backend API (api.php) trong tool call này
  api_call_count      TINYINT UNSIGNED  NOT NULL DEFAULT 0 COMMENT 'Số request api.php phát sinh (0 = tool local/action)',
  api_calls           JSON              NULL     COMMENT 'Mảng trace: [{time, method, url, query, body, http_status, duration_ms, response_outer, error_code}]',

  -- Thời gian
  called_at           DATETIME          NULL     COMMENT 'Thời điểm LLM gọi tool (GMT+7)',
  created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_toolcall_call_seq (voicebot_callid, seq),
  KEY idx_toolcall_calllog (voicebot_calllog_id),
  KEY idx_toolcall_name (tool_name),
  KEY idx_toolcall_danhbo (ma_danh_bo),
  KEY idx_toolcall_success (tool_name, success),
  KEY idx_toolcall_called (called_at),

  CONSTRAINT fk_toolcall_calllog FOREIGN KEY (voicebot_calllog_id)
    REFERENCES voicebot_calllog (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Đầu vào/đầu ra từng function call của LLM + trace request/response backend API';


-- =============================================================================
--  VIEW tiện tra cứu: tool call kèm thông tin cuộc gọi
-- =============================================================================
CREATE OR REPLACE VIEW v_toolcall_overview AS
SELECT
  t.id,
  t.voicebot_callid,
  c.customer_tel,
  t.seq,
  t.tool_name,
  t.ma_danh_bo,
  t.success,
  t.invalid_danh_bo,
  t.duration_ms,
  t.api_call_count,
  t.called_at,
  JSON_UNQUOTE(JSON_EXTRACT(t.output, '$.message')) AS output_message,
  c.outcome,
  c.json_log_filepath
FROM voicebot_toolcall t
LEFT JOIN voicebot_calllog c ON c.id = t.voicebot_calllog_id;
