// One reviewer process. Run it again after a crash with the same arguments and it picks the run up
// from storage: a run caught mid-step is restarted, a suspended run gets the scripted decision.
// The crash harness (scripts/crash-matrix.ts) starts this, kills it, and starts it again.
import { createApp } from "../src/app";
import { killpoint } from "../src/killpoint";
import type { Decision } from "../src/workflow";

const [dataDir, runId, scenario, ...rest] = process.argv.slice(2);
const question = rest.join(" ");
if (!dataDir || !runId || !scenario || !question) throw new Error("usage: driver.ts <dataDir> <runId> <scenario> <question>");

/** The scripted human. attempt is the draft number in the review request. */
function decide(attempt: number): Decision {
  if (scenario === "approve") return { decision: "approve" };
  if (scenario === "reject-then-approve") {
    return attempt === 1 ? { decision: "reject", comment: "Bitte die Ausnahme ausdrücklich nennen." } : { decision: "approve" };
  }
  if (scenario === "always-reject") return { decision: "reject", comment: "Noch nicht belastbar." };
  throw new Error(`unknown scenario ${scenario}`);
}

const { workflow } = await createApp(dataDir);
for (let turn = 0; turn < 20; turn++) {
  const stored = await workflow.getWorkflowRunById(runId);
  const run = await workflow.createRun({ runId });
  if (stored === null) {
    const r = await run.start({ inputData: { question } });
    if (r.status === "suspended") await killpoint("waiting#1");
    continue;
  }
  if (stored.status === "running") {
    try {
      await run.restart();
    } catch (error) {
      // A killed driver still holds the run-ownership lease until it expires. Wait it out.
      const e = error as { id?: string; details?: { leaseExpiresAt?: string } };
      if (e.id !== "WORKFLOW_RESTART_RUN_OWNED" || !e.details?.leaseExpiresAt) throw error;
      const waitMs = Math.max(0, Date.parse(e.details.leaseExpiresAt) - Date.now()) + 200;
      process.stdout.write(`LEASE_WAIT ${waitMs}\n`);
      await Bun.sleep(waitMs);
    }
    continue;
  }
  if (stored.status === "suspended") {
    const steps = Object.values(stored.steps ?? {}) as { status: string; suspendPayload?: { attempt: number } }[];
    const request = steps.find((s) => s.status !== "success" && s.suspendPayload)?.suspendPayload;
    if (request === undefined) throw new Error(`run ${runId} is suspended but no step holds a review request`);
    const r = await run.resume({ resumeData: decide(request.attempt) });
    if (r.status === "suspended") await killpoint(`waiting#${request.attempt + 1}`);
    continue;
  }
  process.stdout.write(`FINAL ${JSON.stringify({ status: stored.status, result: (stored as any).result ?? null })}\n`);
  process.exit(0);
}
throw new Error(`run ${runId} did not finish in 20 turns`);
