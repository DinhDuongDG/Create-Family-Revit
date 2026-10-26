const prompt =
  process.argv[2] ??
  "A wall mounted electric panel heater, 1200 mm wide, 400 mm high and 120 mm deep. Louvred outlet along the bottom, white painted steel casing, wall bracket at the back.";

const model = process.argv[3] || undefined;
if (model) console.log(`model: ${model}`);

const started = Date.now();

const response = await fetch("http://localhost:8787/api/design", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, spec: null, model }),
});

if (!response.ok || !response.body) {
  console.error("HTTP", response.status, await response.text());
  process.exit(1);
}

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
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      if (event.type === "stage") {
        console.log(`[${elapsed}s] stage: ${event.stage} - ${event.message}`);
      } else if (event.type === "error") {
        console.log(`[${elapsed}s] ERROR: ${event.message}`);
      } else if (event.type === "spec") {
        lastSpec = event.spec;
        console.log(`[${elapsed}s] spec: ${event.spec.name}`);
        console.log(`        parts=${event.stats.parts} params=${event.stats.parameters} attempts=${event.stats.attempts}`);
        console.log(`        bounds=${JSON.stringify(event.stats.bounds)}`);
        console.log(`        errors=${event.errors.length} warnings=${event.issues.filter((i) => i.severity === "warning").length}`);
        for (const issue of event.errors.slice(0, 6)) {
          console.log(`        - ${issue.path}: ${issue.message}`);
        }
      }
    }
    boundary = buffer.indexOf("\n\n");
  }
}

if (lastSpec) {
  const fs = await import("node:fs");
  fs.writeFileSync("last-spec.json", JSON.stringify(lastSpec, null, 2));
  console.log(`\nsaved last-spec.json (${lastSpec.parts.length} parts)`);
}
