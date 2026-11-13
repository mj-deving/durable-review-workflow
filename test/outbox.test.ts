import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, parsePublishMode } from "../src/outbox";

const dir = mkdtempSync(join(tmpdir(), "drw-outbox-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const message = { key: "run-1", question: "q", text: "t [chunk:a]", citations: ["a"], decision: "approve" };

test("idempotent publish: five retries, one message", () => {
  const outbox = new Outbox(join(dir, "a"));
  const firsts = Array.from({ length: 5 }, () => outbox.publish(message, "idempotent").published);
  expect(firsts).toEqual([true, false, false, false, false]);
  expect(outbox.count("run-1")).toBe(1);
});

test("idempotent publish refuses a different message under the same key", () => {
  const outbox = new Outbox(join(dir, "b"));
  outbox.publish(message, "idempotent");
  expect(() => outbox.publish({ ...message, text: "other" }, "idempotent")).toThrow(/different message/);
});

test("naive publish duplicates on retry (the control)", () => {
  const outbox = new Outbox(join(dir, "c"));
  for (let i = 0; i < 5; i++) outbox.publish(message, "naive");
  expect(outbox.count("run-1")).toBe(5);
});

test("publish mode typos throw instead of picking a mode", () => {
  expect(parsePublishMode(undefined)).toBe("idempotent");
  expect(() => parsePublishMode("Naive")).toThrow();
});
