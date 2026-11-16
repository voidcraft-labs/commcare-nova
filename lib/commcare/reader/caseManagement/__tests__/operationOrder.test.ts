/**
 * The order a reading gives a form's case operations
 * (`operationOrder.ts::inWireScopeOrder`), and the form whose changes stand in
 * no order Nova holds.
 *
 * Contract: HQ's form actions list a form's changes in their own order (the
 * worker's record's `usercase_update` before every Save to Case block), and
 * each change's place on the wire is its placement's, so the reading holds the
 * order the commit gate's wire-order rule admits
 * (`lib/doc/caseOperationOrder.ts::caseOperationWireOrderViolationDetails`):
 * a create keyed by an answer before every change that is no create, moved
 * there with every create it reads, so no change stands before a create it
 * reads (`CASE_OPERATION_REFERENCE_ORDER`). Where no order Nova writes is
 * admitted (a keyed create in a repeat beside a change at the root), the
 * reading is one finding at the form under
 * `a-keyed-savetocase-create-in-no-order-nova-holds-beside-the-form-s-other-changes`,
 * and no document.
 *
 * The plausible failures: a reading of Nova's own export that holds an order
 * the gate refuses (a keyed create moved ahead of the plain create it links
 * to), and an HQ edit that leaves no admitted order read into a document the
 * gate refuses, with no finding.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { inWireScopeOrder } from "../operationOrder";
import { readHqApp } from "./heldReading";

const NO_ORDER =
	"questions/a-keyed-savetocase-create-in-no-order-nova-holds-beside-the-form-s-other-changes";
const TYPE_CHANGE =
	"questions/a-savetocase-change-of-a-case-s-type-another-change-of-the-form-may-read-as-its-earlier-type";
const FORM = testUuid("order-form");
const NOTE = testUuid("order-note");
const KIDS = testUuid("order-kids");
const KID_NAME = testUuid("order-kid-name");
const PROPERTY = testUuid("order-property") as Uuid;

const NOTE_AND_SCORE = [
	{ name: "note", label: proseText("Note"), data_type: "text" as const },
	{ name: "score", label: proseText("Score"), data_type: "text" as const },
];

function visitApp(operations: CaseOperation[]): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-1",
			// A patient and a photo hold the same properties, so a retype of
			// one to the other keeps every value (`planCaseRetype`).
			caseTypes: [
				{ name: "patient", properties: NOTE_AND_SCORE },
				{ name: "photo", properties: NOTE_AND_SCORE },
				{ name: "kid", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "order-form",
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", uuid: NOTE }),
								f({
									kind: "repeat",
									id: "kids",
									uuid: KIDS,
									children: [
										f({ kind: "text", id: "kid_name", uuid: KID_NAME }),
									],
								}),
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
			built.userProperties = {
				[PROPERTY]: { uuid: PROPERTY, slug: "team_note", label: "Note" },
			};
			built.userPropertyOrder = [PROPERTY];
		},
	);
}

const worker: CaseOperation = {
	uuid: testUuid("order-worker"),
	id: "worker",
	action: "update",
	caseType: "commcare-user",
	target: { kind: "worker-record" },
	writes: [{ property: "team_note", value: term(formField(NOTE)) }],
};

async function readWhole(
	doc: BlueprintDoc,
	modules?: (modules: Record<string, unknown>[]) => Record<string, unknown>[],
) {
	const body = exportedBody(doc, modules === undefined ? {} : { modules });
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
}

/** A form's changes other than the own arm, each by its action, case type
 *  and whether an answer keys it, in order. */
function changes(operations: readonly CaseOperation[] | undefined): string[] {
	return (operations ?? []).flatMap((one) =>
		one.action === "own"
			? []
			: [
					`${one.action} ${one.caseType}${one.target.kind === "new" && one.target.idFrom !== undefined ? " keyed" : ""}`,
				],
	);
}

/** The codes the commit gate refuses `doc` on, case operations' alone. */
function gateCaseCodes(doc: BlueprintDoc): string[] {
	const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	return (verdict.ok ? [] : verdict.findings)
		.map((one) => one.code)
		.filter((code) => code.startsWith("CASE_OPERATION"));
}

/** The form's own change, writing the note to the patient it loads. */
const ownWritingNote: CaseOperation = {
	uuid: testUuid("order-own"),
	id: "patient",
	action: "own",
	writes: [{ property: "note", value: term(formField(NOTE)) }],
};

function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce((one, row) => row.apply(one), doc);
}

