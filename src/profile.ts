import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Profile {
  version: 1;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export function profilePath(cwd: string): string {
  return join(cwd, ".pi", "profile.json");
}

export function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile must be a JSON object");
  }
  const profile = value as Record<string, unknown>;
  if (profile.version !== 1) throw new Error("unsupported profile version (expected 1)");
  for (const key of ["provider", "model"] as const) {
    if (typeof profile[key] !== "string" || !profile[key].trim()) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  if (!THINKING_LEVELS.includes(profile.thinkingLevel as ThinkingLevel)) {
    throw new Error(`thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return {
    version: 1,
    provider: profile.provider as string,
    model: profile.model as string,
    thinkingLevel: profile.thinkingLevel as ThinkingLevel,
  };
}

export function readProfile(cwd: string): Profile | undefined {
  let text: string;
  try {
    text = readFileSync(profilePath(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseProfile(JSON.parse(text));
}

/** Atomic replacement: concurrent sessions never see a partially written JSON file. */
export function writeProfile(cwd: string, profile: Profile): void {
  const target = profilePath(cwd);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.profile-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(parseProfile(profile), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function sameProfile(left: Profile | undefined, right: Profile | undefined): boolean {
  return left?.provider === right?.provider && left?.model === right?.model &&
    left?.thinkingLevel === right?.thinkingLevel;
}
