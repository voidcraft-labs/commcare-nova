/** What hides a link's target, as the link editor's line reads it. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { FormLink } from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression/builders";
import { formLinkTargetVisibility } from "../useFormLinkFacts";

const targets = testUuid("visibility-targets");
const target = testUuid("visibility-target-form");
const source = testUuid("visibility-source-form");
const supervisor = eq(sessionUser("role"), literal("supervisor"));

function doc() {
	return buildDoc({
		modules: [
			{
				uuid: "visibility-targets",
				name: "Targets",
				forms: [
					{
						uuid: "visibility-target-form",
						name: "Target",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: "Notes" }],
					},
					{
						uuid: "visibility-source-form",
						name: "Source",
						type: "survey",
						fields: [{ kind: "text", id: "remarks", label: "Remarks" }],
					},
				],
			},
		],
	});
}
const toForm: FormLink = {
	uuid: testUuid("visibility-link"),
	target: { type: "form", moduleUuid: targets, formUuid: target },
};
const toModule: FormLink = {
	uuid: testUuid("visibility-link"),
	target: { type: "module", moduleUuid: targets },
};

describe("formLinkTargetVisibility", () => {
	it("reads nothing hiding a plain target", () => {
		expect(formLinkTargetVisibility(doc(), source, toForm)).toEqual({
			targetKind: "form",
			hiddenBy: undefined,
		});
		expect(formLinkTargetVisibility(doc(), source, toModule)).toEqual({
			targetKind: "module",
			hiddenBy: undefined,
		});
	});

	it("reads a display condition on the target form or the target module", () => {
		const conditioned = doc();
		conditioned.forms[target].displayCondition = supervisor;
		conditioned.modules[targets].displayCondition = supervisor;
		expect(
			formLinkTargetVisibility(conditioned, source, toForm)?.hiddenBy,
		).toBe("condition");
		expect(
			formLinkTargetVisibility(conditioned, source, toModule)?.hiddenBy,
		).toBe("condition");
	});

	it("reads off the menu over a condition, for a form inside a module off the menu too", () => {
		const hidden = doc();
		hidden.forms[target].displayCondition = supervisor;
		hidden.modules[targets].hiddenFromMenu = true;
		expect(formLinkTargetVisibility(hidden, source, toForm)?.hiddenBy).toBe(
			"off-the-menu",
		);
		expect(formLinkTargetVisibility(hidden, source, toModule)?.hiddenBy).toBe(
			"off-the-menu",
		);
	});

	it("reads the source form itself for Start this form again", () => {
		const conditioned = doc();
		conditioned.forms[source].displayCondition = supervisor;
		const again: FormLink = { ...toForm, target: { type: "this-form" } };
		expect(formLinkTargetVisibility(conditioned, source, again)).toEqual({
			targetKind: "form",
			hiddenBy: "condition",
		});
		expect(
			formLinkTargetVisibility(conditioned, target, again)?.hiddenBy,
		).toBeUndefined();
	});

	it("reads nothing for a target that is gone", () => {
		expect(
			formLinkTargetVisibility(doc(), source, {
				...toModule,
				target: { type: "module", moduleUuid: testUuid("gone") },
			}),
		).toBeUndefined();
	});
});
