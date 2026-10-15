import { parseArgs } from "@earendil-works/pi-coding-agent";

/** Use Pi's parser so option values and text after `--` are not mistaken for switches. */
export function hasModelOverride(argv: readonly string[]): boolean {
  const args = parseArgs([...argv]);
  return [args.provider, args.model, args.models, args.thinking, args.apiKey]
    .some((value) => value !== undefined);
}
