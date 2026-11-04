// The one "Saves to" planner, each destination row of part 01 §16.3 replayed
// through the reducers and the commit gate. Catches a "Saves to" gesture
// that lands an invalid batch, writes a second concept beside the form's
// operations, or loses a save another question already makes.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	type FieldCaseWritePlan,
	NEW_CASE_NEEDS_NAME_MESSAGE,
	OPENS_WITH_CASE_VALUE_NOTE,
	planFieldCaseWrite,
	planFieldMoveCaseWrites,
	saveNewCaseNameFirstMessage,
} from "@/lib/doc/fieldCaseWriteMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type CaseOperation,
	type Expression,
	fieldCaseWriteViews,
	type Uuid,
} from "@/lib/domain";

const HOUSEHOLDS = testUuid("saves-module-households");
const REG = testUuid("saves-form-registration");
const FUP = testUuid("saves-form-followup");
const SURVEY = testUuid("saves-form-survey");
const HH_NAME = testUuid("saves-hh-name");
const HH_NOTE = testUuid("saves-hh-note");
const MEMBERS = testUuid("saves-members");
const MEMBER_GROUP = testUuid("saves-member-group");
const MEMBER_NAME = testUuid("saves-member-name");
const MEMBER_AGE = testUuid("saves-member-age");
const VISITORS = testUuid("saves-visitors");
const FUP_NAME = testUuid("saves-fup-name");
const FUP_NOTE = testUuid("saves-fup-note");
const FUP_VILLAGE = testUuid("saves-fup-village");
const FUP_PHOTO = testUuid("saves-fup-photo");
const FUP_COLOR = testUuid("saves-fup-color");
const SURVEY_COLOR = testUuid("saves-survey-color");
const SURVEY_MOOD = testUuid("saves-survey-mood");
const COLOR_PROPERTY = testUuid("saves-user-property-color");
const MOOD_PROPERTY = testUuid("saves-user-property-mood");

/** `CASE_CREATE_NAME_MISSING`'s builder sentence for the new members. */
const MEMBER_NAME_MISSING = userFacingError({
	code: "CASE_CREATE_NAME_MISSING",
	scope: "form",
	message: "",
	location: { formUuid: REG, formName: "Register" },
	details: { caseType: "member" },
});

const read = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});

function fixture(): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [
				{
					name: "village",
					properties: [{ name: "village_note", label: "Village note" }],
				},
				{
					name: "household",
					parent_type: "village",
					relationship: "child",
					properties: [
						{ name: "note", label: "Note" },
						{ name: "photo", label: "Photo" },
					],
				},
				{
					name: "member",
					parent_type: "household",
					relationship: "child",
					properties: [{ name: "age", label: "Age" }],
				},
				{ name: "clinic", properties: [] },
			],
			modules: [
				{
					uuid: HOUSEHOLDS,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: REG,
							name: "Register",
							type: "registration",
							fields: [
								f({
									uuid: HH_NAME,
									kind: "text",
									id: "hh_name",
									caseWrite: { caseType: "household", property: "case_name" },
								}),
								f({ uuid: HH_NOTE, kind: "text", id: "hh_note" }),
								f({
									uuid: MEMBERS,
									kind: "repeat",
									id: "members",
									children: [
										f({
											uuid: MEMBER_GROUP,
											kind: "group",
											id: "member_group",
											children: [
												f({
													uuid: MEMBER_NAME,
													kind: "text",
													id: "member_name",
												}),
												f({ uuid: MEMBER_AGE, kind: "int", id: "member_age" }),
											],
										}),
									],
								}),
								f({
									uuid: VISITORS,
									kind: "repeat",
									id: "visitors",
									children: [
										f({
											kind: "text",
											id: "visitor_note",
											uuid: "saves-visitor",
										}),
									],
								}),
							],
						},
						{
							uuid: FUP,
							name: "Visit",
							type: "followup",
							fields: [
								f({ uuid: FUP_NAME, kind: "text", id: "new_name" }),
								f({ uuid: FUP_NOTE, kind: "text", id: "visit_note" }),
								f({ uuid: FUP_VILLAGE, kind: "text", id: "village_note" }),
								f({ uuid: FUP_PHOTO, kind: "image", id: "door_photo" }),
								f({ uuid: FUP_COLOR, kind: "text", id: "color" }),
							],
						},
						{
							uuid: SURVEY,
							name: "Feedback",
							type: "survey",
							fields: [
								f({ uuid: SURVEY_COLOR, kind: "text", id: "favorite" }),
								f({ uuid: SURVEY_MOOD, kind: "text", id: "mood" }),
							],
						},
					],
				},
				{
					name: "Members",
					caseType: "member",
					caseListMenuItem: {},
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			],
		},
		(draft) => {
			draft.userProperties = {
				[COLOR_PROPERTY]: {
					uuid: COLOR_PROPERTY,
					slug: "favorite_color",
					label: "Favorite color",
				},
				[MOOD_PROPERTY]: { uuid: MOOD_PROPERTY, slug: "mood", label: "Mood" },
			};
			draft.userPropertyOrder = [COLOR_PROPERTY, MOOD_PROPERTY];
		},
	);
}

