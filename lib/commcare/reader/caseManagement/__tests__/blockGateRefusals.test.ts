/**
 * Save to Case blocks the commit gate refuses on their own: each reads to one
 * true finding at the block, never to a document the gate refuses.
 *
 * Contract: the reader never returns, without a finding, a document the gate
 * refuses, and the finding it gives names what the source holds. Each source
 * here is Nova's print of a document the gate refuses (the emitter is total),
 * which is a source CommCare HQ can hold:
 *
 * - a block a device refuses on every submission (`index.ts::settleCaseChanges`,
 *   asking `validateCaseOperations` and choosing by the reason it gives): an
 *   update whose case id is the case a menu chooses on a survey, which chooses
 *   none (`CASE_OPERATION_SESSION_UNAVAILABLE` reason `target`); an update whose
 *   case id is a blank literal (`CASE_OPERATION_TARGET_INVALID` reason
 *   `blank-target`); a link of the block's case to itself
 *   (`CASE_OPERATION_LINK_INVALID` reason `self-link`). The id is blank on every
 *   submission in the first two, which HQ's server and Core refuse, and Core
 *   refuses a case's link to itself;
 * - a link name longer than CommCare HQ's index column holds (255 characters,
 *   `CASE_OPERATION_LINK_INVALID` reason `too-long`): its own entry, at the
 *   block (`saveToCase.ts::readBlock`);
 * - a survey's create that links to the case a menu chooses, or whose value
 *   reads it (`CASE_OPERATION_SESSION_UNAVAILABLE` reasons `link-target`,
 *   `case-read`): the entry of a read of a case the form holds none of, whose
 *   link a device takes as no link;
 * - a block or a link that names the case it reaches by a type the case does
 *   not hold, with no type change behind it
 *   (`CASE_OPERATION_TARGET_TYPE_MISMATCH` reason `declared-type`): that
 *   entry at the block, never the type change's at the form, since no case's
 *   type changes;
 * - a link named as HQ's form builder reads the block's own action (`close`):
 *   the link-name entry (`saveToCase.ts::readBlock`, over
 *   `caseOperationLinkNameProblem`); a block, row or link named as it cannot
 *   open a form with (`instance`, `bind`): the question-id entry, and a row it
 *   reads as the block's close: the block-shape entry;

 * - a create keyed by an answer the gate takes as no key: a multi-select
 *   answer (`formFieldCanKeyCreate`), an answer in a repeat for a create at the
 *   root (`formFieldCorrelatesWithCreate`): the authored create id entry.
 *
 * Sources CommCare HQ holds that no gate document prints, each Nova's export
 * edited as a person would in HQ: a create whose link's value is its own case
 * id (`CaseXmlParser.indexCase`, "cannot index itself"), and an update whose
 * case id is the blank literal `''`, each the device-refuses entry at the
 * block (`saveToCase.ts::readBlock`).
 *
 * Beside them, an unlink of a type no other change names reads back into a
 * document that declares the type (`catalog.ts::readCaseCatalog`), which the
 * gate holds every link's to (`CASE_OPERATION_UNKNOWN_CASE_TYPE`).
 *
 * The plausible failure: each read as an operation with no finding, into a
 * document the gate refuses, which the held sweep (`heldReading.ts`) fails.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { updateCaseOperationMutations } from "@/lib/doc/caseOperationMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type {
	BlueprintDoc,
	CaseOperation,
	CaseTypeCalculation,
	Uuid,
} from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/expression";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import {
	type ExportEdits,
	exportedBody,
	inputFor,
} from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { readHqApp } from "./heldReading";

const DEVICE =
	"questions/a-savetocase-change-a-device-refuses-a-blank-case-id-or-a-link-of-its-case-to-itself";
const LINK_NAME = "questions/savetocase-link-name-changes-actions-on-save";
const AUTHORED_ID =
	"questions/savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside";
const QUESTION_ID =
	"questions/question-id-failing-the-grammar-or-meta-in-any-case";
const OUTSIDE = "questions/savetocase-block-outside-nova-s-own-block-shape";
const READS_MENU_CASE =
	"questions/a-savetocase-change-that-reads-the-case-a-menu-chooses-on-a-form-whose-menu-chooses-none";
const DECLARED_TYPE =
	"questions/a-savetocase-change-whose-case-type-is-not-the-type-of-the-case-it-reaches";
const CASE_TYPE_NAME =
	"questions/a-savetocase-case-type-outside-the-case-type-grammar-or-longer-than-255-characters";
const LONG_TYPE = `v${"x".repeat(299)}`;
const EXPRESSION_OUTSIDE =
	"questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id";
const LONG_LINK =
	"questions/a-savetocase-link-name-longer-than-commcare-hq-stores";

const FORM = testUuid("block-gate-form") as Uuid;
const NOTE = testUuid("block-gate-note");
const MANY = testUuid("block-gate-many");
const KIDS = testUuid("block-gate-kids");
const KID = testUuid("block-gate-kid");
const VISIT = testUuid("block-gate-visit") as Uuid;
const answer = term(formField(NOTE));
const onYes = eq(answer, literal("yes"));

function app(
	type: "followup" | "survey",
	operations: CaseOperation[],
	extraTypes: readonly string[] = [],
): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-1",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "outcome", label: "Outcome" }],
				},
				{ name: "visit", properties: [{ name: "outcome", label: "Outcome" }] },
				...extraTypes.map((name) => ({
					name,
					properties: [{ name: "outcome", label: "Outcome" }],
				})),
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "block-gate-form",
							name: "Visit",
							type,
							fields: [
								f({ kind: "text", id: "note", uuid: NOTE }),
								f({
									kind: "multi_select",
									id: "many",
									uuid: MANY,
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								} as never),
								f({
									kind: "repeat",
									id: "kids",
									uuid: KIDS,
									repeat_mode: "user_controlled",
									children: [f({ kind: "text", id: "kid", uuid: KID })],
								} as never),
							],
						},
					],
				},
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
	uuid: testUuid("block-gate-own") as Uuid,
	id: "patient",
	action: "own",
	writes: [{ property: "outcome", value: answer }],
};

function update(extra: Readonly<Record<string, unknown>>): CaseOperation {
	return {
		uuid: testUuid("block-gate-update"),
		id: "again",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		...extra,
	} as CaseOperation;
}

/** A link named `identifier` of a `targetType` to the case a menu chooses. */
function sessionLink(identifier: string, targetType: string) {
	return {
		identifier,
		targetType,
		relationship: "child" as const,
		target: { kind: "session" as const },
	};
}

