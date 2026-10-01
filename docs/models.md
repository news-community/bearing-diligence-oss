# Choosing the answering model

A folder answers with a model on this computer by default, or with a hosted model through
OpenRouter if its owner chooses that in Settings. Which model is the default is decided by
measurement, and the measurement is reproducible with `tools/compare-models.mjs`.

## How models are judged

Twelve research questions over six public agendas of one utility board, each needing several
passages or several meetings: a total across contracts, why an item moved, two agreements compared,
what the agendas say about a position, what could affect what customers pay, and one whose honest
answer is that agendas do not record votes. Each question has an answer key: the facts a good answer
contains, written as patterns.

- **Recall** is the share of key facts found in sentences the answer checks kept. It is what
  separates a research assistant from search, and a fact stated without support earns nothing.
- **Kept share** is precision: the share of an answer's sentences that passed the checks.
- **Finished** counts the questions answered at all; a model that finishes fewer than five in six is
  listed as not ranked rather than scored on what it managed. `--runs` repeats the set so the spread
  is visible, and a difference inside the spread is not a ranking.

Models that can reason do, with room to reason. A model that cannot finish within the limits is not
recommended.

```bash
ELECTRON_RUN_AS_NODE=1 electron tools/compare-models.mjs --dir "<folder>" \
  --models local:qwen3:30b,cloud:anthropic/claude-opus-5.5 --out results.json
```

A `cloud:` model sends each question and its passages to OpenRouter, so the tool refuses to run one
without `--i-understand-this-sends-passages-to-openrouter` and a key in `OPENROUTER_API_KEY` for that
run. Use public material only.

## Results, 2026-09-30 and 2026-10-01

One run of the twelve questions per model, on a Mac with 128 GB of memory. Memory is what the model
runtime reported while answering, with the context window sized to the request.

| Model | Where | Finished | Recall | Median seconds | Memory |
|---|---|---|---|---|---|
| `anthropic/claude-opus-5.5` | hosted | 12 of 12 | 98% | 9 | hosted |
| `anthropic/claude-sonnet-5.5` | hosted | 12 of 12 | 94% | 7 | hosted |
| `openai/gpt-6-astra` | hosted | 12 of 12 | 94% | 7 | hosted |
| `gemma4:31b` | local | 11 of 12 | 75% | 202 | about 27 GB (estimated) |
| `qwen3:30b` | local | 12 of 12 | 68% | 45 | 21.8 GB |
| `gpt-oss:120b` | local | 12 of 12 | 64% | 33 | about 85 GB (estimated) |
| `gemma4:26b` | local | 12 of 12 | 60% | 71 | 17.7 GB |
| `gemma3:27b` | local | 12 of 12 | 38% | 93 | 18.8 GB |
| `gemma4:12b` | local | not ranked, 9 of 12 | 64% | 112 | 8.4 GB |

## How the default is chosen

`src/ui/models.ts` picks the pinned model that is installed at its pinned digest, fits this
computer's memory (the larger of the measured and the estimated need, within three quarters of the
machine), has been ranked, and answers within about 90 seconds as a median, by recall. On the
machine measured that is `qwen3:30b`. `gemma4:31b` found more but is too slow to be the first thing
a person meets, so it is offered rather than chosen. On a 16 GB machine no ranked research model
fits, and the reading model answers unless the person chooses another.

Settings shows each model's measured recall and speed beside it.

## What changed the numbers most

The application, more than the models:

- answer checks that refused true sentences (a grammar word before a name, a name across a line
  break, a document's own date, a gerund restating the agenda's verb, an honest caveat such as "the
  passages do not say whether it was approved");
- retrieval that let keyword matches on common words fill every slot, so the search by meaning never
  ran (fixed, one hosted model went from 83% to 98% recall);
- a time limit that covered only the start of a reply;
- a context window left at each model's maximum, which doubled memory.

## Not yet measured

A second run of the research set, minutes rather than agendas, other folders, any machine but the
one above, and cost as billed.
