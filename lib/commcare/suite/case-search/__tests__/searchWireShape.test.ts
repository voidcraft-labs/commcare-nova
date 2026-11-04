/**
 * The search wire shape (`searchWireShape.ts`), and the platform table's
 * restatement of it.
 *
 * Contract: the three flags spell the authored workflow, one shape for every
 * platform an app declares. `auto_launch` is off only for list first,
 * `default_search` is on only for skip to results, and `inline_search` is
 * exactly Forms read the search; list first beside Forms read the search is
 * unrepresentable. The case list's filter and inputs choose nothing: a
 * search that has a filter and nothing to fill in spells its stored
 * workflow like any other. The platform table's `list-first`,
 * `search-first`, `skip-to-results` and `forms-read-search` detectors
 * restate those rows over the domain (`lib/domain/platformUses.ts`), so they
 * hold exactly where the emitted shape says, or a difference the builder
 * states and the gate refuses would drift from what the wire does.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type CaseListConfig,
	effectiveCaseSearchConfig,
	hiddenSearchInputDef,
	NEW_APP_SETTINGS,
	type OrdinaryCaseSearchConfig,
	ordinaryCaseSearchConfigSchema,
	platformFeatureUses,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, matchNone, prop, term } from "@/lib/domain/expression";
import { searchWireShape } from "../searchWireShape";

const visible = simpleSearchInputDef(
	testUuid("visible"),
	"name",
	"Name",
	"text",
	"case_name",
);
const hidden = hiddenSearchInputDef(
	testUuid("hidden"),
	"context",
	"Context",
	term(literal("North")),
);

/** Each admitted spelling of the workflow, with the flags it writes. */
const ROWS: readonly (readonly [
	string,
	OrdinaryCaseSearchConfig,
	{ autoLaunch: boolean; defaultSearch: boolean; inlineSearch: boolean },
])[] = [
	[
		"list first",
		{ workflow: "listFirst" },
		{ autoLaunch: false, defaultSearch: false, inlineSearch: false },
	],
	[
		"search first",
		{},
		{ autoLaunch: true, defaultSearch: false, inlineSearch: false },
	],
	[
		"search first, forms read the search",
		{ formsReadSearch: true },
		{ autoLaunch: true, defaultSearch: false, inlineSearch: true },
	],
	[
		"skip to results",
		{ workflow: "skipToResults" },
		{ autoLaunch: true, defaultSearch: true, inlineSearch: false },
	],
	[
		"skip to results, forms read the search",
		{ workflow: "skipToResults", formsReadSearch: true },
		{ autoLaunch: true, defaultSearch: true, inlineSearch: true },
	],
];

it.each(ROWS)("spells %s", (_name, config, flags) => {
	const before = structuredClone(config);
	expect(searchWireShape(config)).toEqual(flags);
	// The other settings of the search choose nothing.
	expect(
		searchWireShape({
			...config,
			searchScreenTitle: "Find a patient",
			excludedOwnerIds: term(literal("owner-x")),
		}),
	).toEqual(flags);
	expect(config).toEqual(before);
});

it("refuses list first beside Forms read the search", () => {
	const parsed = ordinaryCaseSearchConfigSchema.safeParse({
		workflow: "listFirst",
		formsReadSearch: true,
	});
	expect(parsed.success).toBe(false);
	expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
		["formsReadSearch"],
	]);
	for (const [, config] of ROWS)
		expect(ordinaryCaseSearchConfigSchema.safeParse(config).success).toBe(true);
});

describe("the platform table's restatement", () => {
	const FILTERS = [
		["no filter", undefined],
		["a narrowing filter", eq(prop("patient", "status"), literal("open"))],
		["a filter that holds nothing", matchNone()],
	] as const;
	const INPUTS = [[], [hidden], [visible]];

	/** Every module the matrix draws: each filter, each set of inputs, each
	 *  workflow row. List first is admitted only where Web Apps is not
	 *  declared, so every module is drawn in an app that runs on Android
	 *  alone and in one that runs in Web Apps alone where it admits it. */
	const modules = FILTERS.flatMap(([name, filter]) =>
		INPUTS.flatMap((inputs) =>
			ROWS.map(([row, search]) => {
				const list: CaseListConfig = caseListConfig([
					{ field: "case_name", header: "Name" },
				]);
				list.filter = filter;
				list.searchInputs = inputs;
				return { name: `${row}, ${name}`, list, search };
			}),
		),
	);

	it("finds each workflow exactly where the wire shape emits it", () => {
		for (const { name, list, search } of modules) {
			const doc = buildDoc({
				appName: "Search shape",
				appSettings: {
					...NEW_APP_SETTINGS,
					runsOnlyOn: search.workflow === "listFirst" ? "android" : "web-apps",
				},
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: list,
						caseSearchConfig: search,
					},
				],
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Name") },
							{ name: "status", label: proseText("Status") },
						],
					},
				],
			});
			const module = Object.values(doc.modules)[0];
			const effective =
				module === undefined ? undefined : effectiveCaseSearchConfig(module);
			if (effective === undefined)
				throw new Error("The module holds no search.");
			const shape = searchWireShape(effective);
			const found = new Set(
				platformFeatureUses(doc, {
					features: new Set([
						"list-first",
						"search-first",
						"skip-to-results",
						"forms-read-search",
					]),
				}).map((use) => use.feature),
			);
			expect([name, [...found].sort()]).toEqual([
				name,
				[
					...(!shape.autoLaunch ? ["list-first"] : []),
					...(shape.inlineSearch ? ["forms-read-search"] : []),
					...(shape.autoLaunch && !shape.defaultSearch && !shape.inlineSearch
						? ["search-first"]
						: []),
					...(shape.defaultSearch && !shape.inlineSearch
						? ["skip-to-results"]
						: []),
				].sort(),
			]);
		}
	});
});
