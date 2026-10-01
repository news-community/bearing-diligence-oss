# Contributing

Thank you. Issues and pull requests are welcome.

## Before you start

- Read [docs/design.md](docs/design.md). The invariants are the product: a change that weakens one
  needs to say so and say why.
- Read [CLAUDE.md](CLAUDE.md), which holds the working rules for people and coding agents alike.

## Setting up

You need macOS, Node 22, and [Ollama](https://ollama.com).

```bash
npm install
npm run models -- --pull   # the models this machine needs, each checked against its pinned digest
npm run app
```

## Checking

```bash
npm run check
```

It runs the tests, the code gates, the document checks, the proof that each check can fail, a smoke
test of the real app, and regenerates the counts in `docs/STATUS.md`. Tests that need the model
runtime say "did not run" when it is down; start it, or set `SKIPS_OK=1` to accept that.

## Pull requests

- Keep them small and say what changed and how you checked it.
- No em or en dashes anywhere, including commit messages. The checks will tell you.
- **Never commit a meeting packet, a recording, a model file or a key.** Test with public records
  you download yourself, and keep them out of the repository.
- A new claim in `docs/STATUS.md` names the test or command that proves it.

By contributing you agree that your contribution is licensed under the MIT License.
