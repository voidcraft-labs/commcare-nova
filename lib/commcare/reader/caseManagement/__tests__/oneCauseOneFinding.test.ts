/**
 * One cause in a source is one finding in the account.
 *
 * Contract: a reading of a Save to Case shape the commit gate refuses gives
 * the one finding that is true of the source, at the place the gate names,
 * with no reader defect and no `unrecognized` finding beside it that restates
 * it; a shape the reader holds reads into a document the gate admits. Each
 * source is Nova's print of a document (the emitter is total, so a document
 * the gate refuses prints a source CommCare HQ can hold), or that print edited
 * as a person would in HQ's form builder or HQ's form settings.
 *
 * - Two blocks of one name in one group, and two rows of one name in one
 *   block (the gate's `CASE_OPERATION_DUPLICATE_ID` and
 *   `CASE_WRITE_DUPLICATE_PROPERTY` reason `operation`): two sibling data
 *   nodes of one name, the data tree's one finding at the form
 *   (`xform/model.ts::readDataTree`), whose refusal covers the block around
 *   them and every bind, setvalue and control that reaches them; two blocks
 *   of one name in two groups (a condition group, a keyed create's repeat):
 *   the later block outside Nova's block shape.
 * - A create keyed by an answer the gate takes as no key: the authored create
 *   id's finding at the block, its `nova_keyed_<id>` repeat and that repeat's
 *   count standing under it (`saveToCase.ts::claimAccepted`).
 * - The gate's reasons a reader stage meets first or the settle maps
 *   (`index.ts::settleCaseChanges`): a case id that reads the id of a case the
 *   form creates (`CASE_OPERATION_TARGET_INVALID` reason `id-of-target`), a
 *   read of a repeat's case or answer from outside its rows
 *   (`CASE_OPERATION_REPEAT_CORRELATION`, `CASE_OPERATION_AMBIGUOUS_REFERENCE`),
 *   a link to a captured file as a case's name or external id
 *   (`CAPTURE_CASE_WRITE_STANDARD_PROPERTY`, refused where `readBlock` reads
 *   it), the changes of a several-case form that run once
 *   (`MULTI_SELECT_*`), and a change of a case's type
 *   (`CASE_OPERATION_RETYPE_UNSAFE`): a property the later type does not
 *   hold, or holds only through a read (a case list column of its menu) that
 *   nothing of its own types, is carried onto it
 *   (`catalog.ts::carryRetypedProperties`), one its own writers type otherwise
 *   is the finding at the block, and a keyed create's
 *   case given another type is the type change's finding at the form.
 * - A form's own open or close condition on a form type that takes none
 *   (`OPEN_CONDITION_WRONG_TYPE`, `CLOSE_CONDITION_WRONG_TYPE`): no reading
 *   holds one, since the form's type is read from the same actions
 *   (`formType.ts`): a follow-up's `open_case` is no action HQ's build reads
 *   (`models/forms.py::Form.active_actions`), and a close condition makes the
 *   form a close form.
 *
 * The plausible failure: the true finding beside reader defects ("claimed
 * twice") and `unrecognized` findings for the nodes around it, or a reading
 * the gate refuses with no finding, which `heldReading.ts` fails.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseOperation,
	NEW_APP_SETTINGS,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { eq, formField, literal, prop, term } from "@/lib/domain/expression";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import {
	type ExportEdits,
	exportedBody,
	inputFor,
} from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import type { ReadOutcome } from "../../types";
import { readHqApp } from "./heldReading";

const SIBLINGS = "questions/two-sibling-data-nodes-with-one-name";
const OUTSIDE = "questions/savetocase-block-outside-nova-s-own-block-shape";
const VOCABULARY =
	"questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id";
const AUTHORED_ID =
	"questions/savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside";
const TYPE_CHANGE =
	"questions/a-savetocase-change-of-a-case-s-type-another-change-of-the-form-may-read-as-its-earlier-type";
const RETYPE_CONVERTS =
	"questions/a-savetocase-change-of-a-case-s-type-to-a-type-that-holds-one-of-its-properties-as-another-type";

const TARGET = {
	origin: "https://india.commcarehq.org",
	domain: "clinic",
} as const;

const FORM = testUuid("one-cause-form") as Uuid;
const NOTE = testUuid("one-cause-note");
const DAY = testUuid("one-cause-day");
const MANY = testUuid("one-cause-many");
const PICK = testUuid("one-cause-pick");
const PIC = testUuid("one-cause-pic");
const KIDS = testUuid("one-cause-kids");
const KID = testUuid("one-cause-kid");
const PETS = testUuid("one-cause-pets");
const VISIT = testUuid("one-cause-visit") as Uuid;
const answer = term(formField(NOTE));
const onYes = eq(answer, literal("yes"));

interface AppOptions {
	readonly type?: "followup" | "survey";
	/** The menu chooses several cases, which only Web Apps runs. */
	readonly several?: true;
	readonly visit?: readonly {
		name: string;
		data_type?: string;
		options?: readonly { value: string; label: string }[];
	}[];
	/** A second menu, of case type `visit`, whose case list shows `kept`. */
	readonly visitMenu?: true;
}

