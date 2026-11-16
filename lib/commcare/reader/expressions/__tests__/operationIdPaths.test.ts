/**
 * A Save to Case block's read of an earlier create's case id, spelled by the
 * create block's absolute path.
 *
 * Contract: Nova prints the read from the node the block's expression stands
 * in, through `current()` (`xform/caseOps.ts::bindOperationPaths`); an author
 * in CommCare HQ may write the create block's absolute path, which Core
 * resolves to the same node wherever that path names one (a create outside
 * every repeat, or one in the block's own repeat, which Core contextualizes
 * to the block's entry). So the reading binds the absolute path as the read
 * of the create's id (`folds.ts::operationId`), held where Core reads what
 * Nova's print reads (the relocation `default-reads-current`,
 * `readExpression.ts::relocatedOperationIds`), and where Nova cannot hold
 * the read, refused under the same entry the `current()` spelling is: a
 * runtime target that reads a create's id, a change at the root that reads
 * the case a repeat's create makes, and one in another repeat. Each of those
 * is one finding, and a slot the checker refuses is left out of the document
 * the block's other slots are printed over (`index.ts::readExpressions`), so
 * no other slot of the block is left unrecognized beside it.
 *
 * The plausible failure: the absolute path read as an expression Core
 * cannot evaluate (`parse:unknown-field`), which is untrue, since Core reads
 * it; or a refused read written into the document every other slot prints
 * over, so the block's case wire fails to print and its other slots are
 * unrecognized beside reader defects.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import {
	type Expression,
	eq,
	formField,
	idOf,
	literal,
	term,
} from "@/lib/domain/expression";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import {
	type ExportEdits,
	exportedBody,
	inputFor,
} from "../../__tests__/novaExport";
import { readHqApp } from "../../caseManagement/__tests__/heldReading";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";

const FORM = testUuid("op-path-form") as Uuid;
const NOTE = testUuid("op-path-note");
const KIDS = testUuid("op-path-kids");
const KID = testUuid("op-path-kid");
const PETS = testUuid("op-path-pets");
const PET = testUuid("op-path-pet");
const VISIT = testUuid("op-path-visit") as Uuid;
const answer = term(formField(NOTE));
/** `concat(<the create's id>, 'x')`. */
const idPlus: Expression = {
	kind: "concat",
	parts: [idOf(VISIT), term(literal("x"))],
};

/** A question's logic Nova prints as this literal, which a test's edit
 *  respells as a read of a create block's id. */
const MARK = "424242";

