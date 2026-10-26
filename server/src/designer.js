import fs from "node:fs";
import path from "node:path";
import { analyzeSpec, formatIssues } from "@family/spec-core";
import { config } from "./config.js";
import { generateJson } from "./agents.js";
import { extractDocumentText } from "./documents.js";

const designerPrompt = fs.readFileSync(path.join(config.dirs.prompts, "designer.md"), "utf8");
const repairPrompt = fs.readFileSync(path.join(config.dirs.prompts, "repair.md"), "utf8");

const MAX_ATTEMPTS = 3;

function summarise(spec, model) {
  const bounds = model.bounds;
  return {
    parameters: spec.parameters.length,
    parts: model.parts.length,
    instances: model.instances,
    materials: spec.materials?.length ?? 0,
    bounds: bounds
      ? {
          x: Math.round(bounds.size.x),
          y: Math.round(bounds.size.y),
          z: Math.round(bounds.size.z),
        }
      : null,
  };
}

export async function design({ prompt, currentSpec, emit, model, attachments, signal }) {
  const startedAt = Date.now();
  const messages = [{ role: "system", content: designerPrompt }];

  if (currentSpec) {
    messages.push({
      role: "user",
      content: `Here is the current spec. Apply my next request to it.\n${JSON.stringify(currentSpec)}`,
    });
  }

  if (attachments && attachments.length > 0) {
    let extracted = [];

    try {
      emit({ type: "stage", stage: "reading", message: "Reading the document" });
      for (const file of attachments) {
        const text = await extractDocumentText(file);
        if (text.length > 40) extracted.push({ name: file.name, text });
      }
    } catch (error) {
      console.error("document extraction failed:", error);
      extracted = [];
    }

    if (extracted.length > 0) {
      messages.push({
        role: "user",
        content:
          "Text extracted from the attached document(s). These numbers come straight from the " +
          "datasheet: use them exactly, and map the drawing reference letters (A, B, C, D, E, F, " +
          "a1, c1, ...) to the matching dimensions.\n\n" +
          extracted.map((doc) => `--- ${doc.name} ---\n${doc.text}`).join("\n\n"),
      });
    } else {
      messages.push({
        role: "user",
        content: `Attached document(s): ${attachments.map((file) => file.name).join(", ")}.\n` +
          "Read each one with the read_file tool before you design. Take every dimension, component, " +
          "connection and material from the document, and keep the family consistent with it. " +
          "Do not guess sizes the document already gives you. " +
          "Apply the Usable & Production-Ready Family standards: ensure all piping stubs (Cooling, Heating, Drain, Humidifier) " +
          "and duct collars protrude properly from the casing with accurate nominal diameters, all driving parameters are declared " +
          "in group Dimensions, and internal components (fans, coils, filters) are modeled cleanly inside the casing.",
      });
    }
  }

  messages.push({ role: "user", content: prompt });

  const modelOptions = {
    ...(model ? { model } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(signal ? { signal } : {}),
    onProgress: (message) => emit({ type: "stage", stage: "working", message }),
  };

  emit({ type: "stage", stage: "thinking", message: "Reading the brief" });

  let analysis = null;
  let attempts = 0;
  let usage = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    if (attempt === 1) {
      emit({ type: "stage", stage: "generating", message: "Sketching the outline" });
    } else {
      emit({
        type: "stage",
        stage: "repairing",
        message: `Repairing ${analysis.errors.length} problem${analysis.errors.length === 1 ? "" : "s"}`,
      });
    }

    const result = await generateJson(messages, modelOptions);
    usage = result.usage ?? usage;

    emit({ type: "stage", stage: "checking", message: "Checking the model" });
    analysis = analyzeSpec(result.json);

    if (analysis.ok) break;

    if (attempt < MAX_ATTEMPTS) {
      emit({
        type: "stage",
        stage: "repairing",
        message: `${analysis.errors.length} problem${analysis.errors.length === 1 ? "" : "s"} found`,
        issues: analysis.errors.slice(0, 12),
      });
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: repairPrompt.replace("{{issues}}", formatIssues(analysis.errors, 25)),
      });
    }
  }

  const stats = {
    ...summarise(analysis.spec, analysis.model),
    attempts,
    elapsedMs: Date.now() - startedAt,
    usage,
  };

  return { analysis, stats };
}
