/**
 * Typed CSQL composition (part 06): one search per construct an editor can
 * author in a search, so proof 3's sessions send each one's CSQL and
 * `csql@A` (`proof/checks/intent.py::search_compiles`) compiles it under
 * every configuration, the one without `CASE_SEARCH_RELATED_LOOKUPS` among
 * them. What each finds is the `csql` native family's
 * (`lib/commcare/__tests__/csqlCompositionFixture.ts`); this document holds
 * that HQ accepts every query Nova sends, and that the chosen case's reads
 * survive HQ's build.
 *
 * "Visits" passes through the "Households" case list: its search narrows by
 * the chosen household, the parent's case id compared with the chosen case in
 * HQ's flag-free ancestor spelling (`parent/@case_id = …`, part 06 §3.12),
 * and by `village = chosen-case-property('Households', 'village')` in a
 * runtime segment; its case list filter reads the same property, so the
 * suite, HQ JSON's short filter and the remote request each hold the datum
 * read. "Members" is nested in the root, case-first "Households" menu with
 * Households as its parent selection, and its case list filter reads the
 * chosen household, so HQ's build renames the short filter's `parent_id` to
 * the root's `case_id` through root alignment, and proof 3 compares that
 * nodeset with the local suite's. "Visit searches" holds the rest, one
 * advanced input each: `closed_on`, the record's case type, the worker's
 * `today()`, a number of days as a date and as a date and time, a date and
 * time equality (an instant range), the worker's id and a user field, a
 * distance in yards, a radius and a unit the worker types, tags the worker
 * types, and a clause chosen by the worker's answer. Every input the worker
 * may leave blank is read only when answered.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	plainColumn,
	proseText,
	type SearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	dateCoerce,
	datetimeCoerce,
	datetimeLiteral,
	double,
	eq,
	gte,
	ifExpr,
	input,
	literal,
	lt,
	lte,
	matchAll,
	not,
	prop,
	relationStep,
	sessionContext,
	sessionUser,
	term,
	today,
	whenInput,
	within,
} from "@/lib/domain/expression";
import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-csql-composition";
const uuid = (name: string) => targetedUuid(ID, name);

const HOUSEHOLD = "household";
const NORTH = "targeted-household-north";
const SOUTH = "targeted-household-south";
const VISIT = "visit";
const MEMBER = "member";

/** One advanced input whose predicate reads no answer: a fixed rule. */
function rule(
	name: string,
	predicate: Parameters<typeof advancedSearchInputDef>[4],
) {
	return advancedSearchInputDef(
		uuid(`${name}-input`),
		name,
		name,
		"text",
		predicate,
	);
}

/** One advanced input whose predicate reads its own answer, only when answered. */
function asked(
	name: string,
	label: string,
	predicate: (
		answer: ReturnType<typeof input>,
	) => Parameters<typeof advancedSearchInputDef>[4],
) {
	const answer = uuid(`${name}-input`);
	return advancedSearchInputDef(
		answer,
		name,
		label,
		"text",
		whenInput(input(answer), predicate(input(answer))),
	);
}

function review(name: string) {
	return {
		uuid: uuid(`${name}-review`),
		name: "Review",
		type: "followup" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid(`${name}-note`),
				id: "note",
				label: proseText("Note"),
			}),
		],
	};
}

