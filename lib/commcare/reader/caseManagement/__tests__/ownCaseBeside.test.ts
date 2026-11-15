/**
 * A Save to Case block that changes the form's own case beside the form's own
 * change of it.
 *
 * Contract: the commit gate keeps one write of each property of the form's own
 * case and lets no other change close it
 * (`validator/rules/caseOperations.ts::ownCaseIndependenceFindings`:
 * `CASE_WRITE_DUPLICATE_PROPERTY` reason `own-case`,
 * `CASE_OPERATION_CLOSES_OWN_CASE`), while CommCare HQ's form builder keeps
 * such a block and a device and HQ's server run both. So a reading of one is
 * one finding at the form under
 * `a-savetocase-change-of-the-form-s-own-case-beside-the-form-s-own-change-of-it`
 * (`index.ts::settleCaseChanges`), with no defect, and a block of the own case
 * that writes only what the own change does not reads into a document the gate
 * admits.
 *
 * The plausible failure: the block read as a plain update or close of the
 * session's case, into a document the gate refuses with no finding (the
 * held sweep, `heldReading.ts`, fails that), or a close operation's block read
 * as the form's own close and refused as a block outside Nova's shape, which is
 * not true of a block Nova writes.
 *
 * Each source is Nova's print of the two changes (the emitter is total), as
 * HQ's form builder keeps them: a follow-up's Case Management update beside a
 * block's row, rename, owner or close; a close form's own close beside a
 * block's close; a registration's own create in a block beside an update of
 * it; an advanced follow-up's own load beside a block.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { eq, formField, literal, or, term } from "@/lib/domain/expression";
import {
	advancedFixture,
	OP,
	read,
} from "../../../__tests__/advancedPlacementFixture";
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

const BESIDE =
	"questions/a-savetocase-change-of-the-form-s-own-case-beside-the-form-s-own-change-of-it";
const FORM = testUuid("own-beside-form") as Uuid;
const NOTE = testUuid("own-beside-note");
const OWN = testUuid("own-beside-own") as Uuid;
const answer = term(formField(NOTE));
const onYes = eq(answer, literal("yes"));

/** A form of patients holding `operations`, the own change's uuid `OWN`. */
function app(
	type: "followup" | "close" | "registration",
	operations: CaseOperation[],
): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-1",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "outcome", label: "Outcome" },
						{ name: "visited", label: "Visited" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "own-beside-form",
							name: "Visit",
							type,
							fields: [f({ kind: "text", id: "note", uuid: NOTE })],
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

const ownWrites: CaseOperation = {
	uuid: OWN,
	id: "patient",
	action: "own",
	writes: [{ property: "outcome", value: answer }],
};

/** An update of the session's case: a write's own condition keeps it in a block. */
function sessionUpdate(
	extra: Readonly<Record<string, unknown>>,
	property = "outcome",
): CaseOperation {
	return {
		uuid: testUuid("own-beside-update"),
		id: "again",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property, value: answer, condition: onYes }],
		...extra,
	} as CaseOperation;
}

function sessionClose(condition?: typeof onYes): CaseOperation {
	return {
		uuid: testUuid("own-beside-close"),
		id: "shut",
		action: "close",
		caseType: "patient",
		target: { kind: "session" },
		...(condition !== undefined && { condition }),
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

/** An advanced follow-up of members whose own load writes `age`, beside `second`. */
function advanced(second: CaseOperation): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "members",
		operations: (): CaseOperation[] => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
			second,
		],
	}).doc;
}

