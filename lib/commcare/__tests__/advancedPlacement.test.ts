/**
 * What an advanced action of CommCare HQ can express. Each clause is a pair
 * of forms in an advanced menu that differ in that clause alone: in one the
 * change takes its load or open action, in the other the clause holds and it
 * takes Save to Case, through `planPlacements` as every emitter reads it.
 * Catches an advanced action HQ's build, its validator or its case
 * configuration page refuses, and one Nova gives up that HQ keeps.
 *
 * The rows are also the shapes `proof/hq/test_advanced_rules.py` builds with
 * HQ's own models (`proof/hq/fixtures/advanced-rule-shapes.json`). The file
 * is written from these rows: `NOVA_WRITE_ADVANCED_RULE_SHAPES=1` writes it,
 * and every other run fails while the committed file differs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HqAdvancedForm, HqForm } from "@/lib/commcare";
import {
	type AdvancedIneligibility,
	loadIneligibility,
	openActionIneligibility,
} from "@/lib/commcare/advancedPlacement";
import { advancedFormLoads } from "@/lib/commcare/advancedSelections";
import { expandDoc } from "@/lib/commcare/expander";
import {
	placementCandidates,
	placementIneligibility,
	planPlacements,
} from "@/lib/commcare/placement";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	derivedUniqueId,
	targetWireIdentity,
} from "@/lib/commcare/wireIdentity";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { CaseOperation, CaseOperationLink, Uuid } from "@/lib/domain";
import { concat, eq, literal, term } from "@/lib/domain/expression/builders";
import {
	type AdvancedFixtureOptions,
	advancedFixture,
	choice,
	chosen,
	HOUSEHOLDS,
	MEMBERS,
	OP,
	read,
	U,
} from "./advancedPlacementFixture";

const OWN = OP("own");
const STATUS_YES = eq(read("status"), choice("status", "yes"));
/** A comparison of one question with a number, which no advanced action
 *  states: `xform.py::XForm.action_relevance` quotes the answer it compares. */
const AGE_IS_THREE = eq(read("age"), term(literal(3)));

function own(extra: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: OWN,
		id: "own_case",
		action: "own",
		...extra,
	} as CaseOperation;
}
function update(
	key: string,
	target: CaseOperation["target"],
	extra: Partial<CaseOperation> = {},
): CaseOperation {
	return {
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "household",
		target,
		writes: [{ property: "age", value: read("age") }],
		...extra,
	} as CaseOperation;
}
function close(
	key: string,
	target: CaseOperation["target"],
	extra: Partial<CaseOperation> = {},
): CaseOperation {
	return {
		uuid: OP(key),
		id: key,
		action: "close",
		caseType: "household",
		target,
		...extra,
	} as CaseOperation;
}
const OWN_LINK: CaseOperationLink = {
	identifier: "parent",
	targetType: "household",
	target: { kind: "op", opUuid: OWN },
	relationship: "child",
};
function create(
	key: string,
	extra: Partial<CaseOperation> & { repeat?: "kids" | "pets" } = {},
): CaseOperation {
	const { repeat, ...rest } = extra;
	return {
		uuid: OP(key),
		id: key,
		action: "create",
		caseType: "member",
		target: { kind: "new" },
		name: read(
			repeat === undefined
				? "name"
				: repeat === "kids"
					? "kid_name"
					: "pet_name",
		),
		links: [OWN_LINK],
		...(repeat !== undefined && { forEach: { repeat: U(repeat) } }),
		...rest,
	} as CaseOperation;
}
/** A household registration whose own case is an open action. */
const registration = (
	...operations: CaseOperation[]
): AdvancedFixtureOptions => ({
	formType: "registration",
	operations: () => [own({ name: read("name") }), ...operations],
});
const followup = (
	operations: CaseOperation[],
	extra: Partial<AdvancedFixtureOptions> = {},
): AdvancedFixtureOptions => ({
	formType: "followup",
	operations: () => operations,
	...extra,
});

