/**
 * `formLinkDependents.ts`: what removing a form or module does to the
 * after-submit links that point into it — a refusal that names them.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	formLinkDependentsOnRemove,
	planFormLinkDependentsOnRemove,
} from "@/lib/doc/formLinkDependents";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const REGISTER = testUuid("frm-register");
const FOLLOW_UP = testUuid("frm-follow-up");
const VISIT = testUuid("frm-visit");
const ARCHIVE = testUuid("frm-archive");

function fixture(): BlueprintDoc {
	const q = (id: string) => f({ kind: "text", id, label: proseText(id) });
	return buildDoc({
		appName: "Dependents",
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				forms: [
					{
						uuid: "frm-register",
						name: "Register",
						type: "survey",
						formLinks: [
							{
								uuid: "lnk-register-visit",
								target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
							},
						],
						fields: [q("a")],
					},
					{
						uuid: "frm-follow-up",
						name: "Follow up",
						type: "survey",
						formLinks: [
							{
								uuid: "lnk-follow-care",
								target: { type: "module", moduleUuid: CARE },
							},
						],
						fields: [q("b")],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Care",
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "survey",
						formLinks: [
							// Points at a sibling inside Care; leaves with the module.
							{
								uuid: "lnk-visit-archive",
								target: { type: "form", moduleUuid: CARE, formUuid: ARCHIVE },
							},
							// A self-link: never a dependent of its own removal.
							{
								uuid: "lnk-visit-self",
								condition: "1 = 1",
								target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
							},
						],
						fields: [q("c")],
					},
					{
						uuid: "frm-archive",
						name: "Archive",
						type: "survey",
						fields: [q("d")],
					},
				],
			},
		],
	});
}

describe("formLinkDependentsOnRemove", () => {
	it("lists links from other forms that point at the removed form, in document order", () => {
		expect(
			formLinkDependentsOnRemove(fixture(), { kind: "form", formUuid: VISIT }),
		).toEqual([
			{
				formUuid: REGISTER,
				formName: "Register",
				moduleName: "Intake",
				linkUuid: testUuid("lnk-register-visit"),
			},
		]);
	});

	it("counts links at the module and at any of its forms when the module goes", () => {
		expect(
			formLinkDependentsOnRemove(fixture(), {
				kind: "module",
				moduleUuid: CARE,
			}).map((d) => d.linkUuid),
		).toEqual([testUuid("lnk-register-visit"), testUuid("lnk-follow-care")]);
	});

	it("ignores links that live on the removed subtree, self-links included", () => {
		expect(
			formLinkDependentsOnRemove(fixture(), {
				kind: "form",
				formUuid: ARCHIVE,
			}),
		).toEqual([
			{
				formUuid: VISIT,
				formName: "Visit",
				moduleName: "Care",
				linkUuid: testUuid("lnk-visit-archive"),
			},
		]);
		expect(
			formLinkDependentsOnRemove(fixture(), {
				kind: "form",
				formUuid: FOLLOW_UP,
			}),
		).toEqual([]);
		expect(
			formLinkDependentsOnRemove(fixture(), {
				kind: "module",
				moduleUuid: INTAKE,
			}),
		).toEqual([]);
	});
});

describe("planFormLinkDependentsOnRemove", () => {
	it("is none when nothing points in", () => {
		expect(
			planFormLinkDependentsOnRemove(fixture(), {
				kind: "form",
				formUuid: FOLLOW_UP,
			}),
		).toEqual({ kind: "none" });
	});

	it("refuses naming the source forms and the repair, in both voices", () => {
		const plan = planFormLinkDependentsOnRemove(fixture(), {
			kind: "module",
			moduleUuid: CARE,
		});
		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.dependents).toHaveLength(2);
		expect(plan.message).toContain('Cannot remove module "Care"');
		expect(plan.message).toContain('"Register" in "Intake"');
		expect(plan.message).toContain('"Follow up" in "Intake"');
		expect(plan.message).toContain("update_form_link");
		expect(plan.message).toContain("remove_form_link");
		expect(plan.message).toContain(testUuid("lnk-register-visit"));
		expect(plan.userMessage).toBe(
			'"Care" can\'t be removed yet: "Register" and "Follow up" send people to it after submit. Point those links somewhere else, or remove them, then try again.',
		);
	});

	it("speaks in the singular for one link", () => {
		const plan = planFormLinkDependentsOnRemove(fixture(), {
			kind: "form",
			formUuid: VISIT,
		});
		if (plan.kind !== "blocked") throw new Error("expected a refusal");
		expect(plan.userMessage).toBe(
			'"Visit" can\'t be removed yet: "Register" sends people to it after submit. Point that link somewhere else, or remove it, then try again.',
		);
		expect(plan.message).toContain("an after-submit link points at it");
	});

	it("is none for an entity that does not exist (the caller's missing branch owns it)", () => {
		expect(
			planFormLinkDependentsOnRemove(fixture(), {
				kind: "form",
				formUuid: testUuid("ghost"),
			}),
		).toEqual({ kind: "none" });
	});
});
