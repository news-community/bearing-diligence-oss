# Changelog

## 0.1.0, unreleased

First public release of the source. A prototype: it runs end to end and has not yet been used by the
people it is for. See [docs/STATUS.md](docs/STATUS.md).

- Open a folder of meeting records; each PDF or text file is read on your computer, with OCR for
  scanned pages.
- A change record, computed by code, of figures, dates and identifiers that moved between packets.
- Answers where every sentence carries the quoted passage it rests on, and sentences the checks cannot
  support are shown as left out.
- The answering model is chosen per folder: a pinned local model through Ollama, chosen by measured
  research recall, or, by the folder owner's choice, a hosted model through OpenRouter.
- Conversations are not saved unless you save them.
- A disk image for Apple silicon Macs, signed and notarised, that offers to move itself to
  Applications when opened from the disk image.
- Updates: Check for updates asks GitHub and sends nothing about you; Install verifies the release's
  signature, checksum, Apple signature and version before replacing the app, and Restart finishes it.
- The app finds Ollama and tesseract where their installers put them, including when it is opened
  from the Finder.
