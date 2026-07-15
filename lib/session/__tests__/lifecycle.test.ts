import { describe, expect, it } from "vitest";
import type { Event } from "@/lib/log/types";
import {
	deriveAgentError,
	deriveAgentStage,
	deriveAttachmentPrep,
	derivePostBuildEdit,
	deriveStatusMessage,
	deriveValidationAttempt,
	stageTagToGenerationStage,
} from "../lifecycle";
import { GenerationStage, STAGE_LABELS } from "../types";

// ── Test helpers ─────────────────────────────────────────────────────────

function mut(stage: string | undefined, seq = 0): Event {
	return {
		kind: "mutation",
		runId: "r",
		ts: 0,
		seq,
		source: "chat",
		actor: "agent",
		...(stage && { stage }),
		mutation: { kind: "setAppName", name: "x" },
	};
}

function err(message: string, fatal: boolean, seq = 0): Event {
	return {
		kind: "conversation",
		runId: "r",
		ts: 0,
		seq,
		source: "chat",
		payload: {
			type: "error",
			error: { type: "internal", message, fatal },
		},
	};
}

function validationAttempt(attempt: number, errors: string[], seq = 0): Event {
	return {
		kind: "conversation",
		runId: "r",
		ts: 0,
		seq,
		source: "chat",
		payload: { type: "validation-attempt", attempt, errors },
	};
}

function attachmentPrep(
	phase: "start" | "done",
	seq = 0,
	count?: number,
): Event {
	return {
		kind: "conversation",
		runId: "r",
		ts: 0,
		seq,
		source: "chat",
		payload: {
			type: "attachment-prep",
			phase,
			...(count !== undefined && { count }),
		},
	};
}

// ── stageTagToGenerationStage ─────────────────────────────────────────────

describe("stageTagToGenerationStage", () => {
	it("maps the live build stages (app / module:create / module:N / form:M-F)", () => {
		expect(stageTagToGenerationStage("app")).toBe(GenerationStage.Foundation);
		expect(stageTagToGenerationStage("module:create")).toBe(
			GenerationStage.Build,
		);
		expect(stageTagToGenerationStage("module:0")).toBe(GenerationStage.Build);
		expect(stageTagToGenerationStage("form:0-1")).toBe(GenerationStage.Build);
	});

	it("maps the historical stages (schema / scaffold / fix) so old logs still render", () => {
		expect(stageTagToGenerationStage("schema")).toBe(
			GenerationStage.Foundation,
		);
		expect(stageTagToGenerationStage("scaffold")).toBe(
			GenerationStage.Foundation,
		);
		expect(stageTagToGenerationStage("fix:attempt-2")).toBe(
			GenerationStage.Fix,
		);
	});

	it("returns null for tags with no narrate-worthy phase", () => {
		expect(stageTagToGenerationStage("edit:0-1")).toBeNull();
		expect(stageTagToGenerationStage("rename:0-1")).toBeNull();
		expect(stageTagToGenerationStage("module:remove:2")).toBeNull();
	});
});

// ── deriveAgentStage ──────────────────────────────────────────────────────

