# Design

Bearing Diligence is private research over public meeting records. You open a folder of a local
body's documents (agendas, packets, minutes); it reads them on your computer, shows what changed
from one packet to the next, and answers questions where every sentence carries the quoted passage
it rests on. This document is for contributors: what the software promises, how each promise is
checked, and where the code that keeps it lives.

## The invariants

Each is a property the code keeps and a check holds it to. Code comments cite them by number.

| # | Invariant | How it is checked |
|---|---|---|
| 1 | **Nothing leaves the machine when you ask a question**, unless you chose a hosted model for that folder, and then only the question, up to two earlier turns and the passages retrieved for it, never a document, the index or the change record | The model endpoint is pinned to loopback in code; a gate refuses network code anywhere but the download module and the cloud module; `npm run watch-calls` records every call the running app makes. The full egress test (a packet filter, network up) is written and has not been run |
| 2 | **Documents enter by being put in the folder.** There is no scheduled download | The only network paths are the model download, from a manifest pinned by digest, and the hosted answering path a folder's owner chose |
| 3 | **Every sentence of an answer carries a receipt**: the passage it rests on. A sentence whose figures, dates, names or stated outcomes are not on its cited page is left out and shown as left out | `src/answer/answer.ts` checks each sentence; `src/quote/locator.ts` proves every quoted span exists. Only the reader can judge that a passage supports a sentence; the checks find what they can and say so |
| 4 | **The person authors the judgments; the machine retrieves and applies.** Nothing labels a vote wrong or a person dishonest | The answer prompt and a fixture of leading questions |
| 5 | **No silent escalation.** Nothing falls back from a local model to a hosted one or back | `src/harness/choose.ts` hands the answer path one asker; tests cover each failure on each side |
| 6 | **Retention is the person's.** No part of a question is written to disk unless that conversation is saved, or saving is switched on for that folder, and then only in that folder's own record; deleting compacts the file | `test/retention.test.ts` and the shell smoke read every byte the app wrote, after asking, write-ahead log included |
| 7 | **No telemetry.** Updates are checked only when you ask, or at launch if you switch that on, and the check sends nothing about you | The update check is its own module (`src/download/update.ts`) with a test of exactly what it sends |
| 8 | **The record lives in a folder you chose and confirmed**, and you are told when that folder syncs or sits in a git repository | `src/util/paths.ts` refuses an unconfirmed location and names what it checked and what it cannot see |
| 9 | **Documents are data, never instructions.** Text that reads as an instruction to a machine, or that a reader cannot see, is marked, and a mark changes nothing about retrieval or ranking | `src/screen/` reads hidden text from the PDF's drawing operators; a gate fails the build if retrieval or ranking reads the marks |
| 10 | **The model that reads a document has no tools**, and nothing offered to a model can reach the network or the shell | `toolsOffered()` in `src/harness/model.ts`, read by a gate |
| 11 | **A machine conclusion never becomes a source.** A transcription (OCR, speech) is labelled as one | Pages carry where their text came from; nothing a model concludes is stored as a passage |

## How an answer earns its receipts

1. **Retrieve by code.** Keyword search first, then search by meaning for what the words missed, with
   at least half the room kept for the search by meaning (`src/answer/retrieve.ts`). An answer gets
   sixteen passages, each up to a whole page.
2. **One model call.** The question, up to two earlier turns and the passages, with the instruction to
   cite passage ids for every sentence. A model that can reason does. The reply is structured and is
   refused if it does not parse.
3. **Check by code.** Each sentence is checked against the passages it cites: values, dates (a
   document's own date from its label counts), names, and outcome words such as "approved", which an
   agenda proposes rather than records. A sentence that fails is kept on screen as left out, with the
   reason.

The page shows the passage under every kept sentence and says, plainly, that the reader confirms it.

## The change record

When a document arrives it is compared, by code and without a model, with everything added before
it: identifiers that first appear, figures and dates that differ, items that recur
(`src/change/compare.ts`). Coverage comes first: what was read, what was not, and why. Changes that
quote the same pair of passages are shown as one comparison with every differing value marked
(`src/change/group.ts`).

## What leaves the machine

- **Model downloads**, once, each verified against the digest the manifest pins
  (`src/download/manifest.json`, `src/download/pull.ts`). `npm run models -- --pull` fetches only what
  this machine needs.
- **An update check**, only when asked.
- **A hosted answer**, only in a folder whose owner chose the cloud in Settings, after a confirmation
  that says what leaves: the question, up to two earlier turns and the passages found for it, to
  OpenRouter, asking for no data collection and zero data retention (the vendor's claims, which this
  app cannot check). The key is kept encrypted by the operating system's keychain. Reading,
  indexing and the change record never use it; a gate holds that only the chooser imports the cloud
  module.

## Choosing the answering model

Models are chosen by measurement, not by size: see [models.md](models.md).

## Where things are

| Area | Code |
|---|---|
| Reading a document | `src/ingest/` (intake, windows, the reading model), `src/extract/` (text and OCR) |
| The record | `src/record/` (SQLite schema, runs, conversations, the per-folder model choice) |
| Answers | `src/answer/` (retrieval, the answer and its checks) |
| The change record | `src/change/` |
| Models | `src/harness/` (the local runtime, pinned to loopback; the chooser), `src/cloud/` (OpenRouter) |
| The interface | `src/ui/app.html` (one page), `src/ui/api.ts` (one table of handlers for both bridges), `app/` (the Electron shell) |
| Gates over the code | `src/gates/` |
| Checks over the documents | `scripts/checks.py` |
