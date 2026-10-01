import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkSentence, stripCitationMarkers } from "../src/answer/answer.js";
import { narrow, queryFrom } from "../src/answer/retrieve.js";
import type { Passage } from "../src/answer/retrieve.js";

const passage = (text: string): Passage => ({
  id: "p1", document_id: 1, filename: "packet.txt", page_no: 3, text, meeting: null, kind: "passage",
});

const SOURCE = passage(
  "Resolution 2026-07 authorises Contract PO-44821 in an amount not to exceed $1,200,000. " +
    "The work is scheduled to be complete by October 15, 2026. Director Alvarez asked for a report.",
);

test("a sentence with no receipt is dropped", () => {
  const r = checkSentence("The contract was approved.", []);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /no receipt/);
});

test("a sentence whose values are in its passage is kept", () => {
  const r = checkSentence("Resolution 2026-07 authorises up to $1,200,000.", [SOURCE]);
  assert.equal(r.ok, true);
});

test("a number the passage does not carry drops the sentence", () => {
  const r = checkSentence("Resolution 2026-07 authorises up to $1,400,000.", [SOURCE]);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /1,400,000/);
});

test("a date the passage does not carry drops the sentence", () => {
  const r = checkSentence("The work is due by December 3, 2026.", [SOURCE]);
  assert.equal(r.ok, false);
});

/**
 * The test above passes with the date check DELETED, which the deletion pass found on 2026-09-22:
 * the value check rejects that sentence first, on the bare 3. So it proves the sentence is dropped
 * and says nothing about which guard dropped it.
 *
 * This one can only be caught by the date check. Every component of "October 30, 2026" is in the
 * passage below (October, a 30 in the dollar amount, 2026 twice) and the date itself is not, which
 * is exactly the case the check's own comment describes.
 */
test("a date whose every PART is in the passage is still dropped, because the date is the value", () => {
  const src = passage(
    "Resolution 2026-07 authorises Contract PO-44821. Notice is given 30 days in advance. " +
      "The work is scheduled to be complete by October 15, 2026.",
  );
  const r = checkSentence("The work is due by October 30, 2026.", [src]);
  assert.equal(r.ok, false, "a whole date is the value, not its parts");
  assert.match(r.ok === false ? r.why : "", /date/, "and the reason names the date, not a number");
});

test("a name the passage does not carry drops the sentence", () => {
  const r = checkSentence("Director Petrov asked for a report.", [SOURCE]);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /Petrov/);
});

test("a name the passage does carry is allowed", () => {
  const r = checkSentence("Director Alvarez asked for a report.", [SOURCE]);
  assert.equal(r.ok, true);
});

test("a figure written differently is still checked against the passage", () => {
  const r = checkSentence("The amount is $1,200,000.", [SOURCE]);
  assert.equal(r.ok, true);
});

test("the query drops stop words and keeps the words that carry the question", () => {
  const q = queryFrom("What did the board decide about the substation contract?");
  assert.ok(q.includes("substation"));
  assert.ok(q.includes("contract"));
  assert.ok(!q.includes('"the"'));
});

test("a capitalised word that opens a sentence is not read as a name", () => {
  const r = checkSentence("Passage p1 states the contract amount not to exceed $1,200,000.", [SOURCE]);
  assert.equal(r.ok, true, r.ok === false ? r.why : "");
});

test("a real name still drops the sentence when it is not in the passage", () => {
  const r = checkSentence("The report from Director Petrov was received.", [SOURCE]);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /Petrov/);
});

test("a citation the model wrote into its own prose is removed, and its words are not", () => {
  assert.equal(
    stripCitationMarkers("The contract was authorised by Resolution 2026-07 {p1}."),
    "The contract was authorised by Resolution 2026-07.",
  );
  assert.equal(
    stripCitationMarkers("The amount rose {p1, p3} to $1.4 million."),
    "The amount rose to $1.4 million.",
  );
  assert.equal(
    stripCitationMarkers("The board (which meets monthly) agreed [see minutes]."),
    "The board (which meets monthly) agreed [see minutes].",
    "only a marker made entirely of passage ids is removed",
  );
});