describe("the order a reading gives a form's case operations", () => {
	it("holds a keyed create, with the plain create it links to, before the worker's record HQ lists first", async () => {
		const plain: CaseOperation = {
			uuid: testUuid("order-plain"),
			id: "photo",
			action: "create",
			caseType: "photo",
			target: { kind: "new" },
			name: term(formField(NOTE)),
		};
		const keyed: CaseOperation = {
			uuid: testUuid("order-keyed"),
			id: "photo_keyed",
			action: "create",
			caseType: "photo",
			target: { kind: "new", idFrom: NOTE },
			name: term(formField(NOTE)),
			links: [
				{
					identifier: "source",
					targetType: "photo",
					target: { kind: "op", opUuid: plain.uuid },
					relationship: "child",
				},
			],
		};
		const doc = visitApp([plain, keyed, worker]);
		// The source's order is one the gate admits.
		const before = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			(before.ok ? [] : before.findings).filter((one) =>
				one.code.startsWith("CASE_OPERATION"),
			),
		).toEqual([]);
		const outcome = await readWhole(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const read = outcome.draft.doc;
		const form = Object.values(read.forms).find(
			(one) => (one.caseOperations ?? []).length > 0,
		);
		const ORDER = [
			"create photo",
			"create photo keyed",
			"update commcare-user",
		];
		expect(changes(form?.caseOperations)).toEqual(ORDER);
		const verdict = mutationCommitVerdict(read, [], LOOKUP_CONTEXT_UNAVAILABLE);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		// The canonical row gives the source document the same order.
		expect(changes(canonical(doc).forms[FORM]?.caseOperations)).toEqual(ORDER);
	});

	it("refuses a keyed create in a repeat once HQ turns on a write of the worker's record, at the form", async () => {
		const keyedKid: CaseOperation = {
			uuid: testUuid("order-keyed-kid"),
			id: "kid",
			action: "create",
			caseType: "kid",
			target: { kind: "new", idFrom: KID_NAME },
			name: term(formField(KID_NAME)),
			forEach: { repeat: KIDS },
		};
		const doc = visitApp([keyedKid]);
		const outcome = await readWhole(doc, (modules) => {
			for (const module of modules)
				for (const form of module.forms as Record<string, unknown>[]) {
					const actions = form.actions as Record<string, unknown>;
					actions.usercase_update = {
						doc_type: "UpdateCaseAction",
						condition: {
							doc_type: "FormActionCondition",
							type: "always",
							question: null,
							answer: null,
							operator: null,
						},
						update: {
							team_note: {
								doc_type: "ConditionalCaseUpdate",
								question_path: "/data/note",
								update_mode: "always",
							},
						},
					};
				}
			return modules;
		});
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "account")
			throw new Error("A form in no order Nova holds was read.");
		expect(outcome.findings.map((one) => one.code)).toEqual([NO_ORDER]);
		expect(outcome.findings[0]?.place).toMatchObject({ kind: "form" });
	});

	it("compares a change whose scope is unranked with none, as the gate does", () => {
		const unranked: CaseOperation = {
			uuid: testUuid("order-unranked"),
			id: "kid",
			action: "create",
			caseType: "kid",
			target: { kind: "new" },
			name: term(formField(KID_NAME)),
			forEach: { repeat: testUuid("order-no-such-repeat") as Uuid },
		};
		const operations = [unranked, worker];
		expect(inWireScopeOrder(operations, new Map([[undefined, 0]]))).toBe(
			operations,
		);
	});
});

describe("a change of a case's type another change of the form may read as its earlier type", () => {
	const keyed = (caseType: string): CaseOperation => ({
		uuid: testUuid("order-keyed-visit"),
		id: "visit",
		action: "create",
		caseType,
		target: { kind: "new", idFrom: NOTE },
		name: term(formField(NOTE)),
	});
	const retype = (target: CaseOperation["target"]): CaseOperation =>
		({
			uuid: testUuid("order-retype"),
			id: "retype",
			action: "update",
			caseType: "patient",
			target,
			retype: "photo",
			writes: [{ property: "score", value: term(formField(NOTE)) }],
		}) as CaseOperation;

	for (const [name, operations] of [
		[
			"a create keyed by an answer, of a type other than the loaded case's",
			[ownWritingNote, keyed("photo")],
		],
		[
			"a `case_type` row on the loaded case",
			[ownWritingNote, retype({ kind: "session" })],
		],
		[
			"a `case_type` row on a case an answer names",
			[
				ownWritingNote,
				retype({ kind: "expression", expr: term(formField(NOTE)) }),
			],
		],
	] as const)
		it(`is one finding at the form for ${name}, beside Case Management's change of the form's own case, and no document`, async () => {
			const doc = visitApp([...operations]);
			// The gate refuses the source document for this alone.
			expect(gateCaseCodes(doc)).toEqual([
				"CASE_OPERATION_TARGET_TYPE_MISMATCH",
			]);
			const outcome = await readWhole(doc);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error("A change the gate refuses was read.");
			expect(outcome.findings.map((one) => one.code)).toEqual([TYPE_CHANGE]);
			expect(outcome.findings[0]?.place).toMatchObject({ kind: "form" });
		});

	it("reads a keyed create of the loaded case's own type into a document the gate admits", async () => {
		const doc = visitApp([ownWritingNote, keyed("patient")]);
		expect(gateCaseCodes(doc)).toEqual([]);
		const outcome = await readWhole(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		expect(gateCaseCodes(outcome.draft.doc)).toEqual([]);
		expect(changes(outcome.draft.doc.forms[FORM]?.caseOperations)).toEqual([
			"create patient keyed",
		]);
	});
});
