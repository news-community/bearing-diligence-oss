import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** A raw file is addressed by what it contains, so the same packet added twice is stored once. */
export function digestOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestFile(path: string): string {
  return digestOf(readFileSync(path));
}
