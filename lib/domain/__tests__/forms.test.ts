/** Domain form schema and navigation classifier boundaries. These tests do
 * not execute the CommCare emitters/session consumer. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { formLinkEntries, formSchema, isCaseFirstModule } from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	sessionUser,
	term,
} from "@/lib/domain/expression";

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

	it("refuses the retired empty text-fragment representation", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				{
					uuid: linkUuid,
					condition: { parts: [] },
					target: linkTarget,
				},
			],
		});
		expect(result.success).toBe(false);
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
					condition: eq(formField(testUuid("outcome")), literal("yes")),
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

	it("admits distinct selected-record identities and a module-only target", () => {
		const form = {
			...baseForm,
			formLinks: [
				{
					uuid: linkUuid,
					target: { type: "module", moduleUuid: linkTarget.moduleUuid },
					datums: [
						{
							name: { kind: "selected-case", module: linkTarget.moduleUuid },
							xpath: term(literal("a")),
						},
						{
							name: { kind: "selected-case", module: testUuid("mod-parent") },
							xpath: term(literal("b")),
						},
					],
				},
			],
		};
		expect(formSchema.parse(form)).toEqual(form);
		expect(
			formSchema.safeParse({
				...form,
				formLinks: [
					{
						...form.formLinks[0],
						target: {
							...form.formLinks[0].target,
							formUuid: linkTarget.formUuid,
						},
					},
				],
			}).success,
		).toBe(false);
	});

	it("refuses two datums with the same identity on one link", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [
				{
					uuid: linkUuid,
					target: linkTarget,
					datums: [
						{
							name: { kind: "selected-case", module: linkTarget.moduleUuid },
							xpath: term(literal("a")),
						},
						{
							name: { kind: "selected-case", module: linkTarget.moduleUuid },
							xpath: term(literal("b")),
						},
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
					datums: [{ name: "", xpath: term(literal("a")) }],
				},
			],
		});
		expect(result.success).toBe(false);
	});
});

describe("formSchema — this-form and otherwise", () => {
	const baseForm = {
		uuid: testUuid("frm-1"),
		id: "visit",
		name: "Visit",
		type: "followup" as const,
	};
	const menuUuid = testUuid("mod-1");
	const destination = {
		uuid: testUuid("lnk-1"),
		condition: eq(term(sessionUser("username")), term(literal("a"))),
		target: { type: "this-form" as const },
	};
	const datum = (value: string) => ({
		name: { kind: "selected-case" as const, module: menuUuid },
		xpath: term(literal(value)),
	});

	it("parses a destination that starts this form again", () => {
		const parsed = formSchema.parse({ ...baseForm, formLinks: [destination] });
		expect(parsed.formLinks?.[0]?.target).toEqual({ type: "this-form" });
	});

	it("refuses a this-form target that names a menu or a form", () => {
		expect(
			formSchema.safeParse({
				...baseForm,
				formLinks: [
					{
						...destination,
						target: { type: "this-form", moduleUuid: menuUuid },
					},
				],
			}).success,
		).toBe(false);
	});

	it("parses a built-in otherwise and a link otherwise", () => {
		const builtIn = formSchema.parse({
			...baseForm,
			formLinks: [destination],
			otherwise: { kind: "destination", destination: "module" },
		});
		expect(builtIn.otherwise).toEqual({
			kind: "destination",
			destination: "module",
		});
		const link = formSchema.parse({
			...baseForm,
			formLinks: [destination],
			otherwise: {
				kind: "link",
				uuid: testUuid("lnk-2"),
				target: { type: "module", moduleUuid: menuUuid },
				datums: [datum("a")],
			},
		});
		expect(link.otherwise).toMatchObject({
			kind: "link",
			uuid: testUuid("lnk-2"),
		});
	});

	it("refuses app_home as an otherwise, which the absent slot means", () => {
		expect(
			formSchema.safeParse({
				...baseForm,
				formLinks: [destination],
				otherwise: { kind: "destination", destination: "app_home" },
			}).success,
		).toBe(false);
	});

	it("refuses an otherwise link with no uuid", () => {
		expect(
			formSchema.safeParse({
				...baseForm,
				formLinks: [destination],
				otherwise: { kind: "link", target: { type: "this-form" } },
			}).success,
		).toBe(false);
	});

	it("refuses an otherwise link with a condition", () => {
		expect(
			formSchema.safeParse({
				...baseForm,
				formLinks: [destination],
				otherwise: {
					kind: "link",
					uuid: testUuid("lnk-2"),
					condition: destination.condition,
					target: { type: "this-form" },
				},
			}).success,
		).toBe(false);
	});

	it("refuses two otherwise datums with the same name", () => {
		const result = formSchema.safeParse({
			...baseForm,
			formLinks: [destination],
			otherwise: {
				kind: "link",
				uuid: testUuid("lnk-2"),
				target: { type: "this-form" },
				datums: [datum("a"), datum("b")],
			},
		});
		expect(result.success).toBe(false);
		if (!result.success)
			expect(result.error.issues[0]?.message).toContain("listed twice");
	});

	it("walks the destinations in order, then the otherwise only when it is a link", () => {
		const second = { ...destination, uuid: testUuid("lnk-3") };
		const otherwise = {
			kind: "link" as const,
			uuid: testUuid("lnk-2"),
			target: { type: "this-form" as const },
		};
		expect(
			formLinkEntries({ formLinks: [destination, second], otherwise }),
		).toEqual([
			{ role: "destination", link: destination, index: 0 },
			{ role: "destination", link: second, index: 1 },
			{
				role: "otherwise",
				link: { uuid: otherwise.uuid, target: otherwise.target },
			},
		]);
		expect(
			formLinkEntries({
				formLinks: [destination],
				otherwise: { kind: "destination", destination: "module" },
			}),
		).toEqual([{ role: "destination", link: destination, index: 0 }]);
	});
});

describe("formSchema — displayCondition", () => {
	const baseForm = {
		uuid: testUuid("frm-display"),
		id: "intake",
		name: "Intake",
		type: "survey" as const,
	};

	it("stores a typed expression carrier", () => {
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
	// Nova's classifier admits only case-loading forms with a case type.
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
