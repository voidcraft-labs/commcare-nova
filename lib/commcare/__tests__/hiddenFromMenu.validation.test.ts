/**
 * `HIDDEN_MENU_NOT_A_DESTINATION`: a module that is off the menu is no
 * screen to send a worker to, so a link to it, its entry point and its case
 * list entry point are refused, each beside the admitted neighbour that
 * reaches a form inside it or a module on the menu. What each runtime does
 * with these shapes is the proof lane's; these prove Nova's own gate.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import { buildDoc, caseListConfig } from "../../__tests__/docHelpers";
import { runValidation } from "../validator/runner";

const start = testUuid("hidden-start");
const go = testUuid("hidden-go");
const targets = testUuid("hidden-targets");
const inside = testUuid("hidden-inside");

/** "Start" links from its follow-up "Go", which hands its case on;
 * "Targets" is the module the arms point at. */
function base(): BlueprintDoc {
	return buildDoc({
		appName: "Hidden menus",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: start,
				name: "Start",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: go,
						name: "Go",
						type: "followup",
						fields: [{ kind: "text", id: "answer", label: "Answer" }],
					},
				],
			},
			{
				uuid: targets,
				name: "Targets",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: inside,
						name: "Inside",
						type: "followup",
						fields: [{ kind: "text", id: "note", label: "Note" }],
					},
				],
			},
		],
	});
}

function variant(change: (doc: BlueprintDoc) => void): BlueprintDoc {
	const doc = structuredClone(base());
	change(doc);
	return doc;
}

function refusals(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		({ code }) => code === "HIDDEN_MENU_NOT_A_DESTINATION",
	);
}

const hide = (doc: BlueprintDoc) => {
	doc.modules[targets].hiddenFromMenu = true;
};
const linkTo = (target: "module" | "form") => (doc: BlueprintDoc) => {
	doc.forms[go].formLinks = [
		{
			uuid: testUuid("hidden-link"),
			target:
				target === "module"
					? { type: "module", moduleUuid: targets }
					: { type: "form", moduleUuid: targets, formUuid: inside },
		},
	];
};

describe("HIDDEN_MENU_NOT_A_DESTINATION", () => {
	it("refuses a link to a module off the menu, located at the link", () => {
		const [refused, ...rest] = refusals(
			variant((doc) => {
				hide(doc);
				linkTo("module")(doc);
			}),
		);
		expect(rest).toEqual([]);
		expect(refused.location).toMatchObject({ formUuid: go, moduleUuid: start });
		expect(refused.details).toMatchObject({
			arm: "link",
			targetModuleUuid: targets,
		});
		const sentence =
			'"Targets" is off the menu, so the link from "Go" would open a menu with nothing in it on Android and the app\'s first screen in Web Apps. Point it at a form inside the module, or show the module on the menu again.';
		expect(refused.message).toBe(sentence);
		expect(userFacingError(refused)).toBe(sentence);
	});

	it("admits a link to a form inside that module, and to the module on the menu", () => {
		assertAdmittedDoc(
			variant((doc) => {
				hide(doc);
				linkTo("form")(doc);
			}),
		);
		assertAdmittedDoc(variant(linkTo("module")));
	});

	it("refuses the module's own entry point and its case list entry point, located at the module", () => {
		const found = refusals(
			variant((doc) => {
				hide(doc);
				doc.modules[targets].entryPoint = {
					uuid: testUuid("hidden-ep-module"),
					id: "targets",
				};
				doc.modules[targets].caseListEntryPoint = {
					uuid: testUuid("hidden-ep-list"),
					id: "targets-list",
				};
			}),
		);
		expect(found.map((finding) => finding.details?.arm)).toEqual([
			"entry-point",
			"case-list-entry-point",
		]);
		for (const finding of found) {
			expect(finding.location).toEqual({
				moduleUuid: targets,
				moduleName: "Targets",
			});
		}
		expect(userFacingError(found[1])).toBe(
			'"Targets" is off the menu, so its case list entry point would open a menu with nothing in it on Android and the app\'s first screen in Web Apps. Point it at a form inside the module, or show the module on the menu again.',
		);
	});

	it("admits a form's entry point inside that module, and the module's entry points on the menu", () => {
		assertAdmittedDoc(
			variant((doc) => {
				hide(doc);
				doc.forms[inside].entryPoint = {
					uuid: testUuid("hidden-ep-form"),
					id: "inside",
				};
			}),
		);
		assertAdmittedDoc(
			variant((doc) => {
				doc.modules[targets].entryPoint = {
					uuid: testUuid("hidden-ep-module"),
					id: "targets",
				};
				doc.modules[targets].caseListEntryPoint = {
					uuid: testUuid("hidden-ep-list"),
					id: "targets-list",
				};
			}),
		);
	});
});
