/**
 * `FORM_LINK_NEEDS_NEW_CASE_DATUM` at the commit gate. An after-submit link
 * that hands a new case to its target needs that case's session value; a
 * menu kept from being advanced, or a create no case action can open, gives
 * none, and the target would open on an empty case. So the edit that adds
 * the link is refused through `mutationCommitVerdict`, the one gate every
 * editor shares, with the validator's message (the SA and MCP) and the
 * builder's sentence, each a person's contract and so asserted whole, one
 * cause at a time, beside a twin that differs only in the cause and is
 * admitted.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type DocSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { formLinkNeedsNewCaseDatumMessage } from "@/lib/commcare/validator/rules/advancedModule";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type Module,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { concat, eq, literal, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { newCaseDatumCauseWords } from "../advancedModule";

const HOUSEHOLDS = testUuid("am-households");
const MEMBERS = testUuid("am-members");
const VISITS = testUuid("am-visits");
const VISIT_HOUSEHOLD = testUuid("am-visit-household");
const ADD_MEMBERS = testUuid("am-add-members");
const CHECK_MEMBER = testUuid("am-check-member");
const REVIEW = testUuid("am-review");
const LINK = testUuid("am-link");
const OP = (key: string): Uuid => testUuid(`am-op-${key}`);
const FIELD = (id: string): Uuid => testUuid(`am-fld-${id}`);
const OPTION = (value: string): Uuid => testUuid(`am-opt-${value}`);

const read = (id: string): Expression =>
	({ kind: "term", term: { kind: "field", uuid: FIELD(id) } }) as Expression;

const field = (spec: Parameters<typeof f>[0]) =>
	f({ ...spec, uuid: `am-fld-${spec.id}` });

/** Every form's questions: a name, a select, a free text and a repeat. */
const questions = () => [
	field({ kind: "text", id: "visit_name" }),
	field({
		kind: "single_select",
		id: "status",
		optionsSource: {
			kind: "inline",
			options: ["yes", "no"].map((value) => ({
				value,
				label: proseText(value),
				uuid: OPTION(value),
			})),
		},
	}),
	field({ kind: "text", id: "note_q" }),
];

/** A create of a visit that extends the case the form opened. */
function visitCreate(
	hostType: string,
	extra: Partial<CaseOperation> = {},
	nameField = "visit_name",
): CaseOperation {
	return {
		uuid: OP("visit"),
		id: "visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: read(nameField),
		links: [
			{
				identifier: "host",
				targetType: hostType,
				target: { kind: "session" },
				relationship: "extension",
			},
		],
		...extra,
	} as CaseOperation;
}

const own = (key: string): CaseOperation =>
	({ uuid: OP(`own-${key}`), id: "own_case", action: "own" }) as CaseOperation;

function memberCreate(identifier: string): CaseOperation {
	return {
		uuid: OP(`member-${identifier}`),
		id: `member_${identifier}`,
		action: "create",
		caseType: "member",
		target: { kind: "new" },
		name: read("member_name"),
		links: [
			{
				identifier,
				targetType: "household",
				target: { kind: "session" },
				relationship: "child",
			} satisfies CaseOperationLink,
		],
	} as CaseOperation;
}

/**
 * Households, Members chosen under a household, and Visits, each with one
 * form. "Visit household" creates a visit extending its household, and
 * "Review visit" opens a visit, so a link from the first to the second
 * hands the new visit on.
 */
