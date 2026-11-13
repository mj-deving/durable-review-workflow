import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";
import { chunks } from "./corpus";
import type { Drafter } from "./drafters";
import { INSTRUCTIONS } from "./instructions";

// The model path: qwen3:8b drafts with the source repo's v2 prompt and one search tool over the
// same 66 chunks. Retrieval is an in-memory cosine search over bge-m3 vectors, cached on disk,
// because 66 vectors do not need a vector database.

const ollama = createOllama({ baseURL: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/api" });
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "qwen3:8b";
const model = ollama(CHAT_MODEL) as unknown as MastraModelConfig;
const embedder = ollama.textEmbeddingModel("bge-m3");
const TOP_K = 5;

async function embed(values: string[]): Promise<number[][]> {
  const { embeddings } = await embedder.doEmbed({ values });
  if (embeddings.length !== values.length) throw new Error(`embedding count mismatch: ${embeddings.length} for ${values.length}`);
  return embeddings;
}

const cachePath = join(import.meta.dir, "..", "data", "embeddings.json");
const corpusHash = createHash("sha256").update(JSON.stringify(chunks)).digest("hex");
let index: { id: string; article: number; text: string; vector: number[] }[] | undefined;

async function loadIndex() {
  if (index) return index;
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { corpusHash: string; vectors: number[][] };
    if (cached.corpusHash === corpusHash) index = chunks.map((c, i) => ({ ...c, vector: cached.vectors[i] as number[] }));
  }
  if (!index) {
    const vectors = await embed(chunks.map((c) => c.text));
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ corpusHash, vectors }));
    index = chunks.map((c, i) => ({ ...c, vector: vectors[i] as number[] }));
  }
  return index;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / Math.sqrt(na * nb);
};

export const ollamaDrafter: Drafter = async (req) => {
  const retrieved = new Set<string>();
  const searchRegulation = createTool({
    id: "search-regulation",
    description:
      "Durchsucht wörtliche Auszüge der KI-Verordnung (EU) 2024/1689 (Artikel 4, 5, 6, 26, 50, 99, 113). " +
      "Liefert Textstellen mit chunkId. Für Fragen mit mehreren Teilen einmal pro Teilfrage aufrufen.",
    inputSchema: z.object({ query: z.string().min(3) }),
    execute: async ({ query }) => {
      const [vector] = await embed([query]);
      const ranked = (await loadIndex())
        .map((c) => ({ chunkId: c.id, article: c.article, score: cosine(vector as number[], c.vector), text: c.text }))
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K);
      for (const c of ranked) retrieved.add(c.chunkId);
      return { chunks: ranked.map((c) => ({ ...c, score: Number(c.score.toFixed(4)) })) };
    },
  });
  const agent = new Agent({
    id: "drafter",
    name: "Drafter",
    instructions: INSTRUCTIONS.v2,
    model,
    tools: { searchRegulation },
  });
  const prompt =
    req.comment === undefined
      ? req.question
      : `${req.question}\n\nEin Prüfer hat deinen vorherigen Entwurf abgelehnt.\nVorheriger Entwurf:\n${req.previous ?? ""}\n\nKommentar des Prüfers:\n${req.comment}\n\nSchreibe einen neuen Entwurf, der den Kommentar berücksichtigt. Es gelten dieselben Regeln: suche erneut, zitiere nur abgerufene chunkIds.`;
  const result = await agent.generate(prompt, {
    providerOptions: { ollama: { think: false } },
    modelSettings: { temperature: 0 },
    maxSteps: 6,
  });
  return { text: result.text.trim(), retrieved: [...retrieved] };
};