describe("a Save to Case change of the form's own case beside the form's own change of it", () => {
	const cases: readonly (readonly [string, string, () => BlueprintDoc])[] = [
		[
			"a follow-up's update of a property the own change writes",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() => app("followup", [ownWrites, sessionUpdate({})]),
		],
		[
			"a follow-up's rename beside the own change's name",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				app("followup", [
					{ uuid: OWN, id: "patient", action: "own", name: answer },
					sessionUpdate({ rename: answer }, "visited"),
				]),
		],
		[
			"a follow-up's owner beside the own change's owner",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				app("followup", [
					{
						uuid: OWN,
						id: "patient",
						action: "own",
						owner: answer,
						writes: [{ property: "outcome", value: answer }],
					},
					sessionUpdate({ owner: answer }, "visited"),
				]),
		],
		[
			"a follow-up's close of its own case on a condition",
			"CASE_OPERATION_CLOSES_OWN_CASE",
			() => app("followup", [ownWrites, sessionClose(onYes)]),
		],
		[
			"a follow-up's close of its own case",
			"CASE_OPERATION_CLOSES_OWN_CASE",
			() => app("followup", [ownWrites, sessionClose()]),
		],
		[
			"a close form's close of its own case",
			"CASE_OPERATION_CLOSES_OWN_CASE",
			() => app("close", [ownWrites, sessionClose(onYes)]),
		],
		[
			"a registration's update of the case its own change creates",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				app("registration", [
					{ ...ownWrites, name: answer },
					sessionUpdate({ target: { kind: "op", opUuid: OWN } }),
				]),
		],
		[
			"an advanced follow-up's update of a property its own load writes",
			"CASE_WRITE_DUPLICATE_PROPERTY",
			() =>
				advanced({
					uuid: OP("again"),
					id: "again",
					action: "update",
					caseType: "member",
					target: { kind: "session" },
					writes: [
						{
							property: "age",
							value: read("age"),
							condition: eq(read("name"), literal("x")),
						},
					],
				}),
		],
	];
	for (const [name, code, make] of cases)
		it(`is one finding at the form for ${name}`, async () => {
			const doc = make();
			expect(gateCodes(doc)).toContain(code);
			const outcome = await readBack(doc);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error(
					"A change of the form's own case the gate refuses was read.",
				);
			expect(outcome.findings.map((one) => one.code)).toEqual([BESIDE]);
			expect(outcome.findings[0]?.place).toMatchObject({ kind: "form" });
		});

	// An advanced follow-up's block of the own case that writes another
	// property than the own load's reads back too.
	it("reads an advanced block of the own case that writes another property", async () => {
		const doc = advanced({
			uuid: OP("again"),
			id: "again",
			action: "update",
			caseType: "member",
			target: { kind: "session" },
			writes: [
				{
					property: "visited",
					value: read("name"),
					condition: eq(read("name"), literal("x")),
				},
			],
		});
		expect(gateCodes(doc)).toEqual([]);
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		expect(
			outcome.kind === "account" ? outcome.findings.map((one) => one.code) : [],
		).toEqual([]);
	});

	// A block of the own case that writes only what the own change does not is
	// a document the gate admits, and reads back as it.
	it("reads a block of the own case that writes another property", async () => {
		const doc = app("followup", [ownWrites, sessionUpdate({}, "visited")]);
		expect(gateCodes(doc)).not.toContain("CASE_WRITE_DUPLICATE_PROPERTY");
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`An admitted block of the own case was refused: ${JSON.stringify(outcome.findings.map((one) => one.code))}`,
			);
		const operations =
			outcome.draft.doc.forms[FORM]?.caseOperations?.map((one) => [
				one.action,
				one.action === "own" ? "own" : one.target.kind,
				(one.writes ?? []).map((write) => write.property),
			]) ?? [];
		expect(operations).toEqual([
			["own", "own", ["outcome"]],
			["update", "session", ["visited"]],
		]);
	});

	// The own close a close form keeps in a block of its own (a condition Case
	// Management's close condition cannot state) still reads as the own close:
	// its block holds no `update`.
	it("still reads the own close kept in a block of its own", async () => {
		const doc = produce(app("close", [ownWrites]), (draft) => {
			const form = draft.forms[FORM];
			if (form !== undefined)
				form.closeCondition = or(onYes, eq(answer, literal("y"))) as never;
		});
		expect(gateCodes(doc)).not.toContain("CASE_OPERATION_CLOSES_OWN_CASE");
		const outcome = await readBack(doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`A close form's own close was refused: ${JSON.stringify(outcome.findings.map((one) => one.code))}`,
			);
		const form = outcome.draft.doc.forms[FORM];
		expect(form?.type).toBe("close");
		expect(form?.closeCondition).toBeDefined();
		expect(
			(form?.caseOperations ?? []).filter((one) => one.action === "close"),
		).toEqual([]);
	});

	// The same own close's block with an empty `update` added by hand: no
	// runtime acts on it beside the close, HQ's form builder drops it on its
	// next save (Vellum writes `update` only for rows), and no block Nova
	// writes holds one. It is outside Nova's block shape and nothing else: no
	// close of the form's own case beside its own change, which the source does
	// not hold (`saveToCase.ts::readSaveToCaseBlocks`, `holdsUpdateRow`).
	it("reads the own close's block with an empty update as outside Nova's shape alone", async () => {
		const doc = produce(app("close", [ownWrites]), (draft) => {
			const form = draft.forms[FORM];
			if (form !== undefined)
				form.closeCondition = or(onYes, eq(answer, literal("y"))) as never;
		});
		const block = `<nova_close vellum:role="SaveToCase" vellum:case_type="patient"><case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><close/>`;
		const outcome = await readBack(doc, {
			xml: (xml) => {
				const at = xml.indexOf(block);
				if (at < 0 || xml.indexOf(block, at + 1) >= 0)
					throw new Error(
						"The export does not hold the own close's block once.",
					);
				return (
					xml.slice(0, at) +
					block.replace("<close/>", "<update/><close/>") +
					xml.slice(at + block.length)
				);
			},
		});
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "account")
			throw new Error("A block outside Nova's shape was read.");
		expect(outcome.findings.map((one) => one.code)).toEqual([
			"questions/savetocase-block-outside-nova-s-own-block-shape",
		]);
		expect(outcome.findings[0]?.place).toMatchObject({ kind: "question" });
	});
});
