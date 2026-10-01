/**
 * Invariant 6 as a choice per folder, with both halves checked by reading
 * every byte: saving off leaves no trace of a question (test/retention.test.ts), saving on writes it
 * only into this folder's record, and deleting a saved conversation takes it off the disk. Also the
 * recent-folders list, and what is new since a folder was last opened.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { intake } from "../src/ingest/intake.js";
import {
  deleteConversation, getConversation, listConversations, saveConversation, savesConversations, setSavesConversations,
} from "../src/record/conversations.js";
import { forgetFolder, recentFolders, rememberedRecord, rememberRecord } from "../src/ui/choose.js";
import { whatsNew } from "../src/ui/whats-new.js";
import { findNonce, NONCE } from "./fixtures.js";

const fresh = (p: string) => {
  const dir = mkdtempSync(join(tmpdir(), p));
  confirmLocation(dir, "the test");
  return { dir, rec: openRecord(dir) };
};

test("a folder saves nothing by default, and the setting belongs to the folder", () => {
  const a = fresh("pr-conv-a-"), b = fresh("pr-conv-b-");
  assert.equal(savesConversations(a.rec), false, "off by default");
  setSavesConversations(a.rec, true);
  assert.equal(savesConversations(a.rec), true);
  assert.equal(savesConversations(b.rec), false, "another folder is not changed");
  a.rec.db.close(); b.rec.db.close();
  rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true });
});

test("a saved conversation is in this folder's record only, reopens whole, and a second save replaces it", () => {
  const a = fresh("pr-conv-c-"), b = fresh("pr-conv-d-");
  const turn = (q: string) => ({ question: q, asked_at: new Date().toISOString(), answer: { sentences: [{ text: "An answer.", kept: true }] } });
  const id = saveConversation(a.rec, [turn(`what about ${NONCE}`)]);
  assert.equal(saveConversation(a.rec, [turn(`what about ${NONCE}`), turn("and then?")], id), id, "saving again keeps the same conversation");
  assert.deepEqual(listConversations(a.rec).map((c) => c.turns), [2]);
  assert.equal(getConversation(a.rec, id).turns[1]!.question, "and then?");
  a.rec.db.close(); b.rec.db.close();
  assert.ok(findNonce(a.dir).length > 0, "saving on: the question IS in this folder's record, which the scan must be able to see");
  assert.deepEqual(findNonce(b.dir), [], "and in no other folder");
  rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true });
});

test("deleting a saved conversation removes every byte of it", () => {
  const a = fresh("pr-conv-e-");
  const id = saveConversation(a.rec, [{ question: `what about ${NONCE}`, asked_at: new Date().toISOString(), answer: null }]);
  deleteConversation(a.rec, id);
  assert.deepEqual(listConversations(a.rec), []);
  a.rec.db.close();
  assert.deepEqual(findNonce(a.dir), [], "nothing of the deleted conversation remains under the data directory");
  rmSync(a.dir, { recursive: true, force: true });
});

test("the recent folders: most recent first, the previous opening returned, and forgetting touches no files", () => {
  const profile = mkdtempSync(join(tmpdir(), "pr-recent-"));
  assert.equal(rememberRecord(profile, "/one"), null, "the first opening has no previous one");
  rememberRecord(profile, "/two");
  const before = recentFolders(profile).find((r) => r.dir === "/one")!.last_opened;
  assert.equal(rememberRecord(profile, "/one"), before, "opening again returns when it was last opened");
  assert.deepEqual(recentFolders(profile).map((r) => r.dir), ["/one", "/two"]);
  assert.equal(rememberedRecord(profile), "/one");
  forgetFolder(profile, "/one");
  assert.equal(rememberedRecord(profile), "/two");
  rmSync(profile, { recursive: true, force: true });
});

test("what is new counts only documents added since the folder was last opened", async () => {
  const a = fresh("pr-new-");
  writeFileSync(join(a.dir, "old.txt"), "Contract PO-44821 not to exceed $1,200,000.");
  await intake(a.rec, join(a.dir, "old.txt"), { layer: "public" });
  const since = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 10));
  writeFileSync(join(a.dir, "new.txt"), "Contract PO-44821 not to exceed $1,500,000.");
  await intake(a.rec, join(a.dir, "new.txt"), { layer: "public" });
  const w = whatsNew(a.rec, since);
  assert.deepEqual(w.documents.map((d) => d.filename), ["new.txt"]);
  assert.ok(w.changes.length > 0, "the moved amount is among what changed");
  assert.ok(w.suggestions.length > 0 && w.suggestions.every((q) => !q.includes("What changed in new.txt")),
    `suggestions come from the changes, not a repeat of the card: ${w.suggestions.join(" | ")}`);
  assert.equal(whatsNew(a.rec, null).documents.length, 2, "the first opening shows everything");
  a.rec.db.close();
  rmSync(a.dir, { recursive: true, force: true });
});

test("a new folder with one packet still gets questions, from the packet's own contents", async () => {
  const a = fresh("pr-new-one-");
  writeFileSync(join(a.dir, "agenda.txt"), "5. Approve Contract No. 4500120070 with TRC Engineers, Inc.\n6. Adopt Resolution No. 26-01.");
  await intake(a.rec, join(a.dir, "agenda.txt"), { layer: "public" });
  const w = whatsNew(a.rec, null);
  assert.equal(w.changes.filter((c) => c.kind === "moved_figure" || c.kind === "moved_date").length, 0,
    "the control: one packet has nothing that moved");
  assert.deepEqual(new Set(w.suggestions), new Set(["What is on the agenda in agenda.txt?", "What is Contract 4500120070?", "What is Resolution 26-01?"]));
  a.rec.db.close();
  rmSync(a.dir, { recursive: true, force: true });
});