function app(
	operations: readonly CaseOperation[],
	options: AppOptions = {},
): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-1",
			...(options.several && {
				appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
			}),
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "outcome", label: "Outcome" },
						{ name: "kept", label: "Kept" },
						{ name: "photo", label: "Photo" },
					],
				},
				{
					name: "visit",
					properties: [
						{ name: "outcome", label: "Outcome" },
						...(options.visit ?? []).map((one) => ({
							...one,
							label: one.name,
						})),
					] as never,
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					...(options.several && {
						caseListConfig: {
							columns: [
								plainColumn(testUuid("one-cause-name"), "case_name", "Name"),
							],
							listColumnOrder: [testUuid("one-cause-name")],
							detailColumnOrder: [testUuid("one-cause-name")],
							searchInputs: [],
							selection: { kind: "multiple", maximum: 10 },
						} as never,
					}),
					forms: [
						{
							uuid: "one-cause-form",
							name: "Visit",
							type: options.type ?? "followup",
							fields: [
								f({ kind: "text", id: "note", uuid: NOTE }),
								f({ kind: "date", id: "day", uuid: DAY } as never),
								f({
									kind: "multi_select",
									id: "many",
									uuid: MANY,
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								} as never),
								f({ kind: "image", id: "pic", uuid: PIC } as never),
								f({
									kind: "repeat",
									id: "kids",
									uuid: KIDS,
									repeat_mode: "user_controlled",
									children: [f({ kind: "text", id: "kid", uuid: KID })],
								} as never),
								f({
									kind: "repeat",
									id: "pets",
									uuid: PETS,
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "pet",
											uuid: testUuid("one-cause-pet"),
										}),
									],
								} as never),
								...(options.visitMenu
									? [
											f({
												kind: "single_select",
												id: "pick",
												uuid: PICK,
												options: [
													{ value: "a", label: "A" },
													{ value: "b", label: "B" },
												],
											} as never),
										]
									: []),
							],
						},
					],
				},
				...(options.visitMenu
					? [
							{
								name: "Visits",
								caseType: "visit",
								caseListConfig: {
									columns: [
										plainColumn(testUuid("one-cause-kept"), "kept", "Kept"),
									],
									searchInputs: [],
								} as never,
								forms: [
									{
										uuid: "one-cause-visit-form",
										name: "Check",
										type: "followup" as const,
										fields: [
											f({
												kind: "text",
												id: "seen",
												uuid: testUuid("one-cause-seen"),
											}),
										],
									},
								],
							},
						]
					: []),
			],
		},
		(built) => {
			built.forms[FORM] = {
				...built.forms[FORM],
				caseOperations: operations,
			} as never;
		},
	);
}

const own: CaseOperation = {
	uuid: testUuid("one-cause-own") as Uuid,
	id: "patient",
	action: "own",
	writes: [{ property: "outcome", value: answer }],
};