describe("deriveAgentStage", () => {
	it("returns null on empty buffer", () => {
		expect(deriveAgentStage([])).toBeNull();
	});

	it("derives the furthest milestone established across the run", () => {
		expect(
			deriveAgentStage([
				mut("schema", 0),
				mut("scaffold", 1),
				mut("module:0", 2),
			]),
		).toBe(GenerationStage.Build);
	});

	it("skips mutations without stage tags", () => {
		expect(deriveAgentStage([mut(undefined, 0), mut("schema", 1)])).toBe(
			GenerationStage.Foundation,
		);
	});

	it("walks past phase-less tags to find a generation stage", () => {
		/* edit:* / rename:* / module:remove:N don't resolve to a generation
		 * stage, so they do not affect the milestone facts in the prefix. */
		expect(
			deriveAgentStage([
				mut("app", 0),
				mut("module:remove:1", 1),
				mut("edit:0-1", 2),
			]),
		).toBe(GenerationStage.Foundation);
	});

	it("treats app naming and data-model recording as one foundation milestone", () => {
		expect(deriveAgentStage([mut("app", 0)])).toBe(GenerationStage.Foundation);
		expect(deriveAgentStage([mut("app", 0), mut("schema", 1)])).toBe(
			GenerationStage.Foundation,
		);
	});

	it("does not rewind when the data model is enriched after content work starts", () => {
		expect(
			deriveAgentStage([
				mut("schema", 0),
				mut("module:create", 1),
				mut("schema", 2),
			]),
		).toBe(GenerationStage.Build);
	});

	it.each([
		{
			name: "live retries and late foundation work",
			tags: ["app", "schema", "schema", "module:create", "schema", "app"],
			expected: [
				GenerationStage.Foundation,
				GenerationStage.Foundation,
				GenerationStage.Foundation,
				GenerationStage.Build,
				GenerationStage.Build,
				GenerationStage.Build,
			],
		},
		{
			name: "historical replay through the retired fix loop",
			tags: ["schema", "scaffold", "form:0-0", "fix:attempt-1", "schema"],
			expected: [
				GenerationStage.Foundation,
				GenerationStage.Foundation,
				GenerationStage.Build,
				GenerationStage.Fix,
				GenerationStage.Fix,
			],
		},
	])("derives every $name prefix monotonically from facts", ({
		tags,
		expected,
	}) => {
		const events = tags.map((tag, seq) => mut(tag, seq));
		const actual = events.map((_, index) =>
			deriveAgentStage(events.slice(0, index + 1)),
		);
		expect(actual).toEqual(expected);
	});
});

// ── deriveAgentError ──────────────────────────────────────────────────────

describe("deriveAgentError", () => {
	it("returns null with no errors", () => {
		expect(deriveAgentError([mut("schema")])).toBeNull();
	});

	it("returns the latest error with correct severity", () => {
		expect(deriveAgentError([err("x", false, 0)])).toEqual({
			message: "x",
			severity: "recovering",
		});
		expect(deriveAgentError([err("x", true, 0)])).toEqual({
			message: "x",
			severity: "failed",
		});
	});

	it("persists through newer non-error conversation events", () => {
		/* Errors are sticky within a run — a newer assistant-text doesn't
		 * clear the error panel. The panel only clears when a fresh
		 * error supersedes or the run ends (buffer cleared). */
		const events: Event[] = [
			err("bad", false, 0),
			{
				kind: "conversation",
				runId: "r",
				ts: 0,
				seq: 1,
				source: "chat",
				payload: { type: "assistant-text", text: "still going" },
			},
		];
		expect(deriveAgentError(events)).toEqual({
			message: "bad",
			severity: "recovering",
		});
	});

	it("persists through newer mutations (walker skips mutations)", () => {
		const events: Event[] = [err("bad", true, 0), mut("fix:attempt-1", 1)];
		expect(deriveAgentError(events)).toEqual({
			message: "bad",
			severity: "failed",
		});
	});

	it("newer error supersedes older error", () => {
		const events: Event[] = [err("first", true, 0), err("second", false, 1)];
		expect(deriveAgentError(events)).toEqual({
			message: "second",
			severity: "recovering",
		});
	});
});

// ── deriveValidationAttempt ───────────────────────────────────────────────

describe("deriveValidationAttempt", () => {
	it("returns null with no validation-attempt events", () => {
		expect(deriveValidationAttempt([mut("schema", 0)])).toBeNull();
	});

	it("returns the latest attempt + errorCount", () => {
		expect(
			deriveValidationAttempt([
				validationAttempt(1, ["e1", "e2"], 0),
				validationAttempt(2, ["e3"], 1),
			]),
		).toEqual({ attempt: 2, errorCount: 1 });
	});

	it("handles multiple attempts — latest wins", () => {
		expect(
			deriveValidationAttempt([
				validationAttempt(1, [], 0),
				validationAttempt(2, ["x"], 1),
				validationAttempt(3, ["a", "b", "c"], 2),
			]),
		).toEqual({ attempt: 3, errorCount: 3 });
	});
});

// ── deriveAttachmentPrep ──────────────────────────────────────────────────

