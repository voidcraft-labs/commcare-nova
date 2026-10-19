/**
 * Which reads Core answers, and which it refuses, over each external
 * instance a form or the Search screen reads, with and without data.
 *
 * Core checks an absolute path before it reads it
 * (`XPathPathExpr.evalRaw` → `DataInstance.hasTemplatePath`): each step must
 * reach a template child or, failing that, some concrete child, predicates
 * ignored. A path that reaches nothing is an invalid nodeset: `count()` reads
 * it as 0 (`XPathNodeset.size`), and every value read (`unpack`,
 * `toArgList`, so a scalar read and `join`) throws "Logic references … which
 * is not a valid question or value". `if()` evaluates only its chosen branch,
 * so a count guard keeps the read from running.
 *
 * - A lookup table (`FixtureXmlParser`, a plain `TreeElement`), a worker's
 *   places when they have none (HQ's empty indexed `<locations/>` registers
 *   no index paths, `IndexedFixtureXmlParser.processRoot`, so the device
 *   reads the flat copy), the selected cases
 *   (`VirtualInstances.buildSelectedValuesInstance`) and the search answers
 *   (`buildSearchInputInstance`, answered prompts only) have no templates:
 *   their paths exist only where their data does.
 * - `casedb` (`CaseDataInstance`, by its id) and `results:inline` (its
 *   `template="case"` source) are checked against Core's static
 *   `casedb_instance_structure.xml` instead, whatever the data holds.
 *
 * Every expectation below is Core's own answer at the pinned commit, from a
 * probe that parsed each shape through those classes (restore XML into
 * `MockUserDataSandbox`, a Formplayer-shaped fixture initializer, the real
 * virtual-instance builders) and printed each read's value or refusal.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { OrganizationLevel } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { LookupFixtureRow } from "@/lib/lookup/types";
import type { LocationFixtureRow } from "@/lib/organization/footprint";
import { evaluate } from "../../xpath/evaluator";
import {
	type XPathInstance,
	XPathInvalidPathError,
} from "../../xpath/runtimeValues";
import { previewLookupData } from "../lookupEvaluation";
import {
	caseDatabaseXPathInstance,
	locationsXPathInstance,
	lookupXPathInstances,
	SEARCH_INPUT_INSTANCE_ID,
	searchInputXPathInstance,
	searchResultsXPathInstance,
	selectedCasesXPathInstance,
} from "../xpathInstances";

const REFUSED = "refused";

/** Core's answer as the probe printed it: the value, or that it refused. */
function read(id: string, instance: XPathInstance, expression: string) {
	try {
		return evaluate(expression, {
			contextPath: "/data",
			position: undefined,
			getValue: () => undefined,
			mainInstance: instance,
			resolveXPathInstance: (requested: string) =>
				requested === id ? instance : undefined,
		});
	} catch (error) {
		/* Core's refusal names the instance the path missed: always this one. */
		if (error instanceof XPathInvalidPathError && error.missedIn === id)
			return REFUSED;
		throw error;
	}
}

function expectReads(
	id: string,
	instance: XPathInstance,
	expected: Readonly<Record<string, unknown>>,
) {
	const actual = Object.fromEntries(
		Object.keys(expected).map((expression) => [
			expression,
			read(id, instance, expression),
		]),
	);
	expect(actual).toEqual(expected);
}

/** The probe's seven shapes over one repeated element. */
function shapes(
	base: string,
	child: string,
	predicate: string,
	leaf: string,
	verdict: { readonly read: unknown; readonly join: unknown },
): Record<string, unknown> {
	const path = `${base}/${child}`;
	return {
		[`count(${path})`]: 0,
		[`count(${path}) > 0`]: false,
		[`${path}[${predicate}]/${leaf}`]: verdict.read,
		[`${path}/${leaf}`]: verdict.read,
		[`join(' ', ${path}/${leaf})`]: verdict.join,
		[`if(count(${path}) > 0, ${path}[${predicate}]/${leaf}, '')`]: "",
		[`if(count(${path}[${predicate}]) > 0, ${path}[${predicate}]/${leaf}, '')`]:
			"",
	};
}

