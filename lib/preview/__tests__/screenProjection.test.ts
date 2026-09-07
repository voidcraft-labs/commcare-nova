import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { NavigationItemVisibility } from "@/lib/preview/engine/displayConditionEvaluation";
import type { Location } from "@/lib/routing/types";
import { admittedControllerDoc } from "../engine/__tests__/fixtures/controllerDoc";
import { inheritedModuleVisibility } from "../menuProjection";
import { locationToPreviewScreen } from "../screenProjection";

const parent = testUuid("screen-parent");
const child = testUuid("screen-child");
const parentForm = testUuid("screen-parent-form");
const childForm = testUuid("screen-child-form");
const source = buildDoc({
	caseTypes: [
		{ name: "household", properties: [] },
		{ name: "person", parent_type: "household", properties: [] },
	],
	modules: (
		[
			[parent, parentForm, "household"],
			[child, childForm, "person"],
		] as const
	).map(([uuid, formUuid, caseType]) => ({
		uuid,
		name: caseType,
		caseType,
		caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		forms: [
			{
				uuid: formUuid,
				name: "Visit",
				type: "followup",
				fields: [f({ kind: "text", id: "note" })],
			},
		],
	})),
});
source.modules[child].parentModuleUuid = parent;
const doc = admittedControllerDoc(source);
function project(
	location: Location,
	parentState: NavigationItemVisibility = "shown",
	childState: NavigationItemVisibility = "shown",
	requiresParent = false,
) {
	const visibility = inheritedModuleVisibility(
		doc,
		new Map([
			[parent, parentState],
			[child, childState],
		]),
	);
	return locationToPreviewScreen(
		location,
		doc.moduleOrder,
		doc.modules,
		doc.formOrder,
		visibility,
		requiresParent ? child : undefined,
	);
}

describe("Running screen route admission", () => {
	it("accepts a form only under its own admitted module and refuses unknown module identity", () => {
		expect(
			project({ kind: "form", moduleUuid: child, formUuid: childForm }),
		).toEqual({ type: "form", moduleUuid: child, formUuid: childForm });
		expect(
			project({ kind: "form", moduleUuid: child, formUuid: parentForm }),
		).toEqual({ type: "module", moduleUuid: child });
		expect(
			project({ kind: "module", moduleUuid: testUuid("unknown-module") }),
		).toEqual({ type: "home" });
	});
	it("direct child module, case and form routes cannot bypass a hidden or pending structural ancestor", () => {
		const routes: Location[] = [
			{ kind: "module", moduleUuid: child },
			{ kind: "cases", moduleUuid: child },
			{ kind: "form", moduleUuid: child, formUuid: childForm },
		];
		for (const route of routes) {
			expect(project(route)).not.toEqual({ type: "home" });
			expect(project(route, "hidden")).toEqual({ type: "home" });
			expect(project(route, "pending")).toEqual({ type: "home" });
			expect(project(route, "shown", "hidden")).toEqual({
				type: "module",
				moduleUuid: parent,
			});
		}
	});
	it("direct child cases and forms enter their module until required parent selection is available", () => {
		const cases: Location = { kind: "cases", moduleUuid: child };
		const form: Location = {
			kind: "form",
			moduleUuid: child,
			formUuid: childForm,
		};
		expect(project(cases, "shown", "shown", true)).toEqual({
			type: "module",
			moduleUuid: child,
		});
		expect(project(form, "shown", "shown", true)).toEqual({
			type: "module",
			moduleUuid: child,
		});
		expect(project(cases)).toEqual({ type: "caseList", moduleUuid: child });
		expect(project(form)).toEqual({
			type: "form",
			moduleUuid: child,
			formUuid: childForm,
		});
	});
	it("condition Preview names the menu where the root or child is offered", () => {
		expect(project({ kind: "module-condition", moduleUuid: parent })).toEqual({
			type: "home",
		});
		expect(project({ kind: "module-condition", moduleUuid: child })).toEqual({
			type: "module",
			moduleUuid: parent,
		});
		expect(project({ kind: "module", moduleUuid: child })).toEqual({
			type: "module",
			moduleUuid: child,
		});
	});
});
