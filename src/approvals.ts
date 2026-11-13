import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mastra's suspend only stops the normal path. run.timeTravel executes any step, nested ones
// included, with caller-supplied input. So once a gate depends on it, no step takes content from
// its input; content travels through records instead, each written by exactly one step:
//   question   pinned once per run by the first draft (write-once).
//   draft      what the draft step produced per attempt (write-once). A rerun returns it instead of
//              drafting again, so a draft a reviewer has seen can never change under them.
//   rejection  the reviewer's comment per attempt (write-once). The next draft reads it from here.
//   approval   the approved question and text. publish writes only this.
// Caller input can still trigger a step, but its content cannot reach the outbox.

export type DraftContent = { question: string; attempt: number; draft: string; retrieved: string[]; guardBlocked: boolean };
export type Approval = { runId: string; attempt: number; decision: "approve" | "edit"; question: string; text: string };

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Kind = "question" | "draft" | "rejection" | "approval";
type Rec<T> = T & { kind: Kind; runId: string };

export class Approvals {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  // One file per (kind, run, attempt), named by a hash, so no run id can collide with another
  // run's record or one of another kind, or escape the directory.
  private path(kind: Kind, runId: string, attempt = 0) {
    return join(this.dir, `${sha256(JSON.stringify([kind, runId, attempt])).slice(0, 32)}.json`);
  }

  private tmp(path: string) {
    return `${path}.${process.pid}.${Date.now()}.tmp`;
  }

  /** Overwrites. Same input, same bytes, so a step rerun after a crash is harmless. */
  private write<T>(kind: Kind, runId: string, attempt: number, value: T): void {
    const path = this.path(kind, runId, attempt);
    const tmp = this.tmp(path);
    writeFileSync(tmp, `${JSON.stringify({ kind, runId, ...value })}\n`);
    renameSync(tmp, path);
  }

  /** First writer wins (link(2) fails if the file exists); everyone gets the winning record. */
  private writeOnce<T extends object>(kind: Kind, runId: string, attempt: number, value: T): T {
    const path = this.path(kind, runId, attempt);
    const tmp = this.tmp(path);
    writeFileSync(tmp, `${JSON.stringify({ kind, runId, ...value })}\n`);
    try {
      linkSync(tmp, path);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.read<T>(kind, runId, attempt) as T;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Reads a record and checks it is the kind and run it is filed under. */
  private read<T>(kind: Kind, runId: string, attempt = 0): T | undefined {
    const path = this.path(kind, runId, attempt);
    if (!existsSync(path)) return undefined;
    const { kind: k, runId: r, ...value } = JSON.parse(readFileSync(path, "utf8")) as Rec<T>;
    if (k !== kind || r !== runId) throw new Error(`record for run ${runId} holds ${k} of run ${r}`);
    return value as T;
  }

  private need<T>(kind: Kind, runId: string, attempt = 0): T {
    const value = this.read<T>(kind, runId, attempt);
    if (value === undefined) throw new Error(`run ${runId}: no ${kind} record${attempt ? ` for attempt ${attempt}` : ""}`);
    return value;
  }

  /** The run's question: the first one offered wins, later offers are ignored. */
  pinQuestion(runId: string, question: string): string {
    return this.writeOnce("question", runId, 0, { question }).question;
  }

  findDraft(runId: string, attempt: number): DraftContent | undefined {
    return this.read<DraftContent>("draft", runId, attempt);
  }

  /** Records the draft unless one exists for this attempt; returns whichever was recorded. */
  recordDraft(runId: string, content: DraftContent): DraftContent {
    return this.writeOnce("draft", runId, content.attempt, content);
  }

  loadDraft(runId: string, attempt: number): DraftContent {
    return this.need<DraftContent>("draft", runId, attempt);
  }

  recordRejection(runId: string, attempt: number, comment: string): string {
    return this.writeOnce("rejection", runId, attempt, { comment }).comment;
  }

  loadRejection(runId: string, attempt: number): string {
    return this.need<{ comment: string }>("rejection", runId, attempt).comment;
  }

  record(approval: Approval): void {
    this.write("approval", approval.runId, 0, approval);
  }

  loadApproval(runId: string): Approval {
    return this.need<Approval>("approval", runId);
  }
}

export function parseApprovalCheck(value: string | undefined): "on" | "off" {
  if (value === undefined || value === "" || value === "on") return "on";
  if (value === "off") return "off";
  throw new Error(`APPROVAL_CHECK must be "on" or "off", got "${value}"`);
}
