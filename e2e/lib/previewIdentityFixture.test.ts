import { expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, declaredPlatforms } from "@/lib/domain";
import { buildIdentityDoc } from "./previewIdentityFixture";

it("the Preview identity peer's document is an admitted app on both platforms", () => {
	const doc = buildIdentityDoc();
	const persistable = toPersistableDoc(doc);
	expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(declaredPlatforms(doc)).toEqual(["web-apps", "android"]);
});
