import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "../src/outbox";

// The cheapest version of the crash matrix, so `bun run check` proves recovery on every run:
// SIGKILL the reviewer process right after the outbox write, recover in a new process, count.
// The lease TTL is shortened so the test does not wait the default 15 s.
const Q = "Muss ein Chatbot den Nutzern sagen, dass sie mit einer KI sprechen?";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function crashThenRecover(mode: "idempotent" | "naive") {
  const dir = mkdtempSync(join(tmpdir(), "drw-crash-"));
  dirs.push(dir);
  const env = { ...process.env, PUBLISH_MODE: mode, DRAFTER: "fixture", MASTRA_AGENT_THREAD_LEASE_TTL_MS: "1500" };
  const args = ["bun", "scripts/driver.ts", dir, "c1", "approve", Q];
  const first = Bun.spawn(args, { env: { ...env, KILL_AT: "publish:after-write" }, stdout: "pipe" });
  const reader = first.stdout.getReader();
  let out = "";
  while (!out.includes("KILLPOINT")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`driver ended before the kill point: ${out}`);
    out += new TextDecoder().decode(value);
  }
  process.kill(first.pid, "SIGKILL");
  await first.exited;
  const second = Bun.spawn(args, { env, stdout: "pipe" });
  const text = await new Response(second.stdout).text();
  expect(await second.exited).toBe(0);
  return { final: JSON.parse(text.split("\n").find((l) => l.startsWith("FINAL "))?.slice(6) ?? "null"), count: new Outbox(join(dir, "outbox")).count("c1") };
}

test("killed after the outbox write: recovery succeeds and the message exists once", async () => {
  const { final, count } = await crashThenRecover("idempotent");
  expect(final.status).toBe("success");
  expect(final.result.firstWrite).toBe(false);
  expect(count).toBe(1);
}, 30_000);

test("control: the same crash with a naive append publishes twice", async () => {
  const { final, count } = await crashThenRecover("naive");
  expect(final.status).toBe("success");
  expect(count).toBe(2);
}, 30_000);
