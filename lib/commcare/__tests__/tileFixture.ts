import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type CaseListConfig,
	NAMED_TILE_SLOTS,
	namedTileSlotsSchema,
	proseText,
	tileCell,
} from "@/lib/domain";
import { eq, literal, prop, term } from "@/lib/domain/expression";

export const resultsTileScenarios = [
	"plain",
	"tile",
	"boxed",
	"persistent",
	"grouped-one",
	"grouped-two",
	"grouped-search",
	"grouped-browse",
] as const;
export const tileScenarios = [
	...resultsTileScenarios,
	"detail-tabs",
	"conditional-search-children",
	"detail-layout",
	"named-layout",
	"persistent-line",
	"persistent-inline",
	"persistent-external",
] as const;
export type TileScenario = (typeof tileScenarios)[number];

/** Saved hidden placement is intentionally wider than every visible cell. */
export function tileFixture(scenario: TileScenario) {
	const grouped = scenario.startsWith("grouped-");
	const headerRows = scenario === "grouped-two" ? 2 : 1;
	const columns = [
		{ field: "case_name", header: "Name" },
		{ field: "village", header: "Village" },
		{ field: "last_visit", header: "Last visit" },
		{ field: "rank", header: "Order" },
	];
	const extras =
		scenario === "named-layout"
			? Array.from({ length: 7 }, (_, i) => ({
					field: `visit_part_${i + 1}`,
					header: `Visit part ${i + 1}`,
				}))
			: [];
	const config = caseListConfig([...columns, ...extras]);
	config.columns = config.columns.map((column, index) => ({
		...column,
		tile: [
			tileCell(0, 0, 4, headerRows, {
				verticalAlign: "top",
				horizontalAlign: "left",
				fontSize: "large",
				...(scenario === "boxed"
					? { showBorder: true, showShading: true }
					: {}),
			}),
			tileCell(0, headerRows, 2, 1, {
				verticalAlign: "middle",
				horizontalAlign: "center",
			}),
			tileCell(2, headerRows, 2, 1, {
				verticalAlign: "bottom",
				horizontalAlign: "right",
			}),
			tileCell(4, 0, 6, 4, { showBorder: true, showShading: true }),
		][index],
		...(index === 3
			? {
					visibleInList: false,
					visibleInDetail: false,
					sort: { direction: "asc" as const, priority: 0 },
				}
			: {}),
	}));
	if (scenario !== "plain")
		config.tile = {
			...(grouped ? { grouping: { identifier: "parent", headerRows } } : {}),
			...(["persistent", "persistent-inline"].includes(scenario)
				? { persistOnForms: true }
				: {}),
		};
	if (
		scenario === "detail-tabs" ||
		scenario === "conditional-search-children"
	) {
		config.detailTabs = [
			{
				uuid: asUuid("2eca1732-d02b-493b-9f88-e19ddcdb4d49"),
				title: "Visit",
				startColumnUuid: config.detailColumnOrder[0],
			},
			{
				uuid: asUuid("276128fa-1817-4453-a455-6c0247175791"),
				title: "Follow-up",
				startColumnUuid: config.detailColumnOrder[2],
				displayCondition: eq(
					term(prop("visit", "village")),
					term(literal("West")),
				),
				...(scenario === "conditional-search-children" && {
					rowSource: {
						kind: "records" as const,
						rows: {
							kind: "cases" as const,
							source: "casedb" as const,
							where: [eq({ kind: "case-row-type" }, literal("visit"))],
						},
						includeChildrenOfType: "contact",
					},
				}),
			},
		];
	}
	if (scenario === "detail-layout") {
		config.detailTile = {
			cells: Object.fromEntries(
				config.columns
					.slice(0, 3)
					.map((column, i) => [
						column.uuid,
						tileCell(0, i, 12, 1, { showBorder: i === 0 }),
					]),
			),
		};
	}
	if (scenario === "named-layout") {
		const members = config.columns.filter((col) => col.visibleInList !== false);
		config.tile = {
			namedSlots: namedTileSlotsSchema.parse(
				Object.fromEntries(
					NAMED_TILE_SLOTS.map((slot, index) => [slot, members[index].uuid]),
				),
			),
			rawSlots: ["topLeftText"],
		};
	}
	if (scenario === "persistent-inline")
		config.contextAboveForm = { kind: "own-tile", expandDetails: true };
	const line = term(prop("visit", "village"));
	if (scenario === "persistent-line")
		config.contextAboveForm = { kind: "line", expression: line };
	const ownerId = asUuid("5e63be07-5caa-4163-a1ba-b9f4e32b4289");
	let external: CaseListConfig | undefined;
	if (scenario === "persistent-external") {
		external = caseListConfig([
			{ field: "last_visit", header: "Previous visit" },
		]);
		external.columns[0].tile = tileCell(0, 0, 12, 1);
		external.tile = {};
		config.contextAboveForm = {
			kind: "menu-tile",
			moduleUuid: ownerId,
			expandDetails: true,
			expression: line,
		};
	}
	return buildDoc({
		appName: `Tile ${scenario}`,
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: config,
				...(scenario === "grouped-search" ||
				scenario === "conditional-search-children"
					? {
							// Nothing to fill in: the search runs as the menu opens.
							caseSearchConfig: {
								searchScreenTitle: "Find a visit",
								workflow: "skipToResults" as const,
							},
						}
					: {}),
				...(scenario === "grouped-browse" ? { caseListMenuItem: {} } : {}),
				forms:
					scenario === "grouped-browse"
						? []
						: [
								{
									name: "Record visit",
									type: "followup",
									fields: [
										f({ kind: "text", id: "notes", label: proseText("Notes") }),
									],
								},
								{
									name: "New visit",
									type: "registration",
									fields: [
										f({
											kind: "text",
											id: "name",
											label: proseText("Name"),
											caseWrite: { caseType: "visit", property: "case_name" },
										}),
									],
								},
							],
			},
			...(scenario === "persistent-external"
				? [
						{
							uuid: ownerId,
							name: "Previous visits",
							caseType: "visit",
							caseListMenuItem: {},
							caseListConfig: external,
							forms: [],
						},
					]
				: []),
		],
		caseTypes: [
			...(scenario === "conditional-search-children"
				? [{ name: "contact", properties: [] }]
				: []),
			{
				name: "visit",
				properties: [...columns, ...extras]
					.map(({ field }) => field)
					.map((name) => ({
						name,
						label: proseText(name),
						data_type: "text" as const,
					})),
			},
		],
	});
}