interface ClauseRow {
	readonly clause: AdvancedIneligibility;
	readonly action: "load" | "open";
	/** Where CommCare HQ holds the rule, `file::symbol`. */
	readonly source: string;
	readonly subject: Uuid;
	readonly refused: AdvancedFixtureOptions;
	readonly accepted: AdvancedFixtureOptions;
	/**
	 * Where no document the commit gate admits holds the refused shape: the
	 * code the gate refuses it with, and why. Such a row's refused twin never
	 * reaches CommCare HQ, so the shapes file lists it apart from the rows
	 * `proof/hq/test_advanced_rules.py` exports.
	 */
	readonly unreachable?: { readonly code: string; readonly why: string };
}

const ROWS: readonly ClauseRow[] = [
	// A load.
	{
		clause: "scope",
		action: "load",
		source: "models/form_actions.py::LoadUpdateAction",
		subject: OP("u"),
		refused: followup([
			own(),
			update("u", { kind: "session" }, { forEach: { repeat: U("kids") } }),
		]),
		accepted: followup([own(), update("u", { kind: "session" })]),
	},
	{
		clause: "value-not-a-question",
		action: "load",
		source: "helpers/validators.py::IndexedFormBaseValidator.check_paths",
		subject: OWN,
		refused: followup([
			own({ writes: [{ property: "remark", value: concat(read("name")) }] }),
		]),
		accepted: followup([
			own({ writes: [{ property: "remark", value: read("name") }] }),
		]),
	},
	{
		clause: "write-condition",
		action: "load",
		source: "models/form_actions.py::ConditionalCaseUpdate",
		subject: OWN,
		refused: followup([
			own({
				writes: [
					{ property: "age", value: read("age"), condition: STATUS_YES },
				],
			}),
		]),
		accepted: followup([
			own({ writes: [{ property: "age", value: read("age") }] }),
		]),
	},
	{
		clause: "condition-not-stateable",
		action: "load",
		source: "xform.py::XForm.action_relevance",
		subject: OP("c"),
		refused: followup(
			[
				own(),
				close(
					"c",
					{ kind: "expression", expr: chosen(HOUSEHOLDS) },
					{
						condition: AGE_IS_THREE,
					},
				),
			],
			{ menu: "members" },
		),
		accepted: followup(
			[
				own(),
				close(
					"c",
					{ kind: "expression", expr: chosen(HOUSEHOLDS) },
					{
						condition: STATUS_YES,
					},
				),
			],
			{ menu: "members" },
		),
	},
	{
		clause: "via-on-indexed-load",
		action: "load",
		source:
			"helpers/validators.py::IndexedFormBaseValidator.check_case_properties",
		subject: OWN,
		unreachable: {
			code: "CASE_WRITE_VIA_INVALID",
			why: "The clause gives the own arm Save to Case, where a save to the case above has no spelling, so the gate refuses the write (reason `placement`).",
		},
		refused: followup(
			[
				own({
					writes: [
						{
							property: "age",
							value: read("age"),
							via: [{ identifier: "parent" }],
						},
					],
				}),
			],
			{ menu: "members" },
		),
		accepted: followup(
			[
				own({
					writes: [
						{
							property: "age",
							value: read("age"),
							via: [{ identifier: "parent" }],
						},
					],
				}),
			],
			{ menu: "visits" },
		),
	},
	{
		clause: "owner",
		action: "load",
		source: "helpers/validators.py::IndexedFormBaseValidator.check_paths",
		subject: OWN,
		refused: followup([own({ owner: { kind: "acting-user" } as never })]),
		accepted: followup([own({ owner: read("owner_q") })]),
	},
	{
		clause: "retype",
		action: "load",
		source: "static/app_manager/json/case-reserved-words.json",
		subject: OP("u"),
		refused: followup(
			[
				own(),
				update(
					"u",
					{ kind: "expression", expr: chosen(HOUSEHOLDS) },
					{
						retype: "visit",
					},
				),
			],
			{ menu: "members" },
		),
		accepted: followup(
			[own(), update("u", { kind: "expression", expr: chosen(HOUSEHOLDS) })],
			{ menu: "members" },
		),
	},
	{
		clause: "link-target",
		action: "load",
		source: "models/form_actions.py::LoadUpdateAction.case_index",
		subject: OWN,
		refused: followup(
			[
				own({
					links: [
						{
							identifier: "host",
							targetType: "household",
							target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
							relationship: "extension",
						},
					],
				}),
			],
			{ menu: "members" },
		),
		accepted: followup([own()], { menu: "members" }),
	},
	// An open action.
	{
		clause: "keyed",
		action: "open",
		source: "xform.py::XForm._create_casexml_advanced",
		subject: OP("kid"),
		refused: registration(
			create("kid", { target: { kind: "new", idFrom: U("name") } }),
		),
		accepted: registration(create("kid")),
	},
	{
		clause: "value-not-a-question",
		action: "open",
		source: "helpers/validators.py::IndexedFormBaseValidator.check_paths",
		subject: OP("kid"),
		refused: registration(create("kid", { name: concat(read("name")) })),
		accepted: registration(create("kid")),
	},
	{
		clause: "name-repeat",
		action: "open",
		source: "static/app_manager/js/forms/advanced/actions.js::repeat_context",
		subject: OP("kid"),
		refused: registration(
			create("kid", { repeat: "kids", name: read("name") }),
		),
		accepted: registration(create("kid", { repeat: "kids" })),
	},
	{
		clause: "write-condition",
		action: "open",
		source: "models/form_actions.py::ConditionalCaseUpdate",
		subject: OP("kid"),
		refused: registration(
			create("kid", {
				writes: [
					{ property: "age", value: read("age"), condition: STATUS_YES },
				],
			}),
		),
		accepted: registration(
			create("kid", { writes: [{ property: "age", value: read("age") }] }),
		),
	},
	{
		clause: "condition-not-stateable",
		action: "open",
		source: "xform.py::XForm.action_relevance",
		subject: OP("kid"),
		refused: registration(create("kid", { condition: AGE_IS_THREE })),
		accepted: registration(create("kid", { condition: STATUS_YES })),
	},
	{
		clause: "owner",
		action: "open",
		source: "xform.py::autoset_owner_id_for_advanced_action",
		subject: OP("kid"),
		refused: registration(create("kid", { owner: concat(read("owner_q")) })),
		accepted: registration(create("kid", { owner: read("owner_q") })),
	},
	{
		clause: "link-target",
		action: "open",
		source: "helpers/validators.py::AdvancedFormValidator.check_actions",
		subject: OP("kid"),
		refused: registration(
			create("kid", { links: [{ ...OWN_LINK, target: null }] }),
		),
		accepted: registration(create("kid")),
	},
	{
		clause: "link-renamed-load",
		action: "open",
		source: "xform.py::XForm._create_casexml_advanced",
		subject: OP("visit"),
		refused: followup(
			[
				own(),
				create("visit", {
					caseType: "visit",
					links: [
						{
							...OWN_LINK,
							target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
						},
					],
				}),
			],
			{ menu: "members", nested: true },
		),
		accepted: followup(
			[
				own(),
				create("visit", {
					caseType: "visit",
					links: [
						{
							...OWN_LINK,
							target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
						},
					],
				}),
			],
			{ menu: "members" },
		),
	},
	{
		clause: "repeat-shared",
		action: "open",
		source: "xform.py::get_action_path",
		subject: OP("pet"),
		refused: registration(
			create("kid", { repeat: "kids", links: [] }),
			create("pet", { repeat: "kids", links: [] }),
		),
		accepted: registration(
			create("kid", { repeat: "kids" }),
			create("pet", { repeat: "kids" }),
		),
	},
	{
		clause: "type-not-a-menu",
		action: "open",
		source: "xform.py::check_case_type",
		subject: OP("kid"),
		refused: registration(create("kid", { caseType: "pet", links: [] })),
		accepted: registration(create("kid", { caseType: "visit", links: [] })),
	},
	{
		clause: "case-changed-before-create",
		action: "open",
		source: "xform.py::XForm._create_casexml_advanced",
		subject: OP("kid"),
		refused: registration(
			create("kid"),
			update("fix", { kind: "op", opUuid: OP("kid") }, { caseType: "member" }),
		),
		accepted: registration(
			create("kid"),
			close("done", { kind: "op", opUuid: OP("kid") }, { caseType: "member" }),
		),
	},
];

