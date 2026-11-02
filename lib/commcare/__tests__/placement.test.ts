/**
 * Where each case change of a form is kept in CommCare HQ. Each eligibility
 * condition is a pair: a form where it holds and the slot is chosen, and
 * the same form changed in that condition alone, where the slot is refused
 * with the reason a person reads. Catches an operation emitted where HQ's
 * Case Management page would rewrite it, and a held path that silently
 * changes.
 */
import { describe, expect, it } from "vitest";
import {
	type PlacementSubject,
	placementCandidates,
	placementIneligibility,
	planPlacements,
	statedCondition,
} from "@/lib/commcare/placement";
import type { CaseOperation, CasePlacement, Form, Uuid } from "@/lib/domain";
import {
	concat,
	eq,
	literal,
	matchNone,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import {
	childCreate,
	type FixtureOptions,
	OP,
	OPT,
	OWN,
	own,
	ownCaseLink,
	placementFixture,
	read,
	U,
} from "./placementFixture";

const choice = (field: string, ...values: string[]): Expression =>
	({
		kind: "term",
		term: { kind: "choice", field: U(field), options: values.map(OPT) },
	}) as Expression;
const write = (property: string, value: Expression, extra = {}) => ({
	property,
	value,
	...extra,
});
const workerUpdate = (key: string, extra: Partial<CaseOperation> = {}) =>
	({
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "commcare-user",
		target: { kind: "worker-record" },
		writes: [write("age", read("age"))],
		...extra,
	}) as CaseOperation;

function planned(formType: Form["type"], options: FixtureOptions) {
	const { doc, formUuid } = placementFixture(formType, options);
	return {
		doc,
		formUuid,
		placements: planPlacements(doc, formUuid).placements,
	};
}

const OWN_SLOT: CasePlacement = { kind: "basic", slot: "own" };
const USERCASE: CasePlacement = { kind: "basic", slot: "usercase" };
const SUBCASE_0: CasePlacement = { kind: "basic", slot: "subcase", index: 0 };
const SUBCASE_ROW: CasePlacement = { kind: "basic", slot: "subcase-row" };

interface ConditionRow {
	readonly condition: string;
	readonly formType: Form["type"];
	readonly subject: Uuid;
	readonly placement: CasePlacement;
	readonly holds: FixtureOptions;
	readonly fails: FixtureOptions;
	readonly reason: string;
	readonly about?: "open" | "close" | "operation";
}

const followupOwn = (extra: Partial<CaseOperation>): FixtureOptions => ({
	operations: () => [own({ writes: [write("age", read("age"))], ...extra })],
});
const registrationOwn = (
	extra: Partial<CaseOperation> = {},
	more: (t: Form["type"]) => CaseOperation[] = () => [],
	form: FixtureOptions["form"] = {},
): FixtureOptions => ({
	operations: (t) => [own({ name: read("name"), ...extra }), ...more(t)],
	form,
});
const withChild = (
	formType: Form["type"],
	extra: Partial<CaseOperation> & { repeat?: string } = {},
	more: CaseOperation[] = [],
	options: FixtureOptions = {},
): FixtureOptions => ({
	...options,
	operations: (t) => [
		formType === "registration" ? own({ name: read("name") }) : own(),
		childCreate("kid", t, extra),
		...more,
	],
});

const ROWS: readonly ConditionRow[] = [
	// The basic own slot.
	{
		condition: "the form selects one case at a time",
		formType: "followup",
		subject: OWN,
		placement: OWN_SLOT,
		holds: followupOwn({}),
		fails: { ...followupOwn({}), severalCases: true },
		reason: "several-cases",
	},
	{
		condition: "each value is a bare read",
		formType: "followup",
		subject: OWN,
		placement: OWN_SLOT,
		holds: followupOwn({}),
		fails: followupOwn({
			writes: [write("age", concat(read("age"), term(literal("!"))))],
		}),
		reason: "value-computed",
	},
	{
		condition: "no value reads a label",
		formType: "followup",
		subject: OWN,
		placement: OWN_SLOT,
		holds: followupOwn({}),
		fails: followupOwn({ writes: [write("age", read("note"))] }),
		reason: "value-label",
	},
	{
		condition: "no value reads a question in a repeat",
		formType: "followup",
		subject: OWN,
		placement: OWN_SLOT,
		holds: followupOwn({}),
		fails: followupOwn({ writes: [write("age", read("kid_age"))] }),
		reason: "value-in-repeat",
	},
	{
		condition: "no write carries a condition",
		formType: "followup",
		subject: OWN,
		placement: OWN_SLOT,
		holds: followupOwn({}),
		fails: followupOwn({
			writes: [write("age", read("age"), { condition: read("flag") })],
		}),
		reason: "write-condition",
	},
	{
		condition: "the arm has no links",
		formType: "followup",
		subject: OWN,
		placement: OWN_SLOT,
		holds: followupOwn({}),
		fails: followupOwn({
			links: [
				{
					identifier: "host",
					targetType: "household",
					target: { kind: "expression", expr: read("name") },
					relationship: "extension",
				},
			],
		}),
		reason: "links",
	},
	{
		condition: "the open condition is stateable",
		formType: "registration",
		subject: OWN,
		placement: OWN_SLOT,
		holds: registrationOwn({}, () => [], {
			openCondition: eq(read("status"), choice("status", "yes")),
		}),
		fails: registrationOwn({}, () => [], {
			openCondition: eq(read("age"), term(literal("3"))),
		}),
		reason: "condition-question-kind",
		about: "open",
	},
	{
		condition: "no operation changes the case the registration creates",
		formType: "registration",
		subject: OWN,
		placement: OWN_SLOT,
		holds: registrationOwn(),
		fails: registrationOwn({}, () => [
			{
				uuid: OP("later"),
				id: "later",
				action: "update",
				caseType: "patient",
				target: { kind: "op", opUuid: OWN },
				writes: [write("status", read("status"))],
			} as CaseOperation,
		]),
		reason: "case-changed-before-create",
	},
	// The basic usercase slot.
	{
		condition: "the worker's record writes bare reads",
		formType: "survey",
		subject: OP("worker"),
		placement: USERCASE,
		holds: { operations: () => [workerUpdate("worker")] },
		fails: {
			operations: () => [
				workerUpdate("worker", {
					writes: [write("age", concat(read("age"), term(literal("y"))))],
				}),
			],
		},
		reason: "value-computed",
	},
	{
		condition: "the worker's record reads no repeat",
		formType: "survey",
		subject: OP("worker"),
		placement: USERCASE,
		holds: { operations: () => [workerUpdate("worker")] },
		fails: {
			operations: () => [
				workerUpdate("worker", { writes: [write("age", read("kid_age"))] }),
			],
		},
		reason: "value-in-repeat",
	},
	{
		condition: "the worker's record has no write condition",
		formType: "survey",
		subject: OP("worker"),
		placement: USERCASE,
		holds: { operations: () => [workerUpdate("worker")] },
		fails: {
			operations: () => [
				workerUpdate("worker", {
					writes: [write("age", read("age"), { condition: read("flag") })],
				}),
			],
		},
		reason: "write-condition",
	},
	// The basic subcase slot.
	{
		condition: "the subcase's form selects one case",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup"),
		fails: { ...withChild("followup"), severalCases: true },
		reason: "several-cases",
	},
	{
		condition: "the new case's id is minted, not keyed",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup"),
		fails: withChild("followup", {
			target: { kind: "new", idFrom: U("name") },
		}),
		reason: "keyed-id",
	},
	{
		condition: "its one link is a parent link to the own case",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup"),
		fails: withChild("followup", {
			links: [{ ...ownCaseLink("followup"), identifier: "mother" }],
		}),
		reason: "subcase-link",
	},
	{
		condition: "a registration's own arm is basic",
		formType: "registration",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("registration"),
		fails: {
			operations: (t) => [
				own({ name: concat(read("name"), term(literal("!"))) }),
				childCreate("kid", t),
			],
		},
		reason: "own-not-basic",
	},
	{
		condition: "its case type is a menu's",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup"),
		fails: withChild("followup", {
			caseType: "household",
		} as Partial<CaseOperation>),
		reason: "subcase-type",
	},
	{
		condition: "its values are bare reads",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup"),
		fails: withChild("followup", {
			writes: [write("age", concat(read("age"), term(literal("y"))))],
		}),
		reason: "value-computed",
	},
	{
		condition: "its values read its own repeat",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_ROW,
		holds: withChild("followup", {
			repeat: "kids",
			writes: [write("age", read("kid_age"))],
		}),
		fails: withChild("followup", {
			repeat: "kids",
			writes: [write("age", read("pet_name"))],
		}),
		reason: "value-wrong-repeat",
	},
	{
		condition: "its name stands in the repeat it runs in",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_ROW,
		holds: withChild("followup", { repeat: "kids" }),
		fails: withChild("followup", { repeat: "kids", name: read("name") }),
		reason: "name-repeat",
	},
	{
		condition: "no write carries a condition",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup"),
		fails: withChild("followup", {
			writes: [write("age", read("age"), { condition: read("flag") })],
		}),
		reason: "write-condition",
	},
	{
		condition: "its condition is stateable",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup", { condition: read("flag") }),
		fails: withChild("followup", { condition: read("age") }),
		reason: "condition-question-kind",
		about: "operation",
	},
	{
		condition: "nothing else updates the case it creates",
		formType: "followup",
		subject: OP("kid"),
		placement: SUBCASE_0,
		holds: withChild("followup"),
		fails: withChild("followup", {}, [
			{
				uuid: OP("touch"),
				id: "touch",
				action: "update",
				caseType: "kid",
				target: { kind: "op", opUuid: OP("kid") },
				writes: [write("age", read("age"))],
			} as CaseOperation,
		]),
		reason: "case-changed-before-create",
	},
];

describe("each eligibility condition", () => {
	it.each(ROWS)("$condition", (row) => {
		const subject: PlacementSubject = {
			kind: "operation",
			operationUuid: row.subject,
		};
		const holds = planned(row.formType, row.holds);
		expect(holds.placements.get(row.subject)?.placement).toEqual(row.placement);
		expect(
			placementIneligibility(holds.doc, holds.formUuid, subject, row.placement),
		).toEqual([]);

		const fails = planned(row.formType, row.fails);
		expect(fails.placements.get(row.subject)?.placement).not.toEqual(
			row.placement,
		);
		expect(fails.placements.get(row.subject)?.placement.kind).toBe(
			"save-to-case",
		);
		expect(
			placementIneligibility(fails.doc, fails.formUuid, subject, row.placement),
		).toContainEqual(
			row.about === undefined
				? { reason: row.reason }
				: { reason: row.reason, condition: row.about },
		);
	});
});

describe("Save to Case conditions", () => {
	const update = (extra: Partial<CaseOperation> = {}): CaseOperation =>
		({
			uuid: OP("upd"),
			id: "upd",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [write("status", read("status"))],
			...extra,
		}) as CaseOperation;
	const subject: PlacementSubject = {
		kind: "operation",
		operationUuid: OP("upd"),
	};
	const at = (path: [string, ...string[]], repeat?: Uuid): CasePlacement => ({
		kind: "save-to-case",
		...(repeat !== undefined && { repeat }),
		path,
	});

	it("writes a held path verbatim", () => {
		const held = at(["nova_operations", "published_update"]);
		const { placements } = planned("followup", {
			operations: () => [own(), update({ placement: held })],
		});
		expect(placements.get(OP("upd"))).toEqual({ placement: held, held: true });
	});

	it("refuses a held path in another scope", () => {
		const held = at(["nova_operations", "upd"], U("kids"));
		const { doc, formUuid, placements } = planned("followup", {
			operations: () => [own(), update({ placement: held })],
		});
		expect(placementIneligibility(doc, formUuid, subject, held)).toEqual([
			{ reason: "scope" },
		]);
		expect(placements.get(OP("upd"))).toEqual({
			placement: at(["nova_operations", "upd"]),
			held: false,
		});
	});

	it("refuses a held path whose wrappers changed", () => {
		const held = at(["nova_operations", "upd"]);
		const { doc, formUuid, placements } = planned("followup", {
			operations: () => [
				own(),
				update({ placement: held, condition: read("flag") }),
			],
		});
		expect(placementIneligibility(doc, formUuid, subject, held)).toEqual([
			{ reason: "block-shape" },
		]);
		expect(placements.get(OP("upd"))?.placement).toEqual(
			at(["nova_operations", "nova_condition_upd", "upd"]),
		);
	});

	it("refuses a block for a write kept only when it changed, or saved through an index", () => {
		const { doc, formUuid } = planned("followup", {
			operations: () => [
				own({
					writes: [
						write("age", read("age"), { onlyIfChanged: true }),
						write("status", read("status"), {
							via: [{ identifier: "parent" }],
						}),
					],
				}),
			],
		});
		expect(
			placementIneligibility(
				doc,
				formUuid,
				{ kind: "operation", operationUuid: OWN },
				at(["nova_operations", "patient"]),
			),
		).toEqual([{ reason: "only-if-changed" }, { reason: "via" }]);
	});
});

describe("the stateable condition", () => {
	const stated = (condition: Expression, own = true) => {
		const { doc, formUuid } = placementFixture("registration", {
			operations: () => [],
		});
		return statedCondition(doc, formUuid, condition, {
			own,
			repeat: undefined,
		});
	};
	const refused = (
		condition: Expression,
		scope: { own: boolean; repeat?: Uuid } = { own: true },
	) => {
		const { doc, formUuid } = planned("registration", {
			operations: (t) => [
				own({ name: read("name") }),
				childCreate("kid", t, {
					...(scope.repeat !== undefined && { repeat: "kids" }),
					condition,
				}),
			],
			form: scope.own ? { openCondition: condition } : {},
		});
		return scope.own
			? placementIneligibility(
					doc,
					formUuid,
					{ kind: "operation", operationUuid: OWN },
					OWN_SLOT,
				)
			: placementIneligibility(
					doc,
					formUuid,
					{ kind: "operation", operationUuid: OP("kid") },
					scope.repeat !== undefined ? SUBCASE_ROW : SUBCASE_0,
				);
	};

	it("states a question alone, an equality with one choice, and a selection holding one", () => {
		expect(stated(read("flag"))).toEqual({
			question: U("flag"),
			operator: "boolean_true",
		});
		expect(stated(eq(read("status"), choice("status", "yes")))).toEqual({
			question: U("status"),
			answer: "yes",
			operator: "=",
		});
		expect(stated(eq(term(literal("x")), read("flag")))).toEqual({
			question: U("flag"),
			answer: "x",
			operator: "=",
		});
		expect(
			stated({
				kind: "multi-select-contains",
				property: read("tags"),
				values: [{ kind: "choice", field: U("tags"), options: [OPT("red")] }],
				quantifier: "any",
			} as Expression),
		).toEqual({ question: U("tags"), answer: "red", operator: "selected" });
	});

	it("refuses every other shape and each broken rule", () => {
		const open = (reason: string) => [{ reason, condition: "open" }];
		expect(refused(eq(read("name"), term(literal("x"))))).toEqual(
			open("condition-question-kind"),
		);
		expect(refused(eq(read("kid_flag"), term(literal("x"))))).toEqual(
			open("condition-question-repeat"),
		);
		expect(refused(eq(read("flag"), term(literal("it's"))))).toEqual(
			open("condition-apostrophe"),
		);
		expect(refused(eq(read("flag"), term(literal('"q"'))))).toEqual(
			open("condition-quote-boundary"),
		);
		expect(refused(eq(read("status"), term(literal("maybe"))))).toEqual(
			open("condition-not-a-choice"),
		);
		expect(refused(eq(read("status"), choice("status", "yes", "no")))).toEqual(
			open("condition-shape"),
		);
		expect(refused(matchNone())).toEqual(open("condition-shape"));
	});

	it("strips no boundary quote from a child's answer, and reads a child's own repeat", () => {
		expect(
			refused(eq(read("flag"), term(literal('"q"'))), { own: false }),
		).toEqual([]);
		expect(
			refused(eq(read("kid_flag"), term(literal("x"))), {
				own: false,
				repeat: U("kids"),
			}),
		).toEqual([]);
	});
});

describe("the procedure", () => {
	it("admits a registration in a menu that selects several cases", () => {
		const { placements } = planned("registration", {
			...registrationOwn(),
			severalCases: true,
		});
		expect(placements.get(OWN)?.placement).toEqual(OWN_SLOT);
	});

	it("gives the usercase slot to the first worker's record and child slots in array order", () => {
		const { placements } = planned("followup", {
			operations: (t) => [
				own(),
				workerUpdate("w1"),
				workerUpdate("w2"),
				childCreate("first", t),
				childCreate("second", t),
			],
		});
		expect(placements.get(OP("w1"))?.placement).toEqual(USERCASE);
		expect(placements.get(OP("w2"))?.placement.kind).toBe("save-to-case");
		expect(placements.get(OP("first"))?.placement).toEqual(SUBCASE_0);
		expect(placements.get(OP("second"))?.placement).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 1,
		});
	});

	it("writes a repeat's only subcase at its row and two at their indices", () => {
		const one = planned("followup", {
			operations: (t) => [own(), childCreate("a", t, { repeat: "kids" })],
		});
		expect(one.placements.get(OP("a"))?.placement).toEqual(SUBCASE_ROW);
		const two = planned("followup", {
			operations: (t) => [
				own(),
				childCreate("a", t, { repeat: "kids" }),
				childCreate("b", t, { repeat: "kids" }),
			],
		});
		expect(two.placements.get(OP("a"))?.placement).toEqual(SUBCASE_0);
		expect(two.placements.get(OP("b"))?.placement).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 1,
		});
	});

	it("keeps held indices and fills the gaps lowest first", () => {
		const { placements } = planned("followup", {
			operations: (t) => [
				own(),
				childCreate("a", t),
				childCreate("b", t, { placement: SUBCASE_0 }),
				childCreate("c", t),
			],
		});
		expect(placements.get(OP("a"))?.placement).toEqual({
			...SUBCASE_0,
			index: 1,
		});
		expect(placements.get(OP("b"))).toEqual({
			placement: SUBCASE_0,
			held: true,
		});
		expect(placements.get(OP("c"))?.placement).toEqual({
			...SUBCASE_0,
			index: 2,
		});
	});

	it("refuses a held index past the form's subcases", () => {
		const held: CasePlacement = { kind: "basic", slot: "subcase", index: 2 };
		const { doc, formUuid, placements } = planned("followup", {
			operations: (t) => [
				own(),
				childCreate("a", t),
				childCreate("b", t, { placement: held }),
			],
		});
		expect(
			placementIneligibility(
				doc,
				formUuid,
				{ kind: "operation", operationUuid: OP("b") },
				held,
			),
		).toEqual([{ reason: "subcase-index" }]);
		expect(placements.get(OP("b"))).toEqual({
			placement: { ...SUBCASE_0, index: 1 },
			held: false,
		});
	});

	it("refuses a held row once its repeat holds a second subcase", () => {
		const { doc, formUuid } = planned("followup", {
			operations: (t) => [
				own(),
				childCreate("a", t, { repeat: "kids", placement: SUBCASE_ROW }),
				childCreate("b", t, { repeat: "kids" }),
			],
		});
		expect(
			placementIneligibility(
				doc,
				formUuid,
				{ kind: "operation", operationUuid: OP("a") },
				SUBCASE_ROW,
			),
		).toEqual([{ reason: "subcase-nesting" }]);
	});

	it("carries the allocator's exact path, suffix included", () => {
		const { placements } = planned("followup", {
			extraRoot: [{ kind: "text", id: "nova_operations" }],
			operations: () => [
				own(),
				{
					uuid: OP("upd"),
					id: "upd",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					condition: read("flag"),
					writes: [write("status", read("name"))],
				} as CaseOperation,
			],
		});
		expect(placements.get(OP("upd"))?.placement).toEqual({
			kind: "save-to-case",
			path: ["nova_operations_1", "nova_condition_upd", "upd"],
		});
	});

	it("sends an excluded create to Save to Case", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [own(), childCreate("kid", t)],
		});
		expect(
			planPlacements(doc, formUuid, {
				excludeBasic: new Set([OP("kid")]),
			}).placements.get(OP("kid"))?.placement,
		).toEqual({ kind: "save-to-case", path: ["nova_operations", "kid"] });
		expect(
			planPlacements(doc, formUuid).placements.get(OP("kid"))?.placement,
		).toEqual(SUBCASE_0);
	});

	it("places a field-written extension child like any create: Save to Case, with the children after it renumbered", () => {
		const { placements } = planned("followup", {
			operations: (t) => [
				own(),
				childCreate("ext", t, { links: [ownCaseLink(t, "extension")] }),
				childCreate("kid", t, { repeat: "kids" }),
				childCreate("pet", t, { repeat: "kids" }),
			],
		});
		expect(placements.get(OP("ext"))).toEqual({
			placement: { kind: "save-to-case", path: ["nova_operations", "ext"] },
			held: false,
		});
		// The extension child counts in no repeat and takes no index.
		expect(placements.get(OP("kid"))?.placement).toEqual(SUBCASE_0);
		expect(placements.get(OP("pet"))?.placement).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 1,
		});
	});

	it("keeps an extension child in a repeat out of its repeat's subcase count", () => {
		const { placements } = planned("followup", {
			operations: (t) => [
				own(),
				childCreate("kid", t, { repeat: "kids" }),
				childCreate("ext", t, {
					repeat: "kids",
					links: [ownCaseLink(t, "extension")],
				}),
			],
		});
		expect(placements.get(OP("kid"))?.placement).toEqual(SUBCASE_ROW);
		expect(placements.get(OP("ext"))?.placement).toEqual({
			kind: "save-to-case",
			repeat: U("kids"),
			path: ["nova_operations", "ext"],
		});
	});

	it("sends an unheld create of the menu's own case type to Save to Case, which it never reports", () => {
		const sameType = (t: Form["type"]) =>
			({ ...childCreate("twin", t), caseType: "patient" }) as CaseOperation;
		const { doc, formUuid, placements } = planned("followup", {
			operations: (t) => [own(), sameType(t)],
		});
		expect(placements.get(OP("twin"))?.placement).toEqual({
			kind: "save-to-case",
			path: ["nova_operations", "twin"],
		});
		expect(
			placementIneligibility(
				doc,
				formUuid,
				{ kind: "operation", operationUuid: OP("twin") },
				SUBCASE_0,
			),
		).toEqual([]);
	});

	it("reads a create's link, not its type's catalog parent", () => {
		const visit = (t: Form["type"], target: CaseOperation["target"] | null) =>
			({
				...childCreate("visit", t),
				caseType: "visit",
				links: [{ ...ownCaseLink(t), target }],
			}) as CaseOperation;
		const linked = planned("followup", {
			operations: (t) => [own(), visit(t, { kind: "session" })],
		});
		expect(linked.placements.get(OP("visit"))?.placement).toEqual(SUBCASE_0);
		const elsewhere = planned("followup", {
			operations: (t) => [
				own(),
				visit(t, { kind: "expression", expr: read("name") }),
			],
		});
		expect(elsewhere.placements.get(OP("visit"))?.placement.kind).toBe(
			"save-to-case",
		);
		expect(
			placementIneligibility(
				elsewhere.doc,
				elsewhere.formUuid,
				{ kind: "operation", operationUuid: OP("visit") },
				SUBCASE_0,
			),
		).toEqual([{ reason: "subcase-link" }]);
	});

	it("lets a close share the subcase it closes, as its close condition", () => {
		const { placements } = planned("followup", {
			operations: (t) => [
				own(),
				childCreate("kid", t),
				{
					uuid: OP("shut"),
					id: "shut",
					action: "close",
					caseType: "kid",
					target: { kind: "op", opUuid: OP("kid") },
					condition: read("flag"),
				} as CaseOperation,
			],
		});
		expect(placements.get(OP("kid"))?.placement).toEqual(SUBCASE_0);
		expect(placements.get(OP("shut"))).toEqual({
			placement: SUBCASE_0,
			held: false,
			sharesWith: OP("kid"),
		});
	});

	it("shares the own close with a basic own arm only where Case Management states it", () => {
		const stateable = planned("close", {
			operations: () => [own()],
			form: { closeCondition: read("flag") },
		});
		expect(stateable.placements.get("own-close")).toEqual({
			placement: OWN_SLOT,
			held: false,
			sharesWith: OWN,
		});
		const apart = planned("close", {
			operations: () => [own()],
			form: { closeCondition: read("name") },
		});
		expect(apart.placements.get(OWN)?.placement).toEqual(OWN_SLOT);
		expect(apart.placements.get("own-close")).toEqual({
			placement: {
				kind: "save-to-case",
				path: ["nova_operations", "nova_condition_close", "nova_close"],
			},
			held: false,
		});
		const several = planned("close", {
			operations: () => [own()],
			severalCases: true,
		});
		expect(several.placements.get("own-close")?.placement).toEqual({
			kind: "save-to-case",
			path: [
				"nova_selected_cases",
				"item",
				"nova_operations",
				"nova_close_selected_cases",
			],
		});
	});

	it("lists the candidates simplest first", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own(),
				{ ...childCreate("twin", t), caseType: "patient" } as CaseOperation,
			],
		});
		expect(
			placementCandidates(doc, formUuid, {
				kind: "operation",
				operationUuid: OP("twin"),
			}),
		).toEqual([
			SUBCASE_0,
			{ kind: "save-to-case", path: ["nova_operations", "twin"] },
		]);
		expect(
			placementCandidates(doc, formUuid, {
				kind: "operation",
				operationUuid: OWN,
			}),
		).toEqual([
			OWN_SLOT,
			{ kind: "save-to-case", path: ["nova_operations", "patient"] },
		]);
	});
});

