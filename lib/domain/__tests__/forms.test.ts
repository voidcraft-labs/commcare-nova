// lib/domain/__tests__/forms.test.ts
//
// Schema-level invariants for form entities. These tests pin
// semantic invariants the runtime consumers rely on (e.g. session
// emitter / expander agree on what "condition present" means) rather
// than the shape of Zod's own combinator output.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { formSchema, isCaseFirstModule } from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/predicate";
import { opaqueXPathExpression } from "../xpath";

describe("formSchema — formLinks", () => {
	const baseForm = {
		uuid: testUuid("frm-1"),
		id: "intake",
		name: "Intake",
		type: "survey" as const,
	};

	const linkTarget = {
		type: "form" as const,
		moduleUuid: testUuid("mod-1"),
		formUuid: testUuid("frm-2"),
	};
	const linkUuid = testUuid("lnk-1");

	it("accepts an empty condition expression — emitters read it as unconditional", () => {
		// No commit boundary stores an empty condition (an empty commit
		// clears the slot), and the projection collapses a degenerate empty
		// expression to "unconditional" (`formLinkIsConditional` reads the
		// printed text).
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				{
					uuid: linkUuid,
					condition: opaqueXPathExpression(""),
					target: linkTarget,
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("accepts an absent condition (unconditional link)", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [{ uuid: linkUuid, target: linkTarget }],
		});
		expect(result.success).toBe(true);
	});

	it("accepts a non-empty condition (conditional link)", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				{
					uuid: linkUuid,
					condition: opaqueXPathExpression("/data/outcome = 'yes'"),
					target: linkTarget,
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("requires a link uuid — links are entities with durable identity", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [{ target: linkTarget }],
		});
		expect(result.success).toBe(false);
	});

	it("refuses an empty link list — absence is the only spelling of 'no links'", () => {
		expect(formSchema.safeParse({ ...baseForm, formLinks: [] }).success).toBe(
			false,
		);
	});

	it("refuses an empty datums list — absence means auto-match", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [{ uuid: linkUuid, target: linkTarget, datums: [] }],
		});
		expect(result.success).toBe(false);
	});

	it("refuses two datums with the same name on one link", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				{
					uuid: linkUuid,
					target: linkTarget,
					datums: [
						{ name: "case_id", xpath: opaqueXPathExpression("'a'") },
						{ name: "case_id", xpath: opaqueXPathExpression("'b'") },
					],
				},
			],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("listed twice");
		}
	});

	it("refuses a blank datum name", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				{
					uuid: linkUuid,
					target: linkTarget,
					datums: [{ name: "", xpath: opaqueXPathExpression("'a'") }],
				},
			],
		});
		expect(result.success).toBe(false);
	});
});

describe("formSchema — displayCondition", () => {
	const baseForm = {
		uuid: testUuid("frm-display"),
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
				displayCondition: "#patient/status = 'open'",
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
