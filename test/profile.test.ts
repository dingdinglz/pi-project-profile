import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  parseProfile, profilePath, readProfile, sameProfile, THINKING_LEVELS, writeProfile,
  type Profile,
} from "../src/profile.ts";

function workspace(t: TestContext): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-profile-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

const profile: Profile = { version: 1, provider: "custom", model: "vendor/model:latest", thinkingLevel: "high" };

test("missing profile does not create any files", (t) => {
  const cwd = workspace(t);
  assert.equal(readProfile(cwd), undefined);
  assert.deepEqual(readdirSync(cwd), []);
});

test("round trips exact provider and model IDs, including slashes and colons", (t) => {
  const cwd = workspace(t);
  writeProfile(cwd, profile);
  assert.deepEqual(readProfile(cwd), profile);
  assert.ok(readFileSync(profilePath(cwd), "utf8").endsWith("\n"));
  assert.deepEqual(readdirSync(dirname(profilePath(cwd))), ["profile.json"]);
});

test("accepts every Pi thinking level, including off and max", () => {
  for (const thinkingLevel of THINKING_LEVELS) {
    assert.equal(parseProfile({ ...profile, thinkingLevel }).thinkingLevel, thinkingLevel);
  }
});

test("rejects malformed shapes without guessing another model or level", () => {
  for (const invalid of [
    null, [], "text", {}, { ...profile, version: 2 }, { ...profile, version: "1" },
    { ...profile, provider: " " }, { ...profile, model: 1 }, { ...profile, model: "" },
    { ...profile, thinkingLevel: "extreme" }, { ...profile, thinkingLevel: undefined },
  ]) {
    assert.throws(() => parseProfile(invalid));
  }
});

test("malformed JSON is not silently overwritten", (t) => {
  const cwd = workspace(t);
  mkdirSync(dirname(profilePath(cwd)));
  writeFileSync(profilePath(cwd), "{invalid");
  assert.throws(() => readProfile(cwd));
  assert.equal(readFileSync(profilePath(cwd), "utf8"), "{invalid");
});

test("replacement preserves neighboring project settings and removes temporary files", (t) => {
  const cwd = workspace(t);
  writeProfile(cwd, profile);
  const settings = join(cwd, ".pi", "settings.json");
  writeFileSync(settings, '{"theme":"dark"}');
  writeProfile(cwd, { ...profile, thinkingLevel: "off" });
  assert.equal(readProfile(cwd)?.thinkingLevel, "off");
  assert.equal(readFileSync(settings, "utf8"), '{"theme":"dark"}');
  assert.deepEqual(readdirSync(join(cwd, ".pi")).sort(), ["profile.json", "settings.json"]);
});

test("failed rename cleans up the temporary file", (t) => {
  const cwd = workspace(t);
  mkdirSync(profilePath(cwd), { recursive: true });
  assert.throws(() => writeProfile(cwd, profile));
  assert.deepEqual(readdirSync(join(cwd, ".pi")), ["profile.json"]);
});

test("working directories are independent and do not inherit parent profiles", (t) => {
  const cwd = workspace(t);
  const child = join(cwd, "child");
  mkdirSync(child);
  writeProfile(cwd, profile);
  assert.equal(readProfile(child), undefined);
  writeProfile(child, { ...profile, provider: "other" });
  assert.deepEqual(readProfile(cwd), profile);
  assert.equal(readProfile(child)?.provider, "other");
});

test("comparison includes the provider, model and thinking level", () => {
  assert.ok(sameProfile(undefined, undefined));
  assert.ok(sameProfile(profile, { ...profile }));
  assert.ok(!sameProfile(profile, undefined));
  assert.ok(!sameProfile(profile, { ...profile, provider: "other" }));
  assert.ok(!sameProfile(profile, { ...profile, model: "other" }));
  assert.ok(!sameProfile(profile, { ...profile, thinkingLevel: "low" }));
});
