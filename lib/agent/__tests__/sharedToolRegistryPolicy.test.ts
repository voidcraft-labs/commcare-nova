/**
 * Execution-policy invariants over the complete shared tool registry.
 *
 * The `satisfies` clause already forces every entry to DECLARE a policy;
 * these tests check relationships between declarations. They do not infer
 * side effects from handlers or prove runtime capability enforcement; the
 * workspace and change-set integration suites own those boundaries.
 */

import { describe, expect, it } from "vitest";
import {
	SHARED_TOOL_REGISTRY,
	type ToolExecutionPolicy,
} from "../sharedToolRegistry";

const EXTERNAL_WRITE_CAPABILITIES = [
	"organization-write",
	"media-write",
	"lookup-write",
	"deployment-write",
] as const;

describe("shared tool registry — execution policy coherence", () => {
	it("every external-effect tool is unstageable", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (
				entry.policy.effect === "mutate-external" ||
				entry.policy.effect === "mixed-transaction"
			) {
				expect(
					entry.policy.staging,
					`${entry.saName} has an external effect and must be forbidden in a change set`,
				).toBe("forbidden");
			}
		}
	});

	it("no stageable tool carries an external-write capability", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (entry.policy.staging === "forbidden") continue;
			for (const capability of entry.policy.capabilities) {
				expect(
					EXTERNAL_WRITE_CAPABILITIES,
					`${entry.saName} is stageable but requires ${capability}`,
				).not.toContain(capability);
			}
		}
	});

	it("every Blueprint mutator declares the canonical write capability", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (entry.policy.effect !== "mutate-blueprint") continue;
			expect(
				entry.policy.capabilities,
				`${entry.saName} mutates the Blueprint`,
			).toContain("canonical-blueprint-write");
		}
	});

	it("read-only tools declare no write capability at all", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (entry.policy.effect !== "read-blueprint") continue;
			for (const capability of entry.policy.capabilities) {
				expect(
					capability.endsWith("-read"),
					`${entry.saName} is a read but requires ${capability}`,
				).toBe(true);
			}
		}
	});

	it("final-guidance read sets are declared read sets", () => {
		for (const entry of SHARED_TOOL_REGISTRY) {
			const policy: ToolExecutionPolicy = entry.policy;
			for (const kind of policy.emitsFinalGuidanceFrom ?? []) {
				expect(
					policy.readSets,
					`${entry.saName} projects guidance from an undeclared read set`,
				).toContain(kind);
			}
		}
	});

	it("the batch-exclusive case-store saga is the only exclusive classification", () => {
		const exclusive = SHARED_TOOL_REGISTRY.filter(
			(entry) => entry.policy.staging === "exclusive",
		).map((entry) => entry.saName);
		expect(exclusive).toEqual(["renameCaseProperties"]);
	});

	it("keeps both public name sets unique and mutation permissions above view", () => {
		for (const key of ["saName", "mcpName"] as const) {
			const names = SHARED_TOOL_REGISTRY.map((entry) => entry[key]);
			expect(new Set(names).size, key).toBe(names.length);
		}
		for (const entry of SHARED_TOOL_REGISTRY) {
			if (entry.policy.effect !== "read-blueprint") {
				expect(entry.requires, entry.saName).not.toBe("view");
			}
		}
	});
});
