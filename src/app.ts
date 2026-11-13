import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { join } from "node:path";
import { fixtureDrafter, parseDrafter, type Drafter } from "./drafters";
import { Approvals, parseApprovalCheck } from "./approvals";
import { Outbox, parsePublishMode } from "./outbox";
import { buildWorkflow } from "./workflow";

/** One Mastra instance over one LibSQL file and one outbox directory. Every process builds its own. */
export async function createApp(dataDir: string, drafter?: Drafter) {
  const mode = parseDrafter(process.env.DRAFTER);
  const chosen = drafter ?? (mode === "ollama" ? (await import("./ollama-drafter" as string)).ollamaDrafter as Drafter : fixtureDrafter);
  const outbox = new Outbox(join(dataDir, "outbox"));
  const approvals = new Approvals(join(dataDir, "approvals"));
  const workflow = buildWorkflow({ drafter: chosen, outbox, approvals, publishMode: parsePublishMode(process.env.PUBLISH_MODE),
    approvalCheck: parseApprovalCheck(process.env.APPROVAL_CHECK),
  });
  const mastra = new Mastra({
    workflows: { reviewWorkflow: workflow },
    storage: new LibSQLStore({ id: "review-store", url: `file:${join(dataDir, "mastra.db")}` }),
    logger: false,
  });
  return { mastra, workflow: mastra.getWorkflow("reviewWorkflow"), outbox };
}
