/**
 * A form's read of an ancestor case walks the index the app links the two
 * types by, not `parent` (`targeted-ancestor-index-names`).
 *
 * A form reads a case above its own one index hop at a time
 * (`lib/commcare/xform/formCaseRead.ts::formCaseWalk`), under the identifier
 * every case the app links between the two types carries
 * (`lib/domain/advancedModule.ts::ancestorWalk`), whatever the link's
 * relationship: CommCare reads an index by its name
 * (`casexml/apps/case/const.py::DEFAULT_CASE_INDEX_IDENTIFIERS` is only HQ's
 * default, `host` for an extension). HQ's summary resolves the load entry
 * `#case/<identifier>/<property>` by the relationship names the app's forms
 * write (`app_schemas/app_case_metadata.py::AppCaseMetadata.get_property_list`).
 *
 * "Visit household" makes a member linked to the household as `home` and a
 * pledge extending the household as `host`. Three menus read the household:
 *
 * - Members, a basic menu choosing a member under its household (HQ's
 *   parent selection lists any index that is not an extension,
 *   `suite_xml/sections/entries.py::get_parent_filter`), whose "Check
 *   member" shows the household's remark in a Hidden Value, starts a
 *   question on it, and shows a note only while it is blank;
 * - Member visits, the same choice made advanced by "Visit member"'s create
 *   its link carries into "Review visit" (HQ narrows the member's load by
 *   `[index/home=…]`, `entries.py::get_parent_filter_by_ref_id`), whose
 *   "Visit member" reads the household the same three ways;
 * - Pledges, a flat list of extension cases, whose "Check pledge" reads the
 *   household it extends.
 *
 * Fixed values: Core opens each form on a case the restore links to its
 * household only under that name (and a member holding a `parent` index to
 * another household beside its `home` one), and every read gives the
 * remark of the household under the app's own name, on HQ's build and on
 * Nova's archive: a read through `parent` would give a blank, or the other
 * household's remark.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseOperation,
	type Expression,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

const ID = "targeted-ancestor-index-names";
export const ancestorIndexNamesUuid = (name: string) => targetedUuid(ID, name);
const uuid = ancestorIndexNamesUuid;

/** A form-logic expression written as form text, which `buildDoc` parses in its slot. */
function logic(text: string): Expression {
	return text as unknown as Expression;
}

const read = (key: string) => term(formField(uuid(key)));

function text(key: string, label: string, extra: Record<string, unknown> = {}) {
	return f({
		kind: "text",
		uuid: uuid(key),
		id: key.replaceAll("-", "_"),
		label: proseText(label),
		...extra,
	});
}

/**
 * The three reads of the household's remark a form under test holds: a
 * Hidden Value calculated from it, a question starting on it, and a note
 * shown only while it is blank.
 */
function householdReads(form: string) {
	return [
		f({
			kind: "hidden",
			uuid: uuid(`${form}-household-remark`),
			id: "household_remark",
			calculate: logic("#household/remark"),
		}),
		text(`${form}-remark-seen`, "Household remark", {
			id: "remark_seen",
			default_value: logic("#household/remark"),
		}),
		f({
			kind: "label",
			uuid: uuid(`${form}-no-remark`),
			id: "no_remark",
			label: proseText("This household has no remark yet."),
			relevant: logic("#household/remark = ''"),
		}),
		text(`${form}-note`, "Note", { id: "note" }),
	];
}

/** The form's own case, saving its note. */
function ownNote(form: string): CaseOperation {
	return {
		uuid: uuid(`${form}-own`),
		id: form.replaceAll("-", "_"),
		action: "own",
		writes: [{ property: "note", value: read(`${form}-note`) }],
	} as CaseOperation;
}

function caseType(
	name: string,
	properties: readonly string[],
	parent?: { readonly type: string; readonly relationship?: "extension" },
) {
	return {
		name,
		...(parent !== undefined && { parent_type: parent.type }),
		...(parent?.relationship !== undefined && {
			relationship: parent.relationship,
		}),
		properties: [
			{ name: "case_name", label: proseText("Name") },
			...properties.map((property) => ({
				name: property,
				label: proseText(property),
				data_type: "text" as const,
			})),
		],
	};
}