function verdict(row: ClauseRow, options: AdvancedFixtureOptions) {
	const { doc, formUuid } = advancedFixture(options);
	const clause =
		row.action === "load"
			? loadIneligibility(doc, formUuid, row.subject)
			: openActionIneligibility(doc, formUuid, row.subject);
	const planned = planPlacements(doc, formUuid).placements.get(row.subject);
	return { doc, formUuid, clause, planned };
}

describe("advanced action clauses", () => {
	for (const row of ROWS)
		it(`${row.action}: ${row.clause}`, () => {
			const refused = verdict(row, row.refused);
			expect(planPlacements(refused.doc, refused.formUuid).formKind).toBe(
				"advanced",
			);
			expect(refused.clause).toBe(row.clause);
			expect(refused.planned?.placement.kind).toBe("save-to-case");
			const accepted = verdict(row, row.accepted);
			expect(accepted.clause).toBeUndefined();
			expect(accepted.planned?.placement.kind).toBe("advanced");
		});

	// The HQ rule test exports each twin, so each is a document the commit
	// gate admits and the emitter writes, apart from a refused shape no
	// admitted document holds, which the gate refuses with the code named.
	for (const row of ROWS)
		it(`${row.action}: ${row.clause} twins are admitted`, () => {
			const twins = [
				["accepted", row.accepted],
				...(row.unreachable === undefined
					? [["refused", row.refused] as const]
					: []),
			] as const;
			for (const [side, options] of twins) {
				const { doc } = advancedFixture(options);
				expect(
					runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((f) => f.code),
					side,
				).toEqual([]);
				expect(() => expandDoc(doc), side).not.toThrow();
			}
			if (row.unreachable !== undefined) {
				const { doc } = advancedFixture(row.refused);
				expect(
					runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((f) => f.code),
				).toContain(row.unreachable.code);
			}
		});
});

