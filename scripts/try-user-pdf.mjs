import fs from "node:fs";
import path from "node:path";

const uploads = fs
  .readdirSync(".uploads")
  .filter((name) => name.endsWith(".pdf"))
  .map((name) => ({ name, time: fs.statSync(path.join(".uploads", name)).mtimeMs }))
  .sort((a, b) => b.time - a.time);

if (!uploads.length) {
  console.error("no uploaded pdf found");
  process.exit(1);
}

const file = path.join(".uploads", uploads[0].name);
const displayName = uploads[0].name.replace(/^\d+-/, "");
const prompt = process.argv[2] ?? "dựng family theo catalog";
const model = process.argv[3] || "deepseek/deepseek-v4-pro";

const log = (line) => {
  const text = `${new Date().toISOString().slice(11, 19)} ${line}`;
  console.log(text);
  fs.appendFileSync("design-run.log", text + "\n");
};

log(`attach=${file} model=${model}`);
const started = Date.now();

const response = await fetch("http://localhost:8787/api/design", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt,
    spec: null,
    model,
    attachments: [{ path: path.resolve(file), name: displayName }],
  }),
});

log(`http ${response.status}`);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let lastSpec = null;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  let boundary = buffer.indexOf("\n\n");
  while (boundary >= 0) {
    const chunk = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);

    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      const event = JSON.parse(data);
      const seconds = ((Date.now() - started) / 1000).toFixed(0);

      if (event.type === "stage") log(`[${seconds}s] ${event.stage}: ${event.message}`);
      else if (event.type === "error") log(`[${seconds}s] ERROR ${event.message}`);
      else if (event.type === "spec") {
        lastSpec = event.spec;
        log(
          `[${seconds}s] spec ${event.spec.name} parts=${event.stats.parts} params=${event.stats.parameters} ` +
            `attempts=${event.stats.attempts} errors=${event.errors.length}`,
        );
      }
    }
    boundary = buffer.indexOf("\n\n");
  }
}

log("stream closed");
if (lastSpec) {
  fs.writeFileSync("design-user-spec.json", JSON.stringify(lastSpec, null, 2));
  log("saved design-user-spec.json");
}
