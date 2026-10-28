import { readFileSync } from "node:fs";
import path from "node:path";
import { jsonrepair } from "jsonrepair";
import { config, ROOT } from "./config.js";

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

function stripFences(text) {
  let trimmed = text.trim();
  // Strip code fences like ```json ... ``` or ```python ... ``` or ``` ...
  if (trimmed.includes("```")) {
    const match = trimmed.match(/```(?:json|python)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      trimmed = match[1].trim();
    }
  }
  return trimmed;
}

function noJsonError(text) {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
  const error = new LlmError(
    `The model replied with text instead of a JSON spec: "${preview}${preview.length >= 120 ? "…" : ""}"`,
  );
  error.text = text;
  return error;
}

export function parseModelJson(text) {
  let clean = stripFences(text);

  // If text starts with python snippet or preface, find the first '{' and last '}'
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw noJsonError(text);
  }

  clean = clean.slice(firstBrace, lastBrace + 1);

  // 1. Try direct parse
  try {
    return JSON.parse(clean);
  } catch (err1) {
    // 2. Try jsonrepair on the full cleaned string
    try {
      const repaired = jsonrepair(clean);
      return JSON.parse(repaired);
    } catch {
      /* continue to advanced repairing */
    }

    // 3. Clean unescaped quotes or common LLM syntax corruptions inside expressions
    let sanitized = clean
      // remove trailing commas before closing braces/brackets
      .replace(/,\s*([}\]])/g, "$1")
      // fix unescaped double quotes inside values if any
      .replace(/:\s*"([^"]*)"([^",}\]]+)"/g, ':"$1 $2"');

    try {
      return JSON.parse(jsonrepair(sanitized));
    } catch {
      // Try balancing braces & brackets
      const openBraces = (sanitized.match(/\{/g) || []).length;
      const closeBraces = (sanitized.match(/\}/g) || []).length;
      const openBrackets = (sanitized.match(/\[/g) || []).length;
      const closeBrackets = (sanitized.match(/\]/g) || []).length;
      
      if (openBrackets > closeBrackets) {
        sanitized += "]".repeat(openBrackets - closeBrackets);
      }
      if (openBraces > closeBraces) {
        sanitized += "}".repeat(openBraces - closeBraces);
      }

      try {
        return JSON.parse(jsonrepair(sanitized));
      } catch (errFinal) {
        const error = new LlmError(`JSON parsing error: ${err1.message}`);
        error.text = text;
        throw error;
      }
    }
  }
}

export function llmStatus() {
  return {
    configured: Boolean(config.llm.apiKey),
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
  };
}

/**
 * The spec schema shipped in the repo. Passing it as a response format keeps OpenAI
 * compatible endpoints close to the shape the add-in expects; the prompt and the
 * validator still guard the result.
 */
let cachedSpecSchema;
let schemaSupported = true;

export function specResponseSchema() {
  if (cachedSpecSchema !== undefined) return cachedSpecSchema;

  try {
    cachedSpecSchema = JSON.parse(
      readFileSync(path.join(ROOT, "spec", "family-spec.schema.json"), "utf8"),
    );
  } catch {
    cachedSpecSchema = null;
  }

  return cachedSpecSchema;
}

function responseFormat() {
  const schema = specResponseSchema();
  if (schemaSupported && schema) {
    return { type: "json_schema", json_schema: { name: "family_spec", strict: false, schema } };
  }

  return { type: "json_object" };
}

async function postCompletion(body, options) {
  try {
    return await fetch(`${config.llm.baseUrl}/chat/completions`, {
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
    response_format: responseFormat(),
  };

  let response = await postCompletion(body, options);

  // Not every compatible endpoint accepts json_schema; fall back once and remember it.
  if (
    !response.ok &&
    body.response_format.type === "json_schema" &&
    (response.status === 400 || response.status === 404 || response.status === 422)
  ) {
    schemaSupported = false;
    body.response_format = { type: "json_object" };
    response = await postCompletion(body, options);
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