describe("the advanced procedure", () => {
	it("tags the chain's loads root first, the own load last, and the worker's after them", () => {
		const { doc, formUuid } = advancedFixture(
			followup(
				[
					own({ writes: [{ property: "age", value: read("age") }] }),
					update("household", {
						kind: "expression",
						expr: chosen(HOUSEHOLDS),
					}),
					{
						uuid: OP("worker"),
						id: "worker",
						action: "update",
						caseType: "commcare-user",
						target: { kind: "worker-record" },
						writes: [{ property: "age", value: read("age") }],
					} as CaseOperation,
				],
				{ menu: "members" },
			),
		);
		expect(advancedFormLoads(doc, formUuid)).toEqual([
			{
				tag: "load_household0",
				caseType: "household",
				listModule: HOUSEHOLDS,
				own: false,
				worker: false,
			},
			{
				tag: "load_member1",
				caseType: "member",
				listModule: MEMBERS,
				index: { tag: "load_household0", identifier: "parent" },
				own: true,
				worker: false,
			},
			{
				tag: "autoload_commcare_user2",
				caseType: "commcare-user",
				listModule: null,
				own: false,
				worker: true,
			},
		]);
		const { placements } = planPlacements(doc, formUuid);
		expect(placements.get(OWN)?.placement).toEqual({
			kind: "advanced",
			tag: "load_member1",
		});
		expect(placements.get(OP("household"))?.placement).toEqual({
			kind: "advanced",
			tag: "load_household0",
		});
		expect(placements.get(OP("worker"))?.placement).toEqual({
			kind: "advanced",
			tag: "autoload_commcare_user2",
		});
	});

	it("names each load's list menu by the id the export gives that menu", () => {
		const { doc, formUuid } = advancedFixture(
			followup(
				[
					own({ writes: [{ property: "age", value: read("age") }] }),
					update("household", {
						kind: "expression",
						expr: chosen(HOUSEHOLDS),
					}),
				],
				{ menu: "members" },
			),
		);
		const householdsId = "a".repeat(32);
		const membersId = "b".repeat(32);
		const hq = expandDoc(doc, {
			identity: targetWireIdentity([
				{
					entityKind: "module",
					novaEntityUuid: HOUSEHOLDS,
					uniqueId: householdsId,
					xmlns: null,
				},
				{
					entityKind: "module",
					novaEntityUuid: MEMBERS,
					uniqueId: membersId,
					xmlns: null,
				},
			]),
		});
		const moduleIds = hq.modules.map((module) => module.unique_id);
		expect(moduleIds).toContain(householdsId);
		expect(moduleIds).toContain(membersId);
		const forms: readonly (HqForm | HqAdvancedForm)[] = hq.modules.flatMap(
			(module): readonly (HqForm | HqAdvancedForm)[] => module.forms,
		);
		const form = forms.find(
			(candidate) => candidate.unique_id === derivedUniqueId(formUuid),
		);
		expect(form?.doc_type).toBe("AdvancedForm");
		const loads =
			form?.doc_type === "AdvancedForm" ? form.actions.load_update_cases : [];
		expect(loads.map((load) => load.details_module)).toEqual([
			householdsId,
			membersId,
		]);
	});

	it("puts a registration's own case first among the open actions, and shares a close with the open action it closes", () => {
		const { doc, formUuid } = advancedFixture(
			registration(
				create("kid"),
				close(
					"done",
					{ kind: "op", opUuid: OP("kid") },
					{
						caseType: "member",
						condition: STATUS_YES,
					},
				),
			),
		);
		const { placements, advanced } = planPlacements(doc, formUuid);
		expect(advanced?.opens.map((open) => open.tag)).toEqual([
			"open_household_0",
			"open_member_1",
		]);
		expect(placements.get(OP("done"))).toEqual({
			placement: { kind: "advanced", tag: "open_member_1" },
			held: false,
			sharesWith: OP("kid"),
		});
	});

	it("shares a close form's own close with its own load where the condition can be stated", () => {
		const closeForm = (closeCondition: typeof STATUS_YES) =>
			advancedFixture({
				formType: "close",
				operations: () => [own()],
				form: { closeCondition },
			});
		const stated = closeForm(STATUS_YES);
		expect(
			planPlacements(stated.doc, stated.formUuid).placements.get("own-close"),
		).toEqual({
			placement: { kind: "advanced", tag: "load_household0" },
			held: false,
			sharesWith: OWN,
		});
		const unstated = closeForm(AGE_IS_THREE);
		expect(
			planPlacements(unstated.doc, unstated.formUuid).placements.get(
				"own-close",
			)?.placement.kind,
		).toBe("save-to-case");
	});

	it("writes an open action at its row where its repeat holds fewer than two indexed open actions", () => {
		const one = advancedFixture(
			registration(create("kid", { repeat: "kids" })),
		);
		expect(
			planPlacements(one.doc, one.formUuid).placements.get(OP("kid"))
				?.placement,
		).toEqual({ kind: "advanced", tag: "open_member_1", row: true });
		const two = advancedFixture(
			registration(
				create("kid", { repeat: "kids" }),
				create("pet", { repeat: "kids" }),
			),
		);
		expect(
			planPlacements(two.doc, two.formUuid).placements.get(OP("kid"))
				?.placement,
		).toEqual({ kind: "advanced", tag: "open_member_1" });
	});

	it("keeps a held tag and steps a derived one around it and around root questions", () => {
		const { doc, formUuid } = advancedFixture({
			...registration(
				create("kid", {
					placement: { kind: "advanced", tag: "open_member_1" },
				}),
			),
			configure: (d) => {
				// A root question named like the own case's derived block.
				const name = d.fields[U("name")];
				if (name !== undefined)
					d.fields[U("name")] = { ...name, id: "case_open_household_0" };
			},
		});
		const { placements, inexpressible } = planPlacements(doc, formUuid);
		expect(placements.get(OWN)?.placement).toEqual({
			kind: "advanced",
			tag: "open_household_1",
		});
		expect(placements.get(OP("kid"))).toEqual({
			placement: { kind: "advanced", tag: "open_member_1" },
			held: true,
		});
		expect(inexpressible).toEqual([]);
	});

	it("refuses a held basic slot in an advanced form, and a held advanced action in a basic one", () => {
		const advanced = advancedFixture(
			registration(
				create("kid", {
					placement: { kind: "basic", slot: "subcase", index: 0 },
				}),
			),
		);
		expect(
			planPlacements(advanced.doc, advanced.formUuid).inexpressible[0]
				?.reasons[0],
		).toEqual({ reason: "module-advanced" });
		const basic = advancedFixture({
			...registration(
				create("kid", {
					placement: { kind: "advanced", tag: "open_member_1" },
				}),
			),
			heldKind: false,
		});
		expect(planPlacements(basic.doc, basic.formUuid).formKind).toBe("basic");
		expect(
			planPlacements(basic.doc, basic.formUuid).inexpressible[0]?.reasons,
		).toEqual([{ reason: "module-basic" }]);
	});

	it("offers the advanced action, then Save to Case", () => {
		const { doc, formUuid } = advancedFixture(registration(create("kid")));
		expect(
			placementCandidates(doc, formUuid, {
				kind: "operation",
				operationUuid: OP("kid"),
			}),
		).toEqual([
			{ kind: "advanced", tag: "open_member_1" },
			{ kind: "save-to-case", path: ["nova_operations", "kid"] },
		]);
		expect(
			placementIneligibility(
				doc,
				formUuid,
				{ kind: "operation", operationUuid: OP("kid") },
				{ kind: "advanced", tag: "open_household_0" },
			),
		).toEqual([{ reason: "scope" }]);
	});
});

