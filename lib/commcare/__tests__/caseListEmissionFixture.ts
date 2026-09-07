import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	eq,
	input,
	literal,
	matchAll,
	matchNone,
	prop,
	relationStep,
	sessionUser,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { mediaIds, mediaManifest } from "./mediaWireFixtures";

export const caseListEmissionScenarios = [
	"local",
	"remote",
	"inline",
	"browse",
	"no-details",
	"match-none",
	"match-all",
	"unanswered",
] as const;
export type CaseListEmissionScenario =
	(typeof caseListEmissionScenarios)[number];

/** Every scenario passes the persisted schema and full export gate in its consumers. */
export function caseListEmissionFixture(scenario: CaseListEmissionScenario) {
	const columns = [
		plainColumn(testUuid("cl-name"), "case_name", "Name & identity", {
			sort: { direction: "asc", priority: 2 },
		}),
		dateColumn(testUuid("cl-date"), "birthdate", "Born", "%Y-%m-%d"),
		phoneColumn(testUuid("cl-phone"), "phone", "Call"),
		linkColumn(testUuid("cl-link"), "website", "Site", "Open & read"),
		idMappingColumn(testUuid("cl-map"), "code", "Status", [
			idMappingEntry("a", "Active & ready"),
			idMappingEntry("b", "Paused"),
		]),
		imageMapColumn(testUuid("cl-image"), "code", "Picture", [
			imageMapEntry("a", mediaIds.label),
		]),
		intervalColumn(
			testUuid("cl-interval"),
			"birthdate",
			"Overdue",
			1,
			"days",
			"flag",
			"Old",
		),
		calculatedColumn(
			testUuid("cl-parent"),
			"Household rank",
			term(
				prop(
					"patient",
					"rank",
					ancestorPath(relationStep("parent", "household")),
				),
			),
			{ sort: { direction: "desc", priority: 0 } },
		),
		plainColumn(testUuid("cl-hidden"), "weight", "Hidden order", {
			visibleInList: false,
			visibleInDetail: false,
			sort: { direction: "asc", priority: 1 },
		}),
		calculatedColumn(
			testUuid("cl-worker"),
			"Worker",
			term(sessionUser("display_name")),
			{ visibleInList: false },
		),
	];
	const config = caseListConfig([]);
	config.columns = columns;
	config.listColumnOrder = columns.map((c) => c.uuid);
	config.detailColumnOrder = [...config.listColumnOrder].reverse();
	config.icon = mediaIds.icon;
	const searchId = testUuid("cl-search");
	config.searchInputs = [
		simpleSearchInputDef(searchId, "code", "Code", "text", "code"),
	];
	if (scenario === "no-details")
		config.columns = columns.map((c) => ({ ...c, visibleInDetail: false }));
	if (scenario === "match-none") config.filter = matchNone();
	else if (scenario === "match-all")
		config.filter = and(matchAll(), matchAll());
	else if (scenario === "unanswered")
		config.filter = whenInput(
			input(searchId),
			eq(prop("patient", "code"), input(searchId)),
		);
	else if (scenario !== "remote" && scenario !== "inline")
		config.filter = eq(prop("patient", "code"), literal("a"));
	const search = scenario === "remote" || scenario === "inline";
	const doc = buildDoc({
		appName: "Case list proof",
		modules: [
			{
				name: "Patients & visits",
				caseType: "patient",
				caseListConfig: config,
				...(search
					? {
							caseSearchConfig:
								scenario === "inline" ? { searchFirst: true } : {},
						}
					: {
							caseSearchConfig: {
								excludedOwnerIds: term(sessionUser("excluded_owners")),
							},
						}),
				...(scenario === "browse" || scenario === "no-details"
					? { caseListOnly: true, forms: [] }
					: {
							forms: [
								{
									name: "Visit",
									type: "followup",
									fields: [
										f({ kind: "text", id: "notes", label: proseText("Notes") }),
									],
								},
							],
						}),
			},
		],
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "rank", label: proseText("Rank"), data_type: "int" },
				],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "birthdate", label: proseText("Born"), data_type: "date" },
					{ name: "phone", label: proseText("Phone") },
					{ name: "website", label: proseText("Site") },
					{ name: "code", label: proseText("Code") },
					{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
				],
			},
		],
	});
	return { doc, assets: mediaManifest() };
}