// Part 02's G3 (N1): HQ's build appends `subcase_<i>` and `commcare_usercase`
// beside a root question of that name, which leaves the form holding the name
// twice, so a slot whose name a question takes is not eligible.
describe("a question named like the block HQ's build appends", () => {
	const subject = (key: string): PlacementSubject => ({
		kind: "operation",
		operationUuid: OP(key),
	});

	it("sends a subcase whose subcase_<i> a root question takes to Save to Case, and renumbers the rest", () => {
		const { doc, formUuid, placements } = planned("followup", {
			extraRoot: [{ kind: "text", id: "subcase_0" }],
			operations: (t) => [
				own(),
				childCreate("first", t),
				childCreate("second", t),
			],
		});
		// `first` would take index 0, whose name the question holds; without
		// it `second` takes index 0, whose name the question still holds, so
		// both take Save to Case.
		expect(placements.get(OP("first"))).toEqual({
			placement: { kind: "save-to-case", path: ["nova_operations", "first"] },
			held: false,
		});
		expect(placements.get(OP("second"))?.placement.kind).toBe("save-to-case");
		expect(
			placementCandidates(doc, formUuid, subject("first")).map((p) => p.kind),
		).toEqual(["save-to-case"]);
	});

	it("keeps the subcase whose index a question does not take", () => {
		const { placements } = planned("followup", {
			extraRoot: [{ kind: "text", id: "subcase_1" }],
			operations: (t) => [
				own(),
				childCreate("first", t),
				childCreate("second", t),
			],
		});
		// `second` would take `subcase_1`, so it takes Save to Case and
		// `first` keeps `subcase_0`.
		expect(placements.get(OP("first"))?.placement).toEqual(SUBCASE_0);
		expect(placements.get(OP("second"))?.placement.kind).toBe("save-to-case");
	});

	it("reads the repeat's rows for two subcases in one repeat, and nothing for a repeat's only subcase", () => {
		const two = planned("followup", {
			extraRoot: [{ kind: "text", id: "subcase_1" }],
			operations: (t) => [
				own(),
				childCreate("a", t, { repeat: "kids" }),
				childCreate("b", t, { repeat: "kids" }),
			],
		});
		// A root `subcase_1` stands beside no block a repeat's subcase writes.
		expect(two.placements.get(OP("b"))?.placement).toEqual({
			...SUBCASE_0,
			index: 1,
		});
		const row = planned("followup", {
			extraRoot: [{ kind: "text", id: "subcase_0" }],
			operations: (t) => [own(), childCreate("a", t, { repeat: "kids" })],
		});
		expect(row.placements.get(OP("a"))?.placement).toEqual(SUBCASE_ROW);
	});

	it("sends the worker's update to Save to Case where a root question is commcare_usercase", () => {
		const { doc, formUuid, placements } = planned("followup", {
			extraRoot: [{ kind: "text", id: "commcare_usercase" }],
			operations: () => [own(), workerUpdate("w")],
		});
		expect(placements.get(OP("w"))?.placement.kind).toBe("save-to-case");
		expect(
			placementCandidates(doc, formUuid, subject("w")).map((p) => p.kind),
		).toEqual(["save-to-case"]);
		const free = planned("followup", {
			operations: () => [own(), workerUpdate("w")],
		});
		expect(free.placements.get(OP("w"))?.placement).toEqual(USERCASE);
	});

	it("keeps a held slot where its name is taken, for the gate to refuse the question", () => {
		const { doc, formUuid, placements } = planned("followup", {
			extraRoot: [
				{ kind: "text", id: "subcase_0" },
				{ kind: "text", id: "commcare_usercase" },
			],
			operations: (t) => [
				own(),
				workerUpdate("w", { placement: USERCASE }),
				childCreate("kid", t, { placement: SUBCASE_0 }),
			],
		});
		expect(placements.get(OP("w"))).toEqual({
			placement: USERCASE,
			held: true,
		});
		expect(placements.get(OP("kid"))).toEqual({
			placement: SUBCASE_0,
			held: true,
		});
		expect(planPlacements(doc, formUuid).inexpressible).toEqual([]);
	});
});