function update(
	uuid: string,
	id: string,
	extra: Readonly<Record<string, unknown>> = {},
): CaseOperation {
	return {
		uuid: testUuid(uuid),
		id,
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "kept", value: answer, condition: onYes }],
		...extra,
	} as CaseOperation;
}

function create(
	uuid: string,
	id: string,
	extra: Readonly<Record<string, unknown>> = {},
): CaseOperation {
	return {
		uuid: testUuid(uuid),
		id,
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: answer,
		...extra,
	} as CaseOperation;
}

const visitCreate = (extra: Readonly<Record<string, unknown>> = {}) =>
	({ ...create("unused", "mk", extra), uuid: VISIT }) as CaseOperation;

/** `doc`'s export with `edits`, read whole as a re-read of `doc`. */
async function readBack(
	doc: BlueprintDoc,
	edits: ExportEdits = {},
): Promise<ReadOutcome> {
	return readHqApp(
		await inputFor(
			exportedBody(doc, {
				...edits,
				expand: { attachmentTarget: TARGET } as never,
			}),
			{
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
				target: TARGET as never,
			},
		),
	);
}

function gateCodes(doc: BlueprintDoc): string[] {
	const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	return verdict.ok ? [] : verdict.findings.map((one) => one.code);
}

/** The account's every finding, by entry and the kind and path of its place. */
function account(outcome: ReadOutcome): string[] {
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "account") return [];
	return outcome.findings.map((one) => {
		const place = one.place as { kind: string; path?: string };
		return `${one.code} @${place.kind}${place.path === undefined ? "" : `:${place.path}`}`;
	});
}

/** `xml` with its one `from` replaced by `to`; a test whose source lacks it fails. */
function replaceOnce(xml: string, from: string, to: string): string {
	const at = xml.indexOf(from);
	if (at < 0 || xml.indexOf(from, at + 1) >= 0)
		throw new Error(
			"The export does not hold the text this edit replaces once.",
		);
	return xml.slice(0, at) + to + xml.slice(at + from.length);
}

describe("two data nodes of one name in a Save to Case block's group or in one block", () => {
	const cases: readonly (readonly [
		string,
		string,
		() => BlueprintDoc,
		string,
	])[] = [
		[
			"two updates of one name",
			"CASE_OPERATION_DUPLICATE_ID",
			() =>
				app([
					own,
					update("one-cause-u1", "again"),
					update("one-cause-u2", "again", {
						writes: [{ property: "photo", value: answer, condition: onYes }],
					}),
				]),
			`${SIBLINGS} @form`,
		],
		[
			"two creates of one name",
			"CASE_OPERATION_DUPLICATE_ID",
			() =>
				app([own, create("one-cause-c1", "mk"), create("one-cause-c2", "mk")]),
			`${SIBLINGS} @form`,
		],
		[
			"an update writing one property twice",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				app([
					own,
					update("one-cause-u1", "again", {
						writes: [
							{ property: "kept", value: answer, condition: onYes },
							{ property: "kept", value: term(literal("x")), condition: onYes },
						],
					}),
				]),
			`${SIBLINGS} @form`,
		],
		[
			"a conditional update writing one property twice",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				app([
					own,
					update("one-cause-u1", "again", {
						condition: onYes,
						writes: [
							{ property: "kept", value: answer },
							{ property: "kept", value: term(literal("x")) },
						],
					}),
				]),
			`${SIBLINGS} @form`,
		],
		[
			"a create writing one property twice",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				app([
					own,
					create("one-cause-c1", "mk", {
						writes: [
							{ property: "outcome", value: answer },
							{ property: "outcome", value: term(literal("x")) },
						],
					}),
				]),
			`${SIBLINGS} @form`,
		],
		[
			"a keyed create writing one property twice",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				app([
					own,
					create("one-cause-c1", "mk", {
						target: { kind: "new", idFrom: NOTE },
						writes: [
							{ property: "outcome", value: answer },
							{ property: "outcome", value: term(literal("x")) },
						],
					}),
				]),
			`${SIBLINGS} @form`,
		],
		[
			"two conditional updates of one name, each in a group of its own",
			"CASE_OPERATION_DUPLICATE_ID",
			() =>
				app([
					own,
					update("one-cause-u1", "again", {
						condition: onYes,
						writes: [{ property: "kept", value: answer }],
					}),
					update("one-cause-u2", "again", {
						condition: onYes,
						writes: [{ property: "photo", value: answer }],
					}),
				]),
			`${OUTSIDE} @question:nova_operations/nova_condition_again_1/again`,
		],
		[
			"two keyed creates of one name, each in a repeat of its own",
			"CASE_OPERATION_DUPLICATE_ID",
			() =>
				app([
					own,
					create("one-cause-c1", "mk", {
						caseType: "patient",
						target: { kind: "new", idFrom: NOTE },
					}),
					create("one-cause-c2", "mk", {
						caseType: "patient",
						target: { kind: "new", idFrom: NOTE },
					}),
				]),
			`${OUTSIDE} @question:nova_operations/nova_keyed_mk_1/mk`,
		],
	];
	for (const [name, code, make, finding] of cases)
		it(`reads ${name} as one finding`, async () => {
			const doc = make();
			expect(gateCodes(doc)).toContain(code);
			expect(account(await readBack(doc))).toEqual([finding]);
		});
});

