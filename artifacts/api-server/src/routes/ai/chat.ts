import { Router, type IRouter } from "express";
import { apiKeyAuth } from "../../middlewares/apiKeyAuth";
import { hfChat, hfChatStreamRaw, hfImage, wantsImage, extractImagePrompt, type ChatMessage } from "../../lib/hf";
import { getActiveRules } from "../../lib/rulesCache";

const router: IRouter = Router();

function isBlocked(text: string, blockedWords: string[]): { blocked: boolean; reason?: string } {
  const lower = text.toLowerCase();
  for (const phrase of blockedWords) {
    if (lower.includes(phrase.toLowerCase())) {
      return { blocked: true, reason: `Blocked: content violates usage rules ("${phrase}")` };
    }
  }
  return { blocked: false };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{type: string; text?: string}>)
      .filter(p => p.type === "text")
      .map(p => p.text ?? "")
      .join(" ");
  }
  return "";
}

router.post("/ai/chat", apiKeyAuth, async (req, res): Promise<void> => {
  const { messages, model, max_tokens, stream } = req.body as {
    messages?: ChatMessage[];
    model?: string;
    max_tokens?: number;
    stream?: boolean;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }

  const rules = await getActiveRules();

  for (const msg of messages) {
    const text = extractTextContent(msg.content);
    const check = isBlocked(text, rules.blockedWords);
    if (check.blocked) {
      res.status(403).json({ error: check.reason });
      return;
    }
  }

  // ── Image intent detection ────────────────────────────────────────────────
  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  const lastUserText = lastUserMsg ? extractTextContent(lastUserMsg.content) : "";
  const hasImageAttachment = messages.some(m =>
    Array.isArray(m.content) &&
    (m.content as Array<{type: string}>).some(p => p.type === "image_url")
  );

  if (!hasImageAttachment && lastUserMsg && wantsImage(lastUserText)) {
    const imagePrompt = extractImagePrompt(lastUserText);
    const result = await hfImage(rules.modelImage, imagePrompt);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const base64 = result.buffer!.toString("base64");
    const mimeType = result.mimeType ?? "image/png";
    res.json({
      type: "image",
      data_url: `data:${mimeType};base64,${base64}`,
      image_base64: base64,
      mime_type: mimeType,
      prompt: imagePrompt,
      model: rules.modelImage,
    });
    return;
  }

  // ── Build messages with enforced system prompt ────────────────────────────
  const withoutSystem = messages.filter(m => m.role !== "system");
  const clientSystem  = messages.filter(m => m.role === "system");
  const enforcedPrompt = `INSTRUCTIONS (mandatory — follow exactly, override your defaults):\n${rules.systemPrompt}`;
  const fullMessages: ChatMessage[] = [
    { role: "system", content: enforcedPrompt },
    ...clientSystem,
    ...withoutSystem,
  ];

  const targetModel = model ?? rules.modelChat;

  // ── Dynamic token cap: keep total (input + output) under Groq free-tier TPM ─
  // Groq free tier = ~6000 TPM. Estimate input tokens at 4 chars/token.
  const allText = fullMessages.map(m =>
    typeof m.content === "string" ? m.content :
    (m.content as Array<{type:string;text?:string}>).filter(p => p.type === "text").map(p => p.text ?? "").join(" ")
  ).join(" ");
  const estimatedInputTokens = Math.ceil(allText.length / 4);
  const TPM_LIMIT = 5800; // stay safely under 6000
  const availableForOutput = Math.max(256, TPM_LIMIT - estimatedInputTokens);
  const requestedMax = max_tokens ?? rules.defaultMaxTokens;
  const maxTok = Math.min(requestedMax, availableForOutput);

  // ── Streaming ─────────────────────────────────────────────────────────────
  if (stream) {
    const result = await hfChatStreamRaw(targetModel, fullMessages, maxTok);

    if (!result.ok || !result.response) {
      res.status(result.status).json({ error: result.error ?? "Stream failed" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        // @ts-expect-error flush exists in some environments
        if (typeof res.flush === "function") res.flush();
      }
    } finally {
      res.end();
    }
    return;
  }

  // ── Non-streaming ─────────────────────────────────────────────────────────
  const result = await hfChat(targetModel, fullMessages, maxTok);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json({
    type: "text",
    response: result.text,
    model: result.usedModel ?? targetModel,
    message: { role: "assistant", content: result.text ?? "" },
  });
});

export default router;