test("a lone name in FIRST position is checked, because only known openers are exempt", () => {
  const r = checkSentence("Petrov asked for a report on the contract.", [SOURCE]);
  assert.equal(r.ok, false, "the first version exempted every lone capitalised word here");
  assert.match(r.ok === false ? r.why : "", /Petrov/);
});

test("a known opener in first position is still grammar, not a name", () => {
  assert.equal(checkSentence("Although the amount is $1,200,000, the work continues.", [SOURCE]).ok, true);
  assert.equal(checkSentence("Passage p1 states the contract amount not to exceed $1,200,000.", [SOURCE]).ok, true);
  assert.equal(checkSentence("According to the passage, the amount is $1,200,000.", [SOURCE]).ok, true);
});

test("a name in first position that IS in the passage is allowed", () => {
  assert.equal(checkSentence("Alvarez asked for a report.", [SOURCE]).ok, true);
});

test("a fabricated vote tally is refused, however small its numbers", () => {
  const votes = passage("Resolution 2026-07 passed. The motion carried on a vote of 5 to 0.");
  assert.equal(checkSentence("The motion carried on a vote of 5 to 0.", [votes]).ok, true);
  const r = checkSentence("The board approved it on a vote of 4 to 1.", [votes]);
  assert.equal(r.ok, false, "single digit values were skipped entirely until 2026-09-22");
  assert.match(r.ok === false ? r.why : "", /the value 4/);
});

test("a number that is merely a SUBSTRING of a real one is refused", () => {
  // $1,200,000 normalised to 1200000 contains 20, 12, 120 and 000, and containment certified them.
  assert.equal(checkSentence("The amount is $20.", [SOURCE]).ok, false);
  assert.equal(checkSentence("The rate rose to 12 percent.", [SOURCE]).ok, false);
  assert.equal(checkSentence("The reserve is 000 dollars.", [SOURCE]).ok, false);
});

test("the same value written differently is still the same value", () => {
  assert.equal(checkSentence("The amount is $1.2 million.", [SOURCE]).ok, true, "$1,200,000 by value");
  assert.equal(checkSentence("The amount is $1,200,000.", [SOURCE]).ok, true);
});

test("a short name is checked like any other", () => {
  const r = checkSentence("The report from Ito was received.", [SOURCE]);
  assert.equal(r.ok, false, "names of three characters were skipped everywhere but first position");
  assert.match(r.ok === false ? r.why : "", /Ito/);
});

test("an emptied citation bracket is removed, and a page-sized passage is kept whole", () => {
  assert.equal(stripCitationMarkers("Minutes of May 21 are on the consent calendar. ( )"), "Minutes of May 21 are on the consent calendar.");
  assert.equal(stripCitationMarkers("The amount increased to $29.67 million p10"), "The amount increased to $29.67 million");
  const page = "AGENDA June 18, 2026\n" + "Item text. ".repeat(180) + "\nConsent Calendar: minutes.";
  const kept = narrow({ id: "p1", document_id: 1, filename: "a.pdf", page_no: 1, text: page, meeting: null, kind: "passage" }, "consent calendar");
  assert.ok(page.length < 2400 && kept.text.includes("June 18") && kept.text.includes("Consent Calendar"),
    "a page shorter than the passage size keeps its heading, which the quote check needs");
});

test("a sentence saying an item was approved needs that word on its page, because an agenda only proposes", () => {
  const agenda: Passage = { id: "p1", document_id: 1, filename: "agenda.pdf", page_no: 2, meeting: null, kind: "passage",
    text: "5. Approve Contract Change No. 5 to Contract No. 4500120070, to increase the amount from $21.67 million to $29.67 million. Item 5 was reviewed by the March 17, 2026, Finance and Audit Committee." };
  const said = checkSentence("The Finance and Audit Committee approved Contract Change No. 5 on March 17, 2026.", [agenda]);
  assert.equal(said.ok, false, "the agenda says reviewed, not approved");
  assert.equal(checkSentence("The proposed change would increase the amount from $21.67 million to $29.67 million.", [agenda]).ok, true,
    "a sentence that states the proposal is kept");
  assert.equal(checkSentence("The not-to-exceed amount increased from $21.67 million to $29.67 million.", [agenda]).ok, false,
    "the agenda says to increase; a sentence saying it increased states an outcome the page does not");
  const minutes: Passage = { ...agenda, text: "The Board approved Contract Change No. 5, increasing the amount to $29.67 million." };
  assert.equal(checkSentence("The Board approved Contract Change No. 5.", [minutes]).ok, true, "minutes that say approved support it");
});

