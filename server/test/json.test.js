import test from "node:test";
import assert from "node:assert/strict";
import { parseModelJson } from "../src/llm.js";

test("parses a plain JSON object", () => {
  const spec = parseModelJson('{"schemaVersion":"1.0","name":"X","parts":[]}');
  assert.equal(spec.name, "X");
});

test("strips markdown fences and surrounding prose", () => {
  const text = [
    "Here is the family spec:",
    "",
    "```json",
    '{"schemaVersion":"1.0","name":"Pump","category":"Mechanical Equipment","parameters":[],"parts":[{"id":"a"}]}',
    "```",
    "",
    "Let me know if you need changes.",
  ].join("\n");

  const spec = parseModelJson(text);
  assert.equal(spec.name, "Pump");
  assert.equal(spec.parts.length, 1);
});

test("repairs trailing commas", () => {
  const spec = parseModelJson('{"a":1,"b":[1,2,],}');
  assert.deepEqual(spec, { a: 1, b: [1, 2] });
});

test("a prose answer fails with a readable error and keeps the raw text", () => {
  const prose = "## 5. VẬT LIỆU\n- Thép: #b9bec2\n- Đồng: #b87333";

  assert.throws(
    () => parseModelJson(prose),
    (error) => {
      assert.equal(error.name, "LlmError");
      assert.match(error.message, /replied with text instead of a JSON spec/);
      assert.match(error.message, /VẬT LIỆU/);
      assert.equal(error.text, prose);
      return true;
    },
  );
});
