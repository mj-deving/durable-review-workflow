import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { Approvals } from "./approvals";
import type { Drafter } from "./drafters";
import { REFUSAL_MARKER, citationValidity, parseCitations } from "./grading";
import { killpoint } from "./killpoint";
import type { Outbox, PublishMode } from "./outbox";

export const MAX_ATTEMPTS = 3;

// Same rule and fallback as the citation guard in the answer path of the source repo: an answer
// whose citations were not all retrieved in this run (or that cites nothing and is no refusal) is
// replaced, not repaired.
export const GUARD_FALLBACK = `${REFUSAL_MARKER} Die Antwort ließ sich nicht mit den abgerufenen Textstellen belegen und wurde zurückgehalten.`;

export function guard(text: string, retrieved: readonly string[]): { text: string; blocked: boolean } {
  return citationValidity(text, new Set(retrieved)) === 1 ? { text, blocked: false } : { text: GUARD_FALLBACK, blocked: true };
}

const Cycle = z.object({
  question: z.string().min(1),
  attempt: z.number().int().min(0),
  comment: z.string().optional(),
  previous: z.string().optional(),
  decision: z.enum(["approve", "edit", "reject"]).optional(),
  text: z.string().optional(),
  citations: z.array(z.string()).optional(),
});
type Cycle = z.infer<typeof Cycle>;

const Drafted = Cycle.extend({ draft: z.string(), retrieved: z.array(z.string()), guardBlocked: z.boolean() });

// The decisions a reviewer may send. reject needs a comment, edit needs the replacement text, and
// nothing else is accepted.
export const Decision = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }).strict(),
  z.object({ decision: z.literal("reject"), comment: z.string().trim().min(1) }).strict(),
  z.object({ decision: z.literal("edit"), text: z.string().trim().min(1) }).strict(),
]);
export type Decision = z.infer<typeof Decision>;

// Deliberately looser than Decision. A resume payload that fails Mastra's resumeSchema marks the
// whole run "failed" and it can never be resumed again, so one typo from a reviewer would throw the
// draft away. The step parses Decision itself and sends invalid input back to the reviewer.
const ResumePayload = z.object({ decision: z.string().optional(), comment: z.string().optional(), text: z.string().optional() }).passthrough().optional();

export const ReviewRequest = z.object({
  question: z.string(),
  attempt: z.number(),
  draft: z.string(),
  retrieved: z.array(z.string()),
  guardBlocked: z.boolean(),
  error: z.string().optional(),
});

export const Published = z.object({
  status: z.enum(["published", "rejected"]),
  attempts: z.number(),
  text: z.string().optional(),
  firstWrite: z.boolean().optional(),
});

// approvalCheck "off" exists only as the control for scripts/gate-bypass.ts.
export type Deps = { drafter: Drafter; outbox: Outbox; approvals: Approvals; publishMode: PublishMode; approvalCheck: "on" | "off" };

export function buildWorkflow(deps: Deps) {
  const draft = createStep({
    id: "draft",
    inputSchema: Cycle,
    outputSchema: Drafted,
    execute: async ({ inputData, runId }) => {
      const attempt = inputData.attempt + 1;
      await killpoint(`draft:start#${attempt}`);
      // A draft that exists may already have been shown to a reviewer: return it, never redraft.
      // Question, comment and previous draft come from records, not from this step's input.
      const recorded = deps.approvals.findDraft(runId, attempt);
      if (recorded !== undefined) return recorded;
      const question = deps.approvals.pinQuestion(runId, inputData.question);
      const comment = attempt > 1 ? deps.approvals.loadRejection(runId, attempt - 1) : undefined;
      const previous = attempt > 1 ? deps.approvals.loadDraft(runId, attempt - 1).draft : undefined;
      const raw = await deps.drafter({ question, attempt, comment, previous });
      const guarded = guard(raw.text, raw.retrieved);
      const content = deps.approvals.recordDraft(runId, { question, attempt, draft: guarded.text, retrieved: raw.retrieved, guardBlocked: guarded.blocked });
      await killpoint(`draft:end#${attempt}`);
      return content;
    },
  });

  const review = createStep({
    id: "review",
    inputSchema: Drafted,
    outputSchema: Cycle,
    suspendSchema: ReviewRequest,
    resumeSchema: ResumePayload,
    execute: async ({ inputData, resumeData, suspend, runId }) => {
      // Show and approve only what the draft step recorded. run.timeTravel can call this step
      // directly with any input, so the input names the attempt and nothing else.
      const request =
        deps.approvalCheck === "on"
          ? deps.approvals.loadDraft(runId, inputData.attempt)
          : { question: inputData.question, attempt: inputData.attempt, draft: inputData.draft, retrieved: inputData.retrieved, guardBlocked: inputData.guardBlocked };
      if (resumeData === undefined) return await suspend(request);
      const parsed = Decision.safeParse(resumeData);
      if (!parsed.success) return await suspend({ ...request, error: `Ungültige Entscheidung: ${parsed.error.issues[0]?.message ?? "unbekannt"}` });
      const d = parsed.data;
      const base = { question: request.question, attempt: request.attempt };
      if (d.decision === "reject") {
        deps.approvals.recordRejection(runId, request.attempt, d.comment);
        await killpoint(`review:resumed#${request.attempt}`);
        return { ...base, decision: "reject" as const, comment: d.comment, previous: request.draft };
      }
      // An edit is the reviewer's text, but it still has to pass the citation rule against what
      // was retrieved; otherwise the human could publish a citation nothing backs.
      const text = d.decision === "edit" ? d.text : request.draft;
      if (d.decision === "edit" && guard(text, request.retrieved).blocked) {
        return await suspend({ ...request, error: "Bearbeiteter Text zitiert nicht abgerufene Stellen oder gar nichts." });
      }
      deps.approvals.record({ runId, attempt: request.attempt, decision: d.decision, question: request.question, text });
      await killpoint(`review:resumed#${request.attempt}`);
      return { ...base, decision: d.decision, text, citations: parseCitations(text) };
    },
  });

  const cycle = createWorkflow({ id: "draft-and-review", inputSchema: Cycle, outputSchema: Cycle })
    .then(draft)
    .then(review)
    .commit();

  const publish = createStep({
    id: "publish",
    inputSchema: Cycle,
    outputSchema: Published,
    execute: async ({ inputData, runId }) => {
      if (inputData.decision !== "approve" && inputData.decision !== "edit") {
        return { status: "rejected" as const, attempts: inputData.attempt };
      }
      // Publish only what the reviewer approved, never this step's input (see src/approvals.ts).
      const { question, text, decision, attempt } =
        deps.approvalCheck === "on"
          ? deps.approvals.loadApproval(runId)
          : { question: inputData.question, text: inputData.text ?? "", decision: inputData.decision, attempt: inputData.attempt };
      await killpoint("publish:before-write");
      const { published } = deps.outbox.publish({ key: runId, question, text, citations: parseCitations(text), decision }, deps.publishMode);
      await killpoint("publish:after-write");
      return { status: "published" as const, attempts: attempt, text, firstWrite: published };
    },
  });

  return createWorkflow({ id: "review-workflow", inputSchema: z.object({ question: z.string().min(1) }), outputSchema: Published })
    .map(async ({ inputData }) => ({ question: inputData.question, attempt: 0 }))
    .dountil(cycle, async ({ inputData }) => inputData.decision !== "reject" || inputData.attempt >= MAX_ATTEMPTS)
    .then(publish)
    .commit();
}

export type ReviewWorkflow = ReturnType<typeof buildWorkflow>;
