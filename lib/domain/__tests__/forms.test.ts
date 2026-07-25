// lib/domain/__tests__/forms.test.ts
//
// Schema-level invariants for form entities. These tests pin
// semantic invariants the runtime consumers rely on (e.g. session
// emitter / expander agree on what "condition present" means) rather
// than the shape of Zod's own combinator output.

import { describe, expect, it } from "vitest";
import {
	asUuid,
	formSchema,
	isCaseFirstModule,
	orderedFormLinks,
} from "@/lib/domain";
import { eq, literal, prop, sessionUser } from "@/lib/domain/predicate";
import { opaqueXPathExpression } from "../xpath";

describe("formSchema — formLinks", () => {
	const baseForm = {
		uuid: asUuid("frm-1"),
		id: "intake",
		name: "Intake",
		type: "survey" as const,
	};

	const linkTarget = {
		type: "form" as const,
		moduleUuid: asUuid("mod-1"),
		formUuid: asUuid("frm-2"),
	};

	const link = (extra: Record<string, unknown>) => ({
		uuid: asUuid("lnk-1"),
		order: "a0",
		target: linkTarget,
		...extra,
	});

	it("accepts an absent condition (unconditional link)", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [link({})],
		});
		expect(result.success).toBe(true);
	});

	it("accepts a typed Predicate condition", () => {
		const condition = eq(prop("patient", "outcome"), literal("yes"));
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [link({ condition })],
		});
		expect(result.success).toBe(true);
		if (result.success)
			expect(result.data.formLinks?.[0].condition).toEqual(condition);
	});

	it("rejects a condition stored as XPath text", () => {
		// The condition shares the display conditions' vocabulary, so the
		// same identity guarantee applies: a rename resolves at print time
		// because the reference is a typed leaf, never a string that would
		// have to be rewritten.
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				link({ condition: opaqueXPathExpression("/data/outcome = 'yes'") }),
			],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a link with no identity or no order key", () => {
		// Both are what make a link addressable by an identity-keyed
		// mutation and orderable independently of array position. A link
		// missing either could not be moved or updated without rewriting
		// the whole list.
		expect(
			formSchema.safeParse({
				...baseForm,
				formLinks: [{ order: "a0", target: linkTarget }],
			}).success,
		).toBe(false);
		expect(
			formSchema.safeParse({
				...baseForm,
				formLinks: [{ uuid: asUuid("lnk-1"), target: linkTarget }],
			}).success,
		).toBe(false);
	});
});

describe("orderedFormLinks", () => {
	const target = {
		type: "module" as const,
		moduleUuid: asUuid("mod-1"),
	};

	it("sorts by order key, not by array position", () => {
		const ordered = orderedFormLinks({
			formLinks: [
				{ uuid: asUuid("lnk-b"), order: "a2", target },
				{ uuid: asUuid("lnk-a"), order: "a1", target },
			],
		});
		expect(ordered.map((link) => link.uuid)).toEqual(["lnk-a", "lnk-b"]);
	});

	it("breaks an order-key tie on uuid so the sequence is total", () => {
		// Sequence decides which guard negates which, so two links holding
		// one key must still resolve to exactly one order on every surface
		// — a comparator returning 0 here would let the emitter and the
		// preview disagree about which branch a worker takes.
		const ordered = orderedFormLinks({
			formLinks: [
				{ uuid: asUuid("lnk-z"), order: "a1", target },
				{ uuid: asUuid("lnk-a"), order: "a1", target },
			],
		});
		expect(ordered.map((link) => link.uuid)).toEqual(["lnk-a", "lnk-z"]);
	});
});

describe("formSchema — displayCondition", () => {
	const baseForm = {
		uuid: asUuid("frm-display"),
		id: "intake",
		name: "Intake",
		type: "survey" as const,
	};

	it("stores a typed Predicate carrier", () => {
		const displayCondition = eq(sessionUser("username"), literal("alice"));
		const parsed = formSchema.safeParse({ ...baseForm, displayCondition });
		expect(parsed.success).toBe(true);
		if (parsed.success)
			expect(parsed.data.displayCondition).toEqual(displayCondition);
	});

	it("rejects untyped expression text", () => {
		expect(
			formSchema.safeParse({
				...baseForm,
				displayCondition: "#case/status = 'open'",
			}).success,
		).toBe(false);
	});
});

describe("isCaseFirstModule", () => {
	// Mirrors CommCareSession.getDataNeededByAllEntries: case-first iff every
	// form needs the same case_id datum (all case-loading) and there's a case
	// type to select from.
	it("is case-first when every form is case-loading (followup + close)", () => {
		expect(isCaseFirstModule(["followup", "close"], true)).toBe(true);
	});

	it("is case-first for a single case-loading form", () => {
		expect(isCaseFirstModule(["followup"], true)).toBe(true);
	});

	it("is forms-first when a registration form is present", () => {
		// Registration needs a fresh case_id_new datum, not the shared case_id,
		// so the case selection can't be hoisted.
		expect(isCaseFirstModule(["registration", "followup"], true)).toBe(false);
	});

	it("is forms-first when a survey form is present", () => {
		// Survey needs no case datum, breaking the shared-datum hoist.
		expect(isCaseFirstModule(["followup", "survey"], true)).toBe(false);
	});

	it("is never case-first without a case type", () => {
		expect(isCaseFirstModule(["followup", "close"], false)).toBe(false);
	});

	it("is never case-first with no forms", () => {
		expect(isCaseFirstModule([], true)).toBe(false);
	});
});
