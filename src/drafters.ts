import { REFUSAL_MARKER } from "./grading";
import { chunks, loadGolden } from "./corpus";

export type DraftRequest = { question: string; attempt: number; comment?: string; previous?: string };
export type Draft = { text: string; retrieved: string[] };
export type Drafter = (req: DraftRequest) => Promise<Draft>;

const golden = [...loadGolden("v1"), ...loadGolden("heldout")];
const byId = new Map(chunks.map((c) => [c.id, c]));

/** What the fixture drafter was asked, so tests can see the reviewer comment arrive. */
export const fixtureCalls: DraftRequest[] = [];

/**
 * Deterministic stand-in for the model: retrieves the golden case's expected chunks and cites them.
 * A question ending in "#bad-citation" cites a chunk it did not retrieve, so the guard has
 * something to catch without a model.
 */
export const fixtureDrafter: Drafter = async (req) => {
  fixtureCalls.push(req);
  const prefix = req.comment ? `Überarbeitet nach Kommentar „${req.comment}“: ` : "";
  if (req.question.endsWith("#bad-citation")) {
    return { text: `${prefix}Laut Verordnung gilt das ab sofort [chunk:art5-p1].`, retrieved: ["art50-p1"] };
  }
  const known = golden.find((c) => c.question === req.question);
  if (known === undefined || known.expected_outcome === "refused") {
    return { text: `${REFUSAL_MARKER} Die abgerufenen Auszüge enthalten dazu keine Grundlage.`, retrieved: [] };
  }
  const sentences = known.expected_chunks.map((id) => {
    const text = byId.get(id)?.text ?? "";
    return `${text.slice(0, 140).trim()} … [chunk:${id}]`;
  });
  return { text: prefix + sentences.join(" "), retrieved: known.expected_chunks };
};

export function parseDrafter(value: string | undefined): "fixture" | "ollama" {
  if (value === undefined || value === "" || value === "fixture") return "fixture";
  if (value === "ollama") return "ollama";
  throw new Error(`DRAFTER must be "fixture" or "ollama", got "${value}"`);
}
