import test from "node:test";
import assert from "node:assert/strict";
import { specResponseSchema } from "../src/llm.js";

test("the repo spec schema loads and covers the response shape", () => {
  const schema = specResponseSchema();

  assert.ok(schema, "spec/family-spec.schema.json should load");
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["name", "category", "parameters", "parts"]);
  assert.ok(schema.properties.parameters);
  assert.ok(schema.properties.parts);
  assert.ok(schema.properties.materials);
});
