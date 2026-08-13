/**
 * The shared orchestration-kind classification — the one source the SQL
 * freeze gate, the progress fold, and the chat route's interruption stamp
 * derive from. The `satisfies` lock in `orchestratorState.ts` proves every
 * schema kind is classified; this pins the reverse (no stale classified
 * kind) and the exact membership of the derived sets.
 */
import { expect, it } from "vitest";
import {
	APP_RELEASING_ORCHESTRATION_KINDS,
	isTerminalOrchestrationKind,
	ORCHESTRATION_KIND_CLASSIFICATION,
	TERMINAL_ORCHESTRATION_KINDS,
} from "../orchestrationKinds";
import { buildOrchestratorStateSchema } from "../orchestratorState";

it("classifies exactly the schema union's kinds", () => {
	const schemaKinds = buildOrchestratorStateSchema.options
		.map((option) => option.shape.kind.value)
		.sort();
	expect(Object.keys(ORCHESTRATION_KIND_CLASSIFICATION).sort()).toEqual(
		schemaKinds,
	);
});

it("pins the freeze-release and terminal sets", () => {
	expect(APP_RELEASING_ORCHESTRATION_KINDS).toEqual([
		"finished",
		"accepted-partial",
	]);
	expect(TERMINAL_ORCHESTRATION_KINDS).toEqual([
		"finished",
		"accepted-partial",
		"failed",
	]);
	expect(isTerminalOrchestrationKind("failed")).toBe(true);
	expect(isTerminalOrchestrationKind("finished")).toBe(true);
	expect(isTerminalOrchestrationKind("executing-slice")).toBe(false);
	expect(isTerminalOrchestrationKind("designing")).toBe(false);
});
