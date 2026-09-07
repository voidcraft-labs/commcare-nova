import * as fc from "fast-check";
import { expect, it } from "vitest";
import { assertGenerated, checkCompilerEvidence } from "./compilerEvidence";
import {
	hasCaseSearch,
	hasChildCase,
	hasMedia,
	hasSort,
	hasSuiteMedia,
	moduleCount,
	suiteDocArbitrary,
} from "./suiteDocArbitrary";

it("compiles 400 workflow samples with valid schema, HQ import, bindings, and archived resources", {
	// The complete synchronous corpus took 45s on a shared CI runner before
	// native media-byte comparison. Keep all 400 samples and scheduling margin.
	timeout: 60_000,
}, () => {
	const census = {
		total: 0,
		multiModule: 0,
		nestedMenu: 0,
		caseSearch: 0,
		childCase: 0,
		sort: 0,
		activeCaseAction: 0,
		media: 0,
		suiteMedia: 0,
	};
	assertGenerated(
		fc.property(suiteDocArbitrary, (doc) => {
			const [root, child] = doc.moduleOrder;
			if (root !== undefined && child !== undefined) {
				doc.modules[child].parentModuleUuid = root;
				census.nestedMenu++;
			}
			checkCompilerEvidence(doc);
			census.total++;
			if (moduleCount(doc) > 1) census.multiModule++;
			if (hasCaseSearch(doc)) census.caseSearch++;
			if (hasChildCase(doc)) census.childCase++;
			if (hasSort(doc)) census.sort++;
			if (Object.values(doc.forms).some((f) => f.type !== "survey"))
				census.activeCaseAction++;
			if (hasMedia(doc)) census.media++;
			if (hasSuiteMedia(doc)) census.suiteMedia++;
		}),
		{ seed: 20260522, numRuns: 400 },
	);
	expect(census.total).toBe(400);
	expect(census.multiModule / census.total).toBeGreaterThan(0.25);
	expect(census.nestedMenu / census.total).toBeGreaterThan(0.25);
	expect(census.caseSearch / census.total).toBeGreaterThan(0.25);
	expect(census.childCase / census.total).toBeGreaterThan(0.15);
	expect(census.sort / census.total).toBeGreaterThan(0.3);
	expect(census.activeCaseAction / census.total).toBeGreaterThan(0.6);
	expect(census.media / census.total).toBeGreaterThan(0.3);
	expect(census.suiteMedia / census.total).toBeGreaterThan(0.3);
});
