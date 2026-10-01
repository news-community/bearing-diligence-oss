/**
 * Finding the model runtime and the OCR engine from an app opened in the Finder, whose PATH holds
 * neither Homebrew's tools nor /usr/local/bin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findTool } from "../src/util/tools.js";

const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const only = (...present: string[]) => (p: string) => present.includes(p);

test("PATH wins when the tool is on it", () => {
  const f = findTool("ollama", { PATH: "/custom/bin:" + FINDER_PATH }, only("/custom/bin/ollama", "/usr/local/bin/ollama"), "/somebody");
  assert.deepEqual(f, { path: "/custom/bin/ollama", where: "/custom/bin (on PATH)" });
});

test("an app opened from the Finder still finds Homebrew's tesseract", () => {
  const f = findTool("tesseract", { PATH: FINDER_PATH }, only("/opt/homebrew/bin/tesseract"), "/somebody");
  assert.equal(f?.path, "/opt/homebrew/bin/tesseract");
  assert.equal(f?.where, "Homebrew");
});

test("Ollama.app's own command is found with no link in /usr/local/bin", () => {
  const f = findTool("ollama", { PATH: FINDER_PATH }, only("/Applications/Ollama.app/Contents/Resources/ollama"), "/somebody");
  assert.equal(f?.where, "/Applications/Ollama.app");
  const mine = findTool("ollama", { PATH: FINDER_PATH }, only("/somebody/Applications/Ollama.app/Contents/Resources/ollama"), "/somebody");
  assert.equal(mine?.where, "~/Applications/Ollama.app");
});

test("nothing installed is null, not a guess", () => {
  assert.equal(findTool("ollama", { PATH: FINDER_PATH }, only(), "/somebody"), null);
});

test("limited to PATH, an installed tool elsewhere is not found", () => {
  assert.equal(findTool("tesseract", { PATH: "", BD_TOOLS_PATH_ONLY: "1" }, only("/opt/homebrew/bin/tesseract"), "/somebody"), null);
});
