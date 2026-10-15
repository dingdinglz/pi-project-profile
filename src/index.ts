import { rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasModelOverride } from "./options.ts";
import { profilePath, readProfile, sameProfile, writeProfile, type Profile } from "./profile.ts";

function describe(profile: Profile | undefined): string {
  return profile ? `${profile.provider}/${profile.model} · thinking:${profile.thinkingLevel}` : "(none)";
}

export default function projectProfile(pi: ExtensionAPI): void {
  let observed: Profile | undefined;
  let enabled = false;
  let invalidProfile = false;
  let disabledReason: string | undefined;

  function current(ctx: ExtensionContext): Profile | undefined {
    const model = ctx.model;
    return model ? {
      version: 1,
      provider: model.provider,
      model: model.id,
      thinkingLevel: pi.getThinkingLevel(),
    } : undefined;
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(`Profile: ${message}`, type);
  }

  function save(ctx: ExtensionContext, selection: Profile): boolean {
    try {
      writeProfile(ctx.cwd, selection);
      return true;
    } catch (error) {
      notify(ctx, `cannot save ${profilePath(ctx.cwd)}: ${String(error)}`, "warning");
      return false;
    }
  }

  function observe(ctx: ExtensionContext): void {
    if (!enabled || invalidProfile || !ctx.isProjectTrusted()) return;
    const selection = current(ctx);
    if (!selection || sameProfile(selection, observed)) return;
    // Advance even on failure to avoid repeated warnings in a read-only directory.
    observed = selection;
    save(ctx, selection);
  }

  pi.registerFlag("no-profile", {
    description: "Disable automatic project model/thinking profiles for this run",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (event, ctx) => {
    // Model/thinking setters emit events themselves. Keep persistence off until restoration
    // is complete, then snapshot the effective selection (including any thinking clamping).
    enabled = false;
    invalidProfile = false;
    observed = undefined;
    disabledReason = ctx.mode !== "tui" ? "automatic profiles only run in TUI mode"
      : !ctx.isProjectTrusted() ? "project is not trusted"
      : pi.getFlag("no-profile") === true ? "--no-profile"
      : hasModelOverride(process.argv.slice(2)) ? "explicit model/thinking CLI options"
      : undefined;
    if (disabledReason) return;

    let profile: Profile | undefined;
    try {
      profile = readProfile(ctx.cwd);
    } catch (error) {
      invalidProfile = true;
      notify(ctx, `cannot read ${profilePath(ctx.cwd)}: ${String(error)}. Auto-save paused; use /profile save to replace it.`, "warning");
    }

    const hasConversation = ctx.sessionManager.getBranch().some(
      (entry) => entry.type === "message" && entry.message.role !== "system",
    );
    const isFresh = (event.reason === "startup" || event.reason === "new") && !hasConversation;
    if (profile && isFresh) {
      try {
        const model = ctx.modelRegistry.find(profile.provider, profile.model);
        if (!model) {
          notify(ctx, `model not found: ${describe(profile)}. Keeping the current selection.`, "warning");
        } else if (await pi.setModel(model)) {
          pi.setThinkingLevel(profile.thinkingLevel);
          const applied = current(ctx);
          notify(ctx, `restored ${describe(applied)}`);
          if (applied?.thinkingLevel !== profile.thinkingLevel) {
            notify(ctx, `saved thinking:${profile.thinkingLevel} is unsupported; using thinking:${applied?.thinkingLevel}. The saved file was not changed.`, "warning");
          }
        } else {
          notify(ctx, `model unavailable (check provider credentials): ${describe(profile)}. Keeping the current selection.`, "warning");
        }
      } catch (error) {
        notify(ctx, `could not restore ${profilePath(ctx.cwd)}: ${String(error)}`, "warning");
      }
    }

    // No file creation/rewriting just because Pi selected a startup model or restored history.
    observed = current(ctx);
    enabled = true;
  });

  pi.on("model_select", (event, ctx) => {
    if (!enabled) return;
    if (event.source === "restore") observed = current(ctx);
    else observe(ctx);
  });
  // Pi emits the clamped, effective level. Read live state rather than a potentially stale
  // event payload: this event is fire-and-forget and other handlers may have awaited work.
  pi.on("thinking_level_select", (_event, ctx) => observe(ctx));
  pi.on("before_agent_start", (_event, ctx) => observe(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      // Also covers a switch immediately followed by quit/reload before an async handler runs.
      observe(ctx);
    } finally {
      enabled = false;
    }
  });

  pi.registerCommand("profile", {
    description: "Show, save, or clear this directory's model/thinking profile",
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        notify(ctx, "project is not trusted; use /trust before accessing its profile", "warning");
        return;
      }
      const action = args.trim() || "show";
      if (action === "show") {
        try {
          const profile = readProfile(ctx.cwd);
          notify(ctx, `${profilePath(ctx.cwd)}\nSaved: ${describe(profile)}\nCurrent: ${describe(current(ctx))}\nAuto-save: ${disabledReason ?? (invalidProfile ? "paused (invalid file)" : "on")}`);
        } catch (error) {
          notify(ctx, `cannot read ${profilePath(ctx.cwd)}: ${String(error)}`, "warning");
        }
      } else if (action === "save") {
        const selection = current(ctx);
        if (!selection) {
          notify(ctx, "no model selected; use /model first", "warning");
          return;
        }
        if (save(ctx, selection)) {
          observed = selection;
          invalidProfile = false;
          notify(ctx, `saved ${describe(selection)} to ${profilePath(ctx.cwd)}`);
        }
      } else if (action === "clear") {
        try {
          rmSync(profilePath(ctx.cwd), { force: true });
          observed = current(ctx);
          invalidProfile = false;
          notify(ctx, "cleared. The next model/thinking change will create a new profile.");
        } catch (error) {
          notify(ctx, `cannot clear ${profilePath(ctx.cwd)}: ${String(error)}`, "warning");
        }
      } else {
        notify(ctx, "usage: /profile [show|save|clear]", "warning");
      }
    },
  });
}
