# Bearing Diligence: working rules

Instructions for coding agents (and people) working in this repository. Bearing Diligence is private
research over public meeting records, run on local models: it reads a folder of agendas and packets,
shows what changed, and answers with a source passage under every sentence. Start at
[README.md](README.md), then [docs/design.md](docs/design.md) for the invariants and
[docs/STATUS.md](docs/STATUS.md) for what actually runs.

## Keep it proportional

- **Small, reversible work is just done.** Styling, copy, renames, bug fixes and tidy-ups: make the
  change, run the checks, commit with a short message.
- **A change to an invariant changes [docs/design.md](docs/design.md)** in the same commit, with the
  check that now holds it.
- **Add a new check only when a failure would be costly and likely to recur.** Most fixes need a
  test, not a new sense or gate.
- **Report plainly.** Say what changed and whether the checks passed.

## Writing

- **No em dashes or en dashes**, in prose, code, pages or commit messages. A dash that code must
  match is written as a Unicode escape in the source, never as the character itself.
- **A value not yet measured reads CALIBRATE**; do not invent one. A measurement names the model,
  the machine and the command that produced it.
- **A vendor's privacy or security claim is a claim** unless a mechanism an outsider can check is
  named.
- **Links stay inside this repository.**

## Where things go

| Kind | Where |
|---|---|
| The invariants and how they are checked | `docs/design.md` |
| What runs and what does not | `docs/STATUS.md` |
| How models are judged, and the results | `docs/models.md` |
| How an outsider checks nothing leaves | `docs/egress-test.md` |
| Meeting packets and other documents | Never in git |

## How the code fits together

- **Everything runs under Electron's own Node** (`ELECTRON_RUN_AS_NODE=1` in every script), so there
  is one native build of `better-sqlite3`. Use `npm run <script>`, never bare `node`.
- **One table of handlers, `src/ui/api.ts`, feeds both bridges** (`app/preload.cjs` for the app,
  `tools/ui-dev/serve.ts` for the browser development server). Add a handler there, and give it a
  control on the page.
- **The page is a conversation**: answers stack above a question box, and the documents and the
  checks are a drawer one click away. Settings is the same page at `#settings` in its own window.
  Every action is one function on the page whichever way it arrives: a control, a key, or the menu
  bar, whose commands reach the page over the one `menu` channel in the preload (the bridge gate
  allows exactly that channel). Each folder keeps its own record; the shell keeps a record open while
  its documents are still being read, so switching folders never stops a reading.
- **Only the download module and the cloud module may reach the network.** The app binds nothing and
  talks to the local model runtime on 127.0.0.1:1948. The cloud module (`src/cloud/openrouter.ts`)
  answers questions through OpenRouter only in a folder whose owner chose it in Settings, and only the
  chooser (`src/harness/choose.ts`) may import it: reading documents, the search index and the change
  record never reach it. Its key lives in the app's profile, encrypted by the keychain. No fallback
  either way: a cloud failure is never retried locally, nor a local one in the cloud.
- **No part of a question is written to disk unless the person saves that conversation** or has
  switched on saving for that folder (invariant 6), and then only into that folder's
  record, where Delete compacts the file. `test/retention.test.ts`, `test/conversations.test.ts` and
  the shell smoke check both halves by reading every byte the app wrote.
- **Models are chosen by measurement.** `tools/compare-models.mjs` asks twelve research questions
  with answer keys and scores recall (key facts in kept sentences) and precision; the manifest
  records what each pinned model measured, and `src/ui/models.ts` picks the default from those
  numbers, not from size. Answers reason when a model can (`src/harness/model.ts`), get sixteen
  passages with half kept for the search by meaning (`src/answer/retrieve.ts`), and a context window
  sized to the request. Re-measure after changing any of these.
- **Marks on suspicious packet text are a disclosure, not a filter** (invariant 9): they never change
  what is retrieved or how it ranks.
- **The page's colours are tokens** in `src/ui/app.html`, light and dark, styled after
  communities.news; a gate and the smoke check their contrast.

## Checking

```bash
npm run check          # tests, gates, senses (and their --prove mode), shell smoke, counts
```

Run it before committing anything that touches code. For a documents-only change,
`python3 scripts/checks.py` is enough. Tests that need the model runtime report "did not run" when
it is down; start it or set `SKIPS_OK=1`. Slower checks for release gates: `npm run deletion-pass`,
`npm run watch-calls`, `npm run models`, `npm run probes`. The counts in `docs/STATUS.md` are
generated by `npm run counts`; do not type them.

`npm run probes` is the one measurement here that is not a fact about a file, and it needs neither a
gold answer nor a real packet, which is why it can run before any real packet is scored. It mutates
an input whose effect is known and checks the output moved the way it had to, in five families: the
receipt check under mutation (no record, no model), the document mutated before it is read, retrieval
under a question written two ways, the answering path on things the record does not contain, and the
party swap. Three rules make it a measurement rather than decoration. **Three polarities, not two**:
a value-preserving change must stay supported, a value-changing one must be refused AND name what
changed, and a documented exemption must stay unchecked, so a limit fails when it silently becomes a
capability. **A positive control on every family that can answer "nothing survived"**, because a dead
model and an honest refusal produce the same silence. And **required versus measured**, checked by
looking, so a failure cannot be reclassified until it passes. `npm run probes -- --prove` makes all
six of its controls come back negative. A probe is an instrument and never a filter, which the
eleventh gate enforces.

The harness's checks, which `scripts/checks.py` requires this table to name:

| Check | Looks for |
|---|---|
| dashes | Em and en dashes, and their HTML entities |
| tables | Table rows with the wrong number of columns |
| links | Relative links to missing files |
| derived counts | Numbers in prose that disagree with what they count |
| closed | Links, imports or paths that reach outside this repository |
| code paths | A source file named in prose that does not exist |
| no packets | A document or recording committed under fixtures/ |
| documented | A check missing from this table, or listed and not real |
| forbidden reference *(over the code)* | Network code or web addresses outside the download and cloud modules, or any host but OpenRouter's in the cloud module |
| no fallback *(over the code)* | Any hosted model provider named outside the cloud module, or any but OpenRouter inside it |
| loopback pinned *(over the code)* | A model endpoint that is not loopback, or read from the environment |
| tool list empty *(over the code)* | Any tool offered to the model |
| download isolated *(over the code)* | Ingestion or question code importing the download module |
| cloud isolated *(over the code)* | Any file but the chooser importing the cloud module |
| one way in *(over the code)* | A path that adds a document without the intake sequence |
| a mark changes nothing *(over the code)* | Retrieval or ranking reading invariant 9's marks |
| one table behind both bridges *(over the code)* | A bridge method written by hand |
| the page calls what the table offers *(over the code)* | A handler with no control, or a call with no handler |
| every colour pair clears its floor *(over the code)* | A colour pair below its contrast floor, in either theme |
| the application never imports the harness *(over the code)* | Application code importing the probe harness |

## Git

Commit to a branch and open a pull request. `npm run check` must pass. Never commit a meeting packet,
a recording, a model file or a key: `.env` is ignored, and the "no packets" sense refuses documents
under `fixtures/`.
