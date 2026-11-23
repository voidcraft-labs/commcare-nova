import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	relationStep,
	subcasePath,
} from "@/lib/domain/expression";
import { relationSummary } from "../relationSummary";

const HOUSEHOLD: CaseType = { name: "household", properties: [] };
const PATIENT: CaseType = {
	name: "patient",
	properties: [],
	parent_type: "household",
};
const CASE_TYPES = [HOUSEHOLD, PATIENT];

describe("relationSummary", () => {
	it("reads a hyphen or period connection name as the valid name it is", () => {
		for (const name of ["host-case", "host.ref"]) {
			for (const via of [
				ancestorPath(relationStep(name, "household")),
				subcasePath(name, "patient"),
				anyRelationPath(name, "patient"),
			]) {
				const origin = via.kind === "ancestor" ? "patient" : "household";
				const summary = relationSummary(via, origin, CASE_TYPES);
				expect(summary.needsAttention).toBeUndefined();
				expect(summary.detail ?? "").not.toContain("needs attention");
			}
		}
	});

	it("names a saved connection whose name no case index can hold", () => {
		for (const via of [
			ancestorPath(relationStep("not valid", "household")),
			subcasePath("1st", "patient"),
		]) {
			const origin = via.kind === "ancestor" ? "patient" : "household";
			const summary = relationSummary(via, origin, CASE_TYPES);
			expect(summary.needsAttention).toBe(true);
			expect(summary.detail).toMatch(/^Saved connection needs attention/);
		}
	});
});
