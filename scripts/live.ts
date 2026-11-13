// End-to-end with the real model: qwen3:8b drafts, a scripted reviewer approves or rejects once
// with a comment, the run publishes. Needs Ollama with qwen3:8b and bge-m3; hold the Ollama lock.
//
//   DRAFTER=ollama bun run live
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { loadGolden } from "../src/corpus";
import { citationValidity, isRefusal, refusalCorrectness } from "../src/grading";
import { CHAT_MODEL } from "../src/ollama-drafter";

if (process.env.DRAFTER !== "ollama") throw new Error("set DRAFTER=ollama");

const COMMENT = "Bitte nenne ausdrücklich, unter welcher Bedingung die Pflicht entfällt.";
// Picked before the run: three answerable and one refusal case per set, plus one reject loop.
const picks: { set: "v1" | "heldout"; id: string; reject?: boolean }[] = [
  { set: "v1", id: "a50-chatbot-disclosure" },
  { set: "v1", id: "a50-chatbot-exception", reject: true },
];
const v1 = loadGolden("v1");
const heldout = loadGolden("heldout");
for (const [set, cases] of [["v1", v1], ["heldout", heldout]] as const) {
  for (const outcome of ["answered", "refused"] as const) {
    const want = outcome === "answered" ? 3 : 1;
    for (const c of cases.filter((x) => x.expected_outcome === outcome && !picks.some((p) => p.id === x.id)).slice(0, want)) {
      picks.push({ set, id: c.id });
    }
  }
}

type Review = { attempt: number; draft: string; retrieved: string[]; guardBlocked: boolean };
const rows = [];
for (const pick of picks) {
  const golden = (pick.set === "v1" ? v1 : heldout).find((c) => c.id === pick.id);
  if (golden === undefined) throw new Error(`no case ${pick.id}`);
  const dir = join("data", "live", pick.id);
  rmSync(dir, { recursive: true, force: true });
  const { workflow, outbox } = await createApp(dir);
  const run = await workflow.createRun({ runId: pick.id });
  const t0 = Date.now();
  let result = await run.start({ inputData: { question: golden.question } });
  const drafts: (Review & { ms: number; citationValid: number })[] = [];
  for (let turn = 0; result.status === "suspended" && turn < 3; turn++) {
    const review = (result.steps["draft-and-review"] as { suspendPayload: Review }).suspendPayload;
    drafts.push({ ...review, ms: Date.now() - t0, citationValid: citationValidity(review.draft, new Set(review.retrieved)) });
    const decision = pick.reject && review.attempt === 1 ? { decision: "reject" as const, comment: COMMENT } : { decision: "approve" as const };
    result = await run.resume({ resumeData: decision });
  }
  const published = outbox.all().filter((m) => m.key === pick.id);
  const final = published[0]?.text ?? "";
  rows.push({
    set: pick.set,
    id: pick.id,
    expected: golden.expected_outcome,
    rejectedOnce: pick.reject ?? false,
    status: result.status,
    drafts,
    published: published.length,
    refused: isRefusal(final),
    refusalCorrect: refusalCorrectness(golden.expected_outcome, final),
    guardBlockedAny: drafts.some((d) => d.guardBlocked),
    totalMs: Date.now() - t0,
  });
  console.log(`${pick.set}/${pick.id}: ${result.status} drafts=${drafts.length} guard=${drafts.map((d) => d.guardBlocked).join(",")} published=${published.length}`);
}

const summary = {
  cases: rows.length,
  finishedSuccess: rows.filter((r) => r.status === "success").length,
  publishedExactlyOnce: rows.filter((r) => r.published === 1).length,
  refusalCorrect: rows.filter((r) => r.refusalCorrect === 1).length,
  guardBlockedDrafts: rows.flatMap((r) => r.drafts).filter((d) => d.guardBlocked).length,
  drafts: rows.flatMap((r) => r.drafts).length,
};
mkdirSync("results", { recursive: true });
const file = join("results", "live-ollama.json");
writeFileSync(file, `${JSON.stringify({ date: new Date().toISOString(), model: CHAT_MODEL, prompt: "v2 (source repo)", comment: COMMENT, summary, rows }, null, 2)}\n`);
console.log(JSON.stringify(summary));
console.log(`wrote ${file}`);