const refusedReads = { read: REFUSED, join: REFUSED };
const blankReads = { read: "", join: "" };

describe("a worker's places", () => {
	const district: OrganizationLevel = {
		uuid: testUuid("parity-level-district"),
		code: "district",
		name: "District",
		caseFlow: { workers: "none", ownsCases: true },
		addressBook: { reach: "own-branch" },
	};
	const code = {
		uuid: testUuid("parity-property-code"),
		slug: "district_code",
		label: "Code",
	};
	const organization = {
		organizationLevels: { [district.uuid]: district },
		organizationLevelOrder: [district.uuid],
		locationProperties: { [code.uuid]: code },
		locationPropertyOrder: [code.uuid],
	};
	const place = (id: string, name: string): LocationFixtureRow => ({
		id,
		siteCode: id,
		name,
		levelUuid: district.uuid,
		externalId: null,
		latitude: null,
		longitude: null,
		values: { [code.uuid]: name.slice(0, 1) },
		lineage: {},
	});
	const base = "instance('locations')/locations";

	it("refuses every read below the list when the worker has none", () => {
		const instance = locationsXPathInstance([], organization);
		expectReads("locations", instance, {
			...shapes(base, "location", "@id = 'x'", "name", refusedReads),
			[`${base}/location[@id = 'x']/location_data/district_code`]: REFUSED,
			[`${base}/location/@id`]: REFUSED,
			[`${base}/nope`]: REFUSED,
		});
	});

	it("reads a place that is not there as blank once the worker has one", () => {
		const instance = locationsXPathInstance(
			[place("d1", "North"), place("d2", "South")],
			organization,
		);
		expectReads("locations", instance, {
			[`${base}/location[@id = 'x']/name`]: "",
			[`${base}/location[@id = 'x']/location_data/district_code`]: "",
			[`${base}/location[@id = 'd1']/name`]: "North",
			[`${base}/location[@id = 'd1']/location_data/district_code`]: "N",
			[`count(${base}/location)`]: 2,
			[`${base}/nope`]: REFUSED,
		});
	});
});

describe("a lookup table", () => {
	const tableId = lookupTableIdSchema.parse(
		"11111111-1111-7111-8111-111111111111",
	);
	const codeId = lookupColumnIdSchema.parse(
		"22222222-2222-7222-8222-222222222222",
	);
	const labelId = lookupColumnIdSchema.parse(
		"33333333-3333-7333-8333-333333333333",
	);
	const table = (rows: readonly LookupFixtureRow[]) =>
		lookupXPathInstances(
			previewLookupData({
				projectRevision: "1",
				definitions: [
					{
						id: tableId,
						name: "T",
						tag: "t",
						definitionRevision: parseLookupRevision("1"),
						columns: [
							{ id: codeId, wireName: "code", label: "Code", dataType: "text" },
							{
								id: labelId,
								wireName: "label",
								label: "Label",
								dataType: "text",
							},
						],
					},
				],
				rowsByTable: new Map([[tableId, rows]]),
			}),
			{ includeFixtureAliases: true },
		).get("item-list:t") as XPathInstance;
	const base = "instance('item-list:t')/t_list";

	it("refuses every read below the list when it has no rows", () => {
		expectReads(
			"item-list:t",
			table([]),
			shapes(base, "t", "code = 'x'", "label", refusedReads),
		);
	});

	it("reads its columns once it has a row", () => {
		const instance = table([
			{
				id: lookupRowIdSchema.parse("44444444-4444-7444-8444-444444444444"),
				values: { [codeId]: "a", [labelId]: "A" },
			},
		]);
		expectReads("item-list:t", instance, {
			[`${base}/t[code = 'x']/label`]: "",
			[`${base}/t[code = 'a']/label`]: "A",
			[`join(' ', ${base}/t/label)`]: "A",
			[`${base}/t/nope`]: REFUSED,
			[`${base}/nope`]: REFUSED,
		});
	});
});