/** A create of a visit, its name the note, with `extra`. */
function visitCreate(
	extra: Readonly<Record<string, unknown>> = {},
): CaseOperation {
	return {
		uuid: VISIT,
		id: "mk",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: answer,
		...extra,
	} as CaseOperation;
}

function keyedCreate(idFrom: Uuid): CaseOperation {
	return {
		uuid: testUuid("block-gate-create"),
		id: "member",
		action: "create",
		caseType: "patient",
		target: { kind: "new", idFrom },
		name: answer,
	} as CaseOperation;
}

async function readBack(doc: BlueprintDoc, edits: ExportEdits = {}) {
	return readHqApp(
		await inputFor(exportedBody(doc, edits), {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
}

function gateCodes(doc: BlueprintDoc): string[] {
	const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	return verdict.ok ? [] : verdict.findings.map((one) => one.code);
}

const cases: readonly (readonly [
	string,
	string,
	string,
	() => BlueprintDoc,
])[] = [
	[
		"a survey's update of the case a menu chooses",
		"CASE_OPERATION_SESSION_UNAVAILABLE",
		DEVICE,
		() =>
			app("survey", [
				update({
					writes: [{ property: "outcome", value: answer, condition: onYes }],
				}),
			]),
	],
	[
		"an update whose case id is a blank literal",
		"CASE_OPERATION_TARGET_INVALID",
		DEVICE,
		() =>
			app("followup", [
				own,
				update({
					target: { kind: "expression", expr: term(literal(" ")) },
					writes: [{ property: "outcome", value: answer, condition: onYes }],
				}),
			]),
	],
	[
		"a link of the block's case to itself",
		"CASE_OPERATION_LINK_INVALID",
		DEVICE,
		() =>
			app("followup", [
				own,
				update({
					links: [
						{
							identifier: "self",
							targetType: "patient",
							relationship: "child",
							target: { kind: "session" },
						},
					],
				}),
			]),
	],
	...(
		[
			["close", LINK_NAME],
			["instance", QUESTION_ID],
		] as const
	).map(
		([name, entry]) =>
			[
				`a link named ${name}`,
				"CASE_OPERATION_LINK_INVALID",
				entry,
				() =>
					app("followup", [
						own,
						update({
							links: [
								{
									identifier: name,
									targetType: "patient",
									relationship: "child",
									target: null,
								},
							],
						}),
					]),
			] as const,
	),
	[
		"a create keyed by a multi-select answer",
		"CASE_OPERATION_TARGET_INVALID",
		AUTHORED_ID,
		() => app("followup", [own, keyedCreate(MANY as Uuid)]),
	],
	[
		"a create at the root keyed by an answer in a repeat",
		"CASE_OPERATION_REPEAT_CORRELATION",
		AUTHORED_ID,
		() => app("followup", [own, keyedCreate(KID as Uuid)]),
	],
	[
		"a block named as HQ's form builder cannot open a form with",
		"CASE_OPERATION_INVALID_ID",
		QUESTION_ID,
		() =>
			app("followup", [
				own,
				update({
					id: "instance",
					writes: [{ property: "visited", value: answer, condition: onYes }],
				}),
			]),
	],
	[
		"a row named as HQ's form builder cannot open a form with",
		"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
		QUESTION_ID,
		() =>
			app("followup", [
				own,
				update({
					writes: [{ property: "bind", value: answer, condition: onYes }],
				}),
			]),
	],
	[
		"a row HQ's form builder reads as the block's close",
		"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
		OUTSIDE,
		() =>
			app("followup", [
				own,
				update({
					writes: [{ property: "close", value: answer, condition: onYes }],
				}),
			]),
	],
	[
		"a survey's create whose value reads the case a menu chooses",
		"CASE_OPERATION_SESSION_UNAVAILABLE",
		READS_MENU_CASE,
		() =>
			app("survey", [
				{
					uuid: testUuid("block-gate-survey-create"),
					id: "visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: answer,
					writes: [
						{
							property: "outcome",
							value: {
								kind: "term",
								term: {
									kind: "prop",
									caseType: "patient",
									property: "outcome",
								},
							},
						},
					],
				} as never,
			]),
	],
	[
		"a survey's create that links to the case a menu chooses",
		"CASE_OPERATION_SESSION_UNAVAILABLE",
		READS_MENU_CASE,
		() =>
			app("survey", [
				visitCreate({ links: [sessionLink("parent", "patient")] }),
			]),
	],
	[
		"a link named with more than 255 characters",
		"CASE_OPERATION_LINK_INVALID",
		LONG_LINK,
		() =>
			app("followup", [
				own,
				visitCreate({ links: [sessionLink(`p${"a".repeat(299)}`, "patient")] }),
			]),
	],
	[
		"a link whose case type is not the type of the case a menu chose",
		"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		DECLARED_TYPE,
		() =>
			app("followup", [
				own,
				visitCreate({ links: [sessionLink("parent", "visit")] }),
			]),
	],
	[
		"an update whose case type is not the type its case was created with",
		"CASE_OPERATION_TARGET_TYPE_MISMATCH",
		DECLARED_TYPE,
		() =>
			app("followup", [
				own,
				visitCreate(),
				update({
					target: { kind: "op", opUuid: VISIT },
					writes: [{ property: "outcome", value: answer, condition: onYes }],
				}),
			]),
	],
	...(
		[
			["a create of a type longer than 255 characters", LONG_TYPE, "create"],
			["a create of a type outside the case type grammar", "a.b", "create"],
			["a link to a type longer than 255 characters", LONG_TYPE, "link"],
			["a change of a case's type to one outside the grammar", "a.b", "retype"],
		] as const
	).map(
		([name, typeName, where]) =>
			[
				name,
				"CASE_OPERATION_INVALID_CASE_TYPE",
				CASE_TYPE_NAME,
				() =>
					app(
						"followup",
						[
							own,
							where === "create"
								? visitCreate({ caseType: typeName })
								: where === "link"
									? visitCreate({
											links: [
												{
													identifier: "parent",
													targetType: typeName,
													relationship: "child",
													target: null,
												},
											],
										})
									: update({
											retype: typeName,
											writes: [
												{
													property: "outcome",
													value: answer,
													condition: onYes,
												},
											],
										}),
						],
						[typeName],
					),
			] as const,
	),
];

describe("Save to Case blocks the gate refuses on their own", () => {
	for (const [name, code, entry, make] of cases)
		it(`reads ${name} as its finding at the block`, async () => {
			const doc = make();
			expect(gateCodes(doc)).toContain(code);
			const outcome = await readBack(doc);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error(`${name}, which the gate refuses, was read.`);
			// The one finding, with no other beside it (an `unrecognized` one
			// for a node around the block among them).
			expect(outcome.findings.map((one) => one.code)).toEqual([entry]);
			expect(outcome.findings[0]?.place).toMatchObject({ kind: "question" });
		});

	it("reads an unlink of a type no other change names into a document that declares it", async () => {
		const doc = app("followup", [
			own,
			update({
				links: [
					{
						identifier: "parent",
						targetType: "visit",
						relationship: "child",
						target: null,
					},
				],
			}),
		]);
		expect(gateCodes(doc)).not.toContain("CASE_OPERATION_UNKNOWN_CASE_TYPE");
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`An admitted unlink was refused: ${JSON.stringify(outcome.findings.map((one) => one.code))}`,
			);
		expect(
			(outcome.draft.doc.caseTypes ?? []).map((one) => one.name),
		).toContain("visit");
	});
});

// Sources HQ holds that no gate document prints: Nova's export, edited as a
// person would in HQ's form builder or by hand.
const edited: readonly (readonly [
	string,
	() => BlueprintDoc,
	(xml: string) => string,
])[] = [
	...["current()/../../@case_id", "/data/nova_operations/mk/case/@case_id"].map(
		(value) =>
			[
				`a create whose link's value is its own case id, as ${value}`,
				() =>
					app("followup", [
						own,
						visitCreate({ links: [sessionLink("parent", "patient")] }),
					]),
				(xml: string) =>
					replaceOnce(
						xml,
						`nodeset="/data/nova_operations/mk/case/index/parent" calculate="instance(&apos;commcaresession&apos;)/session/data/case_id"`,
						`nodeset="/data/nova_operations/mk/case/index/parent" calculate="${value}"`,
					),
			] as const,
	),
	[
		"an update whose case id is the blank literal",
		() =>
			app("followup", [
				own,
				update({
					target: { kind: "expression", expr: term(literal("abc")) },
					writes: [{ property: "outcome", value: answer, condition: onYes }],
				}),
			]),
		(xml: string) =>
			replaceOnce(
				xml,
				`calculate="instance(&apos;casedb&apos;)/casedb/case[@case_id = &apos;abc&apos; and @case_type = &apos;patient&apos;]/@case_id"`,
				`calculate="&apos;&apos;"`,
			),
	],
];

/** `xml` with its one `from` replaced by `to`; a test whose source lacks it fails. */
function replaceOnce(xml: string, from: string, to: string): string {
	const at = xml.indexOf(from);
	if (at < 0 || xml.indexOf(from, at + 1) >= 0)
		throw new Error(
			"The export does not hold the text this edit replaces once.",
		);
	return xml.slice(0, at) + to + xml.slice(at + from.length);
}

describe("Save to Case blocks a device refuses, as a person writes them in HQ", () => {
	for (const [name, make, xml] of edited)
		it(`reads ${name} as the device's refusal at the block`, async () => {
			const doc = make();
			// The document behind the edit holds no case change the gate refuses.
			expect(gateCodes(doc).filter((code) => code.startsWith("CASE_"))).toEqual(
				[],
			);
			const outcome = await readBack(doc, { xml });
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error(`${name}, which a device refuses, was read.`);
			expect(outcome.findings.map((one) => one.code)).toEqual([DEVICE]);
			expect(
				outcome.findings.find((one) => one.code === DEVICE)?.place,
			).toMatchObject({ kind: "question" });
		});

	// The control: each source unedited reads with no finding.
	for (const [name, make] of edited)
		it(`reads the unedited export behind ${name}`, async () => {
			const outcome = await readBack(make());
			expect(outcome.defects).toEqual([]);
			expect(
				outcome.kind === "account"
					? outcome.findings.map((one) => one.code)
					: [],
			).toEqual([]);
		});
});

// A change whose case is the one a create in a repeat makes, from outside
// that repeat's rows: from the root, which every row's case answers
// (`CASE_OPERATION_AMBIGUOUS_REFERENCE`), and from another repeat, whose rows
// are not the create's (`CASE_OPERATION_REPEAT_CORRELATION`). Each row makes
// its own case, and Nova holds a change of it only in the same row. Each is
// read from Nova's print, which names the create's id from `current()`, and
// with that id named by the create block's absolute path, as an author may
// write it in HQ, which Core resolves to the same nodes. Either way the source
// is one finding at the block, never a reader defect and never an expression
// Core cannot evaluate:
// - from the root, the block-shape entry: Nova writes a form's root blocks
//   before its repeats', so the change's case id reads a block after it, which
//   no block Nova writes for a document the gate admits does;
// - from another repeat, the gate's refusal, the entry of a case id outside
//   Nova's typed vocabularies (`index.ts::settleCaseChanges`), where the id is
//   read from `current()`; and the block-shape entry where it is spelled by
//   the absolute path, which Nova writes from `current()` and the block's
//   re-emission holds the source to (`saveToCase.ts::settleSaveToCase`).
const PETS = testUuid("block-gate-pets");
const PET = testUuid("block-gate-pet");

/** `app`'s followup with a second repeat, `pets`, beside `kids`. */
function twoRepeats(operations: CaseOperation[]): BlueprintDoc {
	return produce(app("followup", operations), (draft) => {
		const pets = f({
			kind: "repeat",
			id: "pets",
			uuid: PETS,
			repeat_mode: "user_controlled",
		} as never);
		const pet = f({ kind: "text", id: "pet", uuid: PET });
		draft.fields[PETS as Uuid] = pets as never;
		draft.fields[PET as Uuid] = pet as never;
		draft.fieldOrder[FORM]?.push(PETS as Uuid);
		draft.fieldOrder[PETS as Uuid] = [PET as Uuid];
	});
}

const kidVisit = visitCreate({ forEach: { repeat: KIDS } });
const opTargets: readonly (readonly [
	string,
	string,
	() => BlueprintDoc,
	string,
	{ readonly printed: string; readonly absolute: string },
])[] = [
	[
		"a change at the root of the case a repeat's create makes",
		"CASE_OPERATION_AMBIGUOUS_REFERENCE",
		() =>
			twoRepeats([
				own,
				kidVisit,
				update({
					caseType: "visit",
					target: { kind: "op", opUuid: VISIT },
					writes: [{ property: "outcome", value: answer, condition: onYes }],
				}),
			]),
		"current()/../../../../kids/nova_operations/mk/case/@case_id",
		{ printed: OUTSIDE, absolute: OUTSIDE },
	],
	[
		"a change in another repeat of the case a repeat's create makes",
		"CASE_OPERATION_REPEAT_CORRELATION",
		() =>
			twoRepeats([
				own,
				kidVisit,
				update({
					caseType: "visit",
					forEach: { repeat: PETS },
					target: { kind: "op", opUuid: VISIT },
					writes: [{ property: "outcome", value: answer, condition: onYes }],
				}),
			]),
		"current()/../../../../../kids/nova_operations/mk/case/@case_id",
		{ printed: EXPRESSION_OUTSIDE, absolute: OUTSIDE },
	],
];

describe("Save to Case changes of the case a repeat's create makes, from outside its rows", () => {
	for (const [name, code, make, printed, entries] of opTargets)
		for (const spelling of ["printed", "absolute"] as const)
			it(`reads ${name}, its case id ${spelling === "printed" ? "as Nova prints it" : "by the create's absolute path"}, as one finding at the block`, async () => {
				const doc = make();
				expect(gateCodes(doc)).toContain(code);
				const outcome = await readBack(
					doc,
					spelling === "printed"
						? {}
						: {
								xml: (xml) =>
									replaceOnce(
										xml,
										`calculate="${printed}"`,
										`calculate="/data/kids/nova_operations/mk/case/@case_id"`,
									),
							},
				);
				expect(outcome.defects).toEqual([]);
				if (outcome.kind !== "account")
					throw new Error(`${name}, which the gate refuses, was read.`);
				expect(outcome.findings.map((one) => one.code)).toEqual([
					entries[spelling],
				]);
				expect(outcome.findings[0]?.place).toMatchObject({ kind: "question" });
			});
});

it("holds a case update between the same submitted questions after HQ read-back", async () => {
	const change = update({
		target: { kind: "expression", expr: term(literal("patient-01")) },
		writes: [{ property: "outcome", value: answer }],
	});
	const position = testUuid("authored-case-update");
	const doc = produce(app("survey", [change]), (draft) => {
		delete draft.modules[draft.moduleOrder[0]].caseType;
		draft.fields[position] = {
			kind: "case_change",
			id: "save_outcome",
			uuid: position,
			operationUuid: change.uuid,
		};
		draft.fieldParent[position] = FORM;
		draft.fieldOrder[FORM].splice(1, 0, position);
	});
	expect(gateCodes(doc)).toEqual([]);
	const outcome = await readBack(doc);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(JSON.stringify(outcome.findings));
	expect(outcome.draft.doc.fieldOrder[FORM].slice(0, 3)).toEqual([
		NOTE,
		position,
		MANY,
	]);
	expect(outcome.draft.doc.fields[position]).toMatchObject({
		kind: "case_change",
		operationUuid: change.uuid,
	});
	expect(
		outcome.draft.doc.forms[FORM].caseOperations?.map((entry) => entry.uuid),
	).toEqual([change.uuid]);
});

it("accounts for a positioned block whose write may race the managed action on the same case", async () => {
	const change = update({
		target: { kind: "expression", expr: term(literal("patient-01")) },
		writes: [{ property: "outcome", value: term(literal("authored outcome")) }],
	});
	const position = testUuid("authored-case-order-violation");
	const doc = produce(app("followup", [own, change]), (draft) => {
		draft.fields[position] = {
			kind: "case_change",
			id: "save_outcome",
			uuid: position,
			operationUuid: change.uuid,
		};
		draft.fieldParent[position] = FORM;
		draft.fieldOrder[FORM].splice(1, 0, position);
	});
	expect(gateCodes(doc)).toContain("CASE_CHANGE_POSITION_INVALID");
	const outcome = await readBack(doc);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "account")
		throw new Error("Expected a positioned case order refusal.");
	expect(outcome.findings.map((finding) => finding.code)).toEqual([
		"questions/a-positioned-case-change-coupled-to-an-hq-case-action",
	]);
});

it.each(["close", "update", "create"] as const)(
	"keeps the %s block's close condition separate from its own relevance",
	async (action) => {
		const change =
			action === "create"
				? visitCreate({ closeAfter: true, closeCondition: onYes })
				: update({
						action,
						target: { kind: "expression", expr: term(literal("patient-01")) },
						closeCondition: onYes,
						writes: [{ property: "outcome", value: answer }],
						...(action === "update" && {
							closeAfter: true,
							rename: term(literal("Renamed")),
						}),
					});
		const doc = produce(app("survey", [change]), (draft) => {
			delete draft.modules[draft.moduleOrder[0]].caseType;
		});
		expect(gateCodes(doc)).toEqual([]);
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(JSON.stringify(outcome.findings));
		const [read] = outcome.draft.doc.forms[FORM].caseOperations ?? [];
		expect(read).toMatchObject({
			uuid: change.uuid,
			action,
			closeCondition: onYes,
		});
		expect(read.condition).toBeUndefined();
		if (action !== "create")
			expect(read.writes).toEqual([{ property: "outcome", value: answer }]);
		expect(read.closeAfter).toBe(action === "close" ? undefined : true);
	},
);

it("keeps the owner condition on the create leaf of a fresh case", async () => {
	const change = visitCreate({
		owner: term(literal("team-01")),
		ownerCondition: onYes,
	});
	const doc = produce(app("survey", [change]), (draft) => {
		delete draft.modules[draft.moduleOrder[0]].caseType;
	});
	expect(gateCodes(doc)).toEqual([]);
	const outcome = await readBack(doc);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(JSON.stringify(outcome.findings));
	expect(outcome.draft.doc.forms[FORM].caseOperations).toEqual([
		{
			...change,
			placement: { kind: "save-to-case", path: ["nova_operations", "mk"] },
		},
	]);
});

describe("a Save to Case create's calculated type", () => {
	const doc = produce(app("survey", [visitCreate()]), (draft) => {
		delete draft.modules[draft.moduleOrder[0]].caseType;
	});
	const calculation: CaseTypeCalculation = {
		kind: "concat",
		parts: [
			{ kind: "term", term: { kind: "literal", value: "vi" } },
			{ kind: "term", term: { kind: "literal", value: "sit" } },
		],
	};

	const source = (xpath: string): ExportEdits => ({
		xml: (xml) =>
			replaceOnce(
				replaceOnce(
					xml,
					'<mk vellum:role="SaveToCase" vellum:case_type="visit">',
					'<mk vellum:role="SaveToCase" vellum:case_type="">',
				),
				'nodeset="/data/nova_operations/mk/case/create/case_type" calculate="&apos;visit&apos;"',
				`nodeset="/data/nova_operations/mk/case/create/case_type" calculate="${xpath}"`,
			),
		modules: (modules) => {
			const [form] = modules[0].forms as Array<{
				case_references_data: { save: Record<string, { case_type: string }> };
			}>;
			const rows = Object.entries(form.case_references_data.save).filter(
				([path]) => path.endsWith("/mk"),
			);
			expect(rows).toHaveLength(1);
			rows[0][1].case_type = "";
			return modules;
		},
	});

	it("keeps the fixed expression, its blank HQ metadata and the original operation identity", async () => {
		const edits = source("concat(&apos;vi&apos;, &apos;sit&apos;)");
		const outcome = await readBack(doc, edits);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(JSON.stringify(outcome.findings));
		const saved = outcome.draft.doc;
		const operation = saved.forms[FORM].caseOperations?.find(
			(op) => op.id === "mk",
		);
		expect(operation).toMatchObject({
			uuid: VISIT,
			action: "create",
			caseType: "visit",
			typeCalculation: calculation,
		});
		expect(gateCodes(saved)).toEqual([]);
		const exported = exportedBody(saved);
		const original = exportedBody(doc, edits);
		expect(exported._attachments).toEqual(original._attachments);
		expect(exported.modules).toEqual(original.modules);

		if (operation?.action !== "create") throw new Error("Missing the create.");
		const { typeCalculation: _carried, ...editable } = operation;
		const renamed = produce(saved, (draft) => {
			applyMutations(
				draft,
				updateCaseOperationMutations(saved, FORM, {
					...editable,
					name: term(literal("Changed name")),
				}),
			);
		});
		expect(renamed.forms[FORM].caseOperations?.[0]).toMatchObject({
			typeCalculation: calculation,
			name: term(literal("Changed name")),
		});
		const changedType = produce(renamed, (draft) => {
			applyMutations(
				draft,
				updateCaseOperationMutations(renamed, FORM, {
					...editable,
					caseType: "patient",
				}),
			);
		});
		expect(changedType.forms[FORM].caseOperations?.[0]).toMatchObject({
			caseType: "patient",
		});
		expect(changedType.forms[FORM].caseOperations?.[0]).not.toHaveProperty(
			"typeCalculation",
		);
		expect(gateCodes(changedType)).toEqual([]);
		const mismatched = produce(saved, (draft) => {
			const create = draft.forms[FORM].caseOperations?.[0];
			if (create?.action === "create") create.caseType = "patient";
		});
		expect(gateCodes(mismatched)).toContain(
			"CASE_OPERATION_TYPE_CALCULATION_MISMATCH",
		);
	});

	it("holds a calculation depending on a form answer at its case change", async () => {
		const outcome = await readBack(
			doc,
			source(
				"if(/data/note = &apos;yes&apos;, &apos;visit&apos;, &apos;commcare-user&apos;)",
			),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") throw new Error("Expected a finding.");
		expect(outcome.findings).toEqual([
			expect.objectContaining({
				code: "questions/savetocase-case-type-given-as-an-xpath",
				place: expect.objectContaining({ path: "nova_operations/mk" }),
			}),
		]);
	});
});

it("round trips a create that chooses one of two declared case types from an answer", async () => {
	const doc = buildDoc(
		{
			appId: "app-1",
			caseTypes: [
				{ name: "visit", properties: [] },
				{ name: "patient", properties: [] },
			],
			modules: [
				{
					name: "Visits",
					caseType: "visit",
					forms: [
						{
							uuid: "block-gate-form",
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "note", uuid: NOTE })],
						},
					],
				},
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Note",
							type: "survey",
							fields: [f({ kind: "text", id: "remark" })],
						},
					],
				},
			],
		},
		(draft) => {
			draft.forms[FORM].caseOperations = [
				visitCreate({
					typeChoice: { condition: onYes, otherwise: "patient" },
					writes: [{ property: "saved_note", value: answer }],
				}),
			];
		},
	);
	const body = exportedBody(doc);
	const attachments = Object.values(
		body._attachments as Record<string, string>,
	);
	const xml = attachments.find(
		(attachment) =>
			attachment.includes("'saved_note'") || attachment.includes("<saved_note"),
	);
	expect(xml).toContain('vellum:role="SaveToCase" vellum:case_type=""');
	expect(xml).toContain("current()/../../../../mk/case/create/case_type");
	const first = await readHqApp(await inputFor(body));
	if (first.kind !== "read") throw new Error(JSON.stringify(first.findings));
	expect(
		Object.values(first.draft.doc.forms)
			.flatMap((form) => form.caseOperations ?? [])
			.find((operation) => operation.action === "create"),
	).toMatchObject({ typeChoice: { otherwise: "patient" } });
	for (const [name, reason] of [
		["missing_type", "undeclared-output"],
		["commcare-user", "platform-owned-output"],
	]) {
		const refused = await readBack(doc, {
			xml: (source) =>
				source.replace("&apos;patient&apos;)", `&apos;${name}&apos;)`),
		});
		expect(refused.kind).toBe("account");
		if (refused.kind !== "read")
			expect(refused.findings).toContainEqual(
				expect.objectContaining({
					code: "questions/savetocase-case-type-given-as-an-xpath",
					detail: expect.objectContaining({ name, reason }),
				}),
			);
	}
	const outcome = await readBack(doc);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(JSON.stringify(outcome.findings));
	const result = outcome.draft.doc;
	expect(result.forms[FORM].caseOperations?.[0]).toMatchObject({
		uuid: VISIT,
		caseType: "visit",
		typeChoice: { condition: onYes, otherwise: "patient" },
	});
	expect(gateCodes(result)).toEqual([]);
	for (const name of ["visit", "patient"])
		expect(
			result.caseTypes
				?.find((type) => type.name === name)
				?.properties.map((property) => property.name),
		).toContain("saved_note");
	const once = exportedBody(result);
	const twice = await readBack(result);
	expect(twice.kind).toBe("read");
	if (twice.kind === "read")
		expect(exportedBody(twice.draft.doc)).toEqual(once);
});