function app(configure: (doc: BlueprintDoc) => void = () => {}): BlueprintDoc {
	const columns = () =>
		caseListConfig([{ field: "case_name", header: "Name" }]);
	const spec: DocSpec = {
		caseTypes: [
			{ name: "household", properties: [{ name: "case_name", label: "Name" }] },
			{
				name: "member",
				parent_type: "household",
				properties: [{ name: "case_name", label: "Name" }],
			},
			{
				name: "visit",
				parent_type: "household",
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
		modules: [
			{
				uuid: "am-households",
				name: "Households",
				caseType: "household",
				caseListConfig: columns(),
				forms: [
					{
						uuid: "am-visit-household",
						name: "Visit household",
						type: "followup",
						fields: questions(),
					},
					{
						uuid: "am-add-members",
						name: "Add members",
						type: "followup",
						fields: [field({ kind: "text", id: "member_name" })],
					},
				],
			},
			{
				uuid: "am-members",
				name: "Members",
				caseType: "member",
				parentCaseModuleUuid: "am-households",
				caseListConfig: columns(),
				forms: [
					{
						uuid: "am-check-member",
						name: "Check member",
						type: "followup",
						fields: [field({ kind: "text", id: "check_name" })],
					},
				],
			},
			{
				uuid: "am-visits",
				name: "Visits",
				caseType: "visit",
				caseListConfig: columns(),
				forms: [
					{
						uuid: "am-review",
						name: "Review visit",
						type: "followup",
						fields: [field({ kind: "text", id: "review_note" })],
					},
				],
			},
		],
	};
	// Before the platforms the content runs on are declared from it.
	return buildDoc(spec, (doc) => {
		operations(doc, VISIT_HOUSEHOLD, [own("visit"), visitCreate("household")]);
		operations(doc, ADD_MEMBERS, [own("add")]);
		operations(doc, CHECK_MEMBER, [own("check")]);
		operations(doc, REVIEW, [own("review")]);
		configure(doc);
	});
}

function operations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ops: CaseOperation[],
): void {
	doc.forms[formUuid] = { ...doc.forms[formUuid], caseOperations: ops };
}

function patchModule(
	doc: BlueprintDoc,
	uuid: Uuid,
	patch: (module: Module) => Partial<Module>,
): void {
	doc.modules[uuid] = { ...doc.modules[uuid], ...patch(doc.modules[uuid]) };
}

/** Members lists its cases on their own: a menu chosen under a search-first
 *  menu would read its search. */
function flatMembers(doc: BlueprintDoc): void {
	const { parentCaseModuleUuid: _, ...members } = doc.modules[MEMBERS];
	doc.modules[MEMBERS] = members;
}

/** The edit under test: a link from `formUuid` to "Review visit". */
const addLink = (formUuid: Uuid): Mutation[] => [
	{
		kind: "addFormLink",
		formUuid,
		link: {
			uuid: LINK,
			target: { type: "form", moduleUuid: VISITS, formUuid: REVIEW },
		},
	},
];

/** The gate's two voices for the one finding the edit meets. */
function refusal(
	doc: BlueprintDoc,
	formUuid = VISIT_HOUSEHOLD,
	alongside: readonly string[] = [],
) {
	const verdict = mutationCommitVerdict(
		doc,
		addLink(formUuid),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (verdict.ok) throw new Error("The gate admitted the link.");
	// The destination's other datums are satisfied, so no finding restates
	// this one; `alongside` names a finding a cause also meets of its own.
	expect(verdict.findings.map((finding) => finding.code).sort()).toEqual(
		["FORM_LINK_NEEDS_NEW_CASE_DATUM", ...alongside].sort(),
	);
	const finding = verdict.findings.find(
		(candidate) => candidate.code === "FORM_LINK_NEEDS_NEW_CASE_DATUM",
	);
	if (finding === undefined) throw new Error("No finding names the link.");
	expect(finding.details?.linkUuid).toBe(LINK);
	return { validator: finding.message, builder: userFacingError(finding) };
}

function admitted(doc: BlueprintDoc, formUuid = VISIT_HOUSEHOLD): void {
	const verdict = mutationCommitVerdict(
		doc,
		addLink(formUuid),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings.map((e) => e.message)).toEqual([]);
}

/** Both voices, framed around one cause's clauses. */
function voices(
	reason: string,
	remedy: string,
	form = "Visit household",
): { validator: string; builder: string } {
	return {
		validator: `"${form}" can't hand its new visit case to "Review visit" after it is submitted: ${reason}. You can send that link to the "Visits" menu instead, where workers choose the case, or ${remedy}.`,
		builder: `After "${form}", the link to "Review visit" can't open the new visit case, because ${reason}. You can send it to the "Visits" menu, where workers choose the case, or ${remedy}.`,
	};
}

describe("a menu something keeps from being advanced", () => {
	it("refuses a link from a menu where workers choose several cases", () => {
		const several = (doc: BlueprintDoc) =>
			patchModule(doc, HOUSEHOLDS, (module) => ({
				caseListConfig:
					module.caseListConfig === undefined
						? undefined
						: {
								...module.caseListConfig,
								selection: { kind: "multiple", maximum: 5 },
							},
			}));
		// Carrying several chosen cases into a form that opens one is
		// refused of its own (`FORM_LINK_SELECTION_CARDINALITY`).
		expect(
			refusal(app(several), VISIT_HOUSEHOLD, [
				"FORM_LINK_SELECTION_CARDINALITY",
			]),
		).toEqual(
			voices(
				`"Households" lets workers choose several cases, and CommCare HQ can hand a new case on only from a menu where they choose one`,
				`let workers choose one case in "Households"`,
			),
		);
		admitted(app());
	});

	it("refuses a link from a menu that opens on its Search screen", () => {
		const searchFirst = (doc: BlueprintDoc) => {
			flatMembers(doc);
			patchModule(doc, HOUSEHOLDS, () => ({
				caseSearchConfig: { searchFirst: true },
			}));
		};
		expect(refusal(app(searchFirst))).toEqual(
			voices(
				`"Households" opens on its Search screen, which CommCare HQ can't keep while handing a new case on`,
				`turn Search first off in "Households"`,
			),
		);
		admitted(app(flatMembers));
	});

	it("refuses a link from a menu whose cases link to their parent under two names", () => {
		const carrying = (identifiers: readonly string[]) =>
			app((doc) => {
				operations(doc, VISIT_HOUSEHOLD, [own("visit")]);
				operations(doc, ADD_MEMBERS, [
					own("add"),
					...identifiers.map(memberCreate),
				]);
				operations(doc, CHECK_MEMBER, [
					own("check"),
					visitCreate("member", {}, "check_name"),
				]);
			});
		expect(refusal(carrying(["parent", "household"]), CHECK_MEMBER)).toEqual(
			voices(
				"member cases link to their household case under more than one name (parent, household), so CommCare HQ couldn't tell which ones to list",
				"link them under one name",
				"Check member",
			),
		);
		admitted(carrying(["parent"]), CHECK_MEMBER);
	});
});

describe("a create no case action can open", () => {
	const withVisit = (
		extra: Partial<CaseOperation>,
		trailing: CaseOperation[] = [],
	) =>
		app((doc) =>
			operations(doc, VISIT_HOUSEHOLD, [
				own("visit"),
				visitCreate("household", extra),
				...trailing,
			]),
		);

	it("admits the link where the visit can be a case action", () => {
		admitted(app());
	});

	it("refuses a create that saves a calculated value", () => {
		expect(
			refusal(
				withVisit({
					name: concat(read("visit_name"), term(literal("!"))),
				}),
			),
		).toEqual(
			voices(
				"the new case saves a calculated value",
				"save that value from a question",
			),
		);
	});

	it("refuses a create that saves a value only when a condition holds", () => {
		expect(
			refusal(
				withVisit({
					writes: [
						{
							property: "note",
							value: read("note_q"),
							condition: eq(read("status"), {
								kind: "term",
								term: {
									kind: "choice",
									field: FIELD("status"),
									options: [OPTION("yes")],
								},
							} as Expression),
						},
					],
				} as Partial<CaseOperation>),
			),
		).toEqual(
			voices(
				"one of its values is saved only when a condition holds",
				"save that value every time",
			),
		);
	});

	it("refuses a create under a condition case actions can't state", () => {
		expect(
			refusal(
				withVisit({
					condition: eq(read("note_q"), literal("x")),
				} as Partial<CaseOperation>),
			),
		).toEqual(
			voices(
				"CommCare HQ can't state the condition it is created under",
				"compare a question with one of its choices",
			),
		);
	});

	it("refuses a create whose owner is not one question's answer", () => {
		expect(
			refusal(
				withVisit({
					owner: concat(read("note_q"), term(literal("-x"))),
				} as Partial<CaseOperation>),
			),
		).toEqual(
			voices(
				"its owner comes from a place in your organization",
				"let the worker who submits it own it",
			),
		);
	});

	it("refuses a create that links to a case the form neither chooses nor creates first", () => {
		expect(
			refusal(
				withVisit({
					links: [
						{
							identifier: "host",
							targetType: "household",
							target: { kind: "expression", expr: read("note_q") },
							relationship: "extension",
						},
					],
				} as Partial<CaseOperation>),
			),
		).toEqual(
			voices(
				"it links to a case this form doesn't choose or create first",
				"link it to the case this form opens or creates",
			),
		);
	});

	it("refuses a create another change updates in the same form", () => {
		expect(
			refusal(
				withVisit({}, [
					{
						uuid: OP("touch"),
						id: "touch",
						action: "update",
						caseType: "visit",
						target: { kind: "op", opUuid: OP("visit") },
						writes: [{ property: "note", value: read("note_q") }],
					} as CaseOperation,
				]),
			),
		).toEqual(
			voices(
				"another case change in the form updates or closes it, which CommCare HQ would do before creating it",
				"save those values when it is created",
			),
		);
	});
});

/**
 * Causes no document the gate admits can reach in this step, each worded
 * as the table states it so the copy is held before a shape reaches it:
 * a case list menu item stands beside no form until menus hold both, a
 * carried create runs in no repeat and holds no key, and no clause yet
 * refuses an appended name.
 */
describe("the copy of causes no admitted document reaches yet", () => {
	const words = (cause: Parameters<typeof newCaseDatumCauseWords>[0]) =>
		newCaseDatumCauseWords(cause, "visit");
	const blocked = (why: "filter" | "hidden-owners" | "chosen-before") =>
		words({
			kind: "blocker",
			blocker: { kind: "case-list-menu-item-narrowed", why },
			moduleName: "Households",
		});

	it("words a narrowed case list menu item by what narrows it", () => {
		const reason = (what: string) =>
			`"Households" shows its case list in the menu, and handing a new case on would make that list show every open case, without its ${what}`;
		expect([
			blocked("filter"),
			blocked("hidden-owners"),
			blocked("chosen-before"),
		]).toEqual([
			{
				reason: reason("filter"),
				remedy: "remove the case list from the menu",
			},
			{
				reason: reason("hidden owners"),
				remedy: "remove the case list from the menu",
			},
			{
				reason: reason("parent case"),
				remedy: "remove the case list from the menu",
			},
		]);
	});

	it("words each open action clause a carried create meets nowhere yet", () => {
		const ineligible = (
			reason: Parameters<typeof newCaseDatumCauseWords>[0] & {
				kind: "ineligible";
			},
		) => words(reason);
		expect(
			(
				[
					"name-repeat",
					"link-renamed-load",
					"repeat-shared",
					"type-not-a-menu",
					"appended-name-taken",
				] as const
			).map((reason) => ineligible({ kind: "ineligible", reason })),
		).toEqual([
			{
				reason: "the new case takes its name from a question in another repeat",
				remedy: "name it from a question in its own repeat",
			},
			{
				reason: "it links to a case this menu shares with the menu above it",
				remedy: "link it to this form's own case",
			},
			{
				reason:
					"it shares its repeat with another new case that links to nothing",
				remedy: "link both to a case",
			},
			{
				reason: "no menu lists visit cases",
				remedy: "add a menu for visit cases",
			},
			{
				reason:
					"a question at the top of the form takes the name CommCare HQ gives its case block",
				remedy: "rename that question",
			},
		]);
	});

	it("sends the link to the home screen where no menu is offered", () => {
		expect(
			formLinkNeedsNewCaseDatumMessage({
				formName: "Visit household",
				targetName: "Review visit",
				caseType: "visit",
				reason: "the new case saves a calculated value",
				remedy: "save that value from a question",
				menuName: undefined,
			}),
		).toBe(
			`"Visit household" can't hand its new visit case to "Review visit" after it is submitted: the new case saves a calculated value. You can send that link to the app's home screen instead, or save that value from a question.`,
		);
		expect(
			userFacingError({
				code: "FORM_LINK_NEEDS_NEW_CASE_DATUM",
				scope: "form",
				message: "",
				location: { formUuid: VISIT_HOUSEHOLD, formName: "Visit household" },
				details: {
					targetName: "Review visit",
					caseType: "visit",
					reason: "the new case saves a calculated value",
					remedy: "save that value from a question",
				},
			}),
		).toBe(
			`After "Visit household", the link to "Review visit" can't open the new visit case, because the new case saves a calculated value. You can send it to the home screen, or save that value from a question.`,
		);
	});
});