describe("holds the document no longer expresses", () => {
	const own0: PlacementSubject = { kind: "operation", operationUuid: OWN };

	it("lists a held own slot a calculated value strands, and plans it as if unheld", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own({
					placement: OWN_SLOT,
					writes: [write("age", concat(read("age"), term(literal("!"))))],
				}),
			],
		});
		const plan = planPlacements(doc, formUuid);
		expect(plan.inexpressible).toEqual([
			{
				subject: own0,
				held: OWN_SLOT,
				reasons: [{ reason: "value-computed" }],
			},
		]);
		expect(plan.placements.get(OWN)).toEqual({
			placement: { kind: "save-to-case", path: ["nova_operations", "patient"] },
			held: false,
		});
	});

	it("lists a held index past the form's subcases", () => {
		const held: CasePlacement = { kind: "basic", slot: "subcase", index: 2 };
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own(),
				childCreate("a", t),
				childCreate("b", t, { placement: held }),
			],
		});
		expect(planPlacements(doc, formUuid).inexpressible).toEqual([
			{
				subject: { kind: "operation", operationUuid: OP("b") },
				held,
				reasons: [{ reason: "subcase-index" }],
			},
		]);
	});

	it("lists a held own close on a form that no longer closes its case", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [own()],
			form: {
				ownClosePlacement: {
					kind: "save-to-case",
					path: ["nova_operations", "nova_close"],
				},
			},
		});
		const plan = planPlacements(doc, formUuid);
		expect(plan.inexpressible).toEqual([
			{
				subject: { kind: "own-close" },
				held: { kind: "save-to-case", path: ["nova_operations", "nova_close"] },
				reasons: [{ reason: "no-close" }],
			},
		]);
		expect(plan.placements.has("own-close")).toBe(false);
	});

	it("lists nothing for holds that still express their subjects", () => {
		const shut = (placement?: CasePlacement): CaseOperation =>
			({
				uuid: OP("shut"),
				id: "shut",
				action: "close",
				caseType: "kid",
				target: { kind: "op", opUuid: OP("kid") },
				condition: read("flag"),
				...(placement !== undefined && { placement }),
			}) as CaseOperation;
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own({ placement: OWN_SLOT, writes: [write("age", read("age"))] }),
				childCreate("kid", t, { placement: SUBCASE_0 }),
				shut(SUBCASE_0),
			],
		});
		const plan = planPlacements(doc, formUuid);
		expect(plan.inexpressible).toEqual([]);
		expect(plan.placements.get(OP("shut"))).toEqual({
			placement: SUBCASE_0,
			held: true,
			sharesWith: OP("kid"),
		});
		expect(planPlacements(doc, formUuid)).toBe(plan);
	});

	it("lists a close holding a subcase place it no longer shares, and the create its block would now precede", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own(),
				childCreate("kid", t, { placement: SUBCASE_0 }),
				{
					uuid: OP("shut"),
					id: "shut",
					action: "close",
					caseType: "kid",
					target: { kind: "op", opUuid: OP("kid") },
					condition: read("name"),
					placement: SUBCASE_0,
				} as CaseOperation,
			],
		});
		expect(planPlacements(doc, formUuid).inexpressible).toEqual([
			{
				subject: { kind: "operation", operationUuid: OP("kid") },
				held: SUBCASE_0,
				reasons: [{ reason: "case-changed-before-create" }],
			},
			{
				subject: { kind: "operation", operationUuid: OP("shut") },
				held: SUBCASE_0,
				reasons: [
					{ reason: "condition-question-kind", condition: "operation" },
				],
			},
		]);
	});
});
