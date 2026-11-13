import * as fc from "fast-check";
import { expect, it } from "vitest";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { advancedDocArbitrary } from "./advancedDocArbitrary";
import { assertGenerated, checkCompilerEvidence } from "./compilerEvidence";
import {
	hasCaseNamedCase,
	hasDigitLeadingCaseType,
	hasHyphenatedFieldId,
	hasHyphenatedSearchField,
	namesDocArbitrary,
} from "./namesDocArbitrary";
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

// The advanced arm: a carried create makes its menu advanced, and the HQ
// import, the local suite's entries and every binding still check clean.
it("compiles workflow samples whose after-submit link carries a create, with an advanced menu", {
	timeout: 60_000,
}, () => {
	const census = { total: 0, advanced: 0 };
	assertGenerated(
		fc.property(advancedDocArbitrary, (doc) => {
			checkCompilerEvidence(doc);
			census.total++;
			if (
				doc.moduleOrder.some(
					(moduleUuid) => emittedModuleKind(doc, moduleUuid) === "advanced",
				)
			)
				census.advanced++;
		}),
		{ seed: 20261102, numRuns: 60 },
	);
	expect(census.total).toBe(60);
	expect(census.advanced / census.total).toBeGreaterThan(0.5);
});

// The names family: case types that start with a digit or are one of
// reference text's fixed words, and a Search field whose name holds a hyphen,
// reach the HQ import, the local suite's entries and every binding. The
// census fails by name if the generator stops drawing them.
it("compiles workflows whose case types and Search fields fill Nova's name grammars", {
	timeout: 60_000,
}, () => {
	const census = {
		total: 0,
		digitType: 0,
		typeNamedCase: 0,
		hyphenatedSearchField: 0,
		hyphenatedId: 0,
	};
	assertGenerated(
		fc.property(namesDocArbitrary, (doc) => {
			checkCompilerEvidence(doc);
			census.total++;
			if (hasDigitLeadingCaseType(doc)) census.digitType++;
			if (hasCaseNamedCase(doc)) census.typeNamedCase++;
			if (hasHyphenatedSearchField(doc)) census.hyphenatedSearchField++;
			if (hasHyphenatedFieldId(doc)) census.hyphenatedId++;
		}),
		{ seed: 20261113, numRuns: 80 },
	);
	expect(census.total).toBe(80);
	expect(census.digitType).toBeGreaterThan(0);
	expect(census.typeNamedCase).toBeGreaterThan(0);
	expect(census.hyphenatedSearchField).toBeGreaterThan(0);
	expect(census.hyphenatedId).toBeGreaterThan(0);
});