describe("a Save to Case change the gate refuses, as its one finding", () => {
	const ABC = "@case_id = &apos;abc&apos;";
	const cases: readonly (readonly [
		string,
		() => BlueprintDoc,
		((xml: string) => string) | undefined,
		string,
	])[] = [
		[
			"a create keyed by a multi-select answer (its keyed repeat under the finding)",
			() =>
				app([
					own,
					create("one-cause-c1", "member", {
						caseType: "patient",
						target: { kind: "new", idFrom: MANY },
					}),
				]),
			undefined,
			`${AUTHORED_ID} @question:nova_operations/nova_keyed_member/member`,
		],
		[
			"a case id that reads the id of a case the form creates",
			() =>
				app([
					own,
					visitCreate(),
					update("one-cause-u1", "again", {
						caseType: "visit",
						target: { kind: "expression", expr: term(literal("abc")) },
					}),
				]),
			(xml) =>
				replaceOnce(
					xml,
					ABC,
					"@case_id = concat(current()/../../../mk/case/@case_id, &apos;&apos;)",
				),
			`${VOCABULARY} @question:nova_operations/again`,
		],
		[
			"a change in one repeat of the case a create in another makes",
			() =>
				app([
					own,
					visitCreate({
						forEach: { repeat: KIDS },
						name: term(formField(KID)),
					}),
					update("one-cause-u1", "again", {
						caseType: "visit",
						target: { kind: "op", opUuid: VISIT },
						forEach: { repeat: PETS },
					}),
				]),
			undefined,
			`${VOCABULARY} @question:pets/nova_operations/again`,
		],
		[
			"a create at the root named by an answer of a repeat",
			() => app([own, visitCreate({ name: term(formField(KID)) })]),
			undefined,
			`${VOCABULARY} @question:nova_operations/mk`,
		],
		[
			"a link to a captured file as a case's external id",
			() =>
				app([
					own,
					update("one-cause-u1", "again", {
						writes: [
							{
								property: "photo",
								value: term({ kind: "capture-link", field: PIC } as never),
							},
						],
					}),
				]),
			(xml) =>
				replaceOnce(
					xml.replace(
						"/data/nova_operations/again/case/update/photo",
						"/data/nova_operations/again/case/update/external_id",
					),
					"<photo/>",
					"<external_id/>",
				),
			`${VOCABULARY} @question:nova_operations/again`,
		],
		[
			"a link to a captured file as a created case's name",
			() =>
				app([
					own,
					create("one-cause-c1", "mk", {
						writes: [
							{
								property: "outcome",
								value: term({ kind: "capture-link", field: PIC } as never),
							},
						],
					}),
				]),
			(xml) => {
				// The name's bind takes the row's capture address.
				const address =
					/nodeset="\/data\/nova_operations\/mk\/case\/update\/outcome" calculate="([^"]*)"/.exec(
						xml,
					)?.[1];
				if (address === undefined)
					throw new Error("The export writes no capture address.");
				return xml.replace(
					/(nodeset="\/data\/nova_operations\/mk\/case\/create\/case_name" calculate=")[^"]*"/,
					`$1${address}"`,
				);
			},
			`${VOCABULARY} @question:nova_operations/mk`,
		],
		[
			"a several-case form's change that links to the chosen case",
			() =>
				app(
					[
						own,
						visitCreate(),
						update("one-cause-u1", "again", {
							caseType: "visit",
							target: { kind: "op", opUuid: VISIT },
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									relationship: "child",
									target: { kind: "session" },
								},
							],
						}),
					],
					{ several: true },
				),
			undefined,
			`${VOCABULARY} @question:nova_operations/again`,
		],
		[
			"a several-case form's create that reads the chosen case",
			() =>
				app(
					[
						own,
						visitCreate({
							writes: [
								{
									property: "outcome",
									value: term(prop("patient", "outcome")),
								},
							],
						}),
					],
					{ several: true },
				),
			undefined,
			`${VOCABULARY} @question:nova_operations/mk`,
		],
		[
			"a several-case form's create keyed by an answer",
			() =>
				app([own, visitCreate({ target: { kind: "new", idFrom: NOTE } })], {
					several: true,
				}),
			undefined,
			`${AUTHORED_ID} @question:nova_operations/nova_keyed_mk/mk`,
		],
		[
			"a change of a case's type to a type holding one of its properties as another type",
			() =>
				app([
					own,
					visitCreate({
						caseType: "patient",
						writes: [{ property: "kept", value: term(formField(DAY)) }],
					}),
					update("one-cause-u1", "again", {
						target: { kind: "op", opUuid: VISIT },
						retype: "visit",
						writes: [{ property: "kept", value: answer, condition: onYes }],
					}),
				]),
			undefined,
			`${RETYPE_CONVERTS} @question:nova_operations/again`,
		],
		[
			"a change of the type of a survey's case keyed by an answer",
			() =>
				app(
					[
						visitCreate({ target: { kind: "new", idFrom: NOTE } }),
						update("one-cause-u1", "again", {
							caseType: "visit",
							target: { kind: "op", opUuid: VISIT },
							retype: "patient",
						}),
					],
					{ type: "survey" },
				),
			undefined,
			`${TYPE_CHANGE} @form`,
		],
	];
	for (const [name, make, xml, finding] of cases)
		it(`reads ${name} as its one finding`, async () => {
			const outcome = await readBack(make(), xml === undefined ? {} : { xml });
			expect(account(outcome)).toEqual([finding]);
		});
});

