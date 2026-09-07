import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseListConfig,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	plainColumn,
	rangeMode,
	simpleSearchInputDef,
} from "@/lib/domain";
import { arith, eq, literal, prop, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

// ── Fixture identifiers ──────────────────────────────────────────
//
// Fixed app id + owner id keep traces readable. Patient case ids
// are pinned so the sort-direction assertions reference the rows
// by name rather than reading back the order to discover them.

export const APP_ID = "case-list-authoring-int";
export const OWNER_ID = "owner-int";
export const PATIENT_ALICE_ID = "30000000-0000-0000-0000-000000000001";
export const PATIENT_BOB_ID = "30000000-0000-0000-0000-000000000002";
export const PATIENT_CAROL_ID = "30000000-0000-0000-0000-000000000003";

// Region id-mapping table — re-used by the well-formed wire fixture.
const REGION_MAPPING = [
	idMappingEntry("N", "North"),
	idMappingEntry("S", "South"),
] as const;

// Pre-allocated column uuids the wire-emission fixture references.
// Stable uuids let assertions cross-check the same column at
// multiple layers (sort directives keyed by uuid; preview cell
// rendering keyed by uuid) without snapshotting opaque generated
// strings.
const COL_NAME_UUID = testUuid("00000000-0000-4000-8000-000000000001");
const COL_DATE_UUID = testUuid("00000000-0000-4000-8000-000000000002");
const COL_INTERVAL_UUID = testUuid("00000000-0000-4000-8000-000000000003");
const COL_REGION_UUID = testUuid("00000000-0000-4000-8000-000000000004");
const COL_AGE_UUID = testUuid("00000000-0000-4000-8000-000000000005");
export const COL_AGE_NEXT_UUID = testUuid(
	"00000000-0000-4000-8000-000000000006",
);

const SI_NAME_UUID = testUuid("00000000-0000-4000-8000-000000000010");
const SI_VISIT_RANGE_UUID = testUuid("00000000-0000-4000-8000-000000000011");

/**
 * Construct the well-formed v2 case-list configuration. Single
 * source of truth for the wire-emission + validator + preview
 * arms. The fixture covers five non-calc column kinds (plain
 * twice, date, interval, id-mapping), one calculated column, a
 * real `eq` predicate filter, multi-priority sort, simple +
 * range-mode search inputs, and visibility flags.
 */
export function buildWellFormedCaseListConfig(): CaseListConfig {
	return resolveCaseListConfig({
		columns: [
			plainColumn(COL_NAME_UUID, "case_name", "Patient", {
				sort: { direction: "asc", priority: 1 },
			}),
			dateColumn(COL_DATE_UUID, "date_opened", "Opened", "%Y-%m-%d"),
			intervalColumn(
				COL_INTERVAL_UUID,
				"last_visit",
				"Weeks since visit",
				2,
				"weeks",
				"always",
				"Overdue",
			),
			idMappingColumn(COL_REGION_UUID, "region", "Region", REGION_MAPPING),
			plainColumn(COL_AGE_UUID, "age", "Age", {
				sort: { direction: "desc", priority: 0 },
			}),
			calculatedColumn(
				COL_AGE_NEXT_UUID,
				"Age next year",
				arith(
					"+",
					term(prop("patient", "age")),
					term({ kind: "literal", value: 1, data_type: "int" }),
				),
			),
		],
		// `status` is a CommCare standard property (text-typed); the
		// type checker resolves it without a declared `properties[]`
		// entry.
		filter: eq(prop("patient", "status"), literal("open")),
		searchInputs: [
			simpleSearchInputDef(
				SI_NAME_UUID,
				"patient_name",
				"Patient name",
				"text",
				"full_name",
			),
			// CommCare's range prompt carries one inseparable start/end
			// answer, so Nova pairs it only with the date-range widget.
			// Keeping that invariant in the shared well-formed fixture
			// means the validator, HQ JSON, and suite emitters all exercise
			// the same value shape.
			simpleSearchInputDef(
				SI_VISIT_RANGE_UUID,
				"last_visit",
				"Visit dates",
				"date-range",
				"last_visit",
				{ mode: rangeMode() },
			),
		],
	});
}

/**
 * Build a `BlueprintDoc` carrying the well-formed v2 config plus a
 * second case-typed module with an identifying Results field.
 * The `patient` case type declares `full_name`,
 * `age`, `region`, `last_visit`. Combined with CommCare's
 * standard properties (`case_name`, `status`, `date_opened`),
 * every column / filter / search-input the well-formed config
 * references resolves cleanly.
 */
export function buildFixtureDoc(): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "Case List Authoring Integration",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: buildWellFormedCaseListConfig(),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Patient name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "name",
								label: proseText("Full name"),
								caseWrite: { caseType: "patient", property: "full_name" },
							}),
							f({
								kind: "int",
								id: "age",
								label: proseText("Age"),
								caseWrite: { caseType: "patient", property: "age" },
							}),
							f({
								kind: "text",
								id: "region",
								label: proseText("Region"),
								caseWrite: { caseType: "patient", property: "region" },
							}),
							f({
								kind: "date",
								id: "last_visit",
								label: proseText("Last visit"),
								caseWrite: { caseType: "patient", property: "last_visit" },
							}),
						],
					},
					{
						// Followup form drives the entry's case-load datum,
						// which threads `caseListConfig.filter` into the
						// `<nodeset>` predicate. Registration forms create
						// cases (no load); without a followup, the suite's
						// session-datum carries no `@case_type='patient'`
						// chain and the filter fragment never lands on the
						// wire.
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "notes", label: proseText("Notes") }),
						],
					},
				],
			},
			{
				name: "Households",
				caseType: "household",
				caseListConfig: resolveCaseListConfig({
					searchInputs: [],
					columns: [
						plainColumn(
							testUuid("household-name-column"),
							"case_name",
							"Household",
						),
					],
				}),
				forms: [
					{
						name: "Register household",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Household name"),
								caseWrite: { caseType: "household", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "full_name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "region", label: proseText("Region"), data_type: "text" },
					{
						name: "last_visit",
						label: proseText("Last visit"),
						data_type: "date",
					},
				],
			},
			{
				name: "household",
				properties: [
					{ name: "full_name", label: proseText("Name"), data_type: "text" },
				],
			},
		],
	});
}
