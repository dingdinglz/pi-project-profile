import assert from "node:assert/strict";
import { test } from "node:test";
import { hasModelOverride } from "../src/options.ts";

test("explicit model/provider/thinking flags opt out of automatic profiles", () => {
  for (const flag of ["--model", "--provider", "--models", "--thinking", "--api-key"]) {
    assert.ok(hasModelOverride([flag, "high"]));
  }
  assert.ok(!hasModelOverride(["--offline", "--continue"]));
  assert.ok(!hasModelOverride(["--", "--model", "value"]));
  assert.ok(!hasModelOverride(["Explain --model and --thinking"]));
  assert.ok(!hasModelOverride(["--name", "--model"]));
  assert.ok(!hasModelOverride(["--system-prompt", "--thinking"]));
  assert.ok(hasModelOverride(["--model", "custom/model:high"]));
});
