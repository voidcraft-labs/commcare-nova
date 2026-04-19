import { describe, expect, it } from "vitest";
import type { Event } from "@/lib/log/types";
import {
	deriveAgentError,
	deriveAgentStage,
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
		payload: { type: "validation-attempt", attempt, errors },
	};
}

// ── stageTagToGenerationStage ─────────────────────────────────────────────

describe("stageTagToGenerationStage", () => {
	it("maps schema/scaffold/module:N/form:M-F/fix:attempt-N", () => {
		expect(stageTagToGenerationStage("schema")).toBe(GenerationStage.DataModel);
		expect(stageTagToGenerationStage("scaffold")).toBe(
			GenerationStage.Structure,
		);
		expect(stageTagToGenerationStage("module:0")).toBe(GenerationStage.Modules);
		expect(stageTagToGenerationStage("form:0-1")).toBe(GenerationStage.Forms);
		expect(stageTagToGenerationStage("fix:attempt-2")).toBe(
			GenerationStage.Fix,
		);
	});

	it("returns null for edit-family tags", () => {
		expect(stageTagToGenerationStage("edit:0-1")).toBeNull();
		expect(stageTagToGenerationStage("rename:0-1")).toBeNull();
		expect(stageTagToGenerationStage("module:create")).toBeNull();
		expect(stageTagToGenerationStage("module:remove:2")).toBeNull();
	});
});

// ── deriveAgentStage ──────────────────────────────────────────────────────

describe("deriveAgentStage", () => {
	it("returns null on empty buffer", () => {
		expect(deriveAgentStage([])).toBeNull();
	});

	it("tracks the latest generation-stage tag across the run", () => {
		expect(
			deriveAgentStage([
				mut("schema", 0),
				mut("scaffold", 1),
				mut("module:0", 2),
			]),
		).toBe(GenerationStage.Modules);
	});

	it("skips mutations without stage tags", () => {
		expect(deriveAgentStage([mut(undefined, 0), mut("schema", 1)])).toBe(
			GenerationStage.DataModel,
		);
	});

	it("walks past edit-family tags to find a generation stage", () => {
		/* edit:* / rename:* / module:create don't resolve to a generation
		 * stage — the walker should continue past them to find the latest
		 * schema/scaffold/module:N/form:M-F/fix instead. */
		expect(
			deriveAgentStage([
				mut("schema", 0),
				mut("module:create", 1),
				mut("edit:0-1", 2),
			]),
		).toBe(GenerationStage.DataModel);
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

	it("clears on non-error conversation event after an error", () => {
		const events: Event[] = [
			err("bad", false, 0),
			{
				kind: "conversation",
				runId: "r",
				ts: 0,
				seq: 1,
				payload: { type: "assistant-text", text: "recovered" },
			},
		];
		expect(deriveAgentError(events)).toBeNull();
	});

	it("mutations don't clear an error — walker keeps looking back", () => {
		const events: Event[] = [err("bad", true, 0), mut("fix:attempt-1", 1)];
		expect(deriveAgentError(events)).toEqual({
			message: "bad",
			severity: "failed",
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

// ── derivePostBuildEdit ───────────────────────────────────────────────────

describe("derivePostBuildEdit", () => {
	it("false when not active", () => {
		expect(derivePostBuildEdit([], false, true)).toBe(false);
	});

	it("false during initial build (schema/scaffold present)", () => {
		expect(derivePostBuildEdit([mut("schema", 0)], true, false)).toBe(false);
		expect(derivePostBuildEdit([mut("scaffold", 0)], true, true)).toBe(false);
	});

	it("true when active, no generation stages, doc has data", () => {
		expect(derivePostBuildEdit([mut("edit:0-1", 0)], true, true)).toBe(true);
	});

	it("false when active, no generation stages, doc empty (askQuestions window)", () => {
		expect(derivePostBuildEdit([], true, false)).toBe(false);
	});
});

// ── deriveStatusMessage ───────────────────────────────────────────────────

describe("deriveStatusMessage", () => {
	it("returns empty string when idle", () => {
		expect(deriveStatusMessage(null, null, null)).toBe("");
	});

	it("returns stage label", () => {
		expect(deriveStatusMessage(GenerationStage.Structure, null, null)).toBe(
			STAGE_LABELS[GenerationStage.Structure],
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
				GenerationStage.Forms,
				{ message: "boom", severity: "failed" },
				null,
			),
		).toBe("boom");
	});
});
