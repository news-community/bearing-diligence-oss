/**
 * The models a folder can answer with on this computer, and which one is the default.
 *
 * Only pinned models are offered (src/download/manifest.json, by digest), because the runtime's
 * model store is shared with other applications on the machine and a name alone could run weights
 * nobody pinned. The embedding model reads nothing and answers nothing, so it is not offered.
 *
 * One function picks the default, so the first run, Settings and the command line agree: the largest
 * pinned model that is installed, matches its digest and fits this computer's memory.
 */
import { totalmem } from "node:os";
import { modelStates } from "../download/pull.js";
import { EMBED_MODEL } from "../answer/embed.js";
import { GENERAL_MODEL } from "../harness/model.js";

export type LocalModel = {
  name: string;
  size: number;
  needs: number;
  held: boolean;
  matches: boolean;
  fits: boolean;
  why?: string;
  /** What was measured on the research questions, when it was. */
  research_recall?: number;
  median_seconds?: number;
  ranked?: boolean;
};

/**
 * Whether a model fits this machine. Measured memory where there is one: estimating from the file
 * size said 24 GB for qwen3:30b, and the runtime reported 44.8 GB while it answered with sixteen
 * passages (2026-09-30). CALIBRATE: up to three quarters of the machine's memory, leaving the rest for
 * the system and the app; the file-size estimate remains for a model never measured.
 */
const OVERHEAD = 1.3;
const SHARE = 0.75;

export function needsOf(size: number, measuredGb?: number): number {
  // The larger of the two, because the runtime's own report can be wrong: it said 2.4 GB for
  // gemma4:31b, a 20 GB model (2026-09-30). An under-report must never put a model on a machine too
  // small for it.
  return Math.max(measuredGb ? measuredGb * 1e9 : 0, size * OVERHEAD);
}

export function fitsMemory(needs: number, memory = totalmem()): boolean {
  return needs <= memory * SHARE;
}

export async function localModels(memory = totalmem()): Promise<LocalModel[]> {
  const states = await modelStates();
  return states
    .filter((m) => m.name !== EMBED_MODEL)
    .map((m) => {
      const needs = needsOf(m.size, m.memory_gb);
      const fits = fitsMemory(needs, memory);
      const why = !m.held ? "not installed on this computer"
        : !m.matches ? "installed, but not the pinned version"
          : !fits ? `too large for this computer's ${Math.round(memory / 1e9)} GB`
            : undefined;
      return { name: m.name, size: m.size, needs, held: m.held, matches: m.matches, fits, why,
        research_recall: m.research_recall, median_seconds: m.median_seconds, ranked: m.ranked };
    })
    .sort((a, b) => (b.research_recall ?? -1) - (a.research_recall ?? -1) || b.size - a.size);
}

/**
 * The default local model: the best MEASURED one that is ranked, installed, pinned, fits, and answers
 * within DEFAULT_MAX_SECONDS, by the share of key facts it found on research questions. Not the
 * largest: the largest pinned model until 2026-09-30, gemma3:27b, found 38% where qwen3:30b found
 * 68%. Not the most thorough either, when that is too slow to be the first thing a person meets:
 * gemma4:31b found 75% at a median of three minutes and twenty seconds, so it is offered rather than
 * chosen. With nothing fast enough, the best that fits; with nothing at all, the reading model.
 */
/** CALIBRATE: how long a default answer may take, as a median, in seconds. */
export const DEFAULT_MAX_SECONDS = 90;

export function bestLocal(models: LocalModel[]): string {
  const usable = models.filter((m) => m.held && m.matches && m.fits && m.ranked !== false);
  const byRecall = (a: LocalModel, b: LocalModel) =>
    (b.research_recall ?? -1) - (a.research_recall ?? -1) || (a.median_seconds ?? 1e9) - (b.median_seconds ?? 1e9);
  const fast = usable.filter((m) => (m.median_seconds ?? 0) <= DEFAULT_MAX_SECONDS).sort(byRecall);
  return fast[0]?.name ?? usable.sort(byRecall)[0]?.name ?? GENERAL_MODEL;
}
