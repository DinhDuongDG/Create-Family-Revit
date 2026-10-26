import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333;
const URL = "http://localhost:5173/";
const OUT = process.argv[2] ?? "ui-run.png";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-shot-"));

const browser = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--window-size=1440,900",
    URL,
  ],
  { stdio: "ignore", detached: false },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === "page" && entry.url.includes("5173"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("browser did not start");
}

const page = await targets();
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

await new Promise((resolve) => socket.addEventListener("open", resolve));

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await sleep(2500);

const prompt = process.argv[3] ?? "Centrifugal inline pump DN80, cast iron casing 500 x 320 x 320, DN80 flanges, base frame";

const started = await evaluate(`
  (() => {
    const box = document.querySelector('.chat-composer textarea');
    if (!box) return 'no textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, ${JSON.stringify(prompt)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()
`);
console.log("fill:", started);

await sleep(300);
console.log("send:", await evaluate(`(() => { const b = document.querySelector('.send'); if (!b) return 'no send'; b.click(); return 'clicked'; })()`));

await sleep(2500);
const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
console.log(`saved ${OUT}`);

const card = await evaluate(`(() => {
  const card = document.querySelector('.run-card');
  if (!card) return 'NO CARD';
  return card.innerText.replace(/\\n/g, ' | ');
})()`);
console.log("card:", card);

socket.close();
browser.kill();