describe("deriveAttachmentPrep", () => {
	it("false on an empty buffer (no condensing in flight)", () => {
		expect(deriveAttachmentPrep([])).toBe(false);
	});

	it("true after start, before done", () => {
		expect(deriveAttachmentPrep([attachmentPrep("start", 0, 2)])).toBe(true);
	});

	it("false once done lands", () => {
		expect(
			deriveAttachmentPrep([
				attachmentPrep("start", 0, 2),
				attachmentPrep("done", 1),
			]),
		).toBe(false);
	});

	it("true again on a second start — latest wins", () => {
		expect(
			deriveAttachmentPrep([
				attachmentPrep("start", 0, 1),
				attachmentPrep("done", 1),
				attachmentPrep("start", 2, 1),
			]),
		).toBe(true);
	});

	it("stays false when a later non-attachment event follows done", () => {
		/* The derivation keys only off attachment-prep events; a mutation that
		 * arrives after `done` must not re-open the reading-documents state. */
		expect(
			deriveAttachmentPrep([
				attachmentPrep("start", 0, 1),
				attachmentPrep("done", 1),
				mut("schema", 2),
			]),
		).toBe(false);
	});
});

// ── derivePostBuildEdit ───────────────────────────────────────────────────

describe("derivePostBuildEdit", () => {
	it("false when buffer is empty (no run in progress)", () => {
		/* Empty buffer = no active run (beginRun/endRun both clear it).
		 * Can't be a post-build edit because no edit is happening. */
		expect(derivePostBuildEdit([], true)).toBe(false);
	});

	it("false when the run opened on an empty doc (an initial build)", () => {
		expect(derivePostBuildEdit([mut("app", 0)], false)).toBe(false);
		expect(derivePostBuildEdit([mut("module:create", 0)], false)).toBe(false);
	});

	it("true when a run is in progress and it opened on a populated doc", () => {
		expect(derivePostBuildEdit([mut("edit:0-1", 0)], true)).toBe(true);
		/* Edits emit the same construction tags builds do — the run-start
		 * capture, not the tag, is the discriminator. */
		expect(derivePostBuildEdit([mut("module:create", 0)], true)).toBe(true);
	});

	it("true even if buffer only has conversation events (askQuestions mid-edit)", () => {
		/* User mid-edit asking a clarifying question — buffer has
		 * tool-call but no mutations. The run opened on a populated doc.
		 * Still a post-build edit in progress. */
		const events: Event[] = [
			{
				kind: "conversation",
				runId: "r",
				ts: 0,
				seq: 0,
				source: "chat",
				payload: { type: "user-message", text: "rename form 1" },
			},
		];
		expect(derivePostBuildEdit(events, true)).toBe(true);
	});
});

// ── deriveStatusMessage ───────────────────────────────────────────────────

describe("deriveStatusMessage", () => {
	it("returns empty string when idle", () => {
		expect(deriveStatusMessage(null, null, null)).toBe("");
	});

	it("returns stage label", () => {
		expect(deriveStatusMessage(GenerationStage.Foundation, null, null)).toBe(
			STAGE_LABELS[GenerationStage.Foundation],
		);
	});

	it("composes stage=Fix with attempt + errorCount (plural)", () => {
		expect(
			deriveStatusMessage(GenerationStage.Fix, null, {
				attempt: 2,
				errorCount: 3,
			}),
		).toBe("Fixing 3 errors, attempt 2");
	});

	it("composes stage=Fix with attempt + errorCount (singular)", () => {
		expect(
			deriveStatusMessage(GenerationStage.Fix, null, {
				attempt: 1,
				errorCount: 1,
			}),
		).toBe("Fixing 1 error, attempt 1");
	});

	it("falls back to stage label when Fix without validation-attempt context", () => {
		expect(deriveStatusMessage(GenerationStage.Fix, null, null)).toBe(
			STAGE_LABELS[GenerationStage.Fix],
		);
	});

	it("prefers error message over stage label", () => {
		expect(
			deriveStatusMessage(
				GenerationStage.Build,
				{ message: "boom", severity: "failed" },
				null,
			),
		).toBe("boom");
	});
});
