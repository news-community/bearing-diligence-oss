import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dates, figures, identifiers, paragraphBounds } from "../src/change/patterns.js";
import { MOVED_IN_ANOTHER_FORMAT, PACKET_A } from "./fixtures.js";

test("identifiers are found by shape and normalised", () => {
  const ids = identifiers(PACKET_A).map((i) => i.id);
  for (const want of ["resolution:2026-07", "contract:PO-44821", "tariff:118", "docket:U-26-014", "agenda_item:4.1"]) {
    assert.ok(ids.includes(want), `expected ${want} in ${JSON.stringify([...new Set(ids)])}`);
  }
});

test("a figure in another format is the same figure", () => {
  const then = figures(MOVED_IN_ANOTHER_FORMAT.then)[0];
  const now = figures(MOVED_IN_ANOTHER_FORMAT.now)[0];
  assert.ok(then && now);
  assert.equal(then.value, now.value, "$1,200,000 and $1.2 million must normalise to one number");
});

test("a figure that really moved is not equal", () => {
  const then = figures("$1,200,000")[0];
  const now = figures("$1.4 million")[0];
  assert.ok(then && now);
  assert.notEqual(then.value, now.value);
});

test("percentages and dates are read", () => {
  assert.equal(figures("a rate increase of 3.5 percent")[0]?.value, 3.5);
  assert.equal(dates("complete by October 15, 2026")[0]?.iso, "2026-10-15");
  assert.equal(dates("due 7/1/2026")[0]?.iso, "2026-07-01");
});

test("a date that cannot exist is not a date", () => {
  assert.equal(dates("The hearing is set for February 31, 2026").length, 0);
  assert.equal(dates("Filed 19/05/2026 with the clerk.").length, 0, "month 19 does not exist");
  assert.equal(dates("February 29, 2024 was a Thursday").length, 1, "and a real leap day is a date");
  assert.equal(dates("February 29, 2026 is not").length, 0);
});

test("a month in capitals is still a month, because headings are in capitals", () => {
  assert.equal(dates("MARCH 5, 2026 REGULAR MEETING")[0]?.iso, "2026-03-05");
});

test("a numbered agenda item is its own unit even with no blank lines, as text from a PDF has", () => {
  const page = "3. Approve compensation (pursuant to Resolution No. 25-04-02) for\nFebruary 16, 2026, through March 15, 2026.\n4. Approval of the minutes of the meeting of February 19, 2026.";
  const at = page.indexOf("Resolution");
  const [from, to] = paragraphBounds(page, at, at + 10);
  const unit = page.slice(from, to);
  assert.ok(unit.startsWith("3. Approve") && unit.includes("March 15, 2026") && !unit.includes("minutes"),
    `item 3's unit stops where item 4 begins: ${JSON.stringify(unit)}`);
  assert.ok(identifiers(page).some((i) => i.id === "resolution:25-04-02"), "a resolution number keeps every segment");
});
