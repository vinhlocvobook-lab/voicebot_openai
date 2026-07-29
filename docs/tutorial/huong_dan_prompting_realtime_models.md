# Hướng dẫn Prompting cho Realtime Models (OpenAI)

> Dịch và biên soạn lại từ tài liệu gốc: [Realtime models prompting guide](https://developers.openai.com/api/docs/guides/realtime-models-prompting) (OpenAI Developer Docs).
> Các khối lệnh mẫu (system prompt, JSON schema, ví dụ hội thoại) được giữ nguyên bản tiếng Anh vì đó là nội dung sẽ đưa thẳng vào prompt gửi cho model — chỉ phần diễn giải được dịch sang tiếng Việt.
>
> **Lưu ý:** Trang nguồn rất dài; công cụ lấy nội dung web bị giới hạn dung lượng nên phần cuối mục "Advanced Conversation Flow" (ví dụ JSON state machine đầy đủ và mục "Dynamic Conversation Flow via session.updates") chưa lấy được trọn vẹn. Phần này được đánh dấu rõ ở cuối tài liệu — nên xem link gốc nếu cần chi tiết đầy đủ.

## Mục lục

1. [Chọn model](#1-chọn-model)
2. [Realtime 2.0 — những gì đã thay đổi](#2-realtime-20--những-gì-đã-thay-đổi)
3. [Cấu trúc prompt khuyến nghị](#3-cấu-trúc-prompt-khuyến-nghị)
4. [Điều chỉnh mức độ suy luận (reasoning effort)](#4-điều-chỉnh-mức-độ-suy-luận-reasoning-effort)
5. [Dùng preamble (câu dẫn) một cách có chủ đích](#5-dùng-preamble-câu-dẫn-một-cách-có-chủ-đích)
6. [Kiểm soát độ dài câu trả lời](#6-kiểm-soát-độ-dài-câu-trả-lời)
7. [Thiết kế hành vi gọi tool](#7-thiết-kế-hành-vi-gọi-tool)
8. [Xử lý im lặng và tạp âm nền](#8-xử-lý-im-lặng-và-tạp-âm-nền)
9. [Dùng message channel (commentary / final) có chủ đích](#9-dùng-message-channel-commentary--final-có-chủ-đích)
10. [Xử lý audio không rõ](#10-xử-lý-audio-không-rõ)
11. [Thu thập chính xác các thực thể (entity)](#11-thu-thập-chính-xác-các-thực-thể-entity)
12. [Tránh bẫy "hiểu theo nghĩa đen"](#12-tránh-bẫy-hiểu-theo-nghĩa-đen)
13. [Kiểm soát ngôn ngữ và giọng (accent) riêng biệt](#13-kiểm-soát-ngôn-ngữ-và-giọng-accent-riêng-biệt)
14. [Duy trì trạng thái trong phiên dài](#14-duy-trì-trạng-thái-trong-phiên-dài)
15. [Di chuyển (migrate) từ các model realtime cũ hơn](#15-di-chuyển-migrate-từ-các-model-realtime-cũ-hơn)
16. [Role and Objective](#16-role-and-objective)
17. [Personality and Tone](#17-personality-and-tone)
18. [Reference Pronunciations](#18-reference-pronunciations)
19. [Instructions](#19-instructions)
20. [Tools](#20-tools)
21. [Conversation Flow](#21-conversation-flow)

---

## Giới thiệu

`gpt-realtime-2` là model giọng nói (speech-to-speech) có khả năng suy luận (reasoning) mạnh nhất hiện nay của OpenAI cho các ứng dụng độ trễ thấp. Model này có thể "suy nghĩ" trước khi nói, tuân theo instruction chặt chẽ hơn, dùng context window lớn hơn, và gọi tool chính xác hơn so với các model realtime đời trước.

Để tận dụng những cải tiến này, cần thiết kế prompt với chủ đích rõ ràng hơn: định nghĩa tường minh trách nhiệm của trợ lý, các điểm ra quyết định, hành vi gọi tool, và các giới hạn (guardrail) — trợ lý nên làm gì, làm khi nào, và không nên làm gì.

**Bắt đầu đơn giản.** Đừng prompt quá tay ngay từ đầu. Bắt đầu với một prompt tối giản, chạy đánh giá (eval), rồi chỉ thêm instruction cho những hành vi thực sự thất bại khi kiểm thử.

## 1. Chọn model

| Model | Dùng khi | Trọng tâm khi prompt |
| --- | --- | --- |
| [`gpt-realtime-2`](https://developers.openai.com/api/docs/models/gpt-realtime-2) | Cần khả năng suy luận, chọn tool, và tuân theo instruction mạnh nhất trong realtime. | Điều chỉnh reasoning effort, preamble, chính sách gọi tool, thu thập thực thể chính xác, và trạng thái phiên dài. |
| [`gpt-realtime-1.5`](https://developers.openai.com/api/docs/models/gpt-realtime-1.5) | Cần một model speech-to-speech nhanh, ổn định, không cần suy luận sâu. | Theo đúng cấu trúc prompt realtime cơ bản, kiểm thử với các hành vi nhạy cảm về độ trễ. |

### Realtime 2.0 Prompting Guide

Dùng `gpt-realtime-2` khi voice agent cần khả năng suy luận, chọn tool, xử lý thực thể chính xác, hoặc trạng thái phiên dài mạnh hơn. Bắt đầu với `reasoning.effort: "low"`, kiểm thử hành vi preamble mặc định, và định nghĩa rõ ranh giới cần xác nhận (confirmation) trước các hành động ghi (write action).

## 2. Realtime 2.0 — những gì đã thay đổi

Hãy prompt Realtime 2 như một **voice agent biết suy luận**, không phải một voice bot cơ bản.

| Thay đổi | Ý nghĩa đối với prompt |
| --- | --- |
| Reasoning (suy luận) | Cho phép model suy luận nội bộ với các tác vụ phức tạp trước khi nói hoặc gọi tool. Dùng preamble để tránh im lặng gượng gạo hoặc filler không cần thiết. |
| Prompt cần chính xác hơn | Thay các hướng dẫn chung chung như "hãy giúp đỡ" bằng quy tắc rõ ràng: khi nào kích hoạt (trigger), hành động là gì, và ngoại lệ nào không áp dụng. |
| Xung đột instruction gây thiệt hại nhiều hơn | Loại bỏ các quy tắc `always`, `never`, `only`, `must` chồng chéo trừ khi thực sự cần thiết. Định nghĩa mức ưu tiên khi các quy tắc mâu thuẫn nhau. |
| Hành vi gọi tool dễ điều khiển hơn | Chỉ rõ khi nào trợ lý nên hành động ngay, khi nào hỏi thêm thông tin còn thiếu, khi nào cần xác nhận chi tiết có độ chính xác cao, khi nào thử lại sau khi lỗi, hoặc khi nào chuyển tiếp (escalate). |
| Preamble là hành vi hạng nhất (first-class) | Model có thể nói một câu cập nhật ngắn trước khi suy luận dài hoặc gọi tool. Hãy chỉ định khi nào nên có preamble, ngắn cỡ nào, và khi nào nên bỏ qua. |
| Context window mở rộng | `gpt-realtime-2` mở rộng context window realtime từ 32k lên 128k token, phù hợp hơn cho phiên dài và system prompt lớn. |

> Preamble **không phải** chain-of-thought ẩn. Đó là những câu cập nhật ngắn được nói ra, ví dụ "Để tôi kiểm tra đơn hàng đó ngay." Đừng yêu cầu model tiết lộ quá trình suy luận nội bộ.

## 3. Cấu trúc prompt khuyến nghị

Dùng các mục ngắn, có tiêu đề rõ ràng. Model cần tìm được instruction liên quan một cách nhanh chóng.

```
# Role and Objective

# Personality and Tone

# Language

# Reasoning

# Message Channels

# Preambles

# Verbosity

# Tools

# Unclear Audio

# Entity Capture

# Long Context Behavior

# Escalation
```

Không phải use case nào cũng cần đủ mọi mục. Chỉ thêm những mục thực sự liên quan đến sản phẩm của bạn.

## 4. Điều chỉnh mức độ suy luận (reasoning effort)

`gpt-realtime-2` có thể đánh đổi độ trễ để lấy khả năng suy luận sâu hơn. Hãy dùng mức reasoning thấp nhất mà vẫn đủ "thông minh" cho luồng nghiệp vụ.

Bắt đầu với `low` cho hầu hết voice agent chạy production. Tăng/giảm tuỳ theo độ phức tạp tác vụ, mức chịu đựng độ trễ, và chi phí khi thất bại.

| Effort | Dùng khi | Ví dụ |
| --- | --- | --- |
| `minimal` | Độ trễ thấp nhất là ưu tiên hàng đầu, tác vụ đơn giản. | Lệnh smart-home, hẹn giờ, kiểm tra lịch đơn giản. |
| `low` | Cần vừa nhanh vừa có suy luận cơ bản. | Hỗ trợ khách hàng, tra cứu đơn hàng, câu hỏi chính sách đơn giản. |
| `medium` | Trợ lý phải suy luận qua nhiều bước. | Hỗ trợ kỹ thuật, chẩn đoán, định tuyến phức tạp. |
| `high` | Suy luận sâu hơn cải thiện tỷ lệ thành công đáng kể. | Luồng nghiệp vụ đòi hỏi độ chính xác cao, quyết định escalation, tác vụ có nhiều ràng buộc. |
| `xhigh` | Suy luận tối đa đáng giá dù tốn thêm độ trễ/chi phí. | Lập kế hoạch phức tạp, phân loại tình huống nguy cấp, điều phối tool ở mức độ cao. |

Ngoài cấu hình API, cần chỉ dẫn thêm cho model biết khi nào và suy luận nhiều đến mức nào:

```
## Reasoning

- For direct answers, simple lookups, and short confirmations, respond quickly and do not reason.
- For multi-step tasks, tool decisions, troubleshooting, or escalation, reason before acting.
- Do not perform extended reasoning when the user's audio is unclear; ask for clarification instead.
```

## 5. Dùng preamble (câu dẫn) một cách có chủ đích

Preamble là những câu cập nhật ngắn được nói ra, giúp voice agent cảm giác vẫn "phản hồi nhanh" trong lúc nó đang suy luận, tra cứu, hoặc gọi tool. Dùng đúng cách, preamble trấn an người dùng rằng trợ lý đang xử lý. Dùng sai cách, nó trở thành filler và làm tăng cảm giác độ trễ.

`gpt-realtime-2` tự sinh preamble theo mặc định. Hãy kiểm thử hành vi mặc định trước. Nếu không khớp với trải nghiệm sản phẩm mong muốn, hãy điều chỉnh tường minh.

```
## Preambles

Use short preambles only when they help the user understand that work is happening.

### When to use a preamble

Use a preamble when:

- you are about to call a tool that may take noticeable time;
- you need to reason through a multi-step request;
- you are checking records, availability, account state, or policy details;
- you are preparing an escalation or handoff;
- silence would make the assistant feel unresponsive.

When a preamble is needed, output it immediately before substantive reasoning or tool use.

### When to not use a preamble

Do not use a preamble when:

- the answer is direct and can be given immediately;
- the user is only confirming, correcting, or declining something;
- the audio is unclear and you need clarification;
- the latest audio is silence, background noise, hold music, TV audio, or side conversation;
- the tool call is lightweight and the user would not benefit from an update.

### Preamble style

When using a preamble:

- keep it natural, calm, and concise;
- vary the wording across turns;
- describe the action, not the internal reasoning;
- avoid filler.

Avoid phrases like:

- "Let me think..."
- "Hmm..."
- "One moment while I process that..."
- "I am now going to access the tool..."

### Preamble length

Use one short sentence.

Do not exceed two short sentences unless the user needs an explanation before a high-impact action.

### Prefer

- "I'll check that order now."
- "I'll look up your appointment details."
- "I'll verify that before we make any changes."
- "I'll check the policy and then give you the next step."
- "I'll pull that up so we can make sure it's the right account."

### Avoid

- "Let me think about that for a second."
- "Please wait while I process your request."
- "I'm going to use my tools now."
- "Interesting question. I will reason through this carefully."
```

## 6. Kiểm soát độ dài câu trả lời

`gpt-realtime-2` tuân theo hướng dẫn về độ dài tốt nhất khi prompt chỉ rõ mức độ chi tiết cho từng loại tác vụ. Thay vì bảo model "hãy súc tích", hãy định nghĩa rõ "súc tích" nghĩa là gì trong từng ngữ cảnh: câu trả lời trực tiếp, kết quả tool, xử lý sự cố, so sánh, và escalation có thể cần độ dài khác nhau.

```
## Verbosity

- Direct answers: Use 1-2 short sentences.
- Clarifying questions: Ask one question at a time.
- Tool results: Summarize the result first, then give only the next useful action.
- Product or option comparisons: Include key differences, tradeoffs, and who each option fits.
- Troubleshooting: Give one step at a time unless the user asks for the full procedure.
- Escalations: Briefly explain why escalation is needed and what will happen next.
```

Ví dụ:
> User: Which plan should I choose?
> Assistant: If you want the lowest cost, choose Basic. If you need team permissions and shared billing, choose Pro. If compliance review or admin controls matter, choose Enterprise.

## 7. Thiết kế hành vi gọi tool

`gpt-realtime-2` gọi tool tốt hơn, nhưng hành vi gọi tool vẫn phụ thuộc vào cách thiết kế prompt và tool-spec. Nếu prompt không định nghĩa rõ khi nào nên hành động, khi nào hỏi thêm, khi nào cần xác nhận, khi nào phục hồi sau lỗi — trợ lý có thể gọi tool quá sớm, hỏi những câu không cần thiết, hoặc lặp lại tool call bị lỗi.

### Đặt mức độ "hăng hái" (eagerness) khi gọi tool

Mức eagerness cao phù hợp với các action chỉ đọc (read-only), rủi ro thấp. Mức eagerness thấp phù hợp hơn khi tool thay đổi dữ liệu, kích hoạt hiệu ứng bên ngoài, hoặc phụ thuộc vào định danh (identifier) chính xác.

| Loại tool | Hành vi mặc định |
| --- | --- |
| Tra cứu chỉ đọc, rủi ro thấp | Gọi ngay khi ý định và các trường bắt buộc đã rõ. |
| Tra cứu chỉ đọc nhưng cần định danh chính xác | Xác nhận định danh trước khi tra cứu. |
| Giao tiếp hiển thị cho người dùng | Soạn nháp hoặc tóm tắt trước khi gửi. |
| Thay đổi tài khoản | Xác nhận trước khi gọi. |
| Mua hàng, huỷ, thanh toán | Xác nhận số tiền, đối tượng, và hệ quả trước khi gọi. |
| Hành động không thể hoàn tác hoặc tác động lớn | Xác nhận rõ ràng và đề nghị escalation khi phù hợp. |

Dùng mẫu cân bằng dưới đây khi bạn có cả action đọc lẫn ghi. Điều chỉnh theo use case của bạn.

```
## Tools

Use only the tools explicitly provided in the current tool list. Do not invent, assume, simulate, or rename tools.

For read-only tools:

- Call the tool when the user's intent is clear and all required fields are available.
- Do not ask for confirmation unless the lookup depends on a high-precision identifier or there is meaningful risk of using the wrong record.
- Ask a clarification question only if a required field is missing, ambiguous, or conflicting.

For write tools or external actions:

- Summarize the intended action before calling the tool.
- Include the key consequence, such as what will be changed, sent, canceled, ordered, or charged.
- Ask for confirmation.
- Do not call the tool until the user clearly confirms.

For exact identifiers:

- Treat order IDs, tracking numbers, account numbers, confirmation codes, phone numbers, and email addresses as high precision.
- Normalize only when the field type is clear.
- Confirm the final value before account-specific lookups, validation, or write actions.

After tool calls:

- Only say an action was completed after the tool call succeeds.
- If the tool fails, explain the failure briefly, avoid raw errors, and give the user a clear next step.
```

Ví dụ rủi ro cao:
> User: Charge my card for the remaining balance.

Không tốt:
> Assistant: I've charged your card.

Tốt:
> Assistant: To confirm, you want me to charge the card on file $248.16 for the remaining balance. Should I proceed?

### Phục hồi sau khi tool call thất bại

Tool call thất bại là chuyện bình thường trong hội thoại. Một cách phục hồi tốt cần giải thích chuyện gì đã xảy ra và cho người dùng một bước tiếp theo rõ ràng.

Đừng xử lý mọi lỗi giống nhau. Cách phục hồi nên phụ thuộc vào loại tool, kiểu lỗi, và mức ảnh hưởng tới người dùng. Một số lỗi nên được xử lý âm thầm bằng cách thử lại. Một số khác cần hỏi người dùng làm rõ, sửa lại định danh, xác nhận một hành động mới, hoặc chọn hướng đi khác.

```
## Tool Failures

If a tool call fails:

1. Briefly explain what failed in user-friendly language.
2. Do not blame the user or expose raw tool errors.
3. If the failure may be due to an exact identifier, read back the value used and ask the user to correct it.
4. If the failure may be temporary, offer to retry once.
5. If the same failure happens repeatedly, offer an alternate path or escalation.

Do not repeatedly call the same tool with the same arguments after failure.

Do not ask for a different identifier until you have first checked whether the captured value was correct.
```

Không tốt:
> Assistant: Something went wrong.

Tốt:
> Assistant: I couldn't find a match for O R D dash 3 1 2 5 B 2 3. Did I get any part of that wrong?

### Giữ danh sách tool luôn đồng bộ

Realtime model rất "nhiệt tình" muốn giúp đỡ. Nếu prompt nhắc tới một tool không thực sự tồn tại, hoặc danh sách tool không khớp với prompt, model có thể tự bịa ra tên tool hoặc giả vờ đã thực hiện xong hành động.

Ví dụ: nếu prompt nhắc tới `lookup_order`, nhưng tool thực tế được cung cấp lại tên là `search_orders`, model có thể gọi sai tên hoặc giả lập hành động.

```
## Tool Availability

Use only the tools that are explicitly provided in the current tool list.

Do not invent, assume, or simulate tools. If a tool is mentioned in the instructions but is not present in the tool list, treat it as unavailable.

If the user requests an action that requires an unavailable tool:

1. Do not pretend to complete the action.
2. Briefly explain that the tool is not available.
3. Offer the closest supported next step.

Only say an action was completed after the relevant tool call succeeds.
```

> Dùng "prompt audit meta prompt" trong phần Phụ lục (Appendix) của tài liệu gốc để rà soát prompt production, phát hiện mâu thuẫn, tool bị thiếu, và instruction dễ vỡ.

## 8. Xử lý im lặng và tạp âm nền

Voice agent có xu hướng trả lời theo mặc định. Trong thực tế production, chúng thường "nghe" phải những đoạn audio không nên có phản hồi nói, ví dụ: im lặng, tạp âm nền, nhạc chờ, âm thanh TV, hoặc hội thoại phía sau (side conversation).

Hãy dùng một tool "no-op" (không làm gì, chỉ chờ) khi trợ lý nên im lặng và tiếp tục lắng nghe. Tool này cho model một hành động hợp lệ để "không nói" thay vì buộc nó phải nói những câu như "Tôi đang nghe đây" hay "Tôi không nghe rõ".

Thiết kế tool:

```json
{
  "name": "wait_for_user",
  "description": "Call this when the latest audio does not need a spoken response, such as silence, background noise, hold music, TV audio, side conversation, or speech not addressed to the assistant. This tool helps end the turn without a spoken reply.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

Kết hợp với instruction trong prompt:

```
## Handling Silence and Background Noise

If the latest audio is silence, background noise, hold music, TV audio, side conversation, or speech not addressed to you, call `wait_for_user`.

Do not respond conversationally after calling this tool.

Do not say "I'm here," "I didn't catch that," "Take your time," or "Let me know when you're ready."

Resume normal responses only when the user clearly addresses you or asks for help.
```

> Chỉ dùng cho audio **không hướng tới trợ lý**, không phải cho các yêu cầu không rõ ràng của người dùng. Nếu người dùng rõ ràng đang nói với trợ lý nhưng nội dung không nghe được, hãy hỏi lại thay vì gọi tool này.

## 9. Dùng message channel (commentary / final) có chủ đích

`gpt-realtime-2` có thể sinh ra các thông điệp trung gian hiển thị cho người dùng trên kênh `commentary`, và câu trả lời cuối cùng trên kênh `final`. Hãy dùng instruction riêng cho từng kênh khi hành vi phụ thuộc vào việc nội dung xuất hiện ở đâu.

| Channel | Hiển thị cho user? | Dùng cho |
| --- | --- | --- |
| `commentary` | Có | Preamble và tool call. |
| `final` | Có | Thông điệp cuối cùng gửi cho người dùng. |

Ví dụ, tool call diễn ra trên kênh commentary. Nếu bạn muốn trợ lý nói điều gì đó trước, trong, hoặc sau khi gọi tool, hãy chỉ định hành vi này liên quan tới kênh commentary.

```
Before calling tools in the commentary channel, briefly tell the user what you are doing.
```

`gpt-realtime-2` có thể phát ra nhiều giai đoạn phản hồi (response phase) trong một lượt. Trong output của API, điều này được thể hiện qua event `response.done`, chứa giá trị `phase` cho biết nội dung là commentary hay câu trả lời cuối cùng.

Bạn có thể dùng field này để xử lý từng giai đoạn khác nhau trong ứng dụng. Ví dụ, commentary có thể được phát hoặc hiển thị như một cập nhật trung gian ngắn, còn `final_answer` dành cho câu trả lời hoàn chỉnh của trợ lý.

```
response.output[0].phase: "commentary"
response.output[1].phase: "final_answer"
```

Ví dụ về các giai đoạn phản hồi:

User prompt:
> "I'm stuck on this AP Bio question [QUESTION]."

Rút gọn API response:

```json
{
  "type": "response.done",
  "response": {
    "output": [
      {
        "phase": "commentary",
        "content": [
          {
            "type": "output_audio",
            "transcript": "Let's zero in on the enzyme's shape and binding, since that's the key idea here."
          }
        ]
      },
      {
        "phase": "final_answer",
        "content": [
          {
            "type": "output_audio",
            "transcript": "What changes at the active site at high temperature?"
          }
        ]
      }
    ]
  }
}
```

## 10. Xử lý audio không rõ

Model chỉ nên hành động dựa trên đoạn audio mà nó hiểu được với độ tin cậy cao. Nếu audio không rõ, model nên hỏi lại ngắn gọn thay vì đoán mò.

Đừng để model tự suy đoán từ bị thiếu, gọi tool, thu thập thực thể, sinh preamble, hoặc dành thời gian suy luận ẩn để cố "tái tạo" điều người dùng có thể đã nói.

```
## Unclear Audio

- Only respond to clear audio or text.
- If the user's audio is not clear, ask for clarification using a short English phrase such as "Sorry, could you repeat that clearly?"
- Don't repeat the same unclear-audio clarification twice.
- Treat audio as unclear if it is ambiguous, noisy, silent, unintelligible, partially cut off, or if you are unsure of the exact words the user said.
- Do not guess what the user meant from unclear audio.
- Do not reason when the audio is unclear.
- Do not provide a preamble or call tools in the commentary channel when the audio is unclear.
```

Ví dụ:
> User audio: "Check order three one-" [bị cắt ngang]

Không tốt:
> Assistant: I'll check order 31 now.

Tốt:
> Assistant: I heard only part of the order number. Could you repeat it digit by digit?

## 11. Thu thập chính xác các thực thể (entity)

Nhiều luồng nghiệp vụ realtime phụ thuộc vào các giá trị chính xác: mã đơn hàng, mã vận đơn, email, mã xác nhận, số tài khoản, mã hồ sơ khiếu nại, mã ticket, mã tham chiếu hỗ trợ, và số điện thoại.

Giọng nói khiến việc này khó hơn. Người dùng nói nhanh, gộp số theo nhiều cách khác nhau, đánh vần một phần giá trị, dùng từ đệm, tự sửa lại giữa lượt nói, hoặc phát âm những ký tự nghe giống nhau. Một chữ số sai có thể khiến tra cứu thất bại hoặc lấy nhầm tài khoản.

**Nguyên tắc:** thu thập thực thể một cách thận trọng. Chỉ thu một giá trị mỗi lần, chuẩn hoá (normalize) những gì thực sự rõ ràng, xác nhận các giá trị có độ chính xác cao trước khi gọi tool, và luôn cho phép sửa lại (recoverable) mọi sai sót.

### Thu thập từng thực thể một

Khi một luồng nghiệp vụ cần nhiều giá trị, hãy thu thập từng giá trị một. Điều này tránh việc các trường bị "trộn lẫn" vào nhau, đặc biệt trong hội thoại bằng giọng nói.

```
## Entity Collection Order

Collect required values one at a time.

- Ask for only the next missing value.
- Do not ask for multiple values in the same turn.
- Before asking, check whether the value was already provided earlier in the conversation or the session.
- If a possible value already exists, confirm it with the user before using it.

Example:

"I see tracking number ABC-54321 from earlier. Should I use that one, or do you have a different tracking number?"

Do not call tools until the current value has been collected, validated, and confirmed.
```

### Xử lý khi người dùng đánh vần từng ký tự

Dùng phần này khi người dùng đánh vần mã, ID, tên, hoặc email từng ký tự một. Chuỗi được nói ra là dữ liệu đầu vào, chưa phải giá trị cuối cùng.

```
## Spelled-Out Characters

When a user dictates an ID, code, or email character by character, treat the spoken sequence as one compact value. Preserve explicitly spoken separators like dash, dot, underscore, slash, or plus; otherwise do not add spaces or separators.

Examples:

- "A B C one two three" -> "ABC123"
- "B C dash nine eight seven" -> "BC-987"
- "J O H N at example dot com" -> "john@example.com"

Do not insert spaces between spelled-out characters unless the user explicitly says the value contains spaces.
```

### Chuẩn hoá số được nói cẩn thận

Với các định danh dạng số, người dùng có thể đọc từng chữ số riêng lẻ, gộp nhóm, hoặc dùng cách nói số tự nhiên. Nếu trường dữ liệu cần một chuỗi số liên tục, hãy chuyển đổi lời nói số rõ ràng thành chữ số.

```
## Spoken Number Handling

Convert spoken numbers into digits when collecting numeric identifiers.

Examples:

- "one two three four" -> "1234"
- "one twenty three" -> "123"
- "one nineteen" -> "119"
- "ninety nine eleven" -> "9911"
- "nine thousand nine hundred eleven" -> "9911"

If multiple interpretations are plausible, ask the user to clarify before using the value.

Example:

"I heard either 119 or 1-19. Could you repeat the number digit by digit?"
```

### Xác nhận định danh chính xác trước khi gọi tool

Mã đơn hàng, mã vận đơn, số tài khoản, mã khiếu nại, mã xác nhận, và các định danh tương tự là những trường có độ chính xác cao (high-precision). Hãy xác nhận chúng trước khi dùng trong tool call.

Với định danh dạng số, đọc lại giá trị **theo từng chữ số**. Đọc giá trị như một con số hoàn chỉnh có thể che giấu lỗi.

Ví dụ:
> Assistant: Just to confirm, I heard 8… 3… 5… 2… 1. Is that right?

Nếu người dùng sửa một ký tự hoặc chữ số, hãy lặp lại toàn bộ giá trị đã sửa trước khi gọi tool.

Ví dụ:
> Assistant: Got it. I have 8… 3… 5… 7… 1. Is that correct?

```
## Exact Identifier Confirmation

Before calling tools with high-precision identifiers:

- Confirm the final normalized value with the user.
- Read numeric identifiers back digit by digit.
- Do not use guessed, partial, or ambiguous values.
- If the user corrects the value, repeat the full corrected value before calling the tool.
```

### Xác nhận email theo từng ký tự

Địa chỉ email là giá trị quan trọng. Dấu chấm, gạch nối, gạch dưới, chữ cái lặp, và các tên nghe giống nhau có thể khiến tra cứu tài khoản thất bại hoặc gửi nhầm tin nhắn.

Yêu cầu người dùng đánh vần email:
> Assistant: Could you spell the email address character by character so I can make sure I have it exactly right?

Khi đọc lại, xác nhận đúng địa chỉ cuối cùng:
> Assistant: Just to confirm, that is c-h-e-n at example dot com, right?

```
## Email Confirmation

Email addresses must be captured exactly.

If the user says the email naturally without spelling it out, ask them to repeat it character by character.

Example:

"Could you spell the email address character by character so I can make sure I have it exactly right?"

When reading an email back, confirm the exact final email address.

Example:

"Just to confirm, that is c-h-e-n at example dot com, right?"
```

### Quy trình thu thập thực thể đầy đủ

Dùng quy trình đầy đủ này khi một tác vụ đòi hỏi giá trị chính xác trước bất kỳ tool call nào.

```
## Entity Collection Workflow

When a workflow requires an exact value, collect and confirm it before using it in any tool call.

Exact values include order IDs, tracking numbers, confirmation codes, account numbers, claim numbers, ticket IDs, support references, email addresses, phone numbers, and similar identifiers.

Follow this workflow:

1. Collect the next required value.

- Ask for only one missing value at a time.
- Do not ask for multiple exact values in the same turn.
- Before asking, check whether the value was already provided earlier in the conversation or session.

2. Normalize only what is clear.

- Convert clearly spoken digits or spelled-out characters into the expected format.
- Preserve explicit separators such as dashes, dots, underscores, slashes, and plus signs.
- Do not guess, infer, repair, or fill in unclear characters.
- If the value could be interpreted in more than one way, ask the user to repeat or clarify it.

3. Confirm the final value.

- Read back the normalized value before using it.
- For numeric identifiers, confirm digit by digit.
- For email addresses, confirm character by character when precision matters.
- Wait for a clear confirmation from the user.

4. Call the tool only after confirmation.

- Do not call lookup, account, messaging, payment, booking, or update tools with guessed, partial, ambiguous, or unconfirmed values.

5. Recover safely from corrections.

- If the user corrects any part of the value, update the value, repeat the full corrected value, and ask for confirmation again.
- Do not use the corrected value in a tool call until the user confirms the full final value.

Examples:

User: My order ID is ORD-3125B23.

Assistant: Just to confirm, I heard O-R-D dash 3-1-2-5-B-2-3. Is that right?

User: It is 83521 - actually, the fourth digit is 7.

Assistant: Got it. I have 8... 3... 5... 7... 1. Is that correct?

User: My email is chen@example.com.

Assistant: Could you spell that email address character by character so I can make sure I have it exactly right?

Never call tools with guessed, partial, ambiguous, or unconfirmed exact values.
```

> **Liên hệ với project này:** đây chính là nguyên tắc đứng sau luồng "mã danh bộ" trong `session-ws.js`/`danh-bo-arbiter.js` — thu từng phần, chuẩn hoá thận trọng, xác nhận trước khi tra cứu, và luôn cho phép người dùng sửa lại. Xem thêm `docs/fix/fix_danh_bo_hai_bien_muc_b_20260726.md` trong repo.

## 12. Tránh bẫy "hiểu theo nghĩa đen"

`gpt-realtime-2` tuân theo instruction **theo nghĩa đen** nhiều hơn so với các model realtime đời trước. Những prompt từng hoạt động tốt trên model cũ có thể cần điều chỉnh lại.

Hãy dùng ngôn ngữ chính xác. Model có thể ưu tiên đúng câu chữ của một instruction hơn là ý định rộng hơn mà bạn muốn truyền đạt. Các quy tắc quá rộng hoặc quá cứng nhắc có thể chi phối hành vi của trợ lý theo cách bất ngờ, đặc biệt khi nhiều quy tắc chồng lấn nhau.

Cẩn thận với các từ mang tính ràng buộc như `must`, `only`, `never`, `always`. Chỉ dùng khi hành vi đó thực sự bắt buộc, không dùng để nhấn mạnh chung chung. Lạm dụng ràng buộc cứng có thể khiến trợ lý trở nên cứng nhắc, quá thận trọng, hoặc không thể xử lý các ngoại lệ hợp lý.

Nên dùng phạm vi chính xác:

```
For write actions that modify user data, ask for confirmation before calling the tool.
```

Tránh phạm vi quá rộng:

```
Always ask for confirmation before doing anything.
```

Phiên bản quá rộng có thể khiến trợ lý xác nhận không cần thiết trước cả những tra cứu chỉ đọc vô hại, ví dụ kiểm tra trạng thái đơn hàng, xem lịch trống, hoặc đọc thông tin tài khoản.

### Ví dụ về bẫy hiểu theo nghĩa đen

Prompt này quá hẹp:

```
When a confirmation code is provided, repeat it verbatim and wait for a clear yes.
```

Tin nhắn người dùng:
> My order ID is ORD-3125B23.

Lỗi có thể xảy ra:

Model có thể **không** áp dụng quy tắc vì người dùng cung cấp mã đơn hàng (order ID), chứ không phải mã xác nhận (confirmation code). Ý định của developer thì rõ ràng, nhưng phạm vi của instruction lại quá hẹp.

Viết lại an toàn hơn:

```
When the user provides an exact identifier, including confirmation codes, order IDs, ticket IDs, reset PINs, claim numbers, tracking numbers, or account numbers, repeat the captured value and wait for confirmation before using it in a tool call.
```

**Khuyến nghị chung khi prompt:**

Ưu tiên instruction tường minh hơn là ý định ngầm định. Tránh dùng từ ràng buộc không cần thiết trừ khi hành vi thực sự phải cứng nhắc. Giảm thiểu hướng dẫn mâu thuẫn nhau. Cẩn thận với các instruction có nhiều lớp ưu tiên chồng chéo. Kiểm thử prompt từng bước nhỏ — một thay đổi câu chữ nhỏ có thể tạo ra hiệu ứng hành vi lớn. Khi migrate từ các model realtime cũ, hãy chuẩn bị tinh thần rằng một số prompt cần được tái cấu trúc để đạt kết quả tốt nhất.

## 13. Kiểm soát ngôn ngữ và giọng (accent) riêng biệt

Ngôn ngữ và giọng (accent) cần được kiểm soát **tách biệt** nhau.

Giọng của người dùng không đồng nghĩa với ngôn ngữ họ mong muốn. Một người có thể nói tiếng Anh với giọng Hindi, Tây Ban Nha, Pháp, hoặc Quan Thoại nhưng vẫn muốn nhận câu trả lời bằng tiếng Anh.

Tránh các instruction ngôn ngữ quá chung chung như:

```
Mirror the user.
Respond naturally in the user's language.
Switch languages when appropriate.
Sound local.
Adapt to the user's accent.
```

Những câu này quá rộng. Model có thể hiểu nhầm giọng, từ đệm, backchannel (ví dụ "ừm", "à"), hoặc một từ nước ngoài lẻ tẻ là lý do để chuyển ngôn ngữ.

### Chính sách ngôn ngữ tiếng Anh

```
## Language

English is the default response language.

- Do not infer language from accent alone.
- Ignore short filler sounds, backchannels, and isolated foreign words for language detection.
- Only switch languages if the user explicitly asks or provides a substantive utterance in another language.
- If language confidence is low, ask a short clarification instead of guessing.
- Keep preambles, spoken bridges, tool-related messages, and final answers in the same language.
- Accent adaptation must not change the response language.
```

### Chính sách đa ngôn ngữ

```
## Language

Default to English unless the user clearly uses another language.

Switch languages only when:

- the user explicitly asks to use another language;
- the user provides a substantive utterance in another language. A substantive utterance means the user gives a complete request, question, or correction in another language, not just a greeting, name, address, filler word, or borrowed phrase.

Do not switch languages based on:

- accent;
- pronunciation;
- filler words;
- short backchannels;
- names;
- addresses;
- isolated foreign words.

If uncertain, ask:

"Would you like me to continue in English or [LANGUAGE]?"
```

### Kiểm soát giọng (accent)

`gpt-realtime-2` có thể tuân theo instruction về giọng mạnh hơn, nhưng prompt về accent quá mơ hồ có thể gây trôi giọng (drift) hoặc vô tình chuyển ngôn ngữ.

Prompt kiểm soát accent hoạt động tốt nhất khi chỉ rõ:

- accent mục tiêu;
- những đặc điểm nào cần giữ ổn định;
- nhịp điệu, trọng âm, ngữ điệu (prosody) mong muốn;
- việc điều chỉnh accent có ảnh hưởng tới lựa chọn ngôn ngữ hay không.

Thay vì:

```
Sound Australian.
```

Hãy dùng:

```
## Accent

Speak English with a light Australian accent.

- Keep the accent stable from the first word to the last.
- Use natural Australian vowel shaping, but keep speech easy to understand.
- Do not exaggerate the accent.
- Do not change response language based on the user's accent.
```

### Custom Voices

Dùng [Custom Voices](https://developers.openai.com/blog/updates-audio-models#custom-voices) khi các giọng chuẩn không đáp ứng được yêu cầu về thương hiệu, accent, hoặc nhân vật.

Prompting có thể điều chỉnh accent, nhịp độ, và cách truyền tải, nhưng không thể thay thế hoàn toàn việc thiết kế giọng. Với các use case cần bản sắc giọng nói theo thương hiệu nhất quán hoặc độ trung thực accent cao, hãy cân nhắc dùng Custom Voices.

Custom Voices hiện chỉ dành cho khách hàng được duyệt riêng. Liên hệ đội ngũ account của OpenAI để được cấp quyền.

## 14. Duy trì trạng thái trong phiên dài

`gpt-realtime-2` mở rộng context window realtime từ 32k lên 128k token, phù hợp hơn cho phiên dài. Với hội thoại hai chiều dày đặc, 128k token tương đương khoảng 1–2 giờ audio thô liên tục. Con số này thay đổi tuỳ theo mức dùng tool, suy luận nội bộ, dữ liệu bơm vào (injected record), và các yếu tố khác của phiên.

Với các use case context dài, `gpt-realtime-2` hoạt động tốt nhất khi biết rõ thông tin nào là hiện hành, thông tin nào là nền (background), và nên bỏ qua thông tin nào khi các nguồn mâu thuẫn nhau. Đừng để model tự suy ra thứ tự ưu tiên nguồn từ một transcript thô hoặc một khối context khổng lồ — hãy **cấu trúc hoá** nó.

Dùng một mẫu có cấu trúc khi bắt đầu phiên với lượng context lớn, ví dụ: hồ sơ đã tra cứu, lịch sử hội thoại trước đó, chính sách, tóm tắt, ghi chú tài khoản, hoặc tài liệu nền.

Mẫu template cho context phiên dài:

```
## Context

### Current State

- **Current task:** [current task]
- **Latest known state:** [current value]
- **Next safe step:** [what the assistant should do next]

### Authoritative Sources

- **Fact or record:** [fact or record]
- **Source:** [tool result / active policy / verified record]
- **Status:** current
- **Retrieved:** [date/time or this turn]

### Historical or Background Sources

- **Older fact or record:** [older fact or record]
- **Source:** [prior conversation / older record / summary]
- **Status:** stale or background
- **Note:** Do not use for current decisions if it conflicts with a current source.

### Relevant Policy or Rules

- [decision rule or constraint]

### Other Context

- [potentially useful but non-authoritative background]
```

> **Liên hệ với project này:** ghi nhớ trong `MEMORY.md` "transcript chỉ để debug — không xây logic nghiệp vụ dựa trên input transcript" cũng cùng tinh thần với nguyên tắc này: không để model tự suy ra ưu tiên nguồn từ một đống transcript thô.

## 15. Di chuyển (migrate) từ các model realtime cũ hơn

Khi migrate từ các model realtime cũ, hãy xem prompt là một **bề mặt hành vi** (behavior surface), không chỉ đơn thuần là văn bản cần chuyển sang.

1. Dùng Codex hoặc một reasoning model mạnh để tái cấu trúc prompt theo hướng dẫn prompting realtime mới nhất. Đính kèm link tới tài liệu hướng dẫn này để việc migrate bám sát best practice.
2. Đặt reasoning effort về `low` thay vì mặc định. Chỉ tăng lên với các luồng nghiệp vụ thực sự cần lập kế hoạch sâu.
3. Rà soát tên tool, tham số, enum, JSON schema, và các cấu hình khác để đảm bảo khớp với implementation thực tế.
4. Loại bỏ các ví dụ đã cũ. Thêm ví dụ ngắn cho happy path, tình huống mơ hồ, bị ngắt lời (interruption), gọi tool, và hành vi fallback.
5. So sánh các hội thoại tiêu biểu trước và sau khi migrate. Kiểm tra hồi quy (regression) so với eval hiện có và ghi lại các thay đổi hành vi có chủ đích.
6. Chạy một lượt rà soát tính nhất quán cuối cùng. Xác nhận prompt phân tách rõ ràng giữa: yêu cầu bắt buộc, hành vi mặc định, quy tắc tool, quy tắc an toàn, và hành vi fallback.
7. Chạy eval, kiểm tra các trường hợp lỗi tiêu biểu, và lặp lại việc chỉnh prompt cho tới khi hành vi mục tiêu ổn định.

```
# Role & Objective        — who you are and what "success" means
# Personality & Tone      — the voice and style to maintain
# Context                 — retrieved context, relevant info
# Reference Pronunciations — phonetic guides for tricky words
# Tools                   — names, usage rules, and preambles
# Instructions / Rules    — do's, don'ts, and approach
# Conversation Flow       — states, goals, and transitions
# Safety & Escalation     — fallback and handoff logic
```

---

Phần dưới đây là các mục chi tiết hơn theo từng thành phần của prompt (áp dụng chung cho cả `gpt-realtime-1.5` và các bản trước), kèm ví dụ trước/sau khi áp dụng instruction.

## 16. Role and Objective

Mục này định nghĩa trợ lý là ai và "hoàn thành" (done) nghĩa là gì. Hai ví dụ dưới đây minh hoạ hai nhân dạng khác nhau, cho thấy model bám sát Role/Objective chặt chẽ tới mức nào khi được nêu tường minh.

- **Dùng khi nào:** model không nhập đúng vai (persona), vai trò, hoặc phạm vi tác vụ bạn cần.
- **Tác dụng:** "ghim" nhân dạng của voice agent để mọi câu trả lời được điều kiện hoá theo đúng mô tả vai trò đó.
- **Cách điều chỉnh:** sửa vai trò tuỳ theo use case của bạn.

Ví dụ (model nhập một giọng/accent cụ thể):

```
# Role & Objective
You are a Quebecois French-speaking customer service bot. Your task is to answer the user's question.
```

Ví dụ (model nhập một nhân vật):

```
# Role & Objective
You are a high-energy game-show host guiding the caller to guess a secret number from 1 to 100 to win 1,000,000$.
```

`gpt-realtime-1.5` có khả năng nhập vai theo đúng chỉ định một cách đáng tin cậy hơn so với các model realtime preview trước đó.

## 17. Personality and Tone

`gpt-realtime-1.5` tuân theo instruction tốt khi giả lập một tính cách (personality) hoặc tông giọng (tone) cụ thể. Bạn có thể tuỳ chỉnh trải nghiệm giọng nói và cách truyền tải theo đúng kỳ vọng của use case.

- **Dùng khi nào:** câu trả lời có vẻ nhạt, dài dòng, hoặc không nhất quán qua các lượt nói.
- **Tác dụng:** thiết lập giọng nói, độ ngắn gọn, và nhịp độ để câu trả lời nghe tự nhiên và nhất quán.
- **Cách điều chỉnh:** điều chỉnh mức độ ấm áp/trang trọng và độ dài mặc định. Với các lĩnh vực bị quản lý chặt (regulated domain), nên ưu tiên sự chính xác trung tính. Có thể thêm các mục con khác phù hợp với use case.

Ví dụ:

```
# Personality & Tone
## Personality
- Friendly, calm and approachable expert customer service assistant.

## Tone
- Warm, concise, confident, never fawning.

## Length
2–3 sentences per turn.
```

Ví dụ (nhiều cảm xúc trong một lượt):

```
# Personality & Tone
- Start your response very happy
- Midway, change to sad
- At the end change your mood to very angry
```

`gpt-realtime-1.5` có thể tuân theo instruction phức tạp này và chuyển đổi giữa ba trạng thái cảm xúc xuyên suốt một câu trả lời audio.

### Chỉ dẫn về tốc độ nói (Speed Instructions)

Trong Realtime API, tham số `speed` chỉ thay đổi **tốc độ phát lại (playback rate)**, không thay đổi cách model tạo câu nói. Để thực sự nghe "nhanh" hơn, cần thêm instruction hướng dẫn về nhịp độ (pacing).

- **Dùng khi nào:** người dùng muốn giọng nói nhanh hơn; chỉ dùng tham số `speed` khi phát lại không đủ để đạt hiệu quả này.
- **Tác dụng:** điều chỉnh phong cách nói (độ ngắn gọn, nhịp độ) độc lập với tốc độ phát lại phía client.
- **Cách điều chỉnh:** sửa instruction về pacing theo yêu cầu của use case.

Ví dụ:

```
# Personality & Tone
## Personality
- Friendly, calm and approachable expert customer service assistant.

## Tone
- Warm, concise, confident, never fawning.

## Length
- 2–3 sentences per turn.

## Pacing
- Deliver your audio response fast, but do not sound rushed.
- Do not modify the content of your response, only increase speaking speed for the same response.
```

Với instruction pacing tường minh, `gpt-realtime-1.5` có thể tạo ra nhịp độ nhanh hơn rõ rệt mà không nghe vội vàng.

### Ràng buộc ngôn ngữ (Language Constraint)

Ràng buộc ngôn ngữ đảm bảo model luôn trả lời đúng ngôn ngữ mong muốn, kể cả trong điều kiện khó như tạp âm nền hoặc input đa ngôn ngữ.

- **Dùng khi nào:** để tránh việc model vô tình chuyển ngôn ngữ trong môi trường đa ngôn ngữ hoặc nhiều tạp âm.
- **Tác dụng:** khoá output vào một ngôn ngữ được chọn để tránh đổi ngôn ngữ ngoài ý muốn.
- **Cách điều chỉnh:** đổi "English" thành ngôn ngữ mục tiêu; hoặc thêm instruction phức tạp hơn tuỳ use case.

Ví dụ (ghim vào một ngôn ngữ):

```
# Personality & Tone
## Personality
- Friendly, calm and approachable expert customer service assistant.

## Tone
- Warm, concise, confident, never fawning.

## Length
- 2–3 sentences per turn.

## Language
- The conversation will be only in English.
- Do not respond in any other language even if the user asks.
- If the user speaks another language, politely explain that support is limited to English.
```

Ví dụ (model dùng để dạy ngôn ngữ):

```
# Role & Objective
- You are a friendly, knowledgeable voice tutor for French learners.
- Your goal is to help the user improve their French speaking and listening skills through engaging conversation and clear explanations.
- Balance immersive French practice with supportive English guidance to ensure understanding and progress.

# Personality & Tone
## Personality
- Friendly, calm and approachable expert customer service assistant.

## Tone
- Warm, concise, confident, never fawning.

## Length
- 2–3 sentences per turn.

## Language
### Explanations
Use English when explaining grammar, vocabulary, or cultural context.

### Conversation
Speak in French when conducting practice, giving examples, or engaging in dialogue.
```

Model có thể "code-switch" (chuyển đổi qua lại) giữa hai ngôn ngữ dựa trên instruction tuỳ chỉnh.

### Giảm lặp lại (Reduce Repetition)

Realtime model có thể bám sát các câu mẫu (sample phrase) để giữ đúng phong cách thương hiệu, nhưng có thể lạm dụng chúng, khiến câu trả lời nghe máy móc và lặp lại. Thêm một quy tắc chống lặp giúp duy trì sự đa dạng mà vẫn giữ được sự rõ ràng và giọng thương hiệu.

- **Dùng khi nào:** output cứ lặp lại các câu mở đầu, từ đệm, hoặc cấu trúc câu giống nhau qua các lượt hoặc các phiên.
- **Tác dụng:** thêm ràng buộc về sự đa dạng — hạn chế lặp cụm từ, gợi ý dùng từ đồng nghĩa và cấu trúc câu khác, đồng thời giữ nguyên các cụm từ bắt buộc.
- **Cách điều chỉnh:** điều chỉnh mức độ chặt chẽ (ví dụ: "không dùng lại cùng một câu mở đầu quá 1 lần trong N lượt"), liệt kê các cụm từ bắt buộc giữ nguyên (pháp lý/tuân thủ/thương hiệu), và cho phép diễn đạt chặt hơn ở những chỗ cần sự nhất quán.

Ví dụ:

```
# Personality & Tone
## Personality
- Friendly, calm and approachable expert customer service assistant.

## Tone
- Warm, concise, confident, never fawning.

## Length
- 2–3 sentences per turn.

## Language
- The conversation will be only in English.
- Do not respond in any other language even if the user asks.
- If the user speaks another language, politely explain that support is limited to English.

## Variety
- Do not repeat the same sentence twice.
- Vary your responses so they don't sound robotic.
```

Trước khi áp dụng instruction, model liên tục lặp lại cùng một câu xác nhận: `Got it`. Sau khi áp dụng, model có thể đa dạng hoá câu xác nhận và không còn nghe máy móc nữa.

## 18. Reference Pronunciations

Mục này hướng dẫn cách đảm bảo model phát âm đúng những từ, con số, tên riêng, và thuật ngữ quan trọng khi tương tác bằng giọng nói.

- **Dùng khi nào:** tên thương hiệu, thuật ngữ kỹ thuật, hoặc địa danh thường bị phát âm sai.
- **Tác dụng:** cải thiện độ tin cậy và sự rõ ràng nhờ gợi ý ngữ âm.
- **Cách điều chỉnh:** giữ danh sách ngắn gọn; cập nhật khi nghe thấy lỗi phát âm mới.

Ví dụ:

```
# Reference Pronunciations
When voicing these words, use the respective pronunciations:
- Pronounce "SQL" as "sequel."
- Pronounce "PostgreSQL" as "post-gress."
- Pronounce "Kyiv" as "KEE-iv."
- Pronounce "Huawei" as "HWAH-way"
```

Với instruction phát âm tham chiếu này, `gpt-realtime-1.5` có thể phát âm đúng "SQL" thành "sequel".

### Phát âm chuỗi chữ-số (Alphanumeric Pronunciations)

Realtime speech-to-speech có thể làm mờ hoặc gộp lẫn chữ số/chữ cái khi đọc lại thông tin quan trọng (số điện thoại, số thẻ, mã đơn hàng). Yêu cầu xác nhận rõ ràng từng ký tự giúp tránh nghe nhầm và tạo ra giọng nói rõ ràng hơn.

- **Dùng khi nào:** model gặp khó khăn khi thu thập hoặc đọc lại số điện thoại, số thẻ, mã 2FA, mã đơn hàng, số serial, địa chỉ, số căn hộ, hoặc chuỗi chữ-số hỗn hợp.
- **Tác dụng:** buộc model đọc từng ký tự một kèm dấu phân cách, sau đó xác nhận với người dùng và xác nhận lại sau khi có chỉnh sửa. Có thể dùng thêm cách phát âm đối chiếu cho chữ cái (ví dụ: "A như trong Alpha").

Ví dụ (mục instruction chung):

```
# Instructions/Rules
- When reading numbers or codes, speak each character separately, separated by hyphens (e.g., 4-1-5).
- Repeat EXACTLY the provided number; do not omit any digits.
```

> **Mẹo:** Nếu bạn đang dùng chiến lược prompt theo conversation flow, có thể chỉ định trạng thái hội thoại nào cần áp dụng instruction phát âm chuỗi chữ-số này.

Ví dụ (instruction đặt trong một trạng thái hội thoại cụ thể — lấy từ prompt mẫu [openai-realtime-agents](https://github.com/openai/openai-realtime-agents/blob/main/src/app/agentConfigs/customerServiceRetail/authentication.ts)):

```json
{
    "id": "3_get_and_verify_phone",
    "description": "Request phone number and verify by repeating it back.",
    "instructions": [
      "Politely request the user's phone number.",
      "Once provided, confirm it by repeating each digit and ask if it's correct.",
      "If the user corrects you, confirm AGAIN to make sure you understand.",
    ],
    "examples": [
      "I'll need some more information to access your account if that's okay. May I have your phone number, please?",
      "You said 0-2-1-5-5-5-1-2-3-4, correct?",
      "You said 4-5-6-7-8-9-0-1-2-3, correct?"
    ],
    "transitions": [{
      "next_step": "4_authentication_DOB",
      "condition": "Once phone number is confirmed"
    }]
}
```

Trước khi áp dụng instruction: *"Sure! The number is 55119765423. Let me know if you need anything else!"*

Sau khi áp dụng instruction: *"Sure! The number is: 5-5-1-1-1-9-7-6-5-4-2-3. Please let me know if you need anything else!"*

## 19. Instructions

Mục này bao gồm các hướng dẫn giúp model giải quyết đúng tác vụ, áp dụng best practice, và sửa các vấn đề có thể gặp phải.

Không ngạc nhiên khi các pattern prompting được khuyến nghị ở đây khá giống với [hướng dẫn prompting cho GPT-4.1](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide).

### Tuân theo instruction (Instruction Following)

Giống GPT-4.1 và GPT-5, nếu instruction mâu thuẫn, mơ hồ, hoặc không rõ ràng, `gpt-realtime-1.5` sẽ hoạt động kém hơn.

- **Dùng khi nào:** output đi lệch khỏi quy tắc, bỏ qua bước, hoặc dùng sai tool.
- **Tác dụng:** dùng một LLM khác để chỉ ra sự mơ hồ, mâu thuẫn, và các định nghĩa còn thiếu trước khi đưa prompt vào production.

**Prompt kiểm tra chất lượng instruction (dùng trên ChatGPT hoặc qua API):**

Dùng prompt sau với GPT-5 để tìm ra những điểm có vấn đề trong prompt của bạn để sửa lại.

```
## Role & Objective
You are a **Prompt-Critique Expert**.
Examine a user-supplied LLM prompt and surface any weaknesses following the instructions below.

## Instructions
Review the prompt that is meant for an LLM to follow and identify the following issues:
- Ambiguity: Could any wording be interpreted in more than one way?
- Lacking Definitions: Are there any class labels, terms, or concepts that are not defined that might be misinterpreted by an LLM?
- Conflicting, missing, or vague instructions: Are directions incomplete or contradictory?
- Unstated assumptions: Does the prompt assume the model has to be able to do something that is not explicitly stated?

## Do **NOT** list issues of the following types:
- Invent new instructions, tool calls, or external information. You do not know what tools need to be added that are missing.
- Issues that you are unsure about.

## Output Format
"""
# Issues
- Numbered list; include brief quote snippets.

# Improvements
- Numbered list; provide the revised lines you would change and how you would change them.

# Revised Prompt
- Revised prompt where you have applied all your improvements surgically with minimal edits to the original prompt
"""
```

**Meta-prompt tối ưu hoá prompt (dùng trên ChatGPT hoặc qua API):**

Meta-prompt này giúp bạn cải thiện system prompt gốc bằng cách nhắm vào một kiểu lỗi cụ thể. Cung cấp prompt hiện tại và mô tả vấn đề bạn đang gặp, model (GPT-5) sẽ gợi ý các biến thể tinh chỉnh để siết chặt ràng buộc và giảm vấn đề đó.

```
Here's my current prompt to an LLM:
[BEGIN OF CURRENT PROMPT]
{CURRENT_PROMPT}
[END OF CURRENT PROMPT]

But I see this issue happening from the LLM:
[BEGIN OF ISSUE]
{ISSUE}
[END OF ISSUE]
Can you provide some variants of the prompt so that the model can better understand the constraints to alleviate the issue?
```

### Không có audio hoặc audio không rõ

Đôi khi model "nghĩ" nó nghe thấy điều gì đó và cố trả lời. Bạn có thể thêm instruction tuỳ chỉnh để chỉ dẫn model cách hành xử khi nghe audio không rõ hoặc input không xác định. Điều chỉnh hành vi mong muốn theo use case — ví dụ, bạn có thể muốn model lặp lại cùng câu hỏi thay vì hỏi làm rõ.

- **Dùng khi nào:** tạp âm nền, từ bị cắt nửa chừng, hoặc im lặng kích hoạt phản hồi không mong muốn.
- **Tác dụng:** ngăn các phản hồi giả (spurious response) và tạo ra cách hỏi làm rõ mượt mà.
- **Cách điều chỉnh:** chọn giữa việc hỏi làm rõ hay lặp lại câu hỏi trước đó, tuỳ use case.

Ví dụ (ho hoặc audio không rõ):

```
# Instructions/Rules
...

## Unclear audio
- Always respond in the same language the user is speaking in, if unintelligible.
- Only respond to clear audio or text.
- If the user's audio is not clear (e.g. ambiguous input/background noise/silent/unintelligible) or if you did not fully hear or understand the user, ask for clarification using {preferred_language} phrases.
```

Với instruction này, model sẽ hỏi làm rõ sau một tiếng ho lớn hoặc audio không rõ, thay vì cố đoán.

### Nhạc nền hoặc âm thanh lạ

Đôi khi model có thể vô tình tạo ra nhạc nền, tiếng ngân nga, âm thanh có nhịp điệu, hoặc các âm thanh lạ khác trong lúc sinh giọng nói. Những artifact này có thể làm giảm độ rõ ràng, gây xao nhãng, hoặc khiến trợ lý nghe kém chuyên nghiệp. Instruction dưới đây giúp ngăn hoặc giảm đáng kể tình trạng này.

- **Dùng khi nào:** khi bạn quan sát thấy các yếu tố âm nhạc hoặc hiệu ứng âm thanh ngoài ý muốn trong câu trả lời audio Realtime.
- **Tác dụng:** hướng model tránh sinh ra các artifact âm thanh không mong muốn này.
- **Cách điều chỉnh:** điều chỉnh instruction để cố gắng loại trừ tường minh các kiểu âm thanh cụ thể bạn đang gặp phải.

Ví dụ:

```
# Instructions/Rules
...
- Do not include any sound effects or onomatopoeic expressions in your responses.
```

## 20. Tools

Dùng mục này để hướng dẫn model cách sử dụng các function/tool của bạn. Chỉ rõ khi nào nên và không nên gọi tool, cần thu thập tham số nào, nói gì trong lúc tool đang chạy, và cách xử lý lỗi hoặc kết quả một phần.

### Chọn tool (Tool Selection)

`gpt-realtime-1.5` bám sát instruction khá chặt. Tuy nhiên, nếu instruction mâu thuẫn với những gì model thực sự có quyền truy cập — ví dụ prompt nhắc tới tool nhưng tool đó KHÔNG có trong danh sách tool được truyền vào — điều này có thể dẫn tới phản hồi sai.

- **Dùng khi nào:** prompt nhắc tới các tool thực tế không khả dụng.
- **Tác dụng:** rà soát các tool khả dụng và system prompt để đảm bảo chúng khớp nhau.

Ví dụ:

```
# Tools
## lookup_account(email_or_phone)
...

## check_outage(address)
...
```

Cần đảm bảo cùng bộ tool đó thực sự khả dụng và **các mô tả không mâu thuẫn nhau**:

```json
[
{
    "name": "lookup_account",
    "description": "Retrieve a customer account using either an email or phone number to enable verification and account-specific actions.",
    "parameters": {
      ...
  },
{
    "name": "check_outage",
    "description": "Check for network outages affecting a given service address and return status and ETA if applicable.",
    "parameters": {
      ...
  }
]
```

### Preamble trước khi gọi tool (Tool Call Preambles)

Một số use case được lợi khi Realtime model vừa nói vừa gọi tool cùng lúc. Điều này tạo trải nghiệm người dùng tốt hơn, che bớt độ trễ cảm nhận được. Bạn có thể điều chỉnh câu mẫu cho phù hợp use case.

- **Dùng khi nào:** người dùng cần được xác nhận ngay lập tức cùng lúc với việc gọi tool; giúp che độ trễ.
- **Tác dụng:** thêm một preamble ngắn, nhất quán trước khi gọi tool.

Ví dụ:

```
# Tools
- Before any tool call, say one short line like "I'm checking that now." Then call the tool immediately.
```

Với instruction này, model xuất ra câu trả lời audio "I'm checking that right now" cùng lúc với việc gọi tool.

#### Preamble trước tool call + câu mẫu (Sample Phrases)

Nếu bạn muốn kiểm soát chặt chẽ hơn loại câu mà model nói ra cùng lúc với việc gọi tool, có thể thêm câu mẫu ngay trong mô tả (description) của tool spec.

Ví dụ:

```python
tools = [
    {
        "name": "lookup_account",
        "description": """Retrieve a customer account using either an email or phone number to enable verification and account-specific actions.

Preamble sample phrases:
- For security, I'll pull up your account using the email on file.
- Let me look up your account by {email} now.
- I'm fetching the account linked to {phone} to verify access.
- One moment—I'm opening your account details.""",
        "parameters": {
            "type": "object",
            "properties": {
                "email": {"type": "string"},
                "phone": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "check_outage",
        "description": """Check for network outages affecting a given service address and return status and ETA if applicable.

Preamble sample phrases:
- I'll check for any outages at {service_address} right now.
- Let me look up network status for your area.
- I'm checking whether there's an active outage impacting your address.
- One sec—verifying service status and any posted ETA.""",
        "parameters": {
            "type": "object",
            "properties": {
                "service_address": {"type": "string"},
            },
            "required": ["service_address"],
            "additionalProperties": False,
        },
    },
]
```

### Gọi tool không cần xác nhận (Tool Calls Without Confirmation)

Đôi khi model sẽ hỏi xác nhận trước khi gọi tool. Với một số use case, điều này gây trải nghiệm không tốt cho người dùng cuối vì model tỏ ra thiếu chủ động.

- **Dùng khi nào:** trợ lý xin phép trước cả những tool call hiển nhiên.
- **Tác dụng:** loại bỏ các vòng lặp xác nhận không cần thiết.

Ví dụ:

```
# Tools
- When calling a tool, do not ask for any user confirmation. Be proactive
```

Với instruction này, model không tạo ra phản hồi audio nào — nó gọi thẳng tool tương ứng.

> **Mẹo:** nếu bạn nhận thấy model quá vội vàng khi gọi tool, hãy thử làm mềm câu chữ. Ví dụ, thay các từ mạnh như "proactive" bằng từ nhẹ nhàng hơn có thể giúp model tiếp cận điềm tĩnh và ít vội vàng hơn.

### Hiệu năng gọi tool (Tool Call Performance)

Khi use case ngày càng phức tạp và số lượng tool khả dụng tăng lên, việc hướng dẫn tường minh model biết khi nào dùng từng tool — và quan trọng không kém, khi nào **không** dùng — trở nên rất quan trọng. Các quy tắc sử dụng rõ ràng không chỉ cải thiện độ chính xác khi gọi tool mà còn giúp model chọn đúng tool vào đúng thời điểm.

- **Dùng khi nào:** model đang gặp khó khăn về hiệu năng gọi tool và cần instruction tường minh để giảm lạm dụng.
- **Tác dụng:** thêm instruction về khi nào "dùng/tránh" mỗi tool. Bạn cũng có thể thêm instruction về thứ tự gọi tool (sau Tool call A, có thể gọi Tool call B hoặc C).

Ví dụ:

```
# Tools
- When you call any tools, you must output at the same time a response letting the user know that you are calling the tool.

## lookup_account(email_or_phone)
Use when: verifying identity or viewing plan/outage flags.
Do NOT use when: the user is clearly anonymous and only asks general questions.

## check_outage(address)
Use when: user reports connectivity issues or slow speeds.
Do NOT use when: question is billing-only.

## refund_credit(account_id, minutes)
Use when: confirmed outage > 240 minutes in the past 7 days.
Do NOT use when: outage is unconfirmed; route to Diagnose → check_outage first.

## schedule_technician(account_id, window)
Use when: repeated failures after reboot and outage status = false.
Do NOT use when: outage status = true (send status + ETA instead).

## escalate_to_human(account_id, reason)
Use when: user seems very frustrated, abuse/harassment, repeated failures, billing disputes >$50, or user requests escalation.
```

> **Mẹo:** nếu một tool call có thể lỗi một cách khó lường, hãy thêm instruction xử lý lỗi rõ ràng để model phản hồi mượt mà hơn.

### Hành vi theo từng tool (Tool Level Behavior)

Bạn có thể tinh chỉnh hành vi của model cho từng tool cụ thể thay vì áp một quy tắc chung cho tất cả. Ví dụ, bạn có thể muốn các tool READ được gọi chủ động, còn tool WRITE cần xác nhận tường minh.

- **Dùng khi nào:** instruction chung về sự chủ động, xác nhận, hoặc preamble không phù hợp với mọi tool.
- **Tác dụng:** thêm quy tắc hành vi theo từng tool, định nghĩa rõ model nên gọi tool ngay, xác nhận trước, hay nói một preamble trước khi gọi.

Ví dụ:

```
# TOOLS
- For the tools marked PROACTIVE: do not ask for confirmation from the user and do not output a preamble.
- For the tools marked as CONFIRMATION FIRST: always ask for confirmation to the user.
- For the tools marked as PREAMBLES: Before any tool call, say one short line like "I'm checking that now." Then call the tool immediately.

## lookup_account(email_or_phone) — PROACTIVE
Use when: verifying identity or accessing billing.
Do NOT use when: caller refuses to identify after second request.

## check_outage(address) — PREAMBLES
Use when: caller reports failed connection or speed lower than 10 Mbps.
Do NOT use when: purely billing OR when internet speed is above 10 Mbps.
If either condition applies, inform the customer you cannot assist and hang up.

## refund_credit(account_id, minutes) — CONFIRMATION FIRST
Use when: confirmed outage > 240 minutes in the past 7 days (credit 60 minutes).
Do NOT use when: outage unconfirmed.
Confirmation phrase: "I can issue a credit for this outage—would you like me to go ahead?"

## schedule_technician(account_id, window) — CONFIRMATION FIRST
Use when: reboot + line checks fail AND outage=false.
Windows: "10am–12pm ET" or "2pm–4pm ET".
Confirmation phrase: "I can schedule a technician to visit—should I book that for you?"

## escalate_to_human(account_id, reason) — PREAMBLES
Use when: harassment, threats, self-harm, repeated failure, billing disputes > $50, caller is frustrated, or caller requests escalation.
Preamble: "Let me connect you to a senior agent who can assist further."
```

### Định dạng kết quả tool (Tool Output Formatting)

Một số kết quả tool, đặc biệt là các chuỗi dài cần được lặp lại nguyên văn, có thể "lệch phân phối" (out-of-distribution) đối với model. Trong quá trình huấn luyện, kết quả tool thường có dạng JSON object với các field được đặt tên. Nếu tool của bạn trả về một chuỗi thô và yêu cầu riêng model "lặp lại chính xác", model dễ có xu hướng diễn giải lại (paraphrase), cắt bớt (truncation), hoặc trộn lẫn phần nói dẫn (preamble) của chính nó vào.

Cách khắc phục thực tế là làm cho kết quả tool trông giống một kết quả tool bình thường, và làm cho yêu cầu "lặp nguyên văn" trở nên tường minh với máy (machine-explicit).

- **Dùng khi nào:** một tool trả về nội dung có cấu trúc dài hoặc phức tạp (instruction nhiều câu, gói bàn giao — handoff packet, ID/link, tóm tắt chính sách, quy trình nhiều bước...) và bạn quan sát thấy hiện tượng **cắt bớt, diễn giải lại, mất field, đảo thứ tự, hoặc model trộn lẫn commentary/preamble của riêng nó vào**.

- **Tác dụng:** bọc kết quả tool trong một **JSON envelope nhỏ, tường minh** (ví dụ: `response_text` cùng các cờ như `require_repeat_verbatim`, `format`, hoặc `content_type`) để câu trả lời trông "trong phân phối" (in-distribution) hơn và hành vi cần thực hiện trở nên **rõ ràng với máy**.

- **Cách điều chỉnh:** giữ schema **tối giản và ổn định**. Ghi rõ hình dạng (shape) kết quả tool mong muốn cả trong **instruction của mục Tools** lẫn ngay cạnh **định nghĩa tool** (ví dụ: "Nếu `require_repeat_verbatim` là true, hãy xuất ra chính xác `response_text` và không gì khác", hoặc "Hiển thị `response_text` nguyên trạng; không thêm, bớt, hay đảo thứ tự field từ kết quả tool.").

#### Ví dụ: chuỗi thô (dễ gây lỗi hơn)

Tool trả về:

```
I just sent you an email with the verification link. Please open it and click "Confirm".
```

Model đôi khi nói:

- "I've emailed you a verification link…" (diễn giải lại)
- Bỏ mất câu cuối (cắt bớt)
- Thêm bình luận thừa ("Can I help with anything else?")

#### Ví dụ: JSON được bọc (trong phân phối hơn, đáng tin cậy hơn)

Tool trả về:

```json
{
  "response_text": "I just sent you an email with the verification link. Please open it and click “Confirm”.",
  "require_repeat_verbatim": true
}
```

Vì kết quả này trông giống một kết quả tool điển hình (JSON object), model thường dễ dàng hơn khi:

- nhận diện đâu là nội dung "chính thức, có thẩm quyền" (`response_text`)
- hiểu ràng buộc về cách thể hiện (`require_repeat_verbatim`)
- tái tạo lại kết quả tool một cách sạch sẽ, không cắt bớt hay thêm bình luận thừa

### Tool "Rephrase Supervisor" (kiến trúc Responder–Thinker)

Trong nhiều hệ thống voice, realtime model đóng vai trò **responder** (nói chuyện với người dùng), trong khi một text model mạnh hơn đóng vai trò **thinker** (lập kế hoạch, tra cứu chính sách, hoàn thành SOP). Câu trả lời dạng văn bản không tự động phù hợp để nói ra, nên responder cần diễn đạt lại (rephrase) văn bản của thinker thành một câu trả lời thân thiện với giọng nói trước khi sinh audio.

- **Dùng khi nào:** khi output nói của responder nghe máy móc, quá dài, hoặc gượng gạo sau khi nhận câu trả lời từ thinker.
- **Tác dụng:** thêm instruction rõ ràng hướng dẫn responder diễn đạt lại văn bản của thinker thành một câu trả lời ngắn, tự nhiên, ưu tiên cho giọng nói.
- **Cách điều chỉnh:** điều chỉnh phong cách diễn đạt, câu mở đầu, và giới hạn độ ngắn gọn theo kỳ vọng use case.

Ví dụ:

```
# Tools
## Supervisor Tool
Name: getNextResponseFromSupervisor(relevantContextFromLastUserMessage: string)

When to call:
- Any request outside the allow list.
- Any factual, policy, account, or process question.
- Any action that might require internal lookups or system changes.

When not to call:
- Simple greetings and basic chitchat.
- Requests to repeat or clarify.
- Collecting parameters for later Supervisor use:
  - phone_number for account help (getUserAccountInfo)
  - zip_code for store lookup (findNearestStore)
  - topic or keyword for policy lookup (lookupPolicyDocument)

Usage rules and preamble:
1) Say a neutral filler phrase to the user, then immediately call the tool. Approved fillers: "One moment.", "Let me check.", "Just a second.", "Give me a moment.", "Let me see.", "Let me look into that." Fillers must not imply success or failure.
2) Do not mention the "Supervisor" when responding with filler phrase.
3) relevantContextFromLastUserMessage is a one-line summary of the latest user message; use an empty string if nothing salient.
4) After the tool returns, apply Rephrase Supervisor and send your reply.

### Rephrase Supervisor
- Start with a brief conversational opener using active language, then flow into the answer (for example: "Thanks for waiting—", "Just finished checking that.", "I've got that pulled up now.").
- Keep it short: no more than 2 sentences.
- Use this template: opener + one-sentence gist + up to 3 key details + a quick confirmation or choice (for example: "Does that match what you expected?", "Want me to review options?").
- Read numbers for speech: money naturally ("$45.20" → "forty-five dollars and twenty cents"), phone numbers 3-3-4, addresses with individual digits, dates/times plainly ("August twelfth", "three-thirty p.m.").
```

Ví dụ không dùng instruction diễn đạt lại:
> Assistant: Your current credit card balance is positive at 32,323,232 AUD.

Ví dụ tương tự nhưng có dùng instruction diễn đạt lại:
> Assistant: Just finished checking that—your credit card balance is thirty-two million three hundred twenty-three thousand two hundred thirty-two dollars in your favor. Your last payment was processed on August first. Does that match what you expected?

### Các tool phổ biến (Common Tools)

`gpt-realtime-1.5` đã được huấn luyện để dùng hiệu quả các tool phổ biến sau. Nếu use case của bạn cần hành vi tương tự, hãy giữ tên, tham số (signature), và mô tả càng gần các tool này càng tốt để tối đa hoá độ tin cậy và giữ prompt "trong phân phối" hơn.

Dưới đây là một số tool phổ biến quan trọng mà model đã được huấn luyện:

```
# answer(question: string)
Description: Call this when the customer asks a question that you don't have an answer to or asks to perform an action.

# escalate_to_human()
Description: Call this when a customer asks for escalation, or to talk to someone else, or expresses dissatisfaction with the call.

# finish_session()
Description: Call this when a customer says they're done with the session or doesn't want to continue. If it's ambiguous, confirm with the customer before calling.
```

## 21. Conversation Flow

Mục này mô tả cách cấu trúc hội thoại thành các giai đoạn (phase) rõ ràng, có mục tiêu cụ thể, để model biết chính xác cần làm gì ở từng bước. Nó định nghĩa mục đích của mỗi giai đoạn, instruction để đi qua giai đoạn đó, và "tiêu chí thoát" (exit criteria) cụ thể để chuyển sang giai đoạn tiếp theo. Cách này giúp tránh việc model bị kẹt, bỏ qua bước, hoặc nhảy cóc, đồng thời giữ hội thoại có tổ chức từ lời chào tới khi giải quyết xong.

Ngoài ra, việc tổ chức prompt thành các trạng thái hội thoại (conversation state) khác nhau cũng giúp dễ dàng xác định các kiểu lỗi (error mode) và lặp lại việc cải thiện hiệu quả hơn.

- **Dùng khi nào:** hội thoại có cảm giác thiếu tổ chức, bị kẹt trước khi đạt mục tiêu, hoặc model gặp khó khăn để hoàn thành mục tiêu một cách hiệu quả.
- **Tác dụng:** chia tương tác thành các giai đoạn có mục tiêu, instruction, và tiêu chí thoát rõ ràng.
- **Cách điều chỉnh:** đổi tên giai đoạn cho khớp với quy trình nghiệp vụ của bạn; sửa instruction cho từng giai đoạn theo đúng hành vi mong muốn; giữ "Exit when" cụ thể và tối giản.

Ví dụ:

```
# Conversation Flow
## 1) Greeting
Goal: Set tone and invite the reason for calling.
How to respond:
- Identify as NorthLoop Internet Support.
- Keep the opener brief and invite the caller's goal.
- Confirm that customer is a Northloop customer
Exit to Discovery: Caller states they are a Northloop customer and mentions an initial goal or symptom.

## 2) Discover
Goal: Classify the issue and capture minimal details.
How to respond:
- Determine billing vs connectivity with one targeted question.
- For connectivity: collect the service address.
- For billing/account: collect email or phone used on the account.
Exit when: Intent and address (for connectivity) or email/phone (for billing) are known.

## 3) Verify
Goal: Confirm identity and retrieve the account.
How to respond:
- Once you have email or phone, call lookup_account(email_or_phone).
- If lookup fails, try the alternate identifier once; otherwise proceed with general guidance or offer escalation if account actions are required.
Exit when: Account ID is returned.

## 4) Diagnose
Goal: Decide outage vs local issue.
How to respond:
- For connectivity, call check_outage(address).
- If outage=true, skip local steps; move to Resolve with outage context.
- If outage=false, guide a short reboot/cabling check; confirm each step's result before continuing.
Exit when: Root cause known.

## 5) Resolve
Goal: Apply fix, credit, or appointment.
How to respond:
- If confirmed outage > 240 minutes in the last 7 days, call refund_credit(account_id, 60).
- If outage=false and issue persists after basic checks, offer "10am–12pm ET" or "2pm–4pm ET" and call schedule_technician(account_id, chosen window).
- If the local fix worked, state the result and next steps briefly.
Exit when: A fix/credit/appointment has been applied and acknowledged by the caller.

## 6) Confirm/Close
Goal: Confirm outcome and end cleanly.
How to respond:
- Restate the result and any next step (e.g., stabilization window or tech ETA).
- Invite final questions; close politely if none.
Exit when: Caller declines more help.
```

### Câu mẫu (Sample Phrases)

Câu mẫu đóng vai trò "ví dụ neo" (anchor example) cho model. Chúng cho thấy phong cách, độ ngắn gọn, và tông giọng bạn muốn model đi theo, mà không khoá cứng nó vào một câu trả lời duy nhất.

- **Dùng khi nào:** câu trả lời thiếu phong cách thương hiệu hoặc không nhất quán.
- **Tác dụng:** cung cấp câu mẫu để model biến tấu nhưng vẫn giữ tự nhiên và ngắn gọn.
- **Cách điều chỉnh:** thay ví dụ cho phù hợp thương hiệu; giữ cảnh báo "không phải lúc nào cũng dùng y nguyên".

Ví dụ:

```
# Sample Phrases
- Below are sample examples that you should use for inspiration. DO NOT ALWAYS USE THESE EXAMPLES, VARY YOUR RESPONSES.

Acknowledgements: "On it." "One moment." "Good question."
Clarifiers: "Do you want A or B?" "What's the deadline?"
Bridges: "Here's the quick plan." "Let's keep it simple."
Empathy (brief): "That's frustrating—let's fix it."
Closers: "Anything else before we wrap?" "Happy to help next time."
```

> **Lưu ý:** nếu hệ thống giọng nói của bạn cứ lặp lại đúng nguyên các câu mẫu, khiến trải nghiệm nghe máy móc hơn, hãy thử thêm ràng buộc "Variety" (đa dạng hoá) như ở mục 17 — cách này đã được ghi nhận là khắc phục được vấn đề.

### Conversation Flow + Sample Phrases

Đây là một pattern hữu ích: thêm câu mẫu vào từng trạng thái của conversation flow để dạy model biết một câu trả lời tốt trông như thế nào:

```
# Conversation Flow
## 1) Greeting
Goal: Set tone and invite the reason for calling.
How to respond:
- Identify as NorthLoop Internet Support.
- Keep the opener brief and invite the caller's goal.
Sample phrases (do not always repeat the same phrases, vary your responses):
- "Thanks for calling NorthLoop Internet—how can I help today?"
- "You've reached NorthLoop Support. What's going on with your service?"
- "Hi there—tell me what you'd like help with."
Exit when: Caller states an initial goal or symptom.

## 2) Discover
Goal: Classify the issue and capture minimal details.
How to respond:
- Determine billing vs connectivity with one targeted question.
- For connectivity: collect the service address.
- For billing/account: collect email or phone used on the account.
Sample phrases (do not always repeat the same phrases, vary your responses):
- "Is this about your bill or your internet speed?"
- "What address are you using for the connection?"
- "What's the email or phone number on the account?"
Exit when: Intent and address (for connectivity) or email/phone (for billing) are known.

## 3) Verify
Goal: Confirm identity and retrieve the account.
How to respond:
- Once you have email or phone, call lookup_account(email_or_phone).
- If lookup fails, try the alternate identifier once; otherwise proceed with general guidance or offer escalation if account actions are required.
Sample phrases:
- "Thanks—looking up your account now."
- "If that doesn't pull up, what's the other contact—email or phone?"
- "Found your account. I'll take care of this."
Exit when: Account ID is returned.

## 4) Diagnose
Goal: Decide outage vs local issue.
How to respond:
- For connectivity, call check_outage(address).
- If outage=true, skip local steps; move to Resolve with outage context.
- If outage=false, guide a short reboot/cabling check; confirm each step's result before continuing.
Sample phrases (do not always repeat the same phrases, vary your responses):
- "I'm running a quick outage check for your area."
- "No outage reported—let's try a fast modem reboot."
- "Please confirm the modem lights: is the internet light solid or blinking?"
Exit when: Root cause known.

## 5) Resolve
Goal: Apply fix, credit, or appointment.
How to respond:
- If confirmed outage > 240 minutes in the last 7 days, call refund_credit(account_id, 60).
- If outage=false and issue persists after basic checks, offer "10am–12pm ET" or "2pm–4pm ET" and call schedule_technician(account_id, chosen window).
- If the local fix worked, state the result and next steps briefly.
Sample phrases (do not always repeat the same phrases, vary your responses):
- "There's been an extended outage—adding a 60-minute bill credit now."
- "No outage—let's book a technician. I can do 10am–12pm ET or 2pm–4pm ET."
- "Credit applied—you'll see it on your next bill."
Exit when: A fix/credit/appointment has been applied and acknowledged by the caller.

## 6) Confirm/Close
Goal: Confirm outcome and end cleanly.
How to respond:
- Restate the result and any next step (e.g., stabilization window or tech ETA).
- Invite final questions; close politely if none.
Sample phrases (do not always repeat the same phrases, vary your responses):
- "We're all set: [credit applied / appointment booked / service restored]."
- "You should see stable speeds within a few minutes."
- "Your technician window is 10am–12pm ET."
Exit when: Caller declines more help.
```

### Conversation Flow nâng cao (Advanced Conversation Flow)

Khi use case ngày càng phức tạp, bạn sẽ cần một cấu trúc có thể mở rộng mà vẫn giữ được hiệu quả của model. Điểm mấu chốt là cân bằng giữa khả năng bảo trì (maintainability) và sự đơn giản: quá nhiều trạng thái cứng nhắc có thể làm model quá tải, ảnh hưởng tới hiệu năng và khiến hội thoại nghe máy móc.

Cách tiếp cận tốt hơn là thiết kế các luồng giúp giảm độ phức tạp mà model "cảm nhận" được. Bằng cách quản lý trạng thái theo hướng có cấu trúc nhưng vẫn linh hoạt, bạn giúp model dễ tập trung và phản hồi tốt hơn, từ đó cải thiện trải nghiệm người dùng.

Hai pattern phổ biến để quản lý các tình huống phức tạp là:

1. Conversation Flow dưới dạng State Machine (máy trạng thái)
2. Conversation Flow động thông qua `session.update`

#### Conversation Flow dưới dạng State Machine

Định nghĩa hội thoại của bạn như một cấu trúc JSON mã hoá cả trạng thái (state) lẫn các chuyển tiếp (transition). Cách này giúp dễ dàng suy luận về độ bao phủ (coverage), xác định các trường hợp biên (edge case), và theo dõi thay đổi theo thời gian. Vì được lưu dưới dạng code, bạn có thể version hoá, diff, và...

> **[NỘI DUNG BỊ CẮT DO GIỚI HẠN CỦA CÔNG CỤ LẤY TRANG]** — đoạn tiếp theo (ví dụ JSON đầy đủ cho state machine, cùng toàn bộ mục "Conversation Flow động thông qua `session.update`") chưa lấy được trọn vẹn từ trang nguồn. Xem đầy đủ tại: [developers.openai.com/api/docs/guides/realtime-models-prompting](https://developers.openai.com/api/docs/guides/realtime-models-prompting) (mục "Advanced Conversation Flow").
>
> Ý tưởng chung của mục thứ hai ("Conversation Flow động thông qua `session.update`"): thay vì nhồi toàn bộ state machine tĩnh vào một system prompt duy nhất, dùng event `session.update` của Realtime API để cập nhật instruction và/hoặc danh sách tool đang hoạt động ngay giữa phiên — sao cho ở mỗi giai đoạn, model chỉ "nhìn thấy" đúng phần instruction/tool liên quan tới giai đoạn đó, giảm tải nhận thức và giảm rủi ro model bị rối giữa các trạng thái không liên quan.

---

## Ghi chú áp dụng cho project Voice Bot CSKH Cấp nước Trung An

Một số điểm trong tài liệu gốc ánh xạ trực tiếp vào các quyết định thiết kế đã có trong repo này (tham khảo thêm `CLAUDE.md`):

- Mục 7 và 11 (thiết kế tool, thu thập thực thể chính xác) chính là cơ sở lý thuyết cho luồng xác nhận mã danh bộ hiện tại: thu từng phần, không đoán, đọc lại từng chữ số, xác nhận trước khi tra cứu (`session-ws.js`, `danh-bo-arbiter.js`).
- Mục 8 (xử lý im lặng/tạp âm nền) liên quan tới cách `session-ws.js` cấu hình VAD (`server_vad` khi đang thu số, `semantic_vad` khi đã chốt).
- Mục 20 (Tool Level Behavior — PROACTIVE / CONFIRMATION FIRST / PREAMBLES) là mẫu tham khảo tốt để rà soát lại 11 tool hiện có trong `tools.js`/`system-prompt.js`, đối chiếu xem mỗi tool đang thuộc nhóm nào.
- Mục 21 (Conversation Flow + Advanced Conversation Flow) gợi ý hướng nếu sau này cần mở rộng luồng hội thoại phức tạp hơn (ví dụ nhiều loại yêu cầu CSKH khác nhau) mà vẫn giữ prompt dễ bảo trì.

Đây chỉ là ghi chú tham khảo nhanh, không thay thế cho việc đọc kỹ từng mục ở trên khi áp dụng vào `system-prompt.js`.