describe("the case database", () => {
	it("answers every read the casedb spec names, with no cases at all", () => {
		const base = "instance('casedb')/casedb";
		expectReads(
			"casedb",
			caseDatabaseXPathInstance({ rows: [], indices: [] }),
			{
				...shapes(base, "case", "@case_id = 'x'", "anyprop", blankReads),
				[`${base}/case[@case_id = 'x']/index/parent`]: "",
				[`${base}/case/index/parent/@case_type`]: "",
				[`${base}/case/index/parent/@nope`]: REFUSED,
				[`${base}/case/@nope`]: REFUSED,
				[`${base}/case/case_name/x`]: REFUSED,
				[`${base}/nope`]: REFUSED,
			},
		);
	});
});

describe("the inline search's results", () => {
	it("answers every read the casedb spec names, with no case found", () => {
		const base = "instance('results:inline')/results";
		expectReads("results:inline", searchResultsXPathInstance([], []), {
			...shapes(base, "case", "@case_id = 'x'", "anyprop", blankReads),
			[`${base}/case/index/parent/@case_type`]: "",
			[`${base}/case/@nope`]: REFUSED,
			// The spec names no attribute on the list itself.
			[`${base}/@id`]: REFUSED,
			[`${base}/nope`]: REFUSED,
		});
	});
});

describe("the selected cases", () => {
	const base = "instance('selected_cases')/results";

	it("refuses a value read when nothing is selected", () => {
		expectReads(
			"selected_cases",
			selectedCasesXPathInstance("selected_cases", []),
			{
				[`count(${base}/value)`]: 0,
				[`${base}/value`]: REFUSED,
				[`${base}/value[1]`]: REFUSED,
				[`join(' ', ${base}/value)`]: REFUSED,
				[`if(count(${base}/value) > 0, ${base}/value[1], '')`]: "",
			},
		);
	});

	it("reads the selection in order", () => {
		expectReads(
			"selected_cases",
			selectedCasesXPathInstance("selected_cases", ["c1", "c2"]),
			{
				[`count(${base}/value)`]: 2,
				[`${base}/value[1]`]: "c1",
				[`join(' ', ${base}/value)`]: "c1 c2",
				[`${base}/nope`]: REFUSED,
			},
		);
	});
});

describe("the search answers", () => {
	const base = `instance('${SEARCH_INPUT_INSTANCE_ID}')/input`;
	const answers = (entries: readonly (readonly [string, string])[]) =>
		searchInputXPathInstance(new Map(entries), SEARCH_INPUT_INSTANCE_ID);

	it("refuses every read below the list when no prompt was answered", () => {
		expectReads(
			SEARCH_INPUT_INSTANCE_ID,
			answers([]),
			shapes(base, "field", "@name = 'x'", ".", refusedReads),
		);
	});

	it("reads an unanswered prompt as blank beside an answered one", () => {
		expectReads(SEARCH_INPUT_INSTANCE_ID, answers([["y", "v"]]), {
			[`${base}/field[@name = 'x']`]: "",
			[`${base}/field[@name = 'y']`]: "v",
			[`count(${base}/field[@name = 'x'])`]: 0,
		});
	});

	it("holds no node for a blank answer, as neither device sends one", () => {
		expectReads(
			SEARCH_INPUT_INSTANCE_ID,
			answers([
				["x", ""],
				["y", "v"],
			]),
			{
				[`count(${base}/field[@name = 'x'])`]: 0,
				[`count(${base}/field)`]: 1,
				[`${base}/field[@name = 'x']`]: "",
			},
		);
	});
});
