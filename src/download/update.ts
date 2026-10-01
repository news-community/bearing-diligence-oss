/**
 * Whether a newer release of the application exists. It runs only when asked, or at launch if
 * that has been switched on (src/ui/updates.ts), and it never downloads anything.
 *
 * One unauthenticated request to GitHub's public release list for this repository. It carries a
 * fixed user agent, the same for every copy, and nothing else about the person: no version, no identifier,
 * nothing from the record. GitHub sees what any web request shows, this computer's address and that
 * user agent, and the "This record" panel says so in those words.
 */
export const RELEASES_URL = "https://api.github.com/repos/news-community/bearing-diligence/releases/latest";
export const USER_AGENT = "Bearing-Diligence-update-check";

export type UpdateCheck = {
  state: "newer" | "current" | "none-published" | "unreachable" | "cannot-compare";
  running: string;
  latest?: string;
  published?: string;
  notes?: string;
  page?: string;
  says: string;
};

/** Semantic versions only ("1.2.3", optionally "v1.2.3"); anything else cannot be compared. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export async function checkForUpdate(running: string, fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  let res: Response;
  try {
    res = await fetchImpl(RELEASES_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
    });
  } catch (e) {
    return { state: "unreachable", running, says: `Could not reach GitHub: ${(e as Error).message}` };
  }
  // A private repository and one with no release answer the same way, and until the first public
  // release both are true: that is a state to say, not an error.
  if (res.status === 404) {
    return { state: "none-published", running, says: "No release has been published yet." };
  }
  if (!res.ok) return { state: "unreachable", running, says: `GitHub answered ${res.status}.` };

  let body: { tag_name?: unknown; published_at?: unknown; body?: unknown; html_url?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { state: "unreachable", running, says: "GitHub's answer was not readable." };
  }
  const latest = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
  const found = {
    running,
    latest,
    published: typeof body.published_at === "string" ? body.published_at.slice(0, 10) : undefined,
    notes: typeof body.body === "string" ? body.body : undefined,
    page: typeof body.html_url === "string" ? body.html_url : undefined,
  };
  const order = compareVersions(running, latest);
  if (order === null) {
    return { state: "cannot-compare", ...found, says: `The latest release is ${latest || "unnamed"}, and this build's version (${running}) cannot be compared with it.` };
  }
  return order < 0
    ? { state: "newer", ...found, says: `Version ${latest} is available. This is ${running}.` }
    : { state: "current", ...found, says: `This is the latest version, ${running}.` };
}
