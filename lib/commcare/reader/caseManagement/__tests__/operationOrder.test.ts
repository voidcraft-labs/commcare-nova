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
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";
import { inWireScopeOrder } from "../operationOrder";

const NO_ORDER =
	"questions/a-keyed-savetocase-create-in-no-order-nova-holds-beside-the-form-s-other-changes";
const FORM = testUuid("order-form");
const NOTE = testUuid("order-note");
const KIDS = testUuid("order-kids");
const KID_NAME = testUuid("order-kid-name");
const PROPERTY = testUuid("order-property") as Uuid;

function visitApp(operations: CaseOperation[]): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-1",
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "photo", properties: [] },
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