// ── The shapes HQ's own models build (`test_advanced_rules.py`) ─────────

const SHAPES_PATH = resolve(
	import.meta.dirname,
	"../../../proof/hq/fixtures/advanced-rule-shapes.json",
);

function shapeOf(row: ClauseRow, options: AdvancedFixtureOptions) {
	const { doc, formUuid, planned } = verdict(row, options);
	const form = doc.forms[formUuid];
	return {
		formType: form?.type,
		menu: options.menu ?? "households",
		nested: options.nested === true,
		operations: form?.caseOperations ?? [],
		...(form?.openCondition !== undefined && {
			openCondition: form.openCondition,
		}),
		...(form?.closeCondition !== undefined && {
			closeCondition: form.closeCondition,
		}),
		placement: planned?.placement,
	};
}

/** The fixture's questions by uuid, as the paths HQ's actions name, and
 *  its menus by uuid. */
function fixtureNames() {
	const { doc, formUuid } = advancedFixture({ formType: "followup" });
	const questions: Record<string, string> = {};
	for (const [uuid, location] of collectFieldLocations(doc, formUuid))
		questions[uuid] = location.path.toXPath();
	const menus: Record<string, { name: string; caseType: string }> = {};
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (module !== undefined)
			menus[moduleUuid] = {
				name: module.name,
				caseType: module.caseType ?? "",
			};
	}
	return { questions, menus };
}

