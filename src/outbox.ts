import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The side effect this whole repo is about. Mastra persists step results, but a process can die
// after the write and before Mastra records the step as done; the restarted step then runs again.
// Exactly-once is therefore the outbox's job, not the workflow engine's.
//
// Idempotent mode: one file per idempotency key, created with link(2), which is atomic and fails
// with EEXIST if the key was already published. A rerun finds the file and returns it unchanged.
// Naive mode: append a line per call. It exists to show what the rerun does without a key.

export type Message = { key: string; question: string; text: string; citations: string[]; decision: string };
export type PublishMode = "idempotent" | "naive";

export function parsePublishMode(value: string | undefined): PublishMode {
  if (value === undefined || value === "" || value === "idempotent") return "idempotent";
  if (value === "naive") return "naive";
  throw new Error(`PUBLISH_MODE must be "idempotent" or "naive", got "${value}"`);
}

export class Outbox {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, "messages"), { recursive: true });
  }

  publish(message: Message, mode: PublishMode): { published: boolean } {
    const body = `${JSON.stringify(message)}\n`;
    if (mode === "naive") {
      appendFileSync(join(this.dir, "naive.jsonl"), body);
      return { published: true };
    }
    const final = join(this.dir, "messages", `${encodeURIComponent(message.key)}.json`);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, body);
    try {
      linkSync(tmp, final);
      return { published: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readFileSync(final, "utf8") !== body) throw new Error(`outbox key ${message.key} already holds a different message`);
      return { published: false };
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Every published message, both modes, in no particular order. */
  all(): Message[] {
    const naivePath = join(this.dir, "naive.jsonl");
    const naive = existsSync(naivePath)
      ? readFileSync(naivePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Message)
      : [];
    const keyed = readdirSync(join(this.dir, "messages"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, "messages", f), "utf8")) as Message);
    return [...naive, ...keyed];
  }

  count(key: string): number {
    return this.all().filter((m) => m.key === key).length;
  }
}