// Measured 2026-09-30: fluent models' true sentences refused by the check's own weak spots. Each
// case below is paired with the control the fix must still refuse.
const AGENDA = (text: string, filename = "2026-03-19_Agenda_BOD-Mtg.pdf"): Passage => ({ ...passage(text), filename });

test("a grammar word before a name is not part of the name, and a name across a line break is one name", () => {
  const p = AGENDA("Item 5 was reviewed by the March 17, 2026, Finance and Audit Committee and the Energy Resources & Customer Services\nCommittee.");
  assert.deepEqual(checkSentence("The Finance and Audit Committee reviewed Item 5.", [p]), { ok: true });
  assert.deepEqual(checkSentence("The Customer Services Committee reviewed an item.", [p]), { ok: true });
  assert.equal(checkSentence("The Budget Committee reviewed Item 5.", [p]).ok, false, "the control: a committee the page does not name");
});

test("a sentence may open with an ordinary word, and an invented name in first position is still refused", () => {
  const p = AGENDA("Approve Board member compensation and technology reimbursement for the period.");
  assert.deepEqual(checkSentence("Technology reimbursement is on the agenda.", [p]), { ok: true }, "the page holds it in lower case");
  assert.deepEqual(checkSentence("Later items concern compensation.", [p]), { ok: true }, "a discourse word");
  assert.equal(checkSentence("Petrov asked for a report on compensation.", [p]).ok, false, "the control: a name on the page in no case");
});

test("the date in a document's label is that passage's date, and another date is still refused", () => {
  const p = AGENDA("6. Approve the Memorandum of Understanding with IBEW Local 1245.");
  assert.deepEqual(checkSentence("The March 19, 2026 agenda includes the Memorandum of Understanding.", [p]), { ok: true });
  assert.equal(checkSentence("The April 2, 2026 agenda includes the Memorandum of Understanding.", [p]).ok, false, "the control: a date neither the page nor its label carries");
  assert.equal(checkSentence("The March 19, 2026 agenda includes the Memorandum.", [AGENDA("6. Approve the Memorandum.", "packet.pdf")]).ok, false,
    "and a file with no date in its name lends none");
});

test("saying the passages do not show an outcome is kept; claiming one, or its opposite, is still refused", () => {
  const p = AGENDA("6. Approve the Memorandum of Understanding with IBEW Local 1245.");
  assert.deepEqual(checkSentence("The passages do not say whether the Board approved the Memorandum.", [p]), { ok: true });
  assert.deepEqual(checkSentence("These are items the Board is asked to approve; the passages do not say they were approved.", [p]), { ok: true });
  assert.equal(checkSentence("The Board approved the Memorandum.", [p]).ok, false, "the control: an outcome claimed");
  assert.equal(checkSentence("The Memorandum was not approved.", [p]).ok, false, "and plain negation is a claim too");
});

test("a gerund restating the agenda's verb opens a sentence; a surname ending in -ing is still refused", () => {
  const p = AGENDA("7. Authorize the Chief Executive Officer and General Manager to execute the Water Forum 2050 Agreement.");
  assert.deepEqual(checkSentence("Authorizing the Chief Executive Officer to execute the Water Forum 2050 Agreement is on the agenda.", [p]), { ok: true });
  assert.equal(checkSentence("Fleming asked about the Water Forum 2050 Agreement.", [p]).ok, false, "the control: a name whose stem is not on the page");
});
