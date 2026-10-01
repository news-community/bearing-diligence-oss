/**
 * The record holds the truth. Everything else is derived and can be rebuilt from it.
 *
 * Two rules shape this schema. A page with no extractable text is stored as a page with no text and
 * a flag, never skipped, so coverage can be reported before any change (docs/design.md, "The change record"). And a claim
 * carries the verdict its quote earned, so an unlocated claim is visible rather than absent.
 */
export const SCHEMA_VERSION = 9;

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS documents (
     id INTEGER PRIMARY KEY,
     digest TEXT NOT NULL UNIQUE,
     filename TEXT NOT NULL,
     layer TEXT NOT NULL CHECK (layer IN ('public', 'private')),
     meeting TEXT,
     meeting_date TEXT,
     added_at TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     page_count INTEGER NOT NULL DEFAULT 0,
     extract_tool TEXT NOT NULL DEFAULT ''
   )`,

  `CREATE TABLE IF NOT EXISTS pages (
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     page_no INTEGER NOT NULL,
     text TEXT NOT NULL,
     chars INTEGER NOT NULL,
     has_text_layer INTEGER NOT NULL,
     /*
      * Where this page's text came from. 'extracted' is the PDF's own text layer. 'ocr' is a
      * machine's reading of pixels, which is a weaker kind of evidence and must stay visible as
      * one: a quote located in OCR text is located in a guess. 'none' is a page with neither.
      */
     text_source TEXT NOT NULL DEFAULT 'extracted'
       CHECK (text_source IN ('extracted','ocr','none')),
     ocr_engine TEXT NOT NULL DEFAULT '',
     UNIQUE (document_id, page_no)
   )`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
     text, content='pages', content_rowid='id', tokenize='porter unicode61'
   )`,

  `CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
     INSERT INTO pages_fts(rowid, text) VALUES (new.id, new.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
     INSERT INTO pages_fts(pages_fts, rowid, text) VALUES('delete', old.id, old.text);
   END`,

  /*
   * An external-content FTS5 index does not follow an UPDATE, and OCR is an UPDATE.
   *
   * Without this, a page OCR read was in `pages` and absent from `pages_fts`: the change record
   * could see it, and searching for a word on it returned nothing. The coverage line said that
   * anything resting on that page rests on a machine's reading of pixels, while the reader could not
   * reach the page at all. One column, `has_text_layer`, was standing for three different claims:
   * the PDF has a text layer, the model may read this, and this is searchable.
   */
  `CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
     INSERT INTO pages_fts(pages_fts, rowid, text) VALUES('delete', old.id, old.text);
     INSERT INTO pages_fts(rowid, text) VALUES (new.id, new.text);
   END`,

  `CREATE TABLE IF NOT EXISTS claims (
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     page_no INTEGER NOT NULL,
     text TEXT NOT NULL,
     quote TEXT NOT NULL,
     start_char INTEGER,
     end_char INTEGER,
     verdict TEXT NOT NULL CHECK (verdict IN ('located','absent','recombined','ambiguous','too_short')),
     window_no INTEGER NOT NULL,
     model TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS ledger (
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     window_no INTEGER NOT NULL,
     claim_text TEXT NOT NULL,
     quote TEXT NOT NULL DEFAULT '',
     verdict TEXT NOT NULL,
     reason TEXT NOT NULL,
     created_at TEXT NOT NULL,
     /*
      * A refusal is a claim about the model until somebody checks it, and then it is a claim about
      * one of the two. Gate rule 1: a gate ships with a case that makes it fire AND a count of what
      * it refused, read by a person before that rate is believed. These three columns are where the
      * reading goes, and without them the count is just a number pointing in an unknown direction.
      */
     reviewed_at TEXT,
     reviewed_verdict TEXT CHECK (reviewed_verdict IN ('right','wrong') OR reviewed_verdict IS NULL),
     reviewed_note TEXT NOT NULL DEFAULT '',
     /* Who read it. A machine's reading is a labeled draft and never the reading a person gives,
        the same rule that keeps an interpretive synthesis out of the record. */
     reviewed_by TEXT CHECK (reviewed_by IN ('person','machine') OR reviewed_by IS NULL)
   )`,

  `CREATE TABLE IF NOT EXISTS coverage (
     document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
     pages_total INTEGER NOT NULL,
     pages_with_text INTEGER NOT NULL,
     pages_read INTEGER NOT NULL,
     windows_total INTEGER NOT NULL,
     windows_completed INTEGER NOT NULL,
     windows_failed INTEGER NOT NULL,
     failure_kinds TEXT NOT NULL DEFAULT '',
     seconds REAL NOT NULL DEFAULT 0,
     /* Read, and yielded nothing. Without this, a window the model answered with an empty list is
        indistinguishable from one it never reached, which is the proxy defect again. */
     windows_empty INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS change_records (
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     compared_against INTEGER NOT NULL,
     coverage_json TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS changes (
     id INTEGER PRIMARY KEY,
     change_record_id INTEGER NOT NULL REFERENCES change_records(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('new_identifier','moved_figure','moved_date','recurrence')),
     subject TEXT NOT NULL,
     now_value TEXT NOT NULL DEFAULT '',
     then_value TEXT NOT NULL DEFAULT '',
     now_document_id INTEGER,
     now_page INTEGER,
     now_passage TEXT NOT NULL DEFAULT '',
     then_document_id INTEGER,
     then_page INTEGER,
     then_passage TEXT NOT NULL DEFAULT '',
     count INTEGER NOT NULL DEFAULT 0,
     meetings TEXT NOT NULL DEFAULT ''
   )`,

  `CREATE TABLE IF NOT EXISTS votes (
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     page_no INTEGER NOT NULL,
     subject TEXT NOT NULL,
     shape TEXT NOT NULL,
     yes INTEGER, no INTEGER, abstain INTEGER, absent INTEGER,
     unanimous INTEGER NOT NULL DEFAULT 0,
     body TEXT NOT NULL DEFAULT '',
     passage TEXT NOT NULL,
     start_char INTEGER NOT NULL,
     end_char INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS commitments (
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     page_no INTEGER NOT NULL,
     text TEXT NOT NULL,
     passage TEXT NOT NULL,
     due TEXT,
     outcome_claim_id INTEGER,
     pairing_state TEXT NOT NULL DEFAULT 'draft'
       CHECK (pairing_state IN ('draft','accepted','rejected')),
     accepted_at TEXT
   )`,

  /*
   * Invariant 9's marks, in a table of their own and DELIBERATELY not joined to anything.
   *
   * The invariant is not "instruction-shaped text is removed" and not "it is down-ranked". It is
   * that the text is MARKED and the mark changes nothing about retrieval or ranking. The separation
   * is the mechanism: `pages` is what retrieval reads and `marks` is what the person reads, and a gate
   * fails the build if the retrieval or ranking path so much as names this table.
   *
   * Storing it any other way would have been easier and wrong. A `suspicious` column on `pages`
   * invites exactly one future commit that reads it while ranking, and then the record quietly
   * shows the person less of their own packet because a pattern fired.
   */
  `CREATE TABLE IF NOT EXISTS marks (
     id INTEGER PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     page_no INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('instruction', 'hidden')),
     reason TEXT NOT NULL,
     rule TEXT NOT NULL,
     text TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     start_char INTEGER,
     end_char INTEGER,
     /* Hidden text that never reached the page text cannot influence anything, and saying so is the
        difference between a warning to act on and one to note. */
     reached_the_record INTEGER NOT NULL DEFAULT 1
   )`,

  `CREATE INDEX IF NOT EXISTS marks_by_document ON marks (document_id, page_no)`,

  /*
   * Saved conversations (invariant 6). Nothing is written here unless the
   * person saves a conversation or has switched on saving for this folder; a turn keeps the question
   * and the answer object the page already held, so a reopened conversation shows its quotes. The
   * table that stood here, `questions`, held bare question text, was never written, and could not
   * hold a thread.
   */
  `DROP TABLE IF EXISTS questions`,
  `CREATE TABLE IF NOT EXISTS conversations (
     id INTEGER PRIMARY KEY,
     started_at TEXT NOT NULL,
     title TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS turns (
     id INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     asked_at TEXT NOT NULL,
     question TEXT NOT NULL,
     answer_json TEXT NOT NULL
   )`,

  /*
   * A run accounts for itself while it happens and after it stops.
   *
   * The reason it carries a heartbeat and a pid is that "running", "not moving" and "stopped
   * without finishing" are three different states, and a job that simply shows nothing collapses
   * all three into one. A person starts an overnight run and walks away; when they come back the
   * record has to be able to tell them which of the three they are looking at.
   */
  `CREATE TABLE IF NOT EXISTS runs (
     id INTEGER PRIMARY KEY,
     document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
     filename TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '',
     pid INTEGER NOT NULL,
     started_at TEXT NOT NULL,
     heartbeat_at TEXT NOT NULL,
     finished_at TEXT,
     outcome TEXT CHECK (outcome IN ('finished','failed') OR outcome IS NULL),
     windows_total INTEGER NOT NULL DEFAULT 0,
     windows_completed INTEGER NOT NULL DEFAULT 0,
     windows_failed INTEGER NOT NULL DEFAULT 0,
     current_window INTEGER NOT NULL DEFAULT 0,
     current_pages TEXT NOT NULL DEFAULT '',
     claims_kept INTEGER NOT NULL DEFAULT 0,
     claims_refused INTEGER NOT NULL DEFAULT 0,
     failure_kinds TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT ''
   )`,

  /*
   * Vectors as plain BLOBs, searched by walking them.
   *
   * `sqlite-vec` is a loadable extension, and a loadable
   * extension under a notarised hardened runtime must be signed with the same team identifier or it
   * will not load, a failure that lands on THEIR machine at first run. A record of a few thousand
   * passages is searched in milliseconds by reading the column, so version one takes the simpler
   * shape and removes that failure entirely. Revisit when a record is large enough to need an index.
   */
  `CREATE TABLE IF NOT EXISTS embeddings (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('passage','claim')),
     ref_id INTEGER NOT NULL,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     model TEXT NOT NULL,
     dims INTEGER NOT NULL,
     vector BLOB NOT NULL,
     UNIQUE (kind, ref_id, model)
   )`,

  /* A file the person left out: its digest, so the folder does not read it again, and nothing it said. */
  `CREATE TABLE IF NOT EXISTS left_out (
     digest TEXT PRIMARY KEY,
     left_out_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS embeddings_doc ON embeddings(document_id)`,
  `CREATE INDEX IF NOT EXISTS runs_doc ON runs(document_id)`,
  `CREATE INDEX IF NOT EXISTS claims_doc ON claims(document_id)`,
  `CREATE INDEX IF NOT EXISTS changes_record ON changes(change_record_id)`,
  `CREATE INDEX IF NOT EXISTS votes_doc ON votes(document_id)`,
];