/** The plan's batch, admitted as every editor admits it and judged by the
 *  gate; the document it lands. */
function land(doc: BlueprintDoc, plan: FieldCaseWritePlan): BlueprintDoc {
	if (!plan.ok) throw new Error(`Expected a plan, got "${plan.message}"`);
	return commit(doc, plan.mutations);
}

function commit(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const parsed = mutations.map((mutation) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
	);
	const verdict = mutationCommitVerdict(
		doc,
		parsed,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	if (!verdict.ok) throw new Error("The gate refused the batch.");
	return verdict.nextDoc;
}

function refusal(plan: FieldCaseWritePlan): string {
	if (plan.ok) throw new Error("Expected a refusal, got a plan.");
	return plan.message;
}

const operationsOf = (doc: BlueprintDoc, formUuid: Uuid): CaseOperation[] =>
	doc.forms[formUuid]?.caseOperations ?? [];

const ownOf = (doc: BlueprintDoc, formUuid: Uuid): CaseOperation => {
	const own = operationsOf(doc, formUuid).find(
		(operation) => operation.action === "own",
	);
	if (own === undefined) throw new Error("The form holds no own case.");
	return own;
};

describe("the fixture's own sugar", () => {
	it("names the registration's own case from its case_name writer", () => {
		const doc = fixture();
		expect(operationsOf(doc, REG)).toEqual([
			expect.objectContaining({ action: "own", name: read(HH_NAME) }),
		]);
		expect(doc.fields[HH_NAME]).not.toHaveProperty("caseWrite");
	});
});

describe("planFieldCaseWrite: destinations", () => {
	it("saves to the own case as one of its writes", () => {
		const doc = fixture();
		const plan = planFieldCaseWrite(doc, HH_NOTE, {
			caseType: "household",
			property: "note",
		});
		expect(plan).toMatchObject({ ok: true, notes: [] });
		const next = land(doc, plan);
		expect(ownOf(next, REG).writes).toEqual([
			{ property: "note", value: read(HH_NOTE) },
		]);
		expect(fieldCaseWriteViews(next, HH_NOTE)).toEqual([
			expect.objectContaining({
				slot: "write",
				caseType: "household",
				property: "note",
				destination: "own",
			}),
		]);
	});

	it("saves case_name to the own case's name, and owner_id to its owner", () => {
		const doc = fixture();
		const renamed = land(
			doc,
			planFieldCaseWrite(doc, FUP_NAME, {
				caseType: "household",
				property: "case_name",
			}),
		);
		expect(ownOf(renamed, FUP).name).toEqual(read(FUP_NAME));
		expect(ownOf(renamed, FUP).writes).toBeUndefined();

		const plan = planFieldCaseWrite(renamed, FUP_COLOR, {
			caseType: "household",
			property: "owner_id",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.notes).toEqual([]);
		expect(plan.mutations).toEqual([
			expect.objectContaining({
				caseOperationPatch: expect.objectContaining({
					targetAction: "own",
					patch: { owner: read(FUP_COLOR) },
				}),
			}),
		]);
	});

	it("saves through via to a case above the own case on a loading form", () => {
		const doc = fixture();
		const via = [{ identifier: "parent" }] as [{ identifier: string }];
		const next = land(
			doc,
			planFieldCaseWrite(doc, FUP_VILLAGE, {
				caseType: "village",
				property: "village_note",
				via,
			}),
		);
		expect(ownOf(next, FUP).writes).toEqual([
			expect.objectContaining({
				property: "village_note",
				value: read(FUP_VILLAGE),
				via,
			}),
		]);
		expect(fieldCaseWriteViews(next, FUP_VILLAGE)[0]).toMatchObject({
			caseType: "village",
			destination: "ancestor",
		});
	});

	it("refuses a via that does not reach the type it names", () => {
		const doc = fixture();
		expect(
			refusal(
				planFieldCaseWrite(doc, FUP_VILLAGE, {
					caseType: "clinic",
					property: "village_note",
					via: [{ identifier: "parent" }],
				}),
			),
		).toBe(
			`"village_note" saves to a case above this form's household case, but the cases above it don't reach a clinic case that way. Choose a case above it that the catalog links to.`,
		);
	});

	it("makes a new child case named by the first save, and joins it after", () => {
		const doc = fixture();
		const named = land(
			doc,
			planFieldCaseWrite(doc, MEMBER_NAME, {
				caseType: "member",
				property: "case_name",
			}),
		);
		const own = ownOf(named, REG);
		const [, create] = operationsOf(named, REG);
		expect(create).toMatchObject({
			action: "create",
			id: "member",
			caseType: "member",
			target: { kind: "new" },
			name: read(MEMBER_NAME),
			forEach: { repeat: MEMBERS },
			links: [
				{
					identifier: "parent",
					targetType: "household",
					target: { kind: "op", opUuid: own.uuid },
					relationship: "child",
				},
			],
		});
		const joined = land(
			named,
			planFieldCaseWrite(named, MEMBER_AGE, {
				caseType: "member",
				property: "age",
			}),
		);
		expect(operationsOf(joined, REG)).toHaveLength(2);
		expect(operationsOf(joined, REG)[1]?.writes).toEqual([
			{ property: "age", value: read(MEMBER_AGE) },
		]);
	});

	it("refuses a child save with no case to join until the case has a name", () => {
		expect(
			refusal(
				planFieldCaseWrite(fixture(), MEMBER_AGE, {
					caseType: "member",
					property: "age",
				}),
			),
		).toBe(saveNewCaseNameFirstMessage("member"));
		expect(saveNewCaseNameFirstMessage("member")).toBe(
			"Save a name for the new member first.",
		);
	});

	it("saves to the worker's record on any form, making its one update", () => {
		const doc = fixture();
		const first = land(
			doc,
			planFieldCaseWrite(doc, SURVEY_COLOR, {
				caseType: "commcare-user",
				property: "favorite_color",
			}),
		);
		expect(operationsOf(first, SURVEY)).toEqual([
			expect.objectContaining({
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "favorite_color", value: read(SURVEY_COLOR) }],
			}),
		]);
		const second = land(
			first,
			planFieldCaseWrite(first, SURVEY_MOOD, {
				caseType: "commcare-user",
				property: "mood",
			}),
		);
		expect(operationsOf(second, SURVEY)).toHaveLength(1);
		expect(operationsOf(second, SURVEY)[0]?.writes).toHaveLength(2);
	});

	it("saves a capture as the link to its file", () => {
		const doc = fixture();
		const plan = planFieldCaseWrite(doc, FUP_PHOTO, {
			caseType: "household",
			property: "photo",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.notes).toEqual([]);
		expect(plan.mutations).toContainEqual(
			expect.objectContaining({
				caseOperationPatch: expect.objectContaining({
					operation: "add-write",
					value: {
						property: "photo",
						value: {
							kind: "term",
							term: { kind: "capture-link", field: FUP_PHOTO },
						},
					},
				}),
			}),
		);
	});
});

describe("planFieldCaseWrite: refusals", () => {
	it("refuses an unknown type, a type that isn't a direct child, and a survey's case", () => {
		const doc = fixture();
		expect(
			refusal(
				planFieldCaseWrite(doc, HH_NOTE, { caseType: "ghost", property: "x" }),
			),
		).toBe(
			`"hh_note" in "Register" saves to the "ghost" case type, but no case type by that name exists. Add that case type, or point the field at one that does.`,
		);
		expect(
			refusal(
				planFieldCaseWrite(doc, HH_NOTE, { caseType: "clinic", property: "x" }),
			),
		).toBe(
			`"hh_note" in "Register" saves to "clinic", but this form can save only to its main case or one of that case's direct children. Choose one of those destinations, or clear the case destination.`,
		);
		expect(
			refusal(
				planFieldCaseWrite(doc, SURVEY_COLOR, {
					caseType: "household",
					property: "note",
				}),
			),
		).toBe(
			`"favorite" in "Feedback" can't save to "household", because this form doesn't create, open, or close a case. Make it a registration, follow-up or close form, or save the answer to the worker's record.`,
		);
	});

	it("refuses a second value for a place another question already saves", () => {
		const doc = fixture();
		expect(
			refusal(
				planFieldCaseWrite(doc, HH_NOTE, {
					caseType: "household",
					property: "case_name",
				}),
			),
		).toBe(
			"This form's household case already saves another value to case_name. Stop that save first, or choose another property.",
		);
	});
});

describe("planFieldCaseWrite: the starting value", () => {
	it("gives a new own-case save on a follow-up the case's current value", () => {
		const doc = fixture();
		const plan = planFieldCaseWrite(doc, FUP_NOTE, {
			caseType: "household",
			property: "note",
		});
		expect(plan).toMatchObject({
			ok: true,
			notes: [OPENS_WITH_CASE_VALUE_NOTE],
		});
		expect(OPENS_WITH_CASE_VALUE_NOTE).toBe(
			"Opens with the case's current value.",
		);
		const next = land(doc, plan);
		expect(next.fields[FUP_NOTE]).toMatchObject({
			default_value: {
				kind: "term",
				term: { kind: "form-case", caseType: "household", property: "note" },
			},
		});
	});

	it("gives none on a registration, through via, or to a capture", () => {
		const doc = fixture();
		const notesOf = (plan: FieldCaseWritePlan) => (plan.ok ? plan.notes : []);
		expect(
			notesOf(
				planFieldCaseWrite(doc, HH_NOTE, {
					caseType: "household",
					property: "note",
				}),
			),
		).toEqual([]);
		expect(
			notesOf(
				planFieldCaseWrite(doc, FUP_VILLAGE, {
					caseType: "village",
					property: "village_note",
					via: [{ identifier: "parent" }],
				}),
			),
		).toEqual([]);
		expect(
			notesOf(
				planFieldCaseWrite(doc, FUP_PHOTO, {
					caseType: "household",
					property: "photo",
				}),
			),
		).toEqual([]);
	});
});

describe("planFieldCaseWrite: removal and replacement", () => {
	it("refuses removing the only name a registration gives its case", () => {
		expect(refusal(planFieldCaseWrite(fixture(), HH_NAME, null))).toBe(
			NEW_CASE_NEEDS_NAME_MESSAGE,
		);
		expect(NEW_CASE_NEEDS_NAME_MESSAGE).toBe(
			"A new case needs a name. Choose another question to name it first.",
		);
	});

	it("removes a new child case with its last save", () => {
		const doc = fixture();
		const named = land(
			doc,
			planFieldCaseWrite(doc, MEMBER_NAME, {
				caseType: "member",
				property: "case_name",
			}),
		);
		const removed = land(named, planFieldCaseWrite(named, MEMBER_NAME, null));
		expect(operationsOf(removed, REG)).toEqual([ownOf(doc, REG)]);
	});

	it("refuses removing a child case's name while it still saves other answers", () => {
		const doc = fixture();
		const named = land(
			doc,
			planFieldCaseWrite(doc, MEMBER_NAME, {
				caseType: "member",
				property: "case_name",
			}),
		);
		const aged = land(
			named,
			planFieldCaseWrite(named, MEMBER_AGE, {
				caseType: "member",
				property: "age",
			}),
		);
		expect(refusal(planFieldCaseWrite(aged, MEMBER_NAME, null))).toBe(
			MEMBER_NAME_MISSING,
		);
	});

	it("removes the worker's record update with its last write", () => {
		const doc = fixture();
		const saved = land(
			doc,
			planFieldCaseWrite(doc, SURVEY_COLOR, {
				caseType: "commcare-user",
				property: "favorite_color",
			}),
		);
		const removed = land(saved, planFieldCaseWrite(saved, SURVEY_COLOR, null));
		expect(removed.forms[SURVEY]?.caseOperations).toBeUndefined();
	});

	it("replaces one save with another in one batch", () => {
		const doc = fixture();
		const saved = land(
			doc,
			planFieldCaseWrite(doc, HH_NOTE, {
				caseType: "household",
				property: "note",
			}),
		);
		const own = ownOf(saved, REG);
		const next = land(
			saved,
			planFieldCaseWrite(
				saved,
				HH_NOTE,
				{ caseType: "household", property: "photo" },
				{
					replace: {
						operationUuid: own.uuid,
						slot: "write",
						key: { property: "note" },
					},
				},
			),
		);
		expect(ownOf(next, REG).writes).toEqual([
			{ property: "photo", value: read(HH_NOTE) },
		]);
		// The same destination again plans nothing.
		expect(
			planFieldCaseWrite(next, HH_NOTE, {
				caseType: "household",
				property: "photo",
			}),
		).toEqual({ ok: true, mutations: [], notes: [] });
	});
});

describe("planFieldMoveCaseWrites", () => {
	it("moves a child case's saves to the case of their new repeat", () => {
		let doc = fixture();
		doc = land(
			doc,
			planFieldCaseWrite(doc, MEMBER_NAME, {
				caseType: "member",
				property: "case_name",
			}),
		);
		doc = land(
			doc,
			planFieldCaseWrite(doc, MEMBER_AGE, {
				caseType: "member",
				property: "age",
			}),
		);
		const plan = planFieldMoveCaseWrites(doc, MEMBER_GROUP, VISITORS);
		if (!plan.ok) throw new Error(plan.message);
		const next = commit(doc, [
			{
				kind: "moveField",
				uuid: MEMBER_GROUP,
				toParentUuid: VISITORS,
				after: null,
			},
			...plan.mutations,
		]);
		const creates = operationsOf(next, REG).filter(
			(operation) => operation.action === "create",
		);
		expect(creates).toEqual([
			expect.objectContaining({
				caseType: "member",
				forEach: { repeat: VISITORS },
				name: read(MEMBER_NAME),
				writes: [{ property: "age", value: read(MEMBER_AGE) }],
			}),
		]);
	});

	it("refuses a move that leaves a child case's other saves without a name", () => {
		let doc = fixture();
		doc = land(
			doc,
			planFieldCaseWrite(doc, MEMBER_NAME, {
				caseType: "member",
				property: "case_name",
			}),
		);
		doc = land(
			doc,
			planFieldCaseWrite(doc, MEMBER_AGE, {
				caseType: "member",
				property: "age",
			}),
		);
		expect(refusal(planFieldMoveCaseWrites(doc, MEMBER_NAME, VISITORS))).toBe(
			MEMBER_NAME_MISSING,
		);
	});

	it("carries nothing for a move inside the same repeat", () => {
		const doc = fixture();
		expect(planFieldMoveCaseWrites(doc, MEMBER_NAME, MEMBERS)).toEqual({
			ok: true,
			mutations: [],
			notes: [],
		});
	});
});