export function csqlComposition() {
	const households = uuid("households-module");
	const chosenHousehold = chosenCaseId(households);
	const chosenVillage = chosenCaseProperty(households, HOUSEHOLD, "village");
	const visitParent = prop(
		VISIT,
		"case_id",
		ancestorPath(relationStep("parent")),
	);
	const seen = prop(VISIT, "seen");
	const gps = prop(VISIT, "gps");
	const center = term(literal("0 0"));
	const searches: SearchInputDef[] = [
		rule(
			"closed_since",
			not(
				lt(
					prop(VISIT, "closed_on"),
					term(datetimeLiteral("2026-01-01T00:00:00Z")),
				),
			),
		),
		rule(
			"own_type",
			eq(
				term({ kind: "case-row-type" }),
				term({ kind: "case-type", caseType: VISIT }),
			),
		),
		rule("due_by_today", lte(prop(VISIT, "due"), today())),
		rule(
			"due_after_day",
			gte(prop(VISIT, "due"), dateCoerce(term(literal(19000)))),
		),
		rule("seen_after_noon", gte(seen, datetimeCoerce(term(literal(19000.5))))),
		rule("seen_at", eq(seen, term(datetimeLiteral("2026-01-02T04:30:00")))),
		rule(
			"assigned_to_me",
			eq(prop(VISIT, "assigned_to"), term(sessionContext("userid"))),
		),
		rule(
			"in_my_region",
			eq(prop(VISIT, "region"), term(sessionUser("region"))),
		),
		rule("near_in_yards", within(gps, center, 250, "yards")),
		asked("radius", "Radius in meters", (answer) =>
			within(gps, center, double(term(answer)), "meters"),
		),
		asked("unit", "Distance unit", (answer) =>
			within(gps, center, 200, term(answer)),
		),
		asked("tags", "Tags", (answer) => ({
			kind: "multi-select-contains",
			property: prop(VISIT, "tags"),
			quantifier: "any",
			values: [term(answer)],
		})),
		asked("mode", "Which visits", (answer) =>
			ifExpr(
				eq(term(answer), term(literal("recent"))),
				gte(seen, term(datetimeLiteral("2026-01-01T00:00:00Z"))),
				matchAll(),
			),
		),
	];
	const members = uuid("members-module");
	const doc = buildDoc(
		{
			appId: ID,
			appName: "Search compositions",
			caseTypes: [
				{
					name: HOUSEHOLD,
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
					],
				},
				{
					name: VISIT,
					parent_type: HOUSEHOLD,
					relationship: "child",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
						{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
						{ name: "due", label: proseText("Due"), data_type: "date" },
						{ name: "assigned_to", label: proseText("Assigned to") },
						{ name: "region", label: proseText("Region") },
						{
							name: "gps",
							label: proseText("Location"),
							data_type: "geopoint",
						},
						{
							name: "tags",
							label: proseText("Tags"),
							data_type: "multi_select",
						},
					],
				},
				{
					name: MEMBER,
					parent_type: HOUSEHOLD,
					relationship: "child",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "home_village", label: proseText("Home village") },
					],
				},
			],
			modules: [
				{
					uuid: households,
					name: "Households",
					caseType: HOUSEHOLD,
					caseListConfig: caseListOf([
						plainColumn(uuid("households-name"), "case_name", "Name"),
					]),
					forms: [review("households")],
				},
				{
					uuid: members,
					name: "Members",
					caseType: MEMBER,
					parentCaseModuleUuid: households,
					caseListConfig: caseListOf(
						[plainColumn(uuid("members-name"), "case_name", "Name")],
						{
							filter: eq(prop(MEMBER, "home_village"), chosenVillage),
						},
					),
					forms: [review("members")],
				},
				{
					uuid: uuid("visits-module"),
					name: "Visits",
					caseType: VISIT,
					parentCaseModuleUuid: households,
					caseListConfig: caseListOf(
						[plainColumn(uuid("visits-name"), "case_name", "Name")],
						{
							filter: eq(prop(VISIT, "village"), chosenVillage),
							searchInputs: [
								rule("in_household", eq(visitParent, chosenHousehold)),
								rule("in_village", eq(prop(VISIT, "village"), chosenVillage)),
							],
						},
					),
					forms: [review("visits")],
				},
				{
					uuid: uuid("searches-module"),
					name: "Visit searches",
					caseType: VISIT,
					caseListConfig: caseListOf(
						[plainColumn(uuid("searches-name"), "case_name", "Name")],
						{
							searchInputs: searches,
						},
					),
					forms: [review("searches")],
				},
			],
		},
		(built) => {
			// Members is a child of the Households menu.
			built.modules[members].parentModuleUuid = households;
		},
	);
	// Two households in two villages, each with a member and a visit in its
	// own village and one in the other's.
	const household = (id: string, village: string) => ({
		id,
		type: HOUSEHOLD,
		name: `${village} house`,
		properties: { village },
	});
	const child =
		(type: string, property: string) =>
		(id: string, name: string, parent: string, village: string) => ({
			id,
			type,
			name,
			properties: { [property]: village },
			indices: [{ identifier: "parent", caseType: HOUSEHOLD, caseId: parent }],
		});
	const member = child(MEMBER, "home_village");
	const visit = child(VISIT, "village");
	const restore = restoreXml({
		cases: [
			household(NORTH, "North"),
			household(SOUTH, "South"),
			member("targeted-member-ama", "Ama", NORTH, "North"),
			member("targeted-member-bo", "Bo", NORTH, "South"),
			member("targeted-member-cy", "Cy", SOUTH, "North"),
			visit("targeted-visit-north-north", "First visit", NORTH, "North"),
			visit("targeted-visit-north-south", "Second visit", NORTH, "South"),
			visit("targeted-visit-south-north", "Third visit", SOUTH, "North"),
		],
	});
	// Each list after the worker chose the North household: its own cases in
	// the household's village.
	const listed = (
		id: string,
		form: ReturnType<typeof uuid>,
		command: string,
		datum: string,
		caseId: string,
	) => ({
		id,
		export: "local" as const,
		form,
		restore: "restore.xml",
		request: {
			session: { command, data: { [datum]: NORTH } },
			caseList: {},
		},
		expect: [{ pointer: "/caseList/rows/0/caseId", value: caseId }],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"CSQL composition (part 06 §8): one search per authorable construct, the chosen case among them",
		],
		doc,
		expected: {
			intent: [
				// Members' entry aligns its household datum to the root's `case_id`.
				listed(
					"members-of-north-listed-local",
					uuid("members-review"),
					"m1-f0",
					"case_id",
					"targeted-member-ama",
				),
				listed(
					"visits-of-north-listed-local",
					uuid("visits-review"),
					"m2-f0",
					"parent_id",
					"targeted-visit-north-north",
				),
			],
		},
		files: { "restore.xml": restore },
	});
}