/**
 * Bringing an EXISTING record up to date, WITHOUT trusting the version number.
 *
 * `CREATE TABLE IF NOT EXISTS` creates a missing table and never adds a column to a table that is
 * already there, so every schema change after the first one silently skipped every record that
 * existed. Found when a record written an hour earlier answered "no such column: reviewed_verdict".
 *
 * The person's record is the thing this product is FOR, and it accumulates for years. A record that cannot
 * survive an upgrade is a record that has to be rebuilt from the raw store every time the tool
 * changes, which is possible here by design and is not something to do by accident.
 *
 * **And the stored version cannot be the authority.** An earlier build stamped the new version onto
 * a record before the migration existed, which left that record permanently unmigratable: version 3
 * on the outside, version 2 columns on the inside, and every version check skipping it for ever.
 * Found on a record an hour old. So this asks the schema what is actually there, column by column,
 * and adds what is missing whatever the version says. The version is a hint; the table is the fact.
 */
export const REQUIRED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: "ledger", column: "reviewed_at", definition: "TEXT" },
  { table: "ledger", column: "reviewed_verdict", definition: "TEXT" },
  { table: "ledger", column: "reviewed_note", definition: "TEXT NOT NULL DEFAULT ''" },
  { table: "ledger", column: "reviewed_by", definition: "TEXT" },
  { table: "coverage", column: "windows_empty", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "pages", column: "text_source", definition: "TEXT NOT NULL DEFAULT 'extracted'" },
  { table: "pages", column: "ocr_engine", definition: "TEXT NOT NULL DEFAULT ''" },
];
