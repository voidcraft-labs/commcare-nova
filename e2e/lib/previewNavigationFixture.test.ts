import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	declaredPlatforms,
	isCaseFirstModule,
	moduleHasCaseListMenuItem,
	moduleIsBareCaseList,
	moduleSearchWorkflow,
} from "@/lib/domain";
import {
	buildNavigationDoc,
	NAVIGATION_MODULE_UUID,
	type NavigationFixture,
} from "./previewNavigationFixture";

describe("Preview navigation fixtures", () => {
	it.each([
		["search-first", false],
		["case-list-entry", false],
		["case-list-entry", true],
	] as const)(
		"%s (details %s) is an admitted app on both platforms",
		(fixture: NavigationFixture, details) => {
			const doc = buildNavigationDoc(fixture, details);
			const persistable = toPersistableDoc(doc);
			expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			expect(declaredPlatforms(doc)).toEqual(["web-apps", "android"]);
		},
	);

	it("searches first in a case-first menu", () => {
		const doc = buildNavigationDoc("search-first", false);
		const module = doc.modules[NAVIGATION_MODULE_UUID];
		if (module === undefined) throw new Error("module missing");
		expect(moduleSearchWorkflow(module)).toBe("searchFirst");
		const forms = (doc.formOrder[NAVIGATION_MODULE_UUID] ?? []).map(
			(uuid) => doc.forms[uuid],
		);
		expect(
			isCaseFirstModule(
				forms.flatMap((form) => (form === undefined ? [] : [form.type])),
				true,
			),
		).toBe(true);
	});

	it("lists the case list beside forms in a forms-first menu", () => {
		const doc = buildNavigationDoc("case-list-entry", false);
		const module = doc.modules[NAVIGATION_MODULE_UUID];
		if (module === undefined) throw new Error("module missing");
		expect(moduleHasCaseListMenuItem(module)).toBe(true);
		expect(moduleIsBareCaseList(doc, NAVIGATION_MODULE_UUID)).toBe(false);
		expect(moduleSearchWorkflow(module)).toBeUndefined();
	});
});