function ruleShapes(): string {
	const shapes = {
		about:
			"Each eligibility clause of Nova's advanced actions (lib/commcare/advancedPlacement.ts) as a pair of forms that differ in that clause alone: `refused` holds the shape Nova keeps from an advanced action (its change takes Save to Case), `accepted` the twin it places on one; every twin is a document Nova's commit gate admits. `unreachable` names each clause whose refused shape no admitted document holds, and the code the gate refuses it with. Written by lib/commcare/__tests__/advancedPlacement.test.ts; read by proof/hq/test_advanced_rules.py.",
		fixture: "lib/commcare/__tests__/advancedPlacementFixture.ts",
		...fixtureNames(),
		rows: ROWS.filter((row) => row.unreachable === undefined).map((row) => ({
			clause: row.clause,
			action: row.action,
			source: `corehq/apps/app_manager/${row.source}`,
			subject: row.subject,
			refused: shapeOf(row, row.refused),
			accepted: shapeOf(row, row.accepted),
		})),
		unreachable: ROWS.flatMap((row) =>
			row.unreachable === undefined
				? []
				: [
						{
							clause: row.clause,
							action: row.action,
							source: `corehq/apps/app_manager/${row.source}`,
							refusedBy: row.unreachable.code,
							why: row.unreachable.why,
						},
					],
		),
	};
	return `${JSON.stringify(shapes, null, "\t")}\n`;
}

describe("advanced-rule-shapes.json", () => {
	it("is the shapes these rows write", () => {
		const written = ruleShapes();
		if (process.env.NOVA_WRITE_ADVANCED_RULE_SHAPES === "1")
			writeFileSync(SHAPES_PATH, written);
		expect(
			existsSync(SHAPES_PATH),
			"proof/hq/fixtures/advanced-rule-shapes.json is missing. Write it with NOVA_WRITE_ADVANCED_RULE_SHAPES=1 npx vitest run lib/commcare/__tests__/advancedPlacement.test.ts.",
		).toBe(true);
		expect(
			readFileSync(SHAPES_PATH, "utf8"),
			"proof/hq/fixtures/advanced-rule-shapes.json differs from the shapes these rows write. Write it again with NOVA_WRITE_ADVANCED_RULE_SHAPES=1 npx vitest run lib/commcare/__tests__/advancedPlacement.test.ts and commit the change.",
		).toBe(written);
	});
});
