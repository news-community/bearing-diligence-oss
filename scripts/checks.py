#!/usr/bin/env python3
"""Senses for Bearing Diligence: checks that run whatever the documents say, and can come back empty.

    python3 scripts/checks.py           every sense against the working tree
    python3 scripts/checks.py --prove   plant a failing case for each sense; every one must fire

A sense that has never been shown to fail is not a sense, it is a decoration, so --prove is what
makes a clean run mean anything. Every sense declares what it CANNOT see, because the failure that
costs most here is not a broken check, it is a working check whose axis excludes half the claim.

Adding a sense is how a review becomes capacity instead of a paragraph: when something is found
that no sense here could have caught, the fix lands with a new sense, in the same commit.
"""
import json, os, re, sys, shutil, subprocess, tempfile
from pathlib import Path

DASHES = re.compile("[\u2014\u2013]")  # escapes, not literals: see CLAUDE.md
LINK = re.compile(r"\]\(([^)]+)\)")
PIPE = re.compile(r"(?<!\\)\|")


IGNORED_DIRS = {".git", "node_modules", "dist", ".venv", "__pycache__"}


def owned(root):
    """What this repository holds, which is what git tracks.

    Dependencies are not this repository's prose: before this boundary existed, the senses reported
    122 findings and every one of them was in node_modules. A tool that reads its own dependencies
    is measuring somebody else's material and calling it yours.
    """
    # Tracked AND untracked-but-not-ignored. This read `git ls-files` alone until 2026-09-28, which
    # made every sense blind to a new document until it was added: a plan planted with a dash and a
    # missing path printed "0 finding(s)", so the pass run before a
    # commit was the one pass that could not see the file being committed. --prove now plants in an
    # untracked file too.
    r = subprocess.run(["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard"],
                       capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return [root / line for line in sorted(set(r.stdout.strip().split("\n")))]
    return [
        p for p in root.rglob("*")
        if p.is_file() and not (IGNORED_DIRS & set(p.relative_to(root).parts))
    ]


def md_files(root):
    return sorted(p for p in owned(root) if p.suffix == ".md" and p.exists())


def rel(root, p):
    return str(p.relative_to(root))


# ---------------------------------------------------------------- senses

# The rule is "never use em dashes in anything you produce", and this sense read only markdown for a
# day and a half. An HTML entity in the interface rendered one where nothing could see it.
DASH_SUFFIXES = (".md", ".html", ".ts", ".tsx", ".js", ".mjs", ".py", ".json", ".css")
DASH_ENTITY = re.compile("&" + "(mdash|ndash|#8212|#8211|#x2014|#x2013);", re.I)


def sense_dashes(root, baseline):
    out = []
    for p in owned(root):
        if p.suffix not in DASH_SUFFIXES or not p.exists():
            continue
        for n, line in enumerate(p.read_text(errors="replace").split("\n"), 1):
            if DASHES.search(line):
                out.append(f"{rel(root, p)}:{n} em or en dash")
            elif DASH_ENTITY.search(line):
                out.append(f"{rel(root, p)}:{n} an HTML entity that renders as a dash")
    return out


def sense_tables(root, baseline):
    out, = [[]]
    for p in md_files(root):
        rows = []
        for n, line in enumerate(p.read_text().split("\n") + [""], 1):
            if line.startswith("|"):
                rows.append((n, line))
                continue
            if rows:
                want = len(PIPE.findall(rows[0][1]))
                out += [f"{rel(root, p)}:{m} table row has {len(PIPE.findall(r))} columns, header has {want}"
                        for m, r in rows if len(PIPE.findall(r)) != want]
                rows = []
    return out


def sense_links(root, baseline):
    out = []
    for p in md_files(root):
        for m in LINK.finditer(p.read_text()):
            target = m.group(1).split("#")[0]
            if not target or target.startswith(("http", "mailto")):
                continue
            if not (p.parent / target).resolve().exists():
                out.append(f"{rel(root, p)} links to missing {target}")
    return out


WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
         "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15}


def sense_counts(root, baseline):
    """Numbers written in prose, re-derived from what they describe.

    A copy of a number is what goes stale, so STATUS's headline is generated (npm run counts) and
    the few numbers that remain in prose are read back here against the thing they count.
    """
    out = []
    status = (root / "docs/STATUS.md").read_text() if (root / "docs/STATUS.md").exists() else ""
    readme = (root / "README.md").read_text()
    design = (root / "docs/design.md").read_text() if (root / "docs/design.md").exists() else ""

    def count_in(path, pattern):
        f = root / path
        return len(re.findall(pattern, f.read_text())) if f.exists() else -1

    tests = sum(len(re.findall(r"^test\(", (root / "test" / f.name).read_text(), re.M))
                for f in (root / "test").glob("*.test.ts")) if (root / "test").exists() else -1
    gates = count_in("src/gates/gates.ts", r"(?m)^export const \w+: Gate = \{")
    guards = count_in("scripts/deletion-pass.mjs", r"(?m)^  \{$")
    gates_src = (root / "src/gates/gates.ts").read_text() if (root / "src/gates/gates.ts").exists() else ""
    block = gates_src.split("const PAIRS: Array<[fg: string, bg: string, role: Role, where: string]> = [")
    colour_pairs = len([l for l in block[1].split("\n];")[0].split("\n") if l.strip().startswith("[")]) if len(block) > 1 else -1
    invariants = len(re.findall(r"(?m)^\| \d+ \| \*\*", design))

    for label, text, pattern, actual in [
        ("tests, in STATUS", status, r"(\d+) tests", tests),
        ("document senses, in STATUS", status, r"(\d+) document senses", len(SENSES)),
        ("code gates, in STATUS", status, r"(\d+) code gates", gates),
        # The second number: the first is how many were CAUGHT, which only a run can say.
        ("guards, in STATUS", status, r"\d+ of (\d+) guards caught", guards),
        ("guards, in STATUS's deletion-pass row", status, r"removes (\d+) guards", guards),
        ("colour pairs, in STATUS", status, r"holds (\d+) pairs", colour_pairs),
        ("invariants, in the README", readme, r"(\w+) invariants", invariants),
    ]:
        m = re.search(pattern, text, re.I)
        if m is None:
            out.append(f"the number for {label} is no longer stated where this sense looks for it")
            continue
        said = WORDS.get(m.group(1).lower(), None)
        said = said if said is not None else (int(m.group(1)) if m.group(1).isdigit() else None)
        if said is None:
            out.append(f"{label}: '{m.group(1)}' is not a number this sense can read")
        elif actual >= 0 and said != actual:
            out.append(f"{label}: the text says {said}, the thing itself has {actual}")
    return out


# Built from parts on purpose: written whole, this pattern would itself be an absolute path in a
# file the closure sense reads, and the checker is not exempt from the check.
# A drive letter is a single letter, so it must not be preceded by one: without the lookbehind
# this matched the string "PASSAGES:\\n" in a prompt template.
ABSPATH = re.compile("(" + "/Users" + "/|" + "/home" + "/[a-z]|(?<![A-Za-z])[A-Z]:" + chr(92) + chr(92) + ")")
IMPORTISH = re.compile(r"""(?:from|import|require|open|Path)\s*\(?\s*['"]([^'"]+)['"]""")


def sense_closed(root, baseline):
    """Nothing here resolves into another tree. Standalone is gated, not asserted.

    A citation in code text is fine; a LINK or an import is not, because it only works from inside
    one particular checkout.
    """
    out = []
    for p in owned(root):
        if p.is_symlink():
            out.append(f"{rel(root, p)} is a symlink, which points out of this repository by design")
        if not p.is_file() or p.suffix not in (".md", ".py", ".ts", ".tsx", ".js", ".mjs", ".json"):
            continue
        text = p.read_text(errors="replace")
        for n, line in enumerate(text.split("\n"), 1):
            # A web address is not a path on this machine. Until 2026-09-29 the rule read inside them,
            # and a research record citing a vendor blog under /home/ was reported as one machine's
            # layout.
            if ABSPATH.search(re.sub(r"https?://\S+", "", line)):
                out.append(f"{rel(root, p)}:{n} carries an absolute path, which is one machine's layout")
        targets = [m.group(1) for m in LINK.finditer(text)]
        if p.suffix != ".md":
            targets += [m.group(1) for m in IMPORTISH.finditer(text)]
        for t in targets:
            t = re.sub(r'\s+"[^"]*"$', "", t).split("#")[0].strip()
            if not t or t.startswith(("http", "mailto", "tel:", "data:", "/")):
                continue
            if not t.startswith("."):
                continue
            try:
                dest = (p.parent / t).resolve()
            except Exception:
                continue
            if not str(dest).startswith(str(root.resolve())):
                out.append(f"{rel(root, p)} reaches {t}, which is outside this repository")
    return out


DOCEXT = re.compile(r"\.(pdf|docx?|pptx?|xlsx?|mp3|wav|m4a|mp4|mov|eml|msg|zip)$", re.I)


def tracked(root):
    return [str(p.relative_to(root)) for p in owned(root)]


def sense_no_packets(root, baseline):
    """Invariant 8 at the repository boundary: no board material in git, ever.

    The private layer never lands here and neither does a public fixture: only the labels, digests
    and results that say what was done to one. There is no way back from a packet in git history
    except a rewrite, so this refuses the file rather than the commit.
    """
    out = []
    for f in tracked(root):
        if DOCEXT.search(f):
            out.append(f"{f} is a document or media file, which invariant 8 keeps out of git")
        elif f.startswith("fixtures/") and not f.endswith((".md", ".json")):
            out.append(f"{f} is under fixtures/ and is neither a label nor a manifest")
    return out


def sense_documented(root, baseline):
    """Every sense and gate is named in CLAUDE.md, and CLAUDE.md names no sense that does not exist.

    The table in CLAUDE.md said six senses while the harness had nine, in the file that carries the
    rule about numbers written in prose. A list of checks is exactly the kind of thing that goes
    stale silently, because nothing fails when a check is missing from a document.
    """
    doc = (root / "CLAUDE.md")
    if not doc.exists():
        return ["CLAUDE.md is missing, so nothing documents the senses"]
    text = doc.read_text()
    out = []
    gate_rows = code_gates(root)
    ran = [r for r in gate_rows if r[0] != "build"]
    if not ran:
        # "Nothing looked" is not "nothing found". With no usable build the gate NAMES are unknown,
        # so only the half that does not need them is asked: every sense here must be documented.
        # Asking the other half anyway would report all ten documented gates as ones the harness
        # does not have, which is the document being accused of the harness's own failure.
        out.append(f"the code half of this sense did not run, so the gates were not compared: "
                   f"{gate_rows[0][1] if gate_rows else 'no rows came back'}")
    names = [name for name, _fn, _s, _b in SENSES] + [r[0] for r in ran]
    for n in names:
        if f"| {n} " not in text:
            out.append(f"the harness has a check called \"{n}\" and CLAUDE.md does not name it")
    if ran:
        for m in re.finditer(r"^\| ([a-z][a-z ]+?) (?:\*\(over the code\)\* )?\| ", text, re.M):
            listed = m.group(1).strip()
            if listed not in names and listed not in ("sense",):
                out.append(f"CLAUDE.md names a check called \"{listed}\" that the harness does not have")
    return out


# A path in code text is a citation, and a citation to a file that is gone is a lie about the tree.
CODE_PATH = re.compile(r"`((?:src|app|test|tools|scripts|sidecar)/[A-Za-z0-9_./-]+)`")


def sense_code_paths(root, baseline):
    """A source file named in prose that is not in the tree.

    The `links` sense resolves markdown links; this resolves paths written as code, which is how
    every document here cites a module. Added 2026-09-22 after a sixth request to bring the plan up
    to date: the counts sense made numbers mechanical, and this makes the other half of staleness
    mechanical, which is prose naming a file that moved.
    """
    out = []
    for f in md_files(root):
        for n, line in enumerate(f.read_text(errors="replace").split("\n"), 1):
            for m in CODE_PATH.finditer(line):
                target = m.group(1).rstrip(".,;:")
                if not (root / target).exists():
                    out.append(f"{rel(root, f)}:{n} names {target}, which is not in the tree")
    return out


SENSES = [
    ("dashes", sense_dashes, "em and en dashes, and the HTML entities for them, in markdown, source, pages and styles",
     "a dash arriving at runtime from data, and every other kind of wrong sentence"),
    ("tables", sense_tables, "a table row whose column count differs from its header, in every file",
     "a table whose columns are right and whose contents are wrong"),
    ("links", sense_links, "a relative link with no file at the other end",
     "a link that resolves to the wrong file, and anchors inside a file"),
    ("derived counts", sense_counts, "a number in prose that disagrees with the thing it counts",
     "every count not in its list, which is the reason that list is meant to grow"),
    ("closed", sense_closed, "a link, an import, a symlink or an absolute path that reaches outside this repository",
     "a citation in code text, which is deliberate and is how this tree names a sibling, and the two commands in CLAUDE.md that are documented as running from the umbrella root"),
    ("documented", sense_documented, "a check the harness has that CLAUDE.md does not name, or the reverse",
     "a check named correctly and described wrongly, and every check nobody thought to write"),
    ("code paths", sense_code_paths, "a source file named in prose that is not in the tree",
     "a path that resolves to the wrong file, a directory named without a file, and every module nobody cited"),
    ("no packets", sense_no_packets, "a document, a recording or anything but a label under fixtures/, in git",
     "a packet's text pasted into a markdown file, which is how this gets broken by someone helpful"),
]


def headline(root):
    """The four numbers in STATUS, each derived from the thing it counts.

    Three of them exist in files and are derived here. The fourth, how many guards were CAUGHT, is
    what happened rather than what exists, so it is read from what the deletion pass wrote, with the
    date it ran. It is never invented: a headline on 2026-09-22 claimed 17 of 17 before the pass had
    finished, and the pass came back 14 of 17.

    Generated rather than checked, which is the stronger form. A check tells you a hand-written
    number has drifted; generation removes the hand. Adopted 2026-09-22 from a public portfolio
    repository whose project catalog is generated from the repositories themselves, with a
    validation mode that fails when the generated copy is stale.
    """
    tests = sum(len(re.findall(r"^test\(", (root / "test" / f.name).read_text(), re.M))
                for f in (root / "test").glob("*.test.ts")) if (root / "test").exists() else 0
    gates = len(re.findall(r"(?m)^export const \w+: Gate = \{", (root / "src/gates/gates.ts").read_text()))
    guards = len(re.findall(r"(?m)^  \{$", (root / "scripts/deletion-pass.mjs").read_text()))
    line = f"{tests} tests    {gates} code gates    {len(SENSES)} document senses    "
    rec = root / "docs" / "deletion-pass.json"
    if rec.exists():
        d = json.loads(rec.read_text())
        if d.get("total") != guards:
            line += (f"{d['caught']} of {d['total']} guards caught when deleted, LAST RUN {d['ran']}, "
                     f"and there are {guards} guards now: run npm run deletion-pass")
        else:
            line += f"{d['caught']} of {d['total']} guards caught when deleted"
    else:
        line += f"{guards} guards, NEVER RUN: run npm run deletion-pass"
    return line


def write_headline(root):
    """Put the generated line into STATUS, between its fences. Returns whether anything changed."""
    p = root / "docs" / "STATUS.md"
    text = p.read_text()
    want = headline(root)
    m = re.search(r"(?m)^(\d+ tests {4}\d+ code gates.*)$", text)
    if not m:
        return "the headline is no longer where this looks for it, in docs/STATUS.md"
    if m.group(1) == want:
        return None
    p.write_text(text[: m.start(1)] + want + text[m.end(1) :])
    return f"rewritten: {want}"


def newest_mtime(bases, suffixes):
    """The newest file of these kinds under these directories, and its path. (0, "") if none."""
    best, name = 0.0, ""
    for base in bases:
        if not base.exists():
            continue
        for f in base.rglob("*"):
            if f.suffix in suffixes and f.is_file():
                m = f.stat().st_mtime
                if m > best:
                    best, name = m, str(f.relative_to(base.parent))
    return best, name


def code_gates(root, prove=False):
    """The gates over the CODE, folded in here so there is one harness rather than two.

    They live in TypeScript because they read TypeScript, and they answer the same contract: each
    declares what it cannot see, and --prove plants a failing case per gate. A missing build is a
    FINDING rather than silence, because a harness that reports clean when it ran nothing is the
    failure this whole file exists to prevent.
    """
    entry = root / "dist" / "src" / "gates" / "run.js"
    if not entry.exists():
        return [("build", "the code gates did not run: dist/ is not built (npm run build)", "", False)]
    # Absence was a finding from the first version; STALENESS was not, and on 2026-09-29 that cost a
    # false accusation. dist/ was six days old, so three gates that exist in src/gates/gates.ts were
    # absent from what actually ran, one had been renamed, and the `documented` sense reported that
    # CLAUDE.md "names a check the harness does not have" three times. The harness had them. This
    # file reads the BUILD of the code gates, which is a proxy for their source, and a proxy nobody
    # checks the freshness of is the defect this repository keeps finding in other clothes. A false
    # accusation and a false clean are the same fault: the instrument answered about other material.
    src_at, src_file = newest_mtime([root / "src", root / "tools", root / "test"], {".ts"})
    dist_at, _ = newest_mtime([root / "dist"], {".js"})
    if src_at > dist_at:
        return [("build", f"the code gates ran a stale build: {src_file} is newer than dist/ (npm run build)", "", False)]
    # Electron's own Node, the one native build (package.json), never whatever `node` is on PATH.
    electron = root / "node_modules" / ".bin" / "electron"
    cmd = [str(electron), str(entry), "--json"] + (["--prove"] if prove else [])
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(root), env=env)
    try:
        rows = json.loads(r.stdout)
    except Exception:
        # Say what happened. On 2026-09-29 this fired with an EMPTY detail, because stderr was empty
        # (node_modules was being rewritten by an install underneath the run), and "produced no JSON:"
        # followed by nothing is an instrument failure reporting nothing about itself. The exit code
        # always exists; stdout is quoted when stderr has nothing to say.
        why = r.stderr.strip()[:200] or (r.stdout.strip()[:200] and f"stdout was {r.stdout.strip()[:200]!r}") \
            or "both stdout and stderr were empty"
        return [("build", f"the code gates produced no JSON (exit {r.returncode}): {why}", "", False)]
    out = []
    for row in rows:
        out.append((row["name"], row["findings"], row["blind_to"], row.get("fired", False)))
    return out


