import * as fc from "fast-check";
import { expect, it } from "vitest";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { advancedDocArbitrary } from "./advancedDocArbitrary";
import { assertGenerated, checkCompilerEvidence } from "./compilerEvidence";
import {
	countMenuScreens,
	emptyMenuScreensCensus,
	menuScreenDocArbitrary,
} from "./menuScreenDocArbitrary";
import {
	countNames,
	emptyNamesCensus,
	expectNamesCensus,
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
	const census = emptyNamesCensus();
	assertGenerated(
		fc.property(namesDocArbitrary, (doc) => {
			checkCompilerEvidence(doc);
			countNames(census, doc);
		}),
		{ seed: 20261113, numRuns: 80 },
	);
	expectNamesCensus(census, 80);
});

// The menu-screens corpus: menus that show their forms in the menu above,
// top-level and nested, with links, entry points and a case list that always
// offers a registration form into them. Every oracle checks the HQ import,
// the local suite's shared menu ids, conjoined conditions, Register actions
// and return frames, and every binding; the census fails by name if the generator
// stops drawing a shape.
it("compiles menu-screens samples whose menus show their forms in the menu above", {
	timeout: 60_000,
}, () => {
	const census = emptyMenuScreensCensus();
	assertGenerated(
		fc.property(menuScreenDocArbitrary, (doc) => {
			checkCompilerEvidence(doc);
			countMenuScreens(census, doc);
		}),
		{ seed: 20261115, numRuns: 200 },
	);
	expect(census.total).toBe(200);
	expect(census.above / census.total).toBeGreaterThan(0.6);
	expect(census.topLevelAbove / census.total).toBeGreaterThan(0.4);
	expect(census.submenuAboveInParentWithScreen / census.total).toBeGreaterThan(
		0.05,
	);
	expect(census.submenuUnderParentAbove / census.total).toBeGreaterThan(0.05);
	expect(census.link / census.total).toBeGreaterThan(0.1);
	expect(census.entryPoint / census.total).toBeGreaterThan(0.1);
	expect(census.register / census.total).toBeGreaterThan(0.2);
	expect(census.registerUnderParent / census.total).toBeGreaterThan(0.05);
	expect(census.registerNewCase / census.total).toBeGreaterThan(0.1);
});