function app(
	operations: CaseOperation[],
	logic: { readonly root?: object; readonly kids?: object } = {},
): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-1",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "outcome", label: "Outcome" },
						{ name: "visit_id", label: "Visit" },
					],
				},
				{ name: "visit", properties: [{ name: "outcome", label: "Outcome" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "op-path-form",
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", uuid: NOTE }),
								...(logic.root === undefined
									? []
									: [f({ id: "link", ...logic.root } as never)]),
								f({
									kind: "repeat",
									id: "kids",
									uuid: KIDS,
									repeat_mode: "user_controlled",
									children: [
										f({ kind: "text", id: "kid", uuid: KID }),
										...(logic.kids === undefined
											? []
											: [f({ id: "kid_link", ...logic.kids } as never)]),
									],
								} as never),
								f({
									kind: "repeat",
									id: "pets",
									uuid: PETS,
									repeat_mode: "user_controlled",
									children: [f({ kind: "text", id: "pet", uuid: PET })],
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
	uuid: testUuid("op-path-own") as Uuid,
	id: "patient",
	action: "own",
	writes: [{ property: "outcome", value: answer }],
};

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

const create = (extra: object = {}) =>
	({
		uuid: VISIT,
		id: "mk",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: answer,
		...extra,
	}) as CaseOperation;

const docs: Record<string, () => BlueprintDoc> = {
	heldWrite: () =>
		app([
			own,
			create(),
			{
				uuid: testUuid("op-path-upd"),
				id: "again",
				action: "update",
				caseType: "visit",
				target: { kind: "op", opUuid: VISIT },
				writes: [{ property: "outcome", value: idPlus }],
			} as CaseOperation,
		]),
	targetExpr: () =>
		app([
			own,
			create(),
			{
				uuid: testUuid("op-path-upd"),
				id: "again",
				action: "update",
				caseType: "visit",
				target: { kind: "expression", expr: idPlus },
				writes: [
					{
						property: "outcome",
						value: answer,
						condition: eq(answer, literal("y")),
					},
				],
			} as CaseOperation,
		]),
	rootFromRepeat: () =>
		app([
			own,
			create({ forEach: { repeat: KIDS } }),
			{
				uuid: testUuid("op-path-upd"),
				id: "again",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{
						property: "visit_id",
						value: idPlus,
						condition: eq(answer, literal("y")),
					},
				],
			} as CaseOperation,
		]),
	sameRepeat: () =>
		app([
			own,
			create({ forEach: { repeat: KIDS } }),
			{
				uuid: testUuid("op-path-upd"),
				id: "again",
				action: "update",
				caseType: "visit",
				forEach: { repeat: KIDS },
				target: { kind: "op", opUuid: VISIT },
				writes: [{ property: "outcome", value: idPlus }],
			} as CaseOperation,
		]),
	otherRepeat: () =>
		app([
			own,
			create({ forEach: { repeat: KIDS } }),
			{
				uuid: testUuid("op-path-upd"),
				id: "again",
				action: "update",
				caseType: "patient",
				forEach: { repeat: PETS },
				target: { kind: "session" },
				writes: [
					{
						property: "visit_id",
						value: idPlus,
						condition: eq(answer, literal("y")),
					},
				],
			} as CaseOperation,
		]),
};

function gateCodes(doc: BlueprintDoc): string[] {
	const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	return verdict.ok ? [] : verdict.findings.map((one) => one.code);
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

/** The export of `doc` with the read Nova prints from `current()` spelled
 *  by the create block's absolute path. */
function absolute(from: string, to: string): ExportEdits {
	return { xml: (xml) => replaceOnce(xml, `concat(${from}`, `concat(${to}`) };
}

const ROOT_CREATE = "/data/nova_operations/mk/case/@case_id";
const REPEAT_CREATE = "/data/kids/nova_operations/mk/case/@case_id";
const OUTSIDE =
	"questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id";

function operationsOf(outcome: Awaited<ReturnType<typeof readBack>>) {
	if (outcome.kind !== "read")
		throw new Error(
			`The source was not read: ${JSON.stringify(outcome.findings.map((one) => one.code))}`,
		);
	return Object.values(outcome.draft.doc.forms).flatMap(
		(form) => form.caseOperations ?? [],
	);
}

describe("a create's id read by the create block's absolute path", () => {
	const held = [
		[
			"a create outside every repeat",
			"heldWrite",
			"current()/../../../../mk/case/@case_id",
			ROOT_CREATE,
		],
		[
			"a create in the block's own repeat",
			"sameRepeat",
			"current()/../../../../mk/case/@case_id",
			REPEAT_CREATE,
		],
	] as const;
	for (const [name, key, from, to] of held)
		it(`holds the read of ${name}, as the read Nova prints from current()`, async () => {
			const doc = docs[key]?.() as BlueprintDoc;
			expect(gateCodes(doc).filter((code) => code.startsWith("CASE_"))).toEqual(
				[],
			);
			const printed = await readBack(doc);
			const edited = await readBack(doc, absolute(from, to));
			expect(edited.defects).toEqual([]);
			const operations = operationsOf(edited);
			expect(operations).toEqual(operationsOf(printed));
			const again = operations.find((one) => one.id === "again");
			expect(
				again !== undefined && "writes" in again
					? again.writes?.[0]?.value
					: undefined,
			).toEqual(idPlus);
		});

	const refused = [
		[
			"a runtime target that reads a create's id",
			"targetExpr",
			"CASE_OPERATION_TARGET_INVALID",
			"current()/../../../mk/case/@case_id",
			ROOT_CREATE,
		],
		[
			"a change at the root that reads the case a repeat's create makes",
			"rootFromRepeat",
			"CASE_OPERATION_AMBIGUOUS_REFERENCE",
			"current()/../../../../../kids/nova_operations/mk/case/@case_id",
			REPEAT_CREATE,
		],
		[
			"a change in another repeat that reads the case a repeat's create makes",
			"otherRepeat",
			"CASE_OPERATION_REPEAT_CORRELATION",
			"current()/../../../../../../kids/nova_operations/mk/case/@case_id",
			REPEAT_CREATE,
		],
	] as const;
	for (const [name, key, code, from, to] of refused)
		it(`refuses ${name} under the entry its current() spelling takes, as one finding`, async () => {
			const doc = docs[key]?.() as BlueprintDoc;
			expect(gateCodes(doc)).toContain(code);
			const printed = await readBack(doc);
			const edited = await readBack(doc, absolute(from, to));
			for (const outcome of [printed, edited]) {
				expect(outcome.defects).toEqual([]);
				if (outcome.kind !== "account")
					throw new Error(`${name}, which the gate refuses, was read.`);
				expect(outcome.findings.map((one) => one.code)).toEqual([OUTSIDE]);
				expect(outcome.findings[0]?.place).toMatchObject({
					kind: "question",
				});
			}
			if (edited.kind !== "account") return;
			// The absolute path is never read as an expression Core cannot evaluate.
			expect(
				edited.findings.map(
					(one) => (one.detail as { reason?: string } | undefined)?.reason,
				),
			).not.toContain("parse:unknown-field");
		});
});

/**
 * A question's own logic (a Hidden Value's calculate, a display condition)
 * reading a Save to Case create's id by the create block's absolute path.
 * HQ's form builder offers a block's case id as a reference, and Core
 * evaluates the path, while Nova holds the read of a create's id only in a
 * case operation's slots (`folds.ts::operationId`). So it is one finding
 * under the entry for a form expression Core runs and Nova's checker
 * narrows, `a-form-expression-outside-what-nova-types`, never the read of a
 * question that is not there.
 */
describe("a question's logic that reads a create's id by its block's path", () => {
	const NARROWED =
		"expressions-and-data/a-form-expression-outside-what-nova-types";
	const cases = [
		[
			"a Hidden Value's calculate at the root reading a root create's id",
			() =>
				app([own, create()], {
					root: { kind: "hidden", calculate: MARK },
				}),
			`calculate="${MARK}"`,
			`calculate="${ROOT_CREATE}"`,
		],
		[
			"a Hidden Value's calculate as HQ's form builder saves it, with its shadow",
			() =>
				app([own, create()], {
					root: { kind: "hidden", calculate: MARK },
				}),
			`calculate="${MARK}"`,
			`calculate="${ROOT_CREATE}" vellum:calculate="#form/nova_operations/mk/case/@case_id"`,
		],
		[
			"a question's display condition reading a root create's id",
			() =>
				app([own, create()], {
					root: { kind: "text", relevant: `${MARK} = 7` },
				}),
			`relevant="${MARK} = 7"`,
			`relevant="${ROOT_CREATE} = 7"`,
		],
		[
			"a Hidden Value's calculate in a repeat reading its repeat's create's id",
			() =>
				app([own, create({ forEach: { repeat: KIDS } })], {
					kids: { kind: "hidden", calculate: MARK },
				}),
			`calculate="${MARK}"`,
			`calculate="${REPEAT_CREATE}"`,
		],
		// A relative path, and one from `current()`, are read from the
		// question the bind is on, as Core reads them.
		[
			"a Hidden Value's calculate at the root reading a root create's id by a relative path",
			() =>
				app([own, create()], {
					root: { kind: "hidden", calculate: MARK },
				}),
			`calculate="${MARK}"`,
			`calculate="../nova_operations/mk/case/@case_id"`,
		],
		[
			"a question's display condition reading a root create's id from current()",
			() =>
				app([own, create()], {
					root: { kind: "text", relevant: `${MARK} = 7` },
				}),
			`relevant="${MARK} = 7"`,
			`relevant="current()/../nova_operations/mk/case/@case_id = 7"`,
		],
		[
			"a Hidden Value's calculate in a repeat reading its repeat's create's id by a relative path",
			() =>
				app([own, create({ forEach: { repeat: KIDS } })], {
					kids: { kind: "hidden", calculate: MARK },
				}),
			`calculate="${MARK}"`,
			`calculate="../nova_operations/mk/case/@case_id"`,
		],
	] as const;
	for (const [name, build, from, to] of cases)
		it(`refuses ${name} as one finding under the narrowed form logic entry`, async () => {
			const doc = build();
			// Nova's own export reads back whole, held to the gate
			// (`heldReading.ts`).
			const printed = await readBack(doc);
			expect(printed.kind).toBe("read");
			expect(printed.defects).toEqual([]);
			const edited = await readBack(doc, {
				xml: (xml) => replaceOnce(xml, from, to),
			});
			expect(edited.defects).toEqual([]);
			if (edited.kind !== "account")
				throw new Error(`${name}, which Nova cannot hold, was read.`);
			expect(edited.findings.map((one) => one.code)).toEqual([NARROWED]);
			expect(edited.findings[0]?.place).toMatchObject({ kind: "question" });
			expect(
				(edited.findings[0]?.detail as { reason?: string } | undefined)?.reason,
			).toBe("operation-id-outside-case-operation");
		});
});
