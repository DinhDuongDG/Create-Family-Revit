import { jsonrepair } from "jsonrepair";
import { config } from "./config.js";

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

function stripFences(text) {
  let trimmed = text.trim();
  // Strip markdown code fences like ```json ... ``` or ``` ...
  if (trimmed.includes("```")) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      trimmed = match[1].trim();
    }
  }
  return trimmed;
}

export function parseModelJson(text) {
  const clean = stripFences(text);

  // Try direct parse
  try {
    return JSON.parse(clean);
  } catch (err1) {
    // Try jsonrepair on the full cleaned string
    try {
      const repaired = jsonrepair(clean);
      return JSON.parse(repaired);
    } catch {
      /* continue to substring extraction */
    }

    // Try finding outer-most brackets { ... }
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = clean.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        try {
          const repairedSlice = jsonrepair(slice);
          return JSON.parse(repairedSlice);
        } catch {
          // If still fails, try closing truncated brackets automatically
          let fixed = slice;
          const openBraces = (fixed.match(/\{/g) || []).length;
          const closeBraces = (fixed.match(/\}/g) || []).length;
          const openBrackets = (fixed.match(/\[/g) || []).length;
          const closeBrackets = (fixed.match(/\]/g) || []).length;
          
          if (openBrackets > closeBrackets) {
            fixed += "]".repeat(openBrackets - closeBrackets);
          }
          if (openBraces > closeBraces) {
            fixed += "}".repeat(openBraces - closeBraces);
          }

          try {
            return JSON.parse(jsonrepair(fixed));
          } catch {
            throw new LlmError(`JSON parsing error: ${err1.message}`);
          }
        }
      }
    }

    throw new LlmError("The model did not return valid JSON");
  }
}

export function llmStatus() {
  return {
    configured: Boolean(config.llm.apiKey),
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
  };
}

export async function chatJson(messages, options = {}) {
  if (!config.llm.apiKey) {
    throw new LlmError(
      "OPENAI_API_KEY is not set. Copy .env.example to .env and add your key (or point OPENAI_BASE_URL at a compatible endpoint).",
    );
  }

  const body = {
    model: options.model || config.llm.model,
    messages,
    temperature: options.temperature ?? config.llm.temperature,
    max_tokens: options.maxTokens ?? config.llm.maxTokens,
    response_format: { type: "json_object" },
  };

  let response;
  try {
    response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
    });
  } catch (error) {
    throw new LlmError(`Could not reach the model endpoint: ${error.message}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new LlmError(
      `Model request failed (${response.status}): ${detail.slice(0, 600) || response.statusText}`,
      response.status,
    );
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new LlmError("The model returned an empty response");

  return {
    text: content,
    json: parseModelJson(content),
    usage: payload.usage ?? null,
  };
}
