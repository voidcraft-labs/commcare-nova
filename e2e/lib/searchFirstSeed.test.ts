import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	menuFormUuidsOf,
	moduleOpensOnSearch,
} from "@/lib/domain";
import {
	buildSearchFirstBlueprint,
	SEARCH_FIRST_SEED,
	searchFirstRoutes,
} from "./searchFirstSeed";

const APP_ID = "493ac633-4fcd-4be0-8403-8fa08f6415af";

describe("search-first smoke seed", () => {
	it("is a valid search-first module whose registration form is off the menu", () => {
		const doc = buildSearchFirstBlueprint(APP_ID);
		const persistable = toPersistableDoc(doc);
		expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);

		const module = doc.modules[SEARCH_FIRST_SEED.moduleUuid];
		if (module === undefined) throw new Error("module missing");
		expect(moduleOpensOnSearch(module)).toBe(true);
		// Only Visit is on the menu; the registration form opens from Results.
		expect(menuFormUuidsOf(doc, SEARCH_FIRST_SEED.moduleUuid)).toEqual([
			SEARCH_FIRST_SEED.visit.formUuid,
		]);
		expect(doc.forms[SEARCH_FIRST_SEED.register.formUuid]?.entry).toEqual({
			kind: "search-no-matches",
			label: SEARCH_FIRST_SEED.register.actionLabel,
		});
	});

	it("builds the same document twice", () => {
		expect(buildSearchFirstBlueprint(APP_ID)).toEqual(
			buildSearchFirstBlueprint(APP_ID),
		);
	});

	it("routes to the Search canvas, Results, and the registration form", () => {
		const routes = searchFirstRoutes(APP_ID);
		expect(routes.searchConfig).toBe(
			`/build/${APP_ID}/${SEARCH_FIRST_SEED.moduleUuid}/search`,
		);
		expect(routes.results).toBe(
			`/build/${APP_ID}/${SEARCH_FIRST_SEED.moduleUuid}/results`,
		);
		expect(routes.registerForm).toBe(
			`/build/${APP_ID}/${SEARCH_FIRST_SEED.register.formUuid}`,
		);
	});
});
