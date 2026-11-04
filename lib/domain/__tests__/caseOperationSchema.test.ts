/** Stored action grammar only; contextual case targets, execution order and
 * catalog permission are enforced by the complete document gate. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	caseOperationSchema,
	caseWriteKeyOf,
	formSchema,
	operationTarget,
	sameCaseWriteKey,
} from "../forms";

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
	property: "visit_state",
	value: literal("complete"),
};
const link = {
	identifier: "parent",
	targetType: "patient",
	target: { kind: "op" as const, opUuid: TARGET_UUID },
	relationship: "child" as const,
};

const own = { uuid: OPERATION_UUID, id: "visit", action: "own" as const };

describe("caseOperationSchema", () => {
	it("admits the own arm with every facet it holds", () => {
		expect(
			caseOperationSchema.safeParse({
				...own,
				name: literal("Visit"),
				owner: { kind: "acting-user" },
				writes: [
					write,
					{ ...write, via: [{ identifier: "parent" }], onlyIfChanged: true },
				],
				links: [link],
				placement: { kind: "basic", slot: "own" },
			}).success,
		).toBe(true);
		expect(caseOperationSchema.safeParse(own).success).toBe(true);
	});

	it("refuses a case type, target, condition, repeat, rename or retype on the own arm", () => {
		// The own arm's type and target are the form's; a stored one would be
		// a second answer that could disagree with the module.
		for (const facet of [
			{ caseType: "visit" },
			{ target: { kind: "session" } },
			{ condition: { kind: "match-all" } },
			{ forEach: { repeat: TARGET_UUID } },
			{ rename: literal("Renamed") },
			{ retype: "archived_visit" },
		]) {
			expect(caseOperationSchema.safeParse({ ...own, ...facet }).success).toBe(
				false,
			);
		}
	});

	it("admits the worker's record only as an update's target", () => {
		const target = { kind: "worker-record" };
		expect(
			caseOperationSchema.safeParse({
				...common,
				caseType: "commcare-user",
				action: "update",
				target,
				writes: [write],
			}).success,
		).toBe(true);
		expect(
			caseOperationSchema.safeParse({
				...common,
				caseType: "commcare-user",
				action: "close",
				target,
			}).success,
		).toBe(false);
		expect(
			caseOperationSchema.safeParse({
				...common,
				action: "create",
				target,
				name: literal("Worker"),
			}).success,
		).toBe(false);
	});

	it("refuses an empty via, a false onlyIfChanged and a placement outside the union", () => {
		for (const facet of [
			{ writes: [{ ...write, via: [] }] },
			{ writes: [{ ...write, onlyIfChanged: false }] },
			{ placement: { kind: "load", tag: "load_visit" } },
			{ placement: { kind: "advanced", tag: "load visit" } },
		]) {
			expect(
				caseOperationSchema.safeParse({
					...common,
					action: "update",
					target: { kind: "session" },
					...facet,
				}).success,
			).toBe(false);
		}
	});

	it("admits the authored create, update and close facet examples", () => {
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

describe("operationTarget", () => {
	it("gives the own arm a new case on a registration and the loaded case elsewhere", () => {
		const parsed = caseOperationSchema.parse(own);
		expect(operationTarget(parsed, "registration")).toEqual({ kind: "new" });
		expect(operationTarget(parsed, "followup")).toEqual({ kind: "session" });
		expect(operationTarget(parsed, "close")).toEqual({ kind: "session" });
		const update = caseOperationSchema.parse({
			...common,
			action: "update",
			target: { kind: "op", opUuid: TARGET_UUID },
		});
		expect(operationTarget(update, "registration")).toEqual({
			kind: "op",
			opUuid: TARGET_UUID,
		});
	});
});

describe("case write keys", () => {
	it("tells writes apart by the case their via reaches, not only by property", () => {
		const self = caseWriteKeyOf(write);
		const parent = caseWriteKeyOf({
			...write,
			via: [{ identifier: "parent" }],
		});
		const typedParent = caseWriteKeyOf({
			...write,
			via: [{ identifier: "parent", throughCaseType: "patient" }],
		});
		expect(self).toEqual({ property: "visit_state" });
		expect(sameCaseWriteKey(self, caseWriteKeyOf({ ...write }))).toBe(true);
		expect(sameCaseWriteKey(self, parent)).toBe(false);
		expect(sameCaseWriteKey(parent, typedParent)).toBe(false);
		expect(
			sameCaseWriteKey(parent, {
				property: "visit_state",
				via: [{ identifier: "parent" }],
			}),
		).toBe(true);
		expect(
			sameCaseWriteKey(parent, {
				property: "visit_state",
				via: [{ identifier: "parent" }, { identifier: "parent" }],
			}),
		).toBe(false);
	});
});

describe("form conditions and the own close's slot", () => {
	const form = {
		uuid: testUuid("33333333-3333-4333-8333-333333333333"),
		id: "visit",
		name: "Visit",
		type: "close",
	};

	it("stores open and close conditions as expressions", () => {
		const condition = {
			kind: "eq",
			left: { kind: "term", term: { kind: "field", uuid: TARGET_UUID } },
			right: literal("yes"),
		};
		expect(
			formSchema.safeParse({
				...form,
				openCondition: condition,
				closeCondition: condition,
				ownClosePlacement: { kind: "save-to-case", path: ["close_visit"] },
			}).success,
		).toBe(true);
	});

	it("refuses the retired field-and-answer close condition and a repeat on the own close", () => {
		expect(
			formSchema.safeParse({
				...form,
				closeCondition: { field: TARGET_UUID, answer: "yes" },
			}).success,
		).toBe(false);
		expect(
			formSchema.safeParse({
				...form,
				ownClosePlacement: {
					kind: "save-to-case",
					repeat: TARGET_UUID,
					path: ["close_visit"],
				},
			}).success,
		).toBe(false);
	});
});
