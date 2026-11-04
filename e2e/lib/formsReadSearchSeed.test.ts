import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	declaredPlatforms,
	menuFormUuidsOf,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
} from "@/lib/domain";
import {
	buildFormsReadSearchBlueprint,
	FORMS_READ_SEARCH_SEED,
	formsReadSearchRoutes,
} from "./formsReadSearchSeed";

const APP_ID = "493ac633-4fcd-4be0-8403-8fa08f6415af";

describe("forms-read-search smoke seed", () => {
	it("is a search-first menu whose forms read the search and whose registration form is off the menu", () => {
		const doc = buildFormsReadSearchBlueprint(APP_ID);
		const persistable = toPersistableDoc(doc);
		expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(declaredPlatforms(doc)).toEqual(["web-apps"]);

		const module = doc.modules[FORMS_READ_SEARCH_SEED.moduleUuid];
		if (module === undefined) throw new Error("module missing");
		expect(moduleSearchWorkflow(module)).toBe("searchFirst");
		expect(moduleFormsReadSearch(module)).toBe(true);
		// Only Visit is on the menu; the registration form opens from Results.
		expect(menuFormUuidsOf(doc, FORMS_READ_SEARCH_SEED.moduleUuid)).toEqual([
			FORMS_READ_SEARCH_SEED.visit.formUuid,
		]);
		expect(module.caseListRegistrationForm).toEqual({
			kind: "after-empty-search",
			formUuid: FORMS_READ_SEARCH_SEED.register.formUuid,
			label: FORMS_READ_SEARCH_SEED.register.actionLabel,
		});
	});

	it("builds the same document twice", () => {
		expect(buildFormsReadSearchBlueprint(APP_ID)).toEqual(
			buildFormsReadSearchBlueprint(APP_ID),
		);
	});

	it("routes to the Search canvas, Results, and the registration form", () => {
		const routes = formsReadSearchRoutes(APP_ID);
		expect(routes.searchConfig).toBe(
			`/build/${APP_ID}/${FORMS_READ_SEARCH_SEED.moduleUuid}/search`,
		);
		expect(routes.results).toBe(
			`/build/${APP_ID}/${FORMS_READ_SEARCH_SEED.moduleUuid}/results`,
		);
		expect(routes.registerForm).toBe(
			`/build/${APP_ID}/${FORMS_READ_SEARCH_SEED.register.formUuid}`,
		);
	});
});
