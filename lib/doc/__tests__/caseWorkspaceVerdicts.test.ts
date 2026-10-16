import { beforeEach, describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	type CaseProperty,
	type CaseSearchConfig,
	type CaseType,
	type Column,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	orderedColumns,
	plainColumn,
	type SearchInputDef,
	simpleSearchInputDef,
	tileCell,
	type Uuid,
} from "@/lib/domain";
import { DATE_FORMAT_PRESET_DEFINITIONS } from "@/lib/domain/dateFormats";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	ancestorPath,
	dateAdd,
	double,
	eq,
	isBlank,
	literal,
	matchAll,
	now,
	type Predicate,
	prop,
	relationStep,
	sessionContext,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { columnSnapshotBatchMutations } from "../caseListColumnMutations";
import {
	caseListOrderChoiceRefusal,
	caseWorkspaceBoundaryVerdicts,
	mutationCommitVerdict,
} from "../commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";
import { offeredChoiceRefusal } from "../userFacingErrors";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE_UUID = testUuid("module-clients");
const CALCULATED_UUID = testUuid("calculated-tags");
const LOOKUP_TABLE = lookupTableIdSchema.parse(
	"00000000-0000-7000-8000-0000000000a1",
);
const LOOKUP_COLUMN = lookupColumnIdSchema.parse(
	"10000000-0000-7000-8000-0000000000a1",
);

const form = {
	name: "Register client",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			caseWrite: { caseType: "client", property: "case_name" },
		}),
	],
};

function docWith({
	filter,
	searchInputs = [],
	caseSearchConfig,
	columns = [plainColumn(testUuid("name-column"), "case_name", "Name")],
	caseTypes,
}: {
	readonly filter?: Predicate;
	readonly searchInputs?: SearchInputDef[];
	readonly caseSearchConfig?: CaseSearchConfig;
	readonly columns?: Column[];
	readonly caseTypes?: CaseType[];
} = {}) {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				uuid: MODULE_UUID,
				name: "Clients",
				caseType: "client",
				caseListConfig: {
					columns,
					searchInputs,
					...(filter === undefined ? {} : { filter }),
				},
				...(caseSearchConfig === undefined ? {} : { caseSearchConfig }),
				forms: [form],
			},
		],
		caseTypes: caseTypes ?? [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "score", label: proseText("Score"), data_type: "int" },
					{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
				],
			},
		],
	});
}