def git_baseline(root):
    def read(relpath):
        r = subprocess.run(["git", "-C", str(root), "show", f"HEAD:{relpath}"],
                           capture_output=True, text=True)
        return r.stdout if r.returncode == 0 else None
    return read


def run(root, baseline, only=None):
    failures = {}
    for name, fn, sees, blind in SENSES:
        if only and name != only:
            continue
        failures[name] = fn(root, baseline)
    return failures


def main():
    root = Path(__file__).resolve().parent.parent
    if "--counts" in sys.argv:
        print(headline(root))
        return 0
    if "--write-counts" in sys.argv:
        out = write_headline(root)
        print(out or "already current: " + headline(root))
        return 1 if out and out.startswith("the headline is no longer") else 0
    if "--prove" not in sys.argv:
        res = run(root, git_baseline(root))
        bad = 0
        for name, fn, sees, blind in SENSES:
            hits = res[name]
            bad += len(hits)
            print(f"{'FAIL' if hits else 'pass'}  {name}: sees {sees}")
            print(f"      blind to {blind}")
            for h in hits[:10]:
                print(f"      {h}")
        print("\n-- gates over the code, same contract, run from here so there is one harness --")
        for name, findings, blind, _ in code_gates(root):
            hits = findings if isinstance(findings, list) else [findings]
            bad += len(hits)
            print(f"{'FAIL' if hits else 'pass'}  {name}")
            if blind:
                print(f"      blind to {blind}")
            for h in hits[:6]:
                print(f"      {h}")
        print(f"\n{bad} finding(s). A clean run means nothing on its own: prove it with --prove.")
        return 1 if bad else 0

    # every sense must fire on a case built to make it fire
    mutations = {
        # Built from escapes: written literally, the planted dash and the planted entity would
        # be the very things this sense looks for, in the file that defines it.
        "dashes": ("src/ui/app.html",
                   lambda t: t + "\n<p>a literal " + chr(0x2014) + " and an entity &"
                   + "mdash; here</p>\n"),
        "tables": ("README.md", lambda t: t + "\n| a | b |\n|---|---|\n| one |\n"),
        "links": ("README.md", lambda t: t + "\n[gone](docs/not-a-file.md)\n"),
        # Two plants, because this sense has two halves and one of them was added after a document
        # audit found every stale number in the repository sitting outside the half that existed.
        # A sense proven on one branch says nothing about the other, so both are planted and both
        # must be reported.
        "derived counts": [
            ("docs/STATUS.md", lambda t: re.sub(r"\d+ tests", "3 tests", t, count=1)),
            ("README.md", lambda t: re.sub(r"\w+ invariants", "nine invariants", t, count=1)),
        ],
        "no packets": (None, None),
        "documented": (None, None),
        # Two halves, two plants: a link out of the tree, and an absolute path written in prose. The
        # second half had no plant until 2026-09-29, when narrowing it to skip web addresses made it
        # worth proving it still fires on a real path.
        "closed": [
            ("README.md", lambda t: t + "\nSee [elsewhere](../elsewhere/README.md).\n"),
            ("docs/STATUS.md", lambda t: t + "\nThe record was at " + "/Users" + "/someone/record for this.\n"),
        ],
        "code paths": ("docs/STATUS.md", lambda t: t + "\nSee `src/screen/gone.ts` for this.\n"),
    }
    ok = True
    for name, fn, sees, blind in SENSES:
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "repo"
            shutil.copytree(root, copy, ignore=shutil.ignore_patterns(*IGNORED_DIRS))
            pristine = {rel(copy, p): p.read_text() for p in md_files(copy)}
            base = lambda rp: pristine.get(rp)
            if name == "documented":
                (copy / "CLAUDE.md").write_text(
                    (copy / "CLAUDE.md").read_text().replace("| dashes | ", "| dashez | ")
                )
            elif name == "no packets":
                (copy / "fixtures").mkdir(exist_ok=True)
                (copy / "fixtures/board-packet-2026-09.pdf").write_bytes(b"%PDF-1.4 planted")
            else:
                plants = mutations[name]
                for relpath, mutate in (plants if isinstance(plants, list) else [plants]):
                    f = copy / relpath
                    f.write_text(mutate(f.read_text()))
            hits = fn(copy, base)
            if name == "documented":
                # A copied tree has no dist/ and no node_modules, so this sense's code half can never
                # run there and always reports itself. Dropping that line is what keeps this proof
                # about the PLANTED case: without it the sense fired on the copy's missing build and
                # would have passed with the plant doing nothing.
                hits = [h for h in hits if not h.startswith("the code half")]
            want = len(mutations[name]) if isinstance(mutations.get(name), list) else 1
            enough = len(hits) >= want
            print(f"{'fires' if enough else 'SILENT'}  {name}: "
                  + (f"{hits[0]}" + (f" (+{len(hits) - 1} more, {want} planted)" if want > 1 else "")
                     if enough else f"{len(hits)} of {want} planted cases fired"))
            ok = ok and enough
    # The senses read what git tracks AND what it does not yet track. The copies above have no .git,
    # so they cannot show the second half; this plants in the real tree, in a file git has never
    # seen, and removes it whatever happens.
    planted = root / "docs" / ".prove-untracked.md"
    try:
        planted.write_text("See `src/screen/untracked-plant.ts` for this.\n")
        hits = [h for h in sense_code_paths(root, git_baseline(root)) if ".prove-untracked.md" in h]
    finally:
        planted.unlink(missing_ok=True)
    print(f"{'fires' if hits else 'SILENT'}  untracked files are read: "
          + (hits[0] if hits else "a planted path in an untracked file was not seen"))
    ok = ok and bool(hits)
    # The stale-build guard, planted in the real tree because its subject is a file TIME rather than
    # a file's contents, which is the one thing the copied-tree plants above cannot express. The
    # clock is moved forward on a source file and put back whatever happens.
    probe = root / "src" / "gates" / "gates.ts"
    was = probe.stat().st_mtime if probe.exists() else None
    stale = []
    if was is not None:
        dist_at, _ = newest_mtime([root / "dist"], {".js"})
        try:
            os.utime(probe, (was, dist_at + 10))
            stale = [f for n, f, _b, _fired in code_gates(root) if n == "build"]
        finally:
            os.utime(probe, (was, was))
    print(f"{'fires' if stale else 'SILENT'}  a stale build is a finding: "
          + (stale[0] if stale else "a source file newer than dist/ was not seen"))
    ok = ok and bool(stale)
    for name, findings, _blind, fired in code_gates(root, prove=True):
        hits = findings if isinstance(findings, list) else [findings]
        if not fired:
            ok = False
        print(f"{'fires' if fired else 'SILENT'}  {name}: {hits[0] if hits else 'the planted case did not fire'}")
    print("\nevery sense and gate fired" if ok else "\nsomething stayed silent on its own failing case")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
