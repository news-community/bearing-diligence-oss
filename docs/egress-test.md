# The egress test

**Not yet run.** This is the procedure by which an outsider checks invariants 1 and 7 of
[the design](design.md): that nothing leaves the machine except what the design permits. Every
number here reads CALIBRATE until it has been run.

`npm run watch-calls` wraps `fetch` in the running process and records every call the application
makes. It is a weaker instrument on purpose and is NOT this test: it is blind to a dependency calling
out below that layer, to the speech sidecar, and to the model runtime itself. The runtime here is the
machine's own `ollama` reading the machine's own model store, and `npm run models -- --pull` is the
one command that is SUPPOSED to produce traffic, which makes it the test's positive control.

## Why this exists instead of the offline test


**Turning the network off proves the tool does not need the network. It cannot prove that nothing is
sent when the network is on.** Those are different claims, and it is easy to make the second from the
first. The difference is not hypothetical: during development the Ollama desktop application updated itself on the reference machine, which is exactly the
behaviour an offline test cannot see.

So there are two checks with two audiences:

| Check | Who runs it | What it proves |
|---|---|---|
| The offline test | **The person using it**, whenever they want | The tool keeps working with the network off, so it is not quietly depending on a service |
| **The egress test** | An outsider, on the release build, before every release | Nothing left the machine while the network was up |

## The sessions, and what each permits

A single rule of "zero connections" cannot hold, because the model has to arrive once. So the test is
scoped by session and each session has its own pass condition.

| Session | What happens in it | Permitted | Fails on |
|---|---|---|---|
| **First run** | The download module fetches models from a pinned manifest, verifies checksums | Connections from the download module to hosts named in the manifest | Any connection to any other host, and any connection from any other process |
| **Ingestion** | A packet is added and read overnight | Nothing | Any outbound connection from any process the application started, the download module included |
| **Question time** | Asking questions, reading answers, opening passages | Nothing | The same |
| **Launch, update check off** | The application opens with the setting at its default | Nothing | Any outbound connection from any process the application started |
| **Hosted answering** | A question in a folder whose owner chose a model on OpenRouter | Connections from the application to `openrouter.ai` only, and only while a question is being answered | Any other host, any connection during ingestion, and any request carrying a document, the index or the change record |
| **Update check** | Pressing Check for updates, or opening the application with the setting on | One request from the application to GitHub's release list for this repository | Any other host, any other process, and any request carrying a version or an identifier |

Loopback is not egress: the bundled runtime on 1948 and the speech sidecar are local by design, and
the test records them separately rather than counting them.

## The instrument

**Requirement: per-process attribution of outbound packets, including connections too short to catch
by polling.** Three candidates, with what each cannot see:

| Instrument | Gets | Misses |
|---|---|---|
| `tcpdump` on the `pktap` pseudo-interface, which carries the originating process on macOS | Every packet with a process name, including short-lived connections | Nothing at the packet layer, but see the two blind spots below |
| A per-process firewall (LuLu, Little Snitch) | An alert and a block per process, with a decision log | Depends on the vendor's own updater behaviour, and is another program on the machine under test |
| Polling `lsof -i` | Established sockets, cheaply | **A connection that opens and closes between polls**, which is what a telemetry ping looks like |

**Use `pktap` as the record and a per-process firewall as the block.** Polling alone is not an
instrument for this, and the procedure says so rather than leaving someone to discover it.

## Two blind spots, named because they change what the result means

1. **DNS resolution is proxied.** On macOS a name lookup goes through `mDNSResponder`, so the query
   appears as that daemon's traffic rather than the application's. A process can therefore reveal
   what it is looking for without a single packet attributed to it. The test records
   `mDNSResponder` queries during each session as a separate list, and an unexpected name in it is a
   finding even when no attributed packet exists.
2. **Background transfers are performed by another process.** A URL session handed to the system for
   background delivery is carried out by `nsurlsessiond`, which is not the application. The same
   recording rule applies: system delivery daemons are logged by name, and traffic from one during a
   session is a finding.

Both mean a clean attributed log is necessary and not sufficient, which is the difference between
this check and a guarantee.

## The control, without which a clean run means nothing

**Before each session, run the instrument against a program known to phone home and confirm it is
caught.** The Ollama desktop application is the one already known to do it on this machine, and it
is the right control because it is the exact failure the test exists for. A single `curl` to a known
host is the cheaper control and should also fire.

**If the control does not fire, the session's result is void**, not clean. Record the control's
result beside the session's, always, in the same file.

## What is recorded

One file per session, kept with the release, holding: the build identifier and its checksum,
the date, the session type, the control result, every attributed connection (time, process,
destination, bytes), every `mDNSResponder` query, every system-daemon connection, and the verdict.
No document text and no question text ever appears in it, which is the same rule the application's
own diagnostics follow.

## Pass, and what a pass does not say

- **First run:** connections only from the download module, only to manifest hosts, checksums
  verified. CALIBRATE: the manifest's host list.
- **Ingestion and question time:** zero attributed outbound connections, zero unexpected DNS names,
  zero system-daemon deliveries.
- **Every session:** the control fired.

A pass says: on this build, on this machine, during these sessions, nothing was observed leaving. It
says nothing about a different build, a different machine, or a session that did something this one
did not. **It is a measurement with a date on it, not a property of the design**, and it is repeated
on the release build before every release.
