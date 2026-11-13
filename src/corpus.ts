import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const root = join(import.meta.dir, "..");

export type Chunk = { id: string; article: number; text: string };
export const chunks: Chunk[] = JSON.parse(readFileSync(join(root, "corpus", "chunks.json"), "utf8"));

const GoldenCase = z.object({
  id: z.string(),
  question: z.string(),
  expected_outcome: z.enum(["answered", "refused"]),
  expected_chunks: z.array(z.string()),
});
export type GoldenCase = z.infer<typeof GoldenCase>;

export function loadGolden(name: "v1" | "heldout"): GoldenCase[] {
  return readFileSync(join(root, "golden", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => GoldenCase.parse(JSON.parse(l)));
}
