import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseOperationSchema } from "../forms";

const OPERATION_UUID = testUuid("11111111-1111-4111-8111-111111111111");
const TARGET_UUID = testUuid("22222222-2222-4222-8222-222222222222");
const literal = (value: string) => ({
	kind: "term" as const,
	term: { kind: "literal" as const, value },
});
const common = {
	uuid: OPERATION_UUID,
	id: "case_effect",
	caseType: "visit",
};
const write = {
	property: "status",
	value: literal("complete"),
};
const link = {
	identifier: "parent",
	targetType: "patient",
	target: { kind: "op" as const, opUuid: TARGET_UUID },
	relationship: "child" as const,
};

describe("caseOperationSchema", () => {
	it("admits exactly the action-specific stored facets", () => {
		for (const valid of [
			{
				action: "create",
				target: { kind: "new" },
				name: literal("Visit"),
				owner: { kind: "acting-user" },
				writes: [write],
				links: [link],
			},
			{
				action: "update",
				target: { kind: "session" },
				owner: { kind: "acting-user" },
				rename: literal("Renamed"),
				retype: "archived_visit",
				writes: [write],
				links: [link],
			},
			{
				action: "close",
				target: { kind: "session" },
				writes: [write],
			},
		]) {
			expect(
				caseOperationSchema.safeParse({ ...common, ...valid }).success,
			).toBe(true);
		}
	});

	it("rejects missing, wrong-target, forbidden, and unknown facets", () => {
		for (const invalid of [
			{ action: "create", target: { kind: "new" } },
			{
				action: "create",
				target: { kind: "session" },
				name: literal("Visit"),
			},
			{
				action: "create",
				target: { kind: "new" },
				name: literal("Visit"),
				rename: literal("Renamed"),
			},
			{
				action: "create",
				target: { kind: "new" },
				name: literal("Visit"),
				retype: "archived_visit",
			},
			{ action: "update", target: { kind: "new" } },
			{
				action: "update",
				target: { kind: "session" },
				name: literal("Visit"),
			},
			{ action: "close", target: { kind: "new" } },
			{
				action: "close",
				target: { kind: "session" },
				name: literal("Closed"),
			},
			{
				action: "close",
				target: { kind: "session" },
				owner: { kind: "acting-user" },
			},
			{
				action: "close",
				target: { kind: "session" },
				rename: literal("Closed"),
			},
			{
				action: "close",
				target: { kind: "session" },
				retype: "closed_visit",
			},
			{
				action: "close",
				target: { kind: "session" },
				links: [],
			},
			{
				action: "update",
				target: { kind: "session" },
				legacyFacet: true,
			},
		]) {
			expect(
				caseOperationSchema.safeParse({ ...common, ...invalid }).success,
			).toBe(false);
		}
	});
});