describe("caseWorkspaceBoundaryVerdicts", () => {
	// Invalid carriers below exercise status projection for imported/historical
	// documents. The unchanged app fixture itself must remain admitted.
	beforeEach(() => assertAdmittedDoc(docWith()));
	it("retains a verdict only for the identical document snapshot", () => {
		const doc = docWith();
		const first = caseWorkspaceBoundaryVerdicts(
			doc,
			MODULE_UUID,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toBe(first);
		const changed = docWith({
			caseSearchConfig: {},
			filter: eq(prop("client", "age"), prop("client", "score")),
		});
		const next = caseWorkspaceBoundaryVerdicts(
			changed,
			MODULE_UUID,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(next).not.toBe(first);
		expect(first.filterBroken).toBe(false);
		expect(next.filterBroken).toBe(true);
	});
	it("keeps valid Search-action and assigned-case settings clean", () => {
		const doc = docWith({
			caseSearchConfig: {
				searchButtonDisplayCondition: eq(
					term(sessionContext("userid")),
					literal("worker-1"),
				),
				excludedOwnerIds: term(sessionContext("userid")),
			},
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual({
			filterBroken: false,
			searchInputsBroken: false,
			searchButtonConditionBroken: false,
			excludedOwnerIdsBroken: false,
			brokenColumnUuids: [],
		});
	});

	it("attributes Search-action and row-dependent assigned-case findings to different surfaces", () => {
		const doc = docWith({
			caseSearchConfig: {
				searchButtonDisplayCondition: isBlank(prop("client", "case_name")),
				// Text-typed on purpose: this is broken because the global setting
				// has no case row, not because the result type is wrong.
				excludedOwnerIds: term(prop("client", "case_name")),
			},
		});

		const verdict = caseWorkspaceBoundaryVerdicts(
			doc,
			MODULE_UUID,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.searchButtonConditionBroken).toBe(true);
		expect(verdict.excludedOwnerIdsBroken).toBe(true);
		expect(verdict.filterBroken).toBe(false);
		expect(verdict.searchInputsBroken).toBe(false);
	});

	it("projects dialect findings for filters, advanced inputs, and calculated fields", () => {
		const doc = docWith({
			filter: eq(prop("client", "age"), prop("client", "score")),
			searchInputs: [
				advancedSearchInputDef(
					testUuid("score-input"),
					"score",
					"Score",
					"text",
					eq(prop("client", "score"), prop("client", "age")),
				),
			],
			caseSearchConfig: {},
			columns: [
				plainColumn(testUuid("name-column"), "case_name", "Name"),
				calculatedColumn(
					CALCULATED_UUID,
					"Tags",
					dateAdd(now(), "months", term(literal(1))),
				),
			],
		});

		const verdict = caseWorkspaceBoundaryVerdicts(
			doc,
			MODULE_UUID,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.filterBroken).toBe(true);
		expect(verdict.searchInputsBroken).toBe(true);
		expect(verdict.brokenColumnUuids).toContain(CALCULATED_UUID);
	});

	it("routes an unsupported Search related-case calculation to its calculated field", () => {
		const doc = docWith({
			caseSearchConfig: {},
			caseTypes: [
				{
					name: "client",
					parent_type: "household",
					properties: [
						{
							name: "case_name",
							label: proseText("Name"),
							data_type: "text",
						},
					],
				},
				{
					name: "household",
					properties: [
						{
							name: "score",
							label: proseText("Score"),
							data_type: "int",
						},
					],
				},
			],
			columns: [
				plainColumn(testUuid("name-column"), "case_name", "Name"),
				calculatedColumn(
					CALCULATED_UUID,
					"Household score",
					double(
						term(
							prop(
								"client",
								"score",
								ancestorPath(relationStep("parent", "household")),
							),
						),
					),
				),
			],
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).brokenColumnUuids,
		).toContain(CALCULATED_UUID);
	});

	it("marks a column broken for a duplicate image-map value", () => {
		const columnUuid = testUuid("flag-image-column");
		const doc = docWith({
			columns: [
				plainColumn(testUuid("name-column"), "case_name", "Name"),
				imageMapColumn(columnUuid, "case_name", "Flag", [
					imageMapEntry("open", testMediaAssetId("asset-a")),
					imageMapEntry("open", testMediaAssetId("asset-b")),
				]),
			],
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).brokenColumnUuids,
		).toContain(columnUuid);
	});

	it("does not apply the remote-query restriction to an on-device-only filter", () => {
		const doc = docWith({
			filter: eq(prop("client", "age"), prop("client", "score")),
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).filterBroken,
		).toBe(false);
	});

	it("marks a historical lookup carrier broken when definitions are unavailable", () => {
		const doc = docWith({
			searchInputs: [
				advancedSearchInputDef(
					testUuid("historical-lookup-input"),
					"lookup_query",
					"Lookup query",
					"text",
					eq(
						tableLookup(LOOKUP_TABLE, LOOKUP_COLUMN, matchAll()),
						literal("north"),
					),
				),
			],
			caseSearchConfig: {},
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).searchInputsBroken,
		).toBe(true);
	});

	it("marks Search broken for a lookup finding on a choice prompt's options", () => {
		// `search_input_options` is a registry slot the older hand-written
		// match never named; the finding carries only `registrySlot`, so a
		// literal set left the workspace clean while export refused.
		const doc = docWith({
			searchInputs: [
				simpleSearchInputDef(
					testUuid("region-input"),
					"region",
					"Region",
					"select",
					"region",
					{
						options: {
							kind: "lookup",
							tableId: LOOKUP_TABLE,
							valueColumnId: LOOKUP_COLUMN,
							labelColumnId: LOOKUP_COLUMN,
						},
					},
				),
			],
			caseSearchConfig: {},
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).searchInputsBroken,
		).toBe(true);
	});
});

// ── Default order's Add menu ──────────────────────────────────────

/** The column a choice commits: an unsorted stored column, or a new column
 *  hidden from both screens over the property, as `seedColumnForProperty`
 *  makes it. */
function newHiddenColumn(property: CaseProperty): Column {
	const slots = { visibleInList: false, visibleInDetail: false };
	return property.data_type === "date" || property.data_type === "datetime"
		? dateColumn(
				testUuid(`new-${property.name}`),
				property.name,
				property.name,
				DATE_FORMAT_PRESET_DEFINITIONS.iso.commCarePattern,
				slots,
			)
		: plainColumn(
				testUuid(`new-${property.name}`),
				property.name,
				property.name,
				slots,
			);
}

/** Every choice the Add menu draws for the module's list, built as
 *  `SortPriorityStack.tsx::orderChoices` builds them: each property no rule
 *  orders by, as its first unsorted Results column or a new hidden column,
 *  then each unsorted column over no property of the catalog. */
function addMenuChoices(doc: BlueprintDoc, moduleUuid: Uuid): Column[] {
	const mod = doc.modules[moduleUuid];
	const config = mod.caseListConfig;
	if (config === undefined) throw new Error("Missing case list");
	const properties =
		effectiveCaseTypes(doc).find((caseType) => caseType.name === mod.caseType)
			?.properties ?? [];
	const results = orderedColumns(config, "list");
	const sortedProperties = new Set(
		results.flatMap((column) =>
			column.sort !== undefined && column.kind !== "calculated"
				? [column.field]
				: [],
		),
	);
	const unsorted = results.filter((column) => column.sort === undefined);
	const choices: Column[] = [];
	for (const property of properties) {
		if (sortedProperties.has(property.name)) continue;
		choices.push(
			unsorted.find(
				(column) =>
					column.kind !== "calculated" && column.field === property.name,
			) ?? newHiddenColumn(property),
		);
	}
	const names = new Set(properties.map((property) => property.name));
	for (const column of unsorted) {
		if (column.kind !== "calculated" && names.has(column.field)) continue;
		choices.push(column);
	}
	return choices;
}

/** The choice's column with the rule Default order gives it, and the batch
 *  the composer commits for it: every rule renumbered by its place, the new
 *  rule last. */
function committedChoice(doc: BlueprintDoc, moduleUuid: Uuid, choice: Column) {
	const config = doc.modules[moduleUuid].caseListConfig;
	if (config === undefined) throw new Error("Missing case list");
	const rules = orderedColumns(config, "list")
		.map((column, index) => ({ column, index }))
		.filter(({ column }) => column.sort !== undefined)
		.sort(
			(a, b) =>
				(a.column.sort?.priority ?? 0) - (b.column.sort?.priority ?? 0) ||
				a.index - b.index,
		)
		.map(({ column }) => column.uuid);
	const column = {
		...choice,
		sort: { direction: "asc" as const, priority: rules.length },
	} as Column;
	const next = config.columns.map((stored): Column => {
		if (stored.uuid === column.uuid) return column;
		const priority = rules.indexOf(stored.uuid);
		return stored.sort === undefined || priority < 0
			? stored
			: ({ ...stored, sort: { ...stored.sort, priority } } as Column);
	});
	if (!next.some((stored) => stored.uuid === column.uuid)) next.push(column);
	return {
		column,
		mutations: columnSnapshotBatchMutations(moduleUuid, config, next),
	};
}

function orderMenuDoc(
	moduleName: string,
	columns: Column[],
	tile: boolean,
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Order menu",
		modules: [
			{
				name: moduleName,
				caseType: "household",
				caseListConfig: {
					columns,
					searchInputs: [],
					...(tile && { tile: {} }),
				},
				forms: [
					{
						name: "Register household",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "rank", label: proseText("Rank"), data_type: "text" },
					{ name: "zone", label: proseText("Zone"), data_type: "text" },
					{ name: "score", label: proseText("Score"), data_type: "int" },
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

const TILE_SCORE = testUuid("tile-score");
const ROW_SCORE_COPY = testUuid("row-score-copy");
const ROW_ZONE_COPY = testUuid("row-zone-copy");
const ROW_ZONE = testUuid("row-zone");

/** A tile list holding a placed Name column and a calculated column hidden
 *  from Results. */
function tileOrderDoc(): BlueprintDoc {
	return orderMenuDoc(
		"Households",
		[
			plainColumn(testUuid("tile-name"), "case_name", "Name", {
				tile: tileCell(0, 0, 6, 1),
			}),
			calculatedColumn(TILE_SCORE, "Score", term(prop("household", "score")), {
				visibleInList: false,
			}),
		],
		true,
	);
}

/** A row list whose first calculated column holds a rule, beside a second
 *  calculated column with the same expression and a calculated column over
 *  the property an earlier ID mapping shows. */
function rowOrderDoc(): BlueprintDoc {
	return orderMenuDoc(
		"Visits",
		[
			idMappingColumn(ROW_ZONE, "zone", "Zone", [
				idMappingEntry("2", "North"),
				idMappingEntry("10", "South"),
			]),
			calculatedColumn(
				testUuid("row-score"),
				"Score",
				term(prop("household", "score")),
				{ sort: { direction: "desc", priority: 0 } },
			),
			calculatedColumn(
				ROW_SCORE_COPY,
				"Score copy",
				term(prop("household", "score")),
			),
			calculatedColumn(
				ROW_ZONE_COPY,
				"Zone copy",
				term(prop("household", "zone")),
			),
		],
		false,
	);
}

describe("caseListOrderChoiceRefusal", () => {
	const tileCalculated =
		"\"Households\"'s tile list can't order by a calculation that isn't on the tile. You can place that column on the tile, or order by a case property.";
	const tileRecordId =
		"\"Households\"'s tile list can't order by Record ID unless Record ID is on the tile. You can show it in Results and place it on the tile.";
	const sameScore =
		'"Visits" already orders by the same value on "Score". CommCare keeps one order rule for each value, so the list needs only that one.';
	const firstZone =
		'In "Visits", CommCare gives this order rule to the first column with the same value, which is "Zone", and that column orders differently. You can put the order rule on that column, or move this column ahead of it.';

	function refusalsOf(doc: BlueprintDoc): Map<string, string | undefined> {
		const moduleUuid = doc.moduleOrder[0];
		return new Map(
			addMenuChoices(doc, moduleUuid).map((choice) => {
				const { column } = committedChoice(doc, moduleUuid, choice);
				return [
					choice.kind === "calculated" ? choice.uuid : choice.field,
					caseListOrderChoiceRefusal(doc, moduleUuid, column),
				];
			}),
		);
	}

	it("withholds Record ID and a hidden calculated column in a tile list, and offers a property it carries", () => {
		const refusals = refusalsOf(tileOrderDoc());
		expect(refusals.get("case_id")).toBe(tileRecordId);
		expect(refusals.get(TILE_SCORE)).toBe(tileCalculated);
		expect(refusals.get("rank")).toBeUndefined();
		expect(refusals.get("owner_id")).toBeUndefined();
	});

	it("withholds what another rule already orders by, and a rule an earlier column would take", () => {
		const refusals = refusalsOf(rowOrderDoc());
		expect(refusals.get(ROW_SCORE_COPY)).toBe(sameScore);
		expect(refusals.get("score")).toBe(sameScore);
		expect(refusals.get(ROW_ZONE_COPY)).toBe(firstZone);
		expect(refusals.get("zone")).toBeUndefined();
		expect(
			[...refusals.values()].filter((refusal) => refusal !== undefined),
		).toHaveLength(3);
	});

	it("agrees with the commit gate on every choice of both lists", () => {
		for (const doc of [tileOrderDoc(), rowOrderDoc()]) {
			const moduleUuid = doc.moduleOrder[0];
			for (const choice of addMenuChoices(doc, moduleUuid)) {
				const { column, mutations } = committedChoice(doc, moduleUuid, choice);
				const verdict = mutationCommitVerdict(
					doc,
					mutations,
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(caseListOrderChoiceRefusal(doc, moduleUuid, column)).toBe(
					verdict.ok ? undefined : offeredChoiceRefusal(verdict.findings),
				);
			}
		}
	});
});
