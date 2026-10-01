import { strict as assert } from "node:assert";
import { test } from "node:test";
import { controlsPass, locate, MIN_QUOTE_CHARS, nearest, normalise } from "../src/quote/locator.js";
import { PACKET_A } from "./fixtures.js";

const SOURCE =
  "Resolution 2026-07 authorises the general manager to execute Contract PO-44821 for substation " +
  "rebuild work in an amount not to exceed $1,200,000. The work is scheduled to be complete by " +
  "October 15, 2026. The board asked staff to report monthly.";

test("a real span is located once", () => {
  const r = locate("authorises the general manager to execute Contract PO-44821", SOURCE);
  assert.equal(r.verdict, "located");
  assert.ok(SOURCE.slice(r.start, r.end).includes("PO-44821"));
});

test("an invented span is absent, and says so", () => {
  const r = locate("authorises the general manager to sell the substation to a private buyer", SOURCE);
  assert.equal(r.verdict, "absent");
});

test("a span that appears twice is ambiguous, not located", () => {
  const twice = "The board asked staff to report monthly. In March the board asked staff to report monthly.";
  const r = locate("the board asked staff to report monthly", twice.toLowerCase());
  assert.equal(r.verdict, "ambiguous");
});

test("a quote under the floor is too short to be a receipt", () => {
  const r = locate("the board", SOURCE);
  assert.equal(r.verdict, "too_short");
  assert.match(r.detail, new RegExp(String(MIN_QUOTE_CHARS)));
});

test("eliding INSIDE one sentence is still a quotation", () => {
  const r = locate("authorises the general manager ... in an amount not to exceed $1,200,000", SOURCE);
  assert.equal(r.verdict, "located", r.detail);
});

test("eliding ACROSS a sentence is recombined, and refused", () => {
  const r = locate("authorises the general manager ... complete by October 15, 2026", SOURCE);
  assert.equal(r.verdict, "recombined", r.detail);
  assert.match(r.detail, /never written/);
});

test("smart quotes and long dashes do not change the answer", () => {
  const fancy = SOURCE.replace("$1,200,000", "“$1,200,000”");
  const r = locate('rebuild work in an amount not to exceed "$1,200,000"', fancy);
  assert.equal(r.verdict, "located", r.detail);
  assert.equal(normalise("a \u2014 b"), "a - b", "an em dash in a SOURCE document normalises; this file writes it as an escape because the dash sense reads source too");
});

test("the per source controls arm and behave on a real packet", () => {
  const c = controlsPass(PACKET_A);
  assert.equal(c.covered, true, c.detail);
});

test("a source too small to arm its controls is NOT COVERED, never passed", () => {
  const c = controlsPass("Too short.");
  assert.equal(c.covered, false);
  assert.match(c.detail, /not covered/);
});

test("a quote ending in an ellipsis locates on its core, and is not called absent", () => {
  const r = locate("authorises the general manager to execute Contract PO-44821...", SOURCE);
  assert.equal(r.verdict, "located", r.detail);
  assert.match(r.detail, /continues past/);
});

test("a quote OPENING with an ellipsis locates the same way", () => {
  const r = locate("...in an amount not to exceed $1,200,000", SOURCE);
  assert.equal(r.verdict, "located", r.detail);
});

test("an ellipsis does not rescue a span that is genuinely not there", () => {
  const r = locate("authorises the general manager to sell the substation outright...", SOURCE);
  assert.equal(r.verdict, "absent");
});

test("an ellipsis does not smuggle a too-short quote past the floor", () => {
  const r = locate("the board...", SOURCE);
  assert.equal(r.verdict, "too_short");
});

test("an ELIDED quote whose whole length is under the floor is refused", () => {
  // Each fragment clears the per-fragment minimum, and together they assert nothing. Found by
  // deleting the whole-quote floor and watching every test still pass.
  const r = locate("The board ... to report", SOURCE);
  assert.equal(r.verdict, "too_short", r.detail);
});

test("an ellipsis crossing a sentence that ends in a QUOTE MARK is still refused", () => {
  const src = 'The chair said the review "had been completed in full." The board then voted to approve the budget.';
  const r = locate('The chair said the review ... voted to approve the budget', src);
  assert.equal(r.verdict, "recombined", `the gate failed open on a closing quote: ${r.detail}`);
});

test("an ellipsis crossing a sentence that ends in a PARENTHESIS is still refused", () => {
  const src = "Staff prepared the analysis (see Attachment A.) The board directed staff to report monthly.";
  const r = locate("Staff prepared the analysis ... directed staff to report monthly", src);
  assert.equal(r.verdict, "recombined", r.detail);
});

test("an abbreviation is not a sentence end, so a true elided quote is not accused", () => {
  const src = "The board approved Res. No. 2026-14 authorizing the general manager to execute the amended agreement.";
  const r = locate("The board approved Res. ... authorizing the general manager to execute", src);
  assert.equal(r.verdict, "located", `a true claim was refused with a false accusation: ${r.detail}`);
});

test("a joined control that comes back AMBIGUOUS leaves the source not covered", () => {
  // A window whose opening sentence repeats made the control ambiguous, and every claim in it was
  // then accepted on the strength of a control that never tested recombination.
  const repeated =
    "The Board of Directors hereby resolves to approve the matter before it today without objection. " +
    "The Board of Directors hereby resolves to approve the matter before it today without objection. " +
    "Staff will report monthly on the substation rebuild programme and its schedule.";
  const c = controlsPass(repeated);
  assert.equal(c.covered, false, c.detail);
  assert.match(c.detail, /never tested recombination|not covered/);
});

test("a hyphen at the end of a line is not a difference, and a hyphen before a space still is", () => {
  // Measured 2026-09-30: six of 22 "absent" refusals on six real agendas were one web address the
  // PDF breaks after a hyphen, so an exact quote of it was refused while it sat on the page.
  const page = "Live video streams (view-only) and indexed archives of meetings are available at:\n" +
    "https://www.example.org/Corporate/About-us/Board-Meetings/Watch-or-\nListen-online\n";
  const r = locate("https://www.example.org/Corporate/About-us/Board-Meetings/Watch-or-Listen-online", page);
  assert.equal(r.verdict, "located");
  assert.ok(page.slice(r.start, r.end).endsWith("Listen-online"));
  // The control: a hyphen followed by an ordinary space is a real difference and is kept.
  assert.equal(locate("meetings of the board - with members of the public present", "meetings of the board -with members of the public present").verdict, "absent");
});

test("a quote that was not found points at the stretch of the page it comes closest to", () => {
  // Measured 2026-09-30: most refusals on real agendas were near copies of standing text, like this.
  const page = "Board and CEO Reports:\n8. Directors' Reports.\n9. President's Report.\n10. CEO's Report.\nAdjournment.";
  const r = nearest("Directors' Reports. Presidents Report. CEO's Report.", page)!;
  assert.equal(locate("Directors' Reports. Presidents Report. CEO's Report.", page).verdict, "absent", "the control: the locator still refuses it");
  assert.match(page.slice(r.start, r.end), /Directors' Reports[\s\S]*CEO's Report/);
  assert.ok(r.shared >= 0.6, `most of its words are there: ${r.shared}`);
  assert.ok(nearest("an unrelated sentence about substations and barges", page)!.shared < 0.3, "and an unrelated quote shares little");
});
