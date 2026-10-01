# Bearing Diligence

**Get your bearings before the meeting.** Do your research. Show your sources.

**Private research over public meeting records, run on your own computer.** From
[Communities News](https://communities.news).

Open a folder of a local body's meeting records (agendas, packets, minutes) and Bearing Diligence
reads them on your computer with local AI models. It shows what changed from one packet to the next
(figures, dates and identifiers that moved), and it answers questions where every sentence carries
the quoted passage it rests on. A sentence no passage supports is left out and shown as left out,
not presented as fact.

**Who it is for:** people who follow a council, a school board or a utility; local reporters
covering those bodies; and directors reading their own board material. The records are public. What
stays private is the line of inquiry: what you are checking before anyone else knows you are checking
it.

## What stays on your computer

- **Your documents, the search index and the change record never leave it.**
- **What you ask is not written to disk** unless you save that conversation, which a test checks by
  reading every byte the app writes.
- **Answers come from a model on your computer** unless you choose, for one folder, a model on
  OpenRouter. Then your question and the passages found for it leave the computer, the app says so
  beside every question, and nothing falls back from one to the other.
- **Only two modules may reach the network**, the model download and that hosted answering path, and
  a gate fails the build if any other code could. The full network test
  ([docs/egress-test.md](docs/egress-test.md)) has not been run yet.

[docs/design.md](docs/design.md) lists the eleven invariants the software keeps and the check that
holds each one.

## Status

**A prototype that runs.** Reading a folder, the change record, answers with a quote under every
sentence and the desktop app work end to end, tested on synthetic material and small folders of real
public agendas. It has not yet been used by the people it is for, and it has been measured on one
Mac. [docs/STATUS.md](docs/STATUS.md) says exactly what is proven and what is not.

## Running it

You need a Mac, Node 22, and [Ollama](https://ollama.com).

```bash
npm install
npm run models -- --pull   # fetches only the models this machine needs, each checked against a pinned digest
npm run app
```

The app starts its own model runtime on `127.0.0.1:1948`. Open a folder of PDFs or text files; each
file is read in the background, and you can ask about any of them as soon as it is added.

**Which model answers** is chosen by measurement: the pinned model that found the most key facts on
twelve research questions, fits this computer's memory, and answers within about 90 seconds. On a
Mac with 32 GB or more that is `qwen3:30b`. Hosted models found more (94 to 98% of key facts against
at most 75% locally) and are faster. See [docs/models.md](docs/models.md) for the method and the
results, and `tools/compare-models.mjs` to rerun them on your own folder.

```bash
npm run check    # tests, code gates, document checks, the proof each can fail, and a smoke test of the real app
```

## Documents

- [docs/design.md](docs/design.md): the invariants, how an answer earns its receipts, and where the
  code is.
- [docs/STATUS.md](docs/STATUS.md): what runs and what does not.
- [docs/models.md](docs/models.md): how models are judged, and the results.
- [docs/egress-test.md](docs/egress-test.md): how an outsider can check that nothing leaves.
- [docs/releasing.md](docs/releasing.md): how a release is built, signed and checked, and how the
  app updates itself.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md): how to work on it.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
