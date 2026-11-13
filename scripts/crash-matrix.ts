// Kills the reviewer process at every step boundary, recovers it in a fresh process, and counts
// what reached the outbox. Runs both publish modes: "idempotent" is the design, "naive" is the
// control that shows what Mastra's recovery does to a side effect without an idempotency key.
//
//   bun run crash                 # fixture drafter, no model needed
//   DRAFTER=ollama bun run crash  # same matrix with qwen3:8b drafting (hold the Ollama lock)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { parseDrafter } from "../src/drafters";

const QUESTION = "Wann entfällt die Pflicht, Personen über die Interaktion mit einem KI-System zu informieren?";
const drafterName = parseDrafter(process.env.DRAFTER);
const root = join("data", "matrix", drafterName);

type Case = { point: string; scenario: "approve" | "reject-then-approve"; stall?: boolean };
const cases: Case[] = [
  { point: "draft:start#1", scenario: "approve" },
  { point: "draft:end#1", scenario: "approve" },
  { point: "waiting#1", scenario: "approve" },
  { point: "review:resumed#1", scenario: "approve" },
  { point: "publish:before-write", scenario: "approve" },
  { point: "publish:after-write", scenario: "approve" },
  { point: "review:resumed#1", scenario: "reject-then-approve" },
  { point: "draft:start#2", scenario: "reject-then-approve" },
  { point: "draft:end#2", scenario: "reject-then-approve" },
  { point: "waiting#2", scenario: "reject-then-approve" },
  { point: "publish:after-write", scenario: "reject-then-approve" },
  // Not a crash: the first process stalls past its lease, a second one recovers the run, then the
  // first wakes up and carries on. Mastra's lease does not fence writes, so both reach publish.
  { point: "publish:before-write", scenario: "approve", stall: true },
];

function driver(dir: string, runId: string, scenario: string, env: Record<string, string>) {
  return Bun.spawn(["bun", "scripts/driver.ts", dir, runId, scenario, QUESTION], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Starts the process and buffers its output; a stream can only be read once. */
function capture(proc: ReturnType<typeof driver>) {
  const decoder = new TextDecoder();
  const buf = { out: "", err: "" };
  const done = Promise.all([
    (async () => {
      for await (const c of proc.stdout) buf.out += decoder.decode(c);
    })(),
    (async () => {
      for await (const c of proc.stderr) buf.err += decoder.decode(c);
    })(),
  ]);
  return {
    proc,
    buf,
    /** First stdout line starting with `prefix`, or undefined if the process ends or time runs out. */
    async waitFor(prefix: string, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      let exited = false;
      void proc.exited.then(() => (exited = true));
      while (Date.now() < deadline) {
        const line = buf.out.split("\n").find((l) => l.startsWith(prefix));
        if (line !== undefined || exited) return line;
        await Bun.sleep(50);
      }
      return undefined;
    },
    async finish() {
      const code = await proc.exited;
      await done;
      return { out: buf.out, err: buf.err, code };
    },
  };
}

const results: { mode: string; pass: boolean; outboxEntries: number; [k: string]: unknown }[] = [];
for (const mode of ["idempotent", "naive"] as const) {
  for (const [i, c] of cases.entries()) {
    const runId = `run-${i}`;
    const dir = join(root, mode, `${i}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const env = { PUBLISH_MODE: mode, DRAFTER: drafterName };
    const started = Date.now();

    const firstRun = capture(driver(dir, runId, c.scenario, { ...env, KILL_AT: c.point }));
    const first = firstRun.proc;
    const hit = { line: await firstRun.waitFor("KILLPOINT", 300_000) };
    // process.kill, not first.kill: Bun's Subprocess.kill("SIGSTOP") left the child running (state S)
    // in Bun 1.4.2, which silently turned the stall case into a lease that never expired.
    if (c.stall) process.kill(first.pid, "SIGSTOP");
    else process.kill(first.pid, "SIGKILL");
    const stopped = c.stall ? Bun.spawnSync(["ps", "-o", "stat=", "-p", String(first.pid)]).stdout.toString().trim().startsWith("T") : null;

    let statusAtKill = "unknown";
    if (!c.stall) {
      await first.exited;
      const probe = await createApp(dir);
      statusAtKill = (await probe.workflow.getWorkflowRunById(runId))?.status ?? "none";
    }

    const recovered = await capture(driver(dir, runId, c.scenario, env)).finish();
    let stalled: { out: string; err: string; code: number } | undefined;
    if (c.stall) {
      process.kill(first.pid, "SIGCONT");
      process.kill(first.pid, "SIGUSR2");
      stalled = await firstRun.finish();
    }

    const final = recovered.out.split("\n").find((l) => l.startsWith("FINAL "));
    const parsed = final ? (JSON.parse(final.slice(6)) as { status: string; result: { status?: string; text?: string; attempts?: number } | null }) : null;
    const { outbox } = await createApp(dir);
    const published = outbox.all().filter((m) => m.key === runId);
    const leaseWaitMs = Number(recovered.out.match(/LEASE_WAIT (\d+)/)?.[1] ?? 0);
    const commentSeen = c.scenario === "reject-then-approve" ? (parsed?.result?.text ?? "").includes("Ausnahme ausdrücklich") : null;
    const row = {
      mode,
      point: c.point,
      scenario: c.scenario,
      stall: c.stall ?? false,
      stallVerified: stopped,
      killPointReached: hit.line !== undefined,
      statusAtKill,
      finalStatus: parsed?.status ?? `exit ${recovered.code}`,
      result: parsed?.result?.status ?? null,
      attempts: parsed?.result?.attempts ?? null,
      commentInRedraft: commentSeen,
      outboxEntries: published.length,
      leaseWaitMs,
      stalledProcessExit: stalled?.code ?? null,
      stalledProcessError: stalled && stalled.code !== 0 ? stalled.err.split("\n").find((l) => l.startsWith("error:")) ?? stalled.err.slice(-300) : null,
      recoveryError: recovered.code !== 0 ? recovered.err.slice(-400) : null,
      durationMs: Date.now() - started,
    };
    // The fixture drafter echoes the reviewer comment, so there the comment must reach the published
    // text. A model may ignore it; for the model the check is only that the redraft happened.
    const redraftOk = c.scenario !== "reject-then-approve" || (row.attempts === 2 && (drafterName !== "fixture" || commentSeen === true));
    const ok = row.killPointReached && stopped !== false && row.finalStatus === "success" && row.result === "published" && row.outboxEntries === 1 && redraftOk;
    results.push({ ...row, pass: ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${mode.padEnd(10)} ${c.point.padEnd(22)} ${c.scenario.padEnd(20)}${c.stall ? " stall" : ""} outbox=${published.length} lease=${leaseWaitMs}ms`);
  }
}

const summary = Object.fromEntries(
  (["idempotent", "naive"] as const).map((mode) => {
    const rows = results.filter((r) => r.mode === mode);
    return [mode, { tested: rows.length, passed: rows.filter((r) => r.pass).length, duplicates: rows.filter((r) => r.outboxEntries > 1).length, lost: rows.filter((r) => r.outboxEntries === 0).length }];
  }),
);
const file = join("results", `crash-matrix-${drafterName}.json`);
mkdirSync("results", { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify({ date: new Date().toISOString(), drafter: drafterName, question: QUESTION, leaseTtlMs: Number(process.env.MASTRA_AGENT_THREAD_LEASE_TTL_MS ?? 15000), summary, results }, null, 2)}\n`,
);
console.log(JSON.stringify(summary));
console.log(`wrote ${file}`);
