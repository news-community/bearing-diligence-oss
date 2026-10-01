import { strict as assert } from "node:assert";
import { test } from "node:test";
import { detectVotes } from "../src/votes/detect.js";
import { PACKET_A, UNANIMOUS_ONLY } from "./fixtures.js";

test("every vote shape in the fixture is found, or the run aborts", () => {
  const votes = detectVotes(PACKET_A);
  const shapes = votes.map((v) => v.shape);
  for (const want of ["tally", "named_counts", "unanimous_no_names"]) {
    assert.ok(shapes.includes(want), `shape ${want} missing from ${JSON.stringify(shapes)}`);
  }
});

test("a committee vote inside a board packet carries the committee", () => {
  const votes = detectVotes(PACKET_A);
  const committee = votes.find((v) => v.body.includes("Committee"));
  assert.ok(committee, "a vote printed under a committee heading must carry that body");
  assert.equal(committee.yes, 3);
  assert.equal(committee.no, 1);
});

test("a unanimous motion has no names and none are invented", () => {
  const votes = detectVotes(UNANIMOUS_ONLY);
  assert.equal(votes.length, 1);
  const v = votes[0]!;
  assert.equal(v.unanimous, true);
  assert.equal(v.yes, null, "a unanimous motion records no count it was not given");
  assert.equal(v.no, null);
});

test("a number that is not a vote is not read as one", () => {
  const votes = detectVotes("The substation is 4-1 miles from the plant and nothing was moved.");
  assert.equal(votes.length, 0, "a tally shape with no vote words around it is not a vote");
});

test("a page range is not a vote, however close the vote words are", () => {
  const votes = detectVotes(
    "Resolution 2026-14 was approved as presented; the staff report appears at pages 10-12 of the packet.",
  );
  assert.equal(
    votes.filter((v) => v.shape === "tally").length, 0,
    `a page citation was recorded as yes 10, no 12: ${JSON.stringify(votes.map((v) => [v.shape, v.yes, v.no]))}`,
  );
});

test("a section number is not a vote either", () => {
  const votes = detectVotes("The motion to adopt Ordinance 118 passed. Members are referred to Section 4-2 of the bylaws.");
  assert.equal(votes.filter((v) => v.shape === "tally").length, 0);
});

test("a real tally beside vote words is still read", () => {
  const votes = detectVotes("Resolution 2026-07 was approved on a vote of 5-2.");
  const tally = votes.find((v) => v.shape === "tally");
  assert.ok(tally, "the guard must not silence real tallies");
  assert.equal(tally.yes, 5);
  assert.equal(tally.no, 2);
});

test("two roll calls on one page stay two votes", () => {
  const votes = detectVotes("Item 5. Ayes: 5, Nays: 0. Item 6. Ayes: 3, Nays: 2.");
  const named = votes.filter((v) => v.shape === "named_counts");
  assert.equal(named.length, 2, `two roll calls merged into one and Item 6 vanished: ${JSON.stringify(named)}`);
  assert.equal(named[0]!.yes, 5);
  assert.equal(named[1]!.yes, 3);
});
