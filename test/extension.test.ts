import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext, type ExtensionFactory, type ExtensionUIContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import projectProfile from "../src/index.ts";
import { profilePath, readProfile, writeProfile, type Profile } from "../src/profile.ts";

const saved: Profile = { version: 1, provider: "profile-test-b", model: "same-id", thinkingLevel: "high" };

async function sandbox(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-profile-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const sessions: AgentSession[] = [];
  const errors: string[] = [];
  t.after(async () => {
    try {
      for (const session of sessions) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      assert.deepEqual(errors, [], "extension errors");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  for (const provider of ["profile-test-a", "profile-test-b", "profile-test-no-auth"]) {
    runtime.registerProvider(provider, {
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      apiKey: provider === "profile-test-no-auth" ? undefined : "test-only-not-a-real-key",
      models: ["same-id", "no-thinking"].map((id) => ({
        id, name: id, reasoning: id !== "no-thinking", input: ["text"],
        contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    });
  }
  const first = runtime.getModel("profile-test-a", "same-id")!;
  const second = runtime.getModel("profile-test-b", "same-id")!;
  const plain = runtime.getModel("profile-test-b", "no-thinking")!;

  async function open(options: {
    mode?: ExtensionContext["mode"];
    trusted?: boolean;
    noProfile?: boolean;
    reason?: SessionStartEvent["reason"];
    conversation?: boolean;
    before?: ExtensionFactory;
  } = {}) {
    const notifications: string[] = [];
    const settings = SettingsManager.inMemory({
      defaultProvider: first.provider,
      defaultModel: first.id,
      defaultThinkingLevel: "low",
      compaction: { enabled: false },
      cacheWarming: "off",
    }, { projectTrusted: options.trusted ?? true });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: options.before ? [options.before, projectProfile] : [projectProfile],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(cwd);
    if (options.conversation) {
      manager.appendMessage({ role: "user", content: "existing conversation", timestamp: 1 });
    }
    const { session } = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime,
      model: first, thinkingLevel: "low",
      settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: [],
      sessionStartEvent: { type: "session_start", reason: options.reason ?? "startup" },
    });
    sessions.push(session);
    if (options.noProfile) session.extensionRunner.setFlagValue("no-profile", true);
    await session.bindExtensions({
      mode: options.mode ?? "tui",
      uiContext: { notify: (message: string) => { notifications.push(message); } } as ExtensionUIContext,
      onError: (error) => errors.push(error.error),
    });
    return { session, settings, notifications };
  }
  return { cwd, first, second, plain, runtime, open };
}

test("SDK: startup and shutdown alone do not create a profile", async (t) => {
  const env = await sandbox(t);
  const { session } = await env.open();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.ok(!existsSync(join(env.cwd, ".pi")));
});

test("SDK: saves model/provider and thinking-only changes through native events", async (t) => {
  const env = await sandbox(t);
  const { session, settings } = await env.open();
  await session.setModel(env.second);
  assert.deepEqual(readProfile(env.cwd), { ...saved, thinkingLevel: "low" });
  session.setThinkingLevel("high");
  assert.deepEqual(readProfile(env.cwd), saved);
  session.setThinkingLevel("off");
  assert.equal(readProfile(env.cwd)?.thinkingLevel, "off");
  assert.equal(settings.getDefaultProvider(), env.first.provider);
  assert.equal(settings.getDefaultThinkingLevel(), "low");
});

test("SDK: model cycling persists the final clamped thinking level", async (t) => {
  const env = await sandbox(t);
  const { session } = await env.open();
  session.setThinkingLevel("high");
  await session.setModel(env.plain);
  assert.equal(readProfile(env.cwd)?.model, "no-thinking");
  assert.equal(readProfile(env.cwd)?.thinkingLevel, "off");
  // Exercise the cycle source as well as the direct set source.
  session.setScopedModels([{ model: env.plain }, { model: env.second, thinkingLevel: "high" }]);
  await session.cycleModel();
  assert.deepEqual(readProfile(env.cwd), saved);
});

test("SDK: a later session restores the profile without changing defaults or rewriting it", async (t) => {
  const env = await sandbox(t);
  const initial = await env.open();
  await initial.session.setModel(env.second);
  initial.session.setThinkingLevel("high");
  await initial.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const original = readFileSync(profilePath(env.cwd), "utf8");
  const next = await env.open();
  assert.equal(next.session.model?.provider, env.second.provider);
  assert.equal(next.session.thinkingLevel, "high");
  assert.equal(next.settings.getDefaultProvider(), env.first.provider);
  assert.equal(next.settings.getDefaultThinkingLevel(), "low");
  assert.equal(readFileSync(profilePath(env.cwd), "utf8"), original);
  assert.ok(next.notifications.some((text) => text.includes("restored")));
});

test("SDK: unsupported saved thinking is clamped without overwriting the requested level", async (t) => {
  const env = await sandbox(t);
  const profile = { ...saved, model: "no-thinking" };
  writeProfile(env.cwd, profile);
  const { session, notifications } = await env.open();
  assert.equal(session.thinkingLevel, "off");
  assert.deepEqual(readProfile(env.cwd), profile);
  assert.ok(notifications.some((text) => text.includes("unsupported")));
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(readProfile(env.cwd), profile);
});

test("SDK: unavailable models keep the original selection and file until an actual change", async (t) => {
  const env = await sandbox(t);
  for (const provider of ["provider-does-not-exist", "profile-test-no-auth"]) {
    const profile = { ...saved, provider };
    writeProfile(env.cwd, profile);
    const { session, notifications } = await env.open();
    assert.equal(session.model?.provider, env.first.provider);
    assert.equal(session.thinkingLevel, "low");
    assert.deepEqual(readProfile(env.cwd), profile);
    assert.ok(notifications.some((text) => /not found|unavailable/.test(text)));
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(readProfile(env.cwd), profile);
  }
});

test("SDK: exceptions while restoring do not crash startup or replace the file", async (t) => {
  const env = await sandbox(t);
  writeProfile(env.cwd, saved);
  const originalCheck = env.runtime.checkAuth.bind(env.runtime);
  t.mock.method(env.runtime, "checkAuth", async (provider: string) => {
    if (provider === saved.provider) throw new Error("simulated auth error");
    return originalCheck(provider);
  });
  const { session, notifications } = await env.open();
  assert.equal(session.model?.provider, env.first.provider);
  assert.deepEqual(readProfile(env.cwd), saved);
  assert.ok(notifications.some((text) => text.includes("could not restore")));
});

test("SDK: resume/fork/reload and startup with conversation history retain session state", async (t) => {
  const env = await sandbox(t);
  writeProfile(env.cwd, saved);
  for (const reason of ["resume", "fork", "reload", "startup"] as const) {
    const { session } = await env.open({ reason, conversation: reason === "startup" });
    assert.equal(session.model?.provider, env.first.provider);
    assert.equal(session.thinkingLevel, "low");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(readProfile(env.cwd), saved);
  }
  const fresh = await env.open({ reason: "new" });
  assert.equal(fresh.session.model?.provider, env.second.provider);
});

test("SDK: non-TUI modes, --no-profile and untrusted projects do not auto-read or write", async (t) => {
  const env = await sandbox(t);
  writeProfile(env.cwd, saved);
  for (const options of [
    { mode: "print" }, { mode: "json" }, { mode: "rpc" }, { noProfile: true }, { trusted: false },
  ] as const) {
    const { session } = await env.open(options);
    assert.equal(session.model?.provider, env.first.provider);
    session.setThinkingLevel("medium");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(readProfile(env.cwd), saved);
  }
});

test("SDK: explicit CLI selection is temporary; /profile save can still opt in", async (t) => {
  const env = await sandbox(t);
  writeProfile(env.cwd, saved);
  const argv = process.argv;
  process.argv = [argv[0], argv[1], "--model", "custom/temporary:low"];
  try {
    const { session } = await env.open();
    assert.equal(session.model?.provider, env.first.provider);
    session.setThinkingLevel("medium");
    assert.deepEqual(readProfile(env.cwd), saved);
    await session.prompt("/profile save");
    assert.deepEqual(readProfile(env.cwd), { ...saved, provider: env.first.provider, thinkingLevel: "medium" });
  } finally {
    process.argv = argv;
  }
});

test("SDK: invalid files stay untouched until explicit save; clear does not recreate on exit", async (t) => {
  const env = await sandbox(t);
  mkdirSync(join(env.cwd, ".pi"));
  writeFileSync(profilePath(env.cwd), "{broken");
  const { session, notifications } = await env.open();
  session.setThinkingLevel("high");
  assert.equal(readFileSync(profilePath(env.cwd), "utf8"), "{broken");
  assert.ok(notifications.some((text) => text.includes("Auto-save paused")));
  await session.prompt("/profile save");
  assert.equal(readProfile(env.cwd)?.thinkingLevel, "high");
  session.setThinkingLevel("medium");
  assert.equal(readProfile(env.cwd)?.thinkingLevel, "medium");
  await session.prompt("/profile clear");
  assert.ok(!existsSync(profilePath(env.cwd)));
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.ok(!existsSync(profilePath(env.cwd)));
});

test("SDK: write failures are warnings rather than session failures", async (t) => {
  const env = await sandbox(t);
  const { session, notifications } = await env.open();
  // Deterministic filesystem failure, independent of the test runner's OS permissions.
  writeFileSync(join(env.cwd, ".pi"), "not a directory");
  session.setThinkingLevel("high");
  assert.ok(notifications.some((text) => text.includes("cannot save")));
  const count = notifications.length;
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(notifications.length, count);
  assert.equal(readFileSync(join(env.cwd, ".pi"), "utf8"), "not a directory");
});

test("SDK: show and help do not create files", async (t) => {
  const env = await sandbox(t);
  const { session, notifications } = await env.open();
  await session.prompt("/profile");
  await session.prompt("/profile unknown");
  assert.ok(notifications.some((text) => text.includes(profilePath(env.cwd))));
  assert.ok(notifications.some((text) => text.includes("usage:")));
  assert.ok(!existsSync(profilePath(env.cwd)));
});

test("SDK: clearing permits the next real change to create a new profile", async (t) => {
  const env = await sandbox(t);
  writeProfile(env.cwd, saved);
  const { session } = await env.open();
  await session.prompt("/profile clear");
  session.setThinkingLevel("medium");
  assert.equal(readProfile(env.cwd)?.thinkingLevel, "medium");
});

test("SDK: untrusted projects reject explicit profile commands too", async (t) => {
  const env = await sandbox(t);
  writeProfile(env.cwd, saved);
  const { session } = await env.open({ trusted: false });
  await session.prompt("/profile clear");
  await session.prompt("/profile save");
  assert.deepEqual(readProfile(env.cwd), saved);
});

test("SDK: unchanged sessions do not overwrite another session's newer choice on exit", async (t) => {
  const env = await sandbox(t);
  const a = await env.open();
  const b = await env.open();
  await b.session.setModel(env.second);
  b.session.setThinkingLevel("high");
  await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(readProfile(env.cwd), saved);
});

test("SDK: delayed thinking handlers during restoration do not rewrite the file", async (t) => {
  const env = await sandbox(t);
  const requested = { ...saved, model: "no-thinking" };
  writeProfile(env.cwd, requested);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { session } = await env.open({
    before: (pi) => { pi.on("thinking_level_select", () => pending); },
  });
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.thinkingLevel, "off");
  assert.deepEqual(readProfile(env.cwd), requested);
});

test("SDK: shutdown captures a switch whose asynchronous thinking event has not arrived yet", async (t) => {
  const env = await sandbox(t);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { session } = await env.open({
    before: (pi) => { pi.on("thinking_level_select", () => pending); },
  });
  session.setThinkingLevel("high");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(readProfile(env.cwd)?.thinkingLevel, "high");
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
