import { expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
} from "@/lib/domain";
import { declaredPlatforms } from "@/lib/domain/platforms";
import {
	buildSearchStandingBlueprint,
	SEARCH_STANDING_SEED,
} from "./searchStandingSeed";

const APP_ID = "0c8f2b6e-3d4a-4f1b-9e7c-5a6b7c8d9e0f";

it("is a valid Web Apps app whose Patients list opens on Results first, its forms reading the search, beside a Search action that opens on Results first and a plain list under one menu", () => {
	const doc = buildSearchStandingBlueprint(APP_ID);
	const persistable = toPersistableDoc(doc);
	expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(declaredPlatforms(doc)).toEqual(["web-apps"]);
	const { clinic, searching, finding, browsing } = SEARCH_STANDING_SEED;
	const module = doc.modules[searching.moduleUuid];
	if (module === undefined) throw new Error("module missing");
	expect(moduleSearchWorkflow(module)).toBe("skipToResults");
	expect(moduleFormsReadSearch(module)).toBe(true);
	const plain = doc.modules[browsing.moduleUuid];
	if (plain === undefined) throw new Error("module missing");
	expect(moduleSearchWorkflow(plain)).toBeUndefined();
	expect(module.parentModuleUuid).toBe(clinic.moduleUuid);
	expect(plain.parentModuleUuid).toBe(clinic.moduleUuid);
	const action = doc.modules[finding.moduleUuid];
	if (action === undefined) throw new Error("module missing");
	expect(moduleSearchWorkflow(action)).toBe("skipToResults");
	expect(moduleFormsReadSearch(action)).toBe(false);
	expect(action.parentModuleUuid).toBe(clinic.moduleUuid);
});