export function ancestorIndexNamesApp() {
	const households = uuid("households");
	const members = uuid("members");
	const memberVisits = uuid("member-visits");
	const visits = uuid("visits");
	const pledges = uuid("pledges");
	const addHousehold = uuid("add-household");
	const visitHousehold = uuid("visit-household");
	const checkMember = uuid("check-member");
	const visitMember = uuid("visit-member");
	const reviewVisit = uuid("review-visit");
	const checkPledge = uuid("check-pledge");
	return buildDoc(
		{
			appId: ID,
			appName: "Household members",
			caseTypes: [
				caseType("household", ["remark"]),
				caseType("member", ["note"], { type: "household" }),
				caseType("pledge", ["note"], {
					type: "household",
					relationship: "extension",
				}),
				caseType("visit", ["note"]),
			],
			modules: [
				{
					uuid: households,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListOf([
						plainColumn(uuid("households-name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: addHousehold,
							name: "Add household",
							type: "registration",
							fields: [
								text("household-name", "Household name"),
								text("household-remark", "Remark"),
							],
						},
						{
							uuid: visitHousehold,
							name: "Visit household",
							type: "followup",
							fields: [
								text("visit-remark", "Remark"),
								text("member-name", "New member"),
								text("pledge-name", "New pledge"),
							],
						},
					],
				},
				{
					uuid: members,
					name: "Members",
					caseType: "member",
					parentCaseModuleUuid: households,
					caseListConfig: caseListOf([
						plainColumn(uuid("members-name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: checkMember,
							name: "Check member",
							type: "followup",
							fields: householdReads("check-member"),
						},
					],
				},
				{
					uuid: memberVisits,
					name: "Member visits",
					caseType: "member",
					parentCaseModuleUuid: households,
					caseListConfig: caseListOf([
						plainColumn(uuid("member-visits-name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: visitMember,
							name: "Visit member",
							type: "followup",
							formLinks: [
								{
									uuid: uuid("open-review"),
									target: {
										type: "form",
										moduleUuid: visits,
										formUuid: reviewVisit,
									},
								},
							],
							fields: [
								...householdReads("visit-member"),
								text("visit-name", "Visit"),
							],
						},
					],
				},
				{
					uuid: visits,
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListOf([
						plainColumn(uuid("visits-name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: reviewVisit,
							name: "Review visit",
							type: "followup",
							fields: [text("review-visit-note", "Note")],
						},
					],
				},
				{
					uuid: pledges,
					name: "Pledges",
					caseType: "pledge",
					caseListConfig: caseListOf([
						plainColumn(uuid("pledges-name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: checkPledge,
							name: "Check pledge",
							type: "followup",
							fields: householdReads("check-pledge"),
						},
					],
				},
			],
		},
		(built) => {
			built.forms[addHousehold].caseOperations = [
				{
					uuid: uuid("add-household-own"),
					id: "household",
					action: "own",
					name: read("household-name"),
					writes: [{ property: "remark", value: read("household-remark") }],
				},
			];
			built.forms[visitHousehold].caseOperations = [
				{
					uuid: uuid("visit-household-own"),
					id: "household",
					action: "own",
					writes: [{ property: "remark", value: read("visit-remark") }],
				},
				{
					uuid: uuid("add-member"),
					id: "member",
					action: "create",
					caseType: "member",
					target: { kind: "new" },
					name: read("member-name"),
					links: [
						{
							identifier: "home",
							targetType: "household",
							target: { kind: "session" },
							relationship: "child",
						},
					],
				},
				{
					uuid: uuid("add-pledge"),
					id: "pledge",
					action: "create",
					caseType: "pledge",
					target: { kind: "new" },
					name: read("pledge-name"),
					links: [
						{
							identifier: "host",
							targetType: "household",
							target: { kind: "session" },
							relationship: "extension",
						},
					],
				},
			];
			built.forms[checkMember].caseOperations = [ownNote("check-member")];
			built.forms[visitMember].caseOperations = [
				ownNote("visit-member"),
				{
					// Carried by the link into "Review visit", which makes the
					// menu advanced.
					uuid: uuid("open-visit"),
					id: "visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: read("visit-name"),
				},
			];
			built.forms[reviewVisit].caseOperations = [ownNote("review-visit")];
			built.forms[checkPledge].caseOperations = [ownNote("check-pledge")];
		},
	);
}

const HILL = "targeted-hill-farm";
const RIVER = "targeted-river-farm";
const AMINA = "targeted-amina";
const BOLA = "targeted-bola";
const PLEDGE = "targeted-roof-pledge";

/** Two households; Amina is linked to the Hill farm only as `home`, Bola as
 *  `home` to the Hill farm and as `parent` to the River farm, and the pledge
 *  extends the Hill farm as `host`. */
const RESTORE = restoreXml({
	cases: [
		{
			id: HILL,
			type: "household",
			name: "Hill farm",
			properties: { remark: "Fenced" },
		},
		{
			id: RIVER,
			type: "household",
			name: "River farm",
			properties: { remark: "Flooded" },
		},
		{
			id: AMINA,
			type: "member",
			name: "Amina",
			indices: [{ identifier: "home", caseType: "household", caseId: HILL }],
		},
		{
			id: BOLA,
			type: "member",
			name: "Bola",
			indices: [
				{ identifier: "home", caseType: "household", caseId: HILL },
				{ identifier: "parent", caseType: "household", caseId: RIVER },
			],
		},
		{
			id: "targeted-cleo",
			type: "member",
			name: "Cleo",
			indices: [
				{
					identifier: "home",
					caseType: "household",
					caseId: HILL,
					relationship: "extension",
				},
			],
		},
		{
			id: "targeted-dara",
			type: "member",
			name: "Dara",
			indices: [
				{ identifier: "neighbor", caseType: "household", caseId: HILL },
			],
		},
		{
			id: PLEDGE,
			type: "pledge",
			name: "Roof",
			indices: [
				{
					identifier: "host",
					caseType: "household",
					caseId: HILL,
					relationship: "extension",
				},
			],
		},
	],
});

/**
 * The form `form` of `key`, opened by `command` on `data`, reads the Hill
 * farm's remark in its Hidden Value and its question, and so hides its note,
 * which a blank read would show.
 */
function readsHillFarm(
	id: string,
	exportName: Expectation["export"],
	key: string,
	command: string,
	data: Readonly<Record<string, string>>,
): Expectation {
	return {
		id,
		export: exportName,
		form: uuid(key),
		restore: "restore.xml",
		request: {
			session: { command, data },
			expressions: [
				"/data/household_remark",
				"/data/remark_seen",
				"if(count(/data/no_remark) > 0, 'shown', 'hidden')",
			],
		},
		expect: [
			{ pointer: "/values/0/value", value: "Fenced" },
			{ pointer: "/values/1/value", value: "Fenced" },
			{ pointer: "/values/2/value", value: "hidden" },
		],
	};
}

/** Core's actual entity screen. The two links point to the same household.
 * Only the named-index advanced entry lists Cleo; only the basic entry
 * lists Dara. A failing nodeset must leave the searched list empty. */
function selectedMember(advanced: boolean, name: "Cleo" | "Dara"): Expectation {
	const present = advanced === (name === "Cleo");
	return {
		id: `${advanced ? "named" : "direct"}-index-${name.toLowerCase()}`,
		export: "local",
		form: uuid(advanced ? "visit-member" : "check-member"),
		restore: "restore.xml",
		request: {
			session: {
				command: advanced ? "m2-f0" : "m1-f0",
				data: { [advanced ? "case_id_load_household0" : "parent_id"]: HILL },
			},
			caseList: { searchText: name },
		},
		expect: present
			? [
					{
						pointer: "/caseList/rows/0/caseId",
						value: `targeted-${name.toLowerCase()}`,
					},
				]
			: [{ pointer: "/caseList/rows", value: [] }],
	};
}

export function ancestorIndexNames() {
	return targetedDocument({
		id: ID,
		rows: [
			"a form's read of an ancestor walks the index the app links it by",
			"an extension's host read through its own index",
		],
		doc: ancestorIndexNamesApp(),
		expected: {
			intent: [
				selectedMember(false, "Cleo"),
				selectedMember(true, "Cleo"),
				selectedMember(false, "Dara"),
				selectedMember(true, "Dara"),
				readsHillFarm("member-home", "A", "check-member", "m1-f0", {
					parent_id: HILL,
					case_id: AMINA,
				}),
				readsHillFarm(
					"member-home-beside-parent",
					"A",
					"check-member",
					"m1-f0",
					{
						parent_id: HILL,
						case_id: BOLA,
					},
				),
				readsHillFarm("member-home-local", "local", "check-member", "m1-f0", {
					parent_id: HILL,
					case_id: AMINA,
				}),
				readsHillFarm("advanced-member-home", "A", "visit-member", "m2-f0", {
					case_id_load_household0: HILL,
					case_id_load_member1: BOLA,
					// The visit's id, which the open action's case block reads.
					case_id_new_visit_0: "targeted-new-visit",
				}),
				readsHillFarm("pledge-host", "A", "check-pledge", "m4-f0", {
					case_id: PLEDGE,
				}),
				readsHillFarm("pledge-host-local", "local", "check-pledge", "m4-f0", {
					case_id: PLEDGE,
				}),
			],
		},
		files: { "restore.xml": RESTORE },
	});
}
