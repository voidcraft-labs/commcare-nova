import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseMapLayerKind,
	mapLayerColumn,
	mapLocationColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const id = "targeted-case-map";
const uuid = (name: string) => targetedUuid(id, name);
export function caseMap() {
	const form = uuid("visit");
	const roles: CaseMapLayerKind[] = [
		"boundary",
		"boundary-color",
		"points",
		"point-colors",
	];
	const field = (role: string) => role.replaceAll("-", "_");
	const doc = buildDoc({
		appId: id,
		appName: "Coverage map",
		caseTypes: [
			{
				name: "place",
				properties: [
					"case_name",
					"primary_location",
					"alternate_location",
					...roles.map(field),
				].map((name) => ({ name, label: proseText(name) })),
			},
		],
		modules: [
			{
				uuid: uuid("places"),
				name: "Places",
				caseType: "place",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					mapLocationColumn(uuid("primary"), "primary_location", "Clinic"),
					mapLocationColumn(uuid("alternate"), "alternate_location", "Home"),
					...roles.map((role) =>
						mapLayerColumn(uuid(role), field(role), role, role),
					),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		doc,
		rows: [
			"Case locations, first usable address, Android boundary and point sources",
		],
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: "map-a",
						type: "place",
						name: "Ana",
						properties: {
							primary_location: "12 24 1 2",
							alternate_location: "25 30",
							boundary: "12 24 15 24 15 20",
							boundary_color: "#80CBA018",
							points: "12 24 14 22",
							point_colors: "#AA2211,blue",
						},
					},
					{
						id: "map-b",
						type: "place",
						name: "Bea",
						properties: {
							alternate_location: "28 44",
							points: "28 44 30 46",
							point_colors: "red",
						},
					},
				],
			}),
		},
		expected: {
			intent: [
				{
					id: "map-sources",
					export: "local",
					form,
					restore: "restore.xml",
					request: { session: { command: "m0-f0" }, caseList: {} },
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "map-a" },
						{ pointer: "/caseList/rows/0/fields/1", value: "12 24 1 2" },
						{ pointer: "/caseList/rows/1/fields/1", value: "" },
						{ pointer: "/caseList/rows/1/fields/2", value: "28 44" },
						{
							pointer: "/caseList/rows/0/fields/3",
							value: "12 24 15 24 15 20",
						},
						{ pointer: "/caseList/rows/0/fields/6", value: "#AA2211,blue" },
					],
				},
			],
		},
	});
}
