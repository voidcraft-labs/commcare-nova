/**
 * `formLinkDependents.ts`: what removing a form or module does to the
 * after-submit links that point into it, a form's otherwise link included:
 * a refusal that names them. Its parity with the commit gate: a removal it
 * refuses is one the gate refuses too, and one it admits commits.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	formLinkDependentsOnRemove,
	planFormLinkDependentsOnRemove,
} from "@/lib/doc/formLinkDependents";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const REGISTER = testUuid("frm-register");
const FOLLOW_UP = testUuid("frm-follow-up");
const VISIT = testUuid("frm-visit");
const ARCHIVE = testUuid("frm-archive");

function fixture(): BlueprintDoc {
	const q = (id: string) => f({ kind: "text", id, label: proseText(id) });
	const doc = buildDoc({
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
	assertAdmittedDoc(doc);
	return doc;
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
				role: "destination",
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

	it("ignores links that leave with the removed subtree", () => {
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
				role: "destination",
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

/**
 * The fixture with Archive sending people on: to Register when a condition
 * holds, otherwise to Follow up, and starting itself again every time.
 */
function withOtherwise(): BlueprintDoc {
	const doc = produce(fixture(), (draft) => {
		draft.forms[ARCHIVE].formLinks = [
			{
				uuid: testUuid("lnk-archive-register"),
				condition: { kind: "match-all" },
				target: { type: "form", moduleUuid: INTAKE, formUuid: REGISTER },
			},
			{ uuid: testUuid("lnk-archive-again"), target: { type: "this-form" } },
		];
		draft.forms[ARCHIVE].otherwise = {
			kind: "link",
			uuid: testUuid("lnk-archive-otherwise"),
			target: { type: "form", moduleUuid: INTAKE, formUuid: FOLLOW_UP },
		};
	});
	assertAdmittedDoc(doc);
	return doc;
}

describe("an otherwise link as a dependent", () => {
	it("counts an otherwise link that points at the removed form, with its role", () => {
		expect(
			formLinkDependentsOnRemove(withOtherwise(), {
				kind: "form",
				formUuid: FOLLOW_UP,
			}),
		).toEqual([
			{
				formUuid: ARCHIVE,
				formName: "Archive",
				moduleName: "Care",
				linkUuid: testUuid("lnk-archive-otherwise"),
				role: "otherwise",
			},
		]);
		expect(
			formLinkDependentsOnRemove(withOtherwise(), {
				kind: "module",
				moduleUuid: INTAKE,
			}).map((dependent) => [dependent.linkUuid, dependent.role]),
		).toEqual([
			[testUuid("lnk-archive-register"), "destination"],
			[testUuid("lnk-archive-otherwise"), "otherwise"],
		]);
	});

	it("refuses exactly what the gate refuses, naming the tool an otherwise link needs", () => {
		const doc = withOtherwise();
		const removeFollowUp = mutationCommitVerdict(
			doc,
			[{ kind: "removeForm", uuid: FOLLOW_UP }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(removeFollowUp.ok).toBe(false);
		if (!removeFollowUp.ok)
			expect(removeFollowUp.findings.map((finding) => finding.code)).toContain(
				"FORM_LINK_TARGET_NOT_FOUND",
			);
		const plan = planFormLinkDependentsOnRemove(doc, {
			kind: "form",
			formUuid: FOLLOW_UP,
		});
		if (plan.kind !== "blocked") throw new Error("expected a refusal");
		expect(plan.message).toContain("(its otherwise)");
		expect(plan.message).toContain("set_form_otherwise");
		expect(plan.message).not.toContain("update_form_link");
		expect(plan.userMessage).toBe(
			'"Follow up" can\'t be removed yet: "Archive" sends people to it after submit. Point that link somewhere else, or remove it, then try again.',
		);
	});

	it("does not count a link that starts its own form again, and a removal it admits commits", () => {
		const doc = withOtherwise();
		expect(
			formLinkDependentsOnRemove(doc, { kind: "form", formUuid: ARCHIVE }),
		).toEqual([
			// Visit's link into Archive; Archive's own links leave with it.
			{
				formUuid: VISIT,
				formName: "Visit",
				moduleName: "Care",
				linkUuid: testUuid("lnk-visit-archive"),
				role: "destination",
			},
		]);
		const repaired = produce(doc, (draft) => {
			delete draft.forms[VISIT].formLinks;
		});
		assertAdmittedDoc(repaired);
		expect(
			planFormLinkDependentsOnRemove(repaired, {
				kind: "form",
				formUuid: ARCHIVE,
			}),
		).toEqual({ kind: "none" });
		expect(
			mutationCommitVerdict(
				repaired,
				[{ kind: "removeForm", uuid: ARCHIVE }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
	});

	it("names both repairs when a destination and an otherwise link point in", () => {
		const plan = planFormLinkDependentsOnRemove(withOtherwise(), {
			kind: "module",
			moduleUuid: INTAKE,
		});
		if (plan.kind !== "blocked") throw new Error("expected a refusal");
		expect(plan.message).toContain(
			"For a destination, point it somewhere else with update_form_link, or remove it with remove_form_link; for an otherwise link, point it somewhere else with set_form_otherwise, or clear it with set_form_otherwise null, then remove the module.",
		);
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