describe("a change of a case's type to one that holds none of a property", () => {
	it("carries the property onto the later type, as the earlier type holds it", async () => {
		const doc = app([
			own,
			visitCreate({
				caseType: "patient",
				writes: [{ property: "kept", value: term(formField(DAY)) }],
			}),
			update("one-cause-u1", "again", {
				target: { kind: "op", opUuid: VISIT },
				retype: "visit",
				writes: [{ property: "outcome", value: answer, condition: onYes }],
			}),
		]);
		expect(gateCodes(doc)).toContain("CASE_OPERATION_RETYPE_UNSAFE");
		const outcome = await readBack(doc);
		expect(account(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The change was refused.");
		const visit = outcome.draft.doc.caseTypes?.find(
			(type) => type.name === "visit",
		);
		expect(visit?.properties.find((one) => one.name === "kept")).toMatchObject({
			data_type: "date",
		});
	});

	// The later type holds the property only through a read (a case list
	// column of a menu of its type, which declares no type), so the earlier
	// type's writer types it there, as the document Nova printed does.
	const choices = [
		{ value: "a", label: "A" },
		{ value: "b", label: "B" },
	];
	for (const [name, writer, kept] of [
		["a date question", DAY, { data_type: "date" }],
		["a single select", PICK, { data_type: "single_select", options: choices }],
	] as const)
		it(`reads back a later type whose list shows a property ${name} writes before the change`, async () => {
			const doc = app(
				[
					own,
					visitCreate({
						caseType: "patient",
						writes: [{ property: "kept", value: term(formField(writer)) }],
					}),
					update("one-cause-u1", "again", {
						target: { kind: "op", opUuid: VISIT },
						retype: "visit",
						writes: [{ property: "outcome", value: answer, condition: onYes }],
					}),
				],
				{
					visit: [{ name: "kept", ...kept }, { name: "photo" }],
					visitMenu: true,
				},
			);
			expect(gateCodes(doc).filter((code) => code.startsWith("CASE_"))).toEqual(
				[],
			);
			const outcome = await readBack(doc);
			expect(account(outcome)).toEqual([]);
			expect(outcome.kind).toBe("read");
		});

	it("refuses a later type whose own writer types the property otherwise", async () => {
		const doc = app(
			[
				own,
				visitCreate({
					caseType: "patient",
					writes: [{ property: "kept", value: term(formField(DAY)) }],
				}),
				update("one-cause-u1", "again", {
					target: { kind: "op", opUuid: VISIT },
					retype: "visit",
					writes: [{ property: "kept", value: answer, condition: onYes }],
				}),
			],
			{ visitMenu: true },
		);
		expect(gateCodes(doc)).toContain("CASE_OPERATION_RETYPE_UNSAFE");
		expect(account(await readBack(doc))).toEqual([
			`${RETYPE_CONVERTS} @question:nova_operations/again`,
		]);
	});

	it("reads back a document whose later type declares the property", async () => {
		const doc = app(
			[
				own,
				visitCreate({
					caseType: "patient",
					writes: [{ property: "kept", value: term(formField(DAY)) }],
				}),
				update("one-cause-u1", "again", {
					target: { kind: "op", opUuid: VISIT },
					retype: "visit",
					writes: [{ property: "outcome", value: answer, condition: onYes }],
				}),
			],
			{ visit: [{ name: "kept", data_type: "date" }, { name: "photo" }] },
		);
		expect(gateCodes(doc).filter((code) => code.startsWith("CASE_"))).toEqual(
			[],
		);
		const outcome = await readBack(doc);
		expect(account(outcome)).toEqual([]);
		expect(outcome.kind).toBe("read");
	});
});

describe("a form's own open or close condition where its type takes none", () => {
	const condition = {
		type: "if",
		question: "/data/pick",
		answer: "y",
		operator: "=",
		doc_type: "FormActionCondition",
	};
	function conditionApp(): BlueprintDoc {
		return buildDoc({
			appId: "app-1",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "outcome", label: "Outcome" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "one-cause-condition-form",
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "single_select",
									id: "pick",
									uuid: testUuid("one-cause-pick"),
									options: [
										{ value: "y", label: "Yes" },
										{ value: "n", label: "No" },
									],
								} as never),
							],
						},
					],
				},
			],
		});
	}
	const withAction =
		(action: "open_case" | "close_case") =>
		(modules: Record<string, unknown>[]) =>
			modules.map((module) => ({
				...module,
				forms: (module.forms as Record<string, unknown>[]).map((form) => {
					const actions = form.actions as Record<string, unknown>;
					return {
						...form,
						actions: {
							...actions,
							[action]: {
								...(actions[action] as Record<string, unknown>),
								condition,
							},
						},
					};
				}),
			}));

	it("reads a follow-up's open condition, which HQ's build does not read, as no condition", async () => {
		const doc = conditionApp();
		const outcome = await readBack(doc, { modules: withAction("open_case") });
		expect(account(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The form was refused.");
		const form = Object.values(outcome.draft.doc.forms)[0];
		expect(form?.type).toBe("followup");
		expect(form?.openCondition).toBeUndefined();
	});

	it("reads a follow-up's close condition as a close form's", async () => {
		const doc = conditionApp();
		const outcome = await readBack(doc, { modules: withAction("close_case") });
		expect(account(outcome)).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The form was refused.");
		const form = Object.values(outcome.draft.doc.forms)[0];
		expect(form?.type).toBe("close");
		expect(form?.closeCondition).toBeDefined();
	});
});
