import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText, tileCell } from "@/lib/domain";

export const tileScenarios = [
	"plain",
	"tile",
	"boxed",
	"persistent",
	"grouped-one",
	"grouped-two",
	"grouped-search",
	"grouped-browse",
] as const;
export type TileScenario = (typeof tileScenarios)[number];

/** Saved hidden placement is intentionally wider than every visible cell. */
export function tileFixture(scenario: TileScenario) {
	const grouped = scenario.startsWith("grouped-");
	const headerRows = scenario === "grouped-two" ? 2 : 1;
	const config = caseListConfig([
		{ field: "case_name", header: "Name" },
		{ field: "village", header: "Village" },
		{ field: "last_visit", header: "Last visit" },
		{ field: "rank", header: "Order" },
	]);
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
			...(scenario === "persistent" ? { persistOnForms: true } : {}),
		};
	return buildDoc({
		appName: `Tile ${scenario}`,
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: config,
				...(scenario === "grouped-search"
					? { caseSearchConfig: { searchScreenTitle: "Find a visit" } }
					: {}),
				...(scenario === "grouped-browse" ? { caseListOnly: true } : {}),
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
		],
		caseTypes: [
			{
				name: "visit",
				properties: ["case_name", "village", "last_visit", "rank"].map(
					(name) => ({
						name,
						label: proseText(name),
						data_type: "text" as const,
					}),
				),
			},
		],
	});
}
