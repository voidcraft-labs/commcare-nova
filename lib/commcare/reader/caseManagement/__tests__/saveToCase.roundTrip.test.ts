/**
 * Save to Case blocks read back from Nova's own emission.
 *
 * Contract: every block shape `saveToCaseBlockShape` returns (a root create,
 * a keyed create, a create in a repeat, a conditional update, a close, a
 * several-case form, the own arm in a block, the own close's block) is read
 * into one operation whose placement is the path the block stands at, held
 * (the canonical member of `unheld-placements-are-held`), with no finding;
 * and each value is read through the wrapper the emitter writes around it,
 * so what is registered for the expression stage is the authored value
 * alone. A date and time saved in the spelling Nova wrote before this reader
 * reads as the same write and records the register row its first publish
 * declares; today's spelling records nothing. The plausible failures: a
 * block read into the wrong operation, a guard read as an operation, a
 * wrapper read as part of the value (the emitter would then wrap it twice
 * and every Nova-born block would fail its re-emission), a keyed create's
 * id compared under the reading's own prefix rather than the source's, so
 * that every Nova-born keyed create reads as outside Nova's shape, the
 * source's prefix not handed out with its operation in
 * `draft.identities.keyedCreates` (a publish would then file a key a worker
 * enters again under a new case), and an
 * app Nova published before refused, or brought in with no word of what its
 * first publish changes.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	authoredCaseIdPrefix,
	type BlueprintDoc,
	type CaseOperation,
	type CaseTarget,
	NEW_APP_SETTINGS,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import {
	actingUser,
	concat,
	datetimeLiteral,
	eq,
	formField,
	literal,
	now,
	or,
	prop,
	term,
	unowned,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { caseListOf } from "../../../../../proof/targeted/build";
import { saveToCaseShapesApp } from "../../../../../proof/targeted/documents/saveToCaseShapes";
import { caseOperationFixture } from "../../../__tests__/caseOperationFixture";
import { planPlacements } from "../../../placement";
import { serializeXml } from "../../../serializeXml";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import {
	saveToCaseBlockShape,
	writtenSaveToCaseBlocks,
} from "../../../xform/caseOps";
import { parseXml } from "../../../xmlParse";
import { readFormSyntax } from "../../../xpath/formSyntax";
import { w } from "../../../xpath/wire/builders";
import { typedInstantValue } from "../../../xpath/wire/instant";
import { serializeWire } from "../../../xpath/wire/serialize";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { sameXPathText } from "../../syntaxCompare";
import { saveToCaseReading } from "../saveToCase";
import { type CaseReading, readCases } from "./caseReading";
import { readHqApp } from "./heldReading";

const OUTSIDE = "questions/savetocase-block-outside-nova-s-own-block-shape";

/** Each form's case changes by what they are, the expression trees aside
 *  (the expression stage's own tests hold those): the form's type and the
 *  place of its own close, and each operation's identity, action, case type,
 *  target, placement, written properties, links and which slots it holds. */
function caseChanges(doc: BlueprintDoc) {
	return Object.fromEntries(
		Object.values(doc.forms).map((form) => [
			form.name,
			{
				type: form.type,
				ownClosePlacement: form.ownClosePlacement,
				operations: (form.caseOperations ?? []).map((operation) => {
					const one = operation as CaseOperation & {
						readonly caseType?: string;
						readonly target?: { readonly kind: string; idFrom?: Uuid };
						readonly links?: readonly {
							readonly identifier: string;
							readonly target: { readonly kind: string } | null;
						}[];
						readonly condition?: unknown;
						readonly name?: unknown;
						readonly owner?: { readonly kind: string };
						readonly rename?: unknown;
						readonly retype?: string;
						readonly forEach?: unknown;
					};
					return {
						uuid: one.uuid,
						id: one.id,
						action: one.action,
						caseType: one.caseType,
						target: one.target?.kind,
						idFrom: one.target?.idFrom,
						placement: one.placement,
						writes: (one.writes ?? []).map((write) => ({
							property: write.property,
							condition: write.condition !== undefined,
						})),
						links: (one.links ?? []).map((link) => ({
							identifier: link.identifier,
							target: link.target?.kind ?? null,
						})),
						condition: one.condition !== undefined,
						name: one.name !== undefined,
						owner: one.owner?.kind,
						rename: one.rename !== undefined,
						retype: one.retype,
						forEach: one.forEach,
					};
				}),
			},
		]),
	);
}

/** Every text registered for the expression stage, by slot and member. */
/** The texts registered for the expression stage to read into an operation's slots; a text of
 *  the emitter's own, registered for the uses its syntax makes alone, is read into none. */
function registered(
	reading: CaseReading,
): { slot: string; member: unknown; text: string }[] {
	return reading.ctx.pending.list().flatMap((one) =>
		one.usesOnly !== true &&
		one.ref.entity === "form" &&
		one.ref.slot.startsWith("case_operation_")
			? [
					{
						slot: one.ref.slot,
						member: "member" in one.ref ? one.ref.member : undefined,
						text: one.text,
					},
				]
			: [],
	);
}

describe("every Save to Case shape Nova's emitter writes", () => {
	it("reads each block into one operation at the path it stands at, with no finding", async () => {
		const doc = saveToCaseShapesApp();
		const reading = await readCases(doc);
		expect(reading.findings.map((one) => one.code)).not.toContain(OUTSIDE);
		for (const [formUuid, form] of Object.entries(doc.forms)) {
			const draft = reading.forms.find((one) => one.form.name === form.name);
			if (draft === undefined) throw new Error(`The app holds ${form.name}.`);
			const { placements } = planPlacements(doc, formUuid as Uuid);
			// Each Save to Case block D's source holds for an operation, by its path from its scope.
			const operations = form.caseOperations ?? [];
			const expected = writtenSaveToCaseBlocks(
				doc,
				formUuid as Uuid,
				null,
			).flatMap((block) => {
				if (block.subject.kind !== "operation") return [];
				const { operationUuid } = block.subject;
				const operation = operations.find((one) => one.uuid === operationUuid);
				return operation === undefined
					? []
					: [
							{
								action: operation.action,
								path: block.path,
								shape: saveToCaseBlockShape(
									doc,
									formUuid as Uuid,
									block.subject,
								),
							},
						];
			});
			const ownClose = placements.get("own-close")?.placement;
			const read = saveToCaseReading(draft);
			expect(
				(read?.proposals ?? []).map((one) => ({
					action: one.action,
					path: one.block.path.slice(
						one.block.path.length - one.segments.length,
					),
					shape: one.segments,
				})),
				form.name,
			).toEqual(expected);
			if (ownClose?.kind === "save-to-case") {
				expect(read?.ownClose?.path).toEqual(ownClose.path);
				expect(draft.form.ownClosePlacement).toEqual({
					kind: "save-to-case",
					path: ownClose.path,
				});
			}
			// Every operation read from a block holds its block's path.
			for (const operation of draft.form.caseOperations ?? [])
				if (operation.placement?.kind === "save-to-case")
					expect(expected.map((one) => one.path)).toContainEqual(
						operation.placement.path,
					);
		}
	});

	it("reads the whole app back to its own case changes, with no finding: the several-case form, the row block and the keyed create among them", async () => {
		const doc = saveToCaseShapesApp();
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const want = READER_CANONICAL_CHOICES.reduce(
			(current, choice) => choice.apply(current),
			doc,
		);
		expect(caseChanges(outcome.draft.doc)).toEqual(caseChanges(want));
	});

	it("claims a block in a repeat under its own entry, and one writing a hyphenated property under that one's", async () => {
		// A create in a repeat's row, and a create at the root that writes a
		// property whose name holds a hyphen.
		const repeated = caseOperationFixture("repeat");
		const base = saveToCaseShapesApp();
		const hyphenated = produce(base, (draft) => {
			for (const [formUuid, form] of Object.entries(draft.forms)) {
				const { placements } = planPlacements(base, formUuid as Uuid);
				const create = (form.caseOperations ?? []).find((one) => {
					const target: CaseTarget | undefined = one.target;
					return (
						one.action === "create" &&
						one.forEach === undefined &&
						target?.kind === "new" &&
						target.idFrom === undefined &&
						placements.get(one.uuid)?.placement.kind === "save-to-case"
					);
				});
				if (create === undefined) continue;
				create.writes = [
					...(create.writes ?? []),
					{ property: "blood-type", value: term(literal("o")) },
				];
				return;
			}
			throw new Error("The app holds no root create in a block.");
		});
		const counts = async (doc: BlueprintDoc) => {
			const outcome = readHqApp(
				await inputFor(exportedBody(doc), {
					resolver: matchingResolver(
						"app-1",
						externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
					),
					knownCaseTypes: knownCaseTypesOf(doc),
				}),
			);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			return outcome.claims.counts;
		};
		expect(
			(await counts(repeated))["questions/savetocase-inside-a-repeat"],
		).toBeGreaterThan(0);
		expect(
			(await counts(hyphenated))[
				"questions/savetocase-property-names-with-hyphens-a-z-w-case-insensitive"
			],
		).toBe(1);
	});

	it.each([
		// An earlier create's id read through `current()` at the root and in a repeat.
		"sequence",
		"repeat",
		"query",
		// A consumer of a conditional create, and of a conditional retype of the
		// session's case and of a case an expression names: the emitter leads each
		// consumer's condition with the producer's, which is read off again.
		"conditional",
		"retype",
		"expression-retype",
		// A keyed create in its own one-row repeat, and directly in a repeat's row.
		"key",
		"key-query",
	] as const)(
		"reads the %s case changes back whole, with no finding",
		async (scenario) => {
			const doc = caseOperationFixture(scenario);
			const outcome = readHqApp(
				await inputFor(exportedBody(doc), {
					resolver: matchingResolver(
						"app-1",
						externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
					),
					knownCaseTypes: knownCaseTypesOf(doc),
				}),
			);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			const want = READER_CANONICAL_CHOICES.reduce(
				(current, choice) => choice.apply(current),
				doc,
			);
			expect(caseChanges(outcome.draft.doc)).toEqual(caseChanges(want));
		},
	);

	it("registers each value inside the emitter's trim, and reads an owner of the acting user as absent first", async () => {
		const doc = saveToCaseShapesApp();
		const reading = await readCases(doc);
		const names = registered(reading).filter(
			(one) => one.slot === "case_operation_name",
		);
		expect(names.length).toBeGreaterThan(0);
		// A name is a question's answer, read inside the emitter's trim.
		for (const name of names) {
			const tree = readFormSyntax(name.text);
			expect(tree.ok && tree.node?.kind !== "call", name.text).toBe(true);
		}
		expect(
			names.some((name) =>
				sameXPathText(name.text, "/data/note", { ruleSet: "form" }),
			),
		).toBe(true);
		const creates = reading.forms
			.flatMap((form) => form.form.caseOperations ?? [])
			.filter((operation) => operation.action === "create");
		for (const create of creates) expect(create.owner).toBeUndefined();
	});
});

const PATIENT_FORM = testUuid("stc-visit");
const SEEN = testUuid("stc-seen");
const PICTURE = testUuid("stc-picture");

function visitApp(operations: CaseOperation[]): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visited_at",
							label: proseText("Visited at"),
							data_type: "datetime",
						},
						{ name: "note", label: proseText("Note"), data_type: "text" },
					],
				},
				{
					name: "photo",
					properties: [{ name: "picture", label: proseText("Picture") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "stc-visit",
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "seen", uuid: SEEN }),
								f({ kind: "image", id: "picture", uuid: PICTURE }),
							],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[PATIENT_FORM] = {
				...built.forms[PATIENT_FORM],
				caseOperations: operations,
			} as never;
		},
	);
}

const ownVisited: CaseOperation = {
	uuid: testUuid("stc-own"),
	id: "patient",
	action: "own",
	writes: [{ property: "visited_at", value: now() }],
};

/** The source with the row that saves `property` given `calculate`. */
function withRowCalculate(property: string, calculate: string) {
	return (xml: string) => {
		const document = parseXml(xml);
		const walk = (nodes: readonly unknown[]): void => {
			for (const node of nodes as {
				type?: string;
				name?: string;
				attribs?: Record<string, string>;
				children?: unknown[];
			}[]) {
				if (
					node.type === "tag" &&
					node.name === "bind" &&
					node.attribs?.nodeset?.endsWith(`/update/${property}`)
				)
					node.attribs.calculate = calculate;
				if (node.children !== undefined) walk(node.children);
			}
		};
		walk(document.children);
		return serializeXml(document);
	};
}

const WHEN = testUuid("stc-when");

/** A follow-up whose blocks create patients, with a text and a date-and-time
 *  question, and `operations` after its own arm. */
function stampsApp(operations: CaseOperation[]): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visited_at",
							label: proseText("Visited at"),
							data_type: "datetime",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "stc-stamps",
							name: "Stamps",
							type: "followup",
							fields: [
								f({ kind: "text", id: "seen", uuid: SEEN }),
								f({ kind: "datetime", id: "when", uuid: WHEN }),
							],
						},
					],
				},
			],
		},
		(built) => {
			const uuid = testUuid("stc-stamps");
			const form = built.forms[uuid];
			built.forms[uuid] = {
				...form,
				caseOperations: [...(form?.caseOperations ?? []), ...operations],
			} as never;
		},
	);
}

/** A create of a patient named by the text question, with `writes`. */
function stampedCreate(
	id: string,
	writes: CaseOperation["writes"],
): CaseOperation {
	return {
		uuid: testUuid(`stc-${id}`),
		id,
		action: "create",
		caseType: "patient",
		target: { kind: "new" },
		name: term(formField(SEEN)),
		writes,
	} as CaseOperation;
}

describe("a value read through its wrapper", () => {
	it("reads a date-and-time write of a question's answer, of a case's stored text, of the clock and of a literal, and an external id inside its trim, back to the authored value", async () => {
		const doc = stampsApp([
			stampedCreate("from_answer", [
				{ property: "visited_at", value: term(formField(WHEN)) },
			]),
			stampedCreate("from_stored", [
				{ property: "visited_at", value: term(prop("patient", "visited_at")) },
			]),
			stampedCreate("from_clock", [{ property: "visited_at", value: now() }]),
			stampedCreate("with_external_id", [
				{ property: "external_id", value: term(formField(SEEN)) },
			]),
		]);
		// Re-emission holds each block whole: a wrapper read as part of the
		// value would be written around it twice.
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		// The clock's node is the write's own, never a question of the reading.
		expect(
			Object.values(outcome.draft.doc.fields).filter((field) =>
				field.id.startsWith("nova_instant_"),
			),
		).toEqual([]);
		// What the expression stage binds is the authored value alone.
		const reading = await readCases(doc);
		const values = registered(reading).filter(
			(one) => one.slot === "case_operation_write_value",
		);
		const writtenValue = (operationId: string) => {
			const operation = reading.forms
				.flatMap((form) => form.form.caseOperations ?? [])
				.find((one) => one.id === operationId);
			return values.find(
				(one) =>
					(one.member as { operationUuid?: Uuid } | undefined)
						?.operationUuid === operation?.uuid,
			)?.text;
		};
		const same = (text: string | undefined, want: string) =>
			text !== undefined && sameXPathText(text, want, { ruleSet: "form" });
		expect(same(writtenValue("from_answer"), "/data/when")).toBe(true);
		expect(same(writtenValue("from_clock"), "now()")).toBe(true);
		expect(same(writtenValue("with_external_id"), "/data/seen")).toBe(true);
		const storedTree = readFormSyntax(writtenValue("from_stored") ?? "");
		expect(storedTree.ok && storedTree.node?.kind !== "call").toBe(true);
		// A literal is written in CommCare HQ's spelling, and read as that
		// literal, with no wrapper around it.
		const literal = await readCases(
			stampsApp([
				stampedCreate("from_literal", [
					{
						property: "visited_at",
						value: term(datetimeLiteral("2026-03-04T05:06:07Z")),
					},
				]),
			]),
		);
		const literalText = registered(literal).find(
			(one) => one.slot === "case_operation_write_value",
		)?.text;
		const literalTree = readFormSyntax(literalText ?? "");
		expect(literalTree.ok && literalTree.node?.kind).toBe("string");
		expect(literal.findings.map((one) => one.code)).not.toContain(OUTSIDE);
	});

	it("reads a date and time saved as CommCare HQ stores it back to the clock it reads, and records nothing", async () => {
		const reading = await readCases(visitApp([ownVisited]));
		const value = registered(reading).find(
			(one) => one.slot === "case_operation_write_value",
		);
		expect(
			value?.text !== undefined &&
				sameXPathText(value.text, "now()", { ruleSet: "form" }),
		).toBe(true);
		expect(
			reading.ctx.facts.sameStateRewrites.filter(
				(one) => one.register === "date-and-time-saved-as-hq-stores-it",
			),
		).toEqual([]);
	});

	it("reads a date and time in the spelling Nova wrote before as the same write, and records its register row", async () => {
		const earlier = serializeWire(typedInstantValue(w.call("now", [])), {
			target: "xform",
			constraint: false,
		}).text;
		const reading = await readCases(visitApp([ownVisited]), {
			editSource: withRowCalculate("visited_at", earlier),
		});
		const value = registered(reading).find(
			(one) => one.slot === "case_operation_write_value",
		);
		expect(
			value?.text !== undefined &&
				sameXPathText(value.text, "now()", { ruleSet: "form" }),
		).toBe(true);
		expect(
			reading.ctx.facts.sameStateRewrites.filter(
				(one) => one.register === "date-and-time-saved-as-hq-stores-it",
			),
		).toHaveLength(1);
		expect(reading.findings.map((one) => one.code)).not.toContain(OUTSIDE);
	});

	it("reads a capture's link as the capture it is built over", async () => {
		const reading = await readCases(
			visitApp([
				{
					uuid: testUuid("stc-photo"),
					id: "photo",
					action: "create",
					caseType: "photo",
					target: { kind: "new" },
					name: term(formField(SEEN)),
					writes: [
						{
							property: "picture",
							value: term({ kind: "capture-link", field: PICTURE }),
						},
					],
				},
			]),
			{
				expand: {
					attachmentTarget: {
						origin: "https://india.commcarehq.org",
						domain: "clinic",
					},
				},
			},
		);
		const photo = reading.forms
			.flatMap((form) => form.form.caseOperations ?? [])
			.find((operation) => operation.action === "create");
		const picture =
			reading.forms[0]?.xform === null ? undefined : reading.forms[0];
		const field = picture?.xform?.nodes.get("picture");
		const role =
			field === undefined ? undefined : picture?.xform?.roles.get(field);
		expect(photo?.writes).toEqual([
			{
				property: "picture",
				value: term({
					kind: "capture-link",
					field:
						role?.kind === "field" ? (role.field.uuid as Uuid) : ("" as Uuid),
				}),
			},
		]);
	});

	it("reads a follow-up form's root create keyed by an answer whole, its id printed back under the prefix the source holds", async () => {
		const keyed: CaseOperation = {
			uuid: testUuid("stc-keyed"),
			id: "photo",
			action: "create",
			caseType: "photo",
			target: { kind: "new", idFrom: SEEN },
			name: term(formField(SEEN)),
		};
		const source = visitApp([keyed]);
		const outcome = readHqApp(await inputFor(exportedBody(source)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const doc = outcome.draft.doc;
		const seen = Object.values(doc.fields).find((field) => field.id === "seen");
		const [formUuid, form] = Object.entries(doc.forms).find(([, one]) =>
			(one.caseOperations ?? []).some((op) => op.action === "create"),
		) ?? [undefined, undefined];
		const create = form?.caseOperations?.find((op) => op.action === "create");
		expect(create?.target).toEqual({ kind: "new", idFrom: seen?.uuid });
		expect(create?.placement).toMatchObject({ kind: "save-to-case" });
		// The reading's own identities derive another prefix; the one the source's ids stand
		// under is handed out with the operation it belongs to.
		const sourcePrefix = authoredCaseIdPrefix({
			appId: source.appId,
			formUuid: PATIENT_FORM,
			operationUuid: keyed.uuid,
			caseType: "photo",
		});
		expect(
			authoredCaseIdPrefix({
				appId: doc.appId,
				formUuid: formUuid as Uuid,
				operationUuid: create?.uuid as Uuid,
				caseType: "photo",
			}),
		).not.toBe(sourcePrefix);
		expect(outcome.draft.identities.keyedCreates).toEqual([
			{
				operationUuid: create?.uuid,
				formUuid,
				caseType: "photo",
				prefix: sourcePrefix,
			},
		]);
	});

	it("reads a keyed create under a prefix Nova never derives as an authored id, so nothing reaches the ledger its floor refuses", async () => {
		const keyed: CaseOperation = {
			uuid: testUuid("stc-keyed"),
			id: "photo",
			action: "create",
			caseType: "photo",
			target: { kind: "new", idFrom: SEEN },
			name: term(formField(SEEN)),
		};
		const source = visitApp([keyed]);
		const derived = authoredCaseIdPrefix({
			appId: source.appId,
			formUuid: PATIENT_FORM,
			operationUuid: keyed.uuid,
			caseType: "photo",
		});
		const uuid = derived.slice("nova-case-v1:".length, -1);
		const offShape = [
			"nova-case-v1:abc:",
			`nova-case-v1:${uuid.toUpperCase()}:`,
			// A version-4 UUID in the version-5 place.
			`nova-case-v1:${uuid.slice(0, 14)}4${uuid.slice(15)}:`,
		];
		for (const prefix of offShape) {
			const outcome = readHqApp(
				await inputFor(
					exportedBody(source, {
						xml: (xml) => xml.split(derived).join(prefix),
					}),
				),
			);
			const findings = outcome.kind === "account" ? outcome.findings : [];
			expect(findings.map((one) => one.code)).toContain(
				"questions/savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside",
			);
			if (outcome.kind === "read")
				expect(outcome.draft.identities.keyedCreates).toEqual([]);
		}
	});

	it("reads an owner of the acting user's id as absent, and of no owner as unowned", async () => {
		const create = (owner: CaseOperation["owner"]): CaseOperation =>
			({
				uuid: testUuid("stc-owned"),
				id: "photo",
				action: "create",
				caseType: "photo",
				target: { kind: "new" },
				name: term(formField(SEEN)),
				...(owner !== undefined && { owner }),
			}) as CaseOperation;
		for (const [owner, read] of [
			[undefined, undefined],
			[actingUser(), undefined],
			[unowned(), unowned()],
		] as const) {
			const reading = await readCases(visitApp([create(owner)]));
			const operation = reading.forms
				.flatMap((form) => form.form.caseOperations ?? [])
				.find((one) => one.action === "create");
			expect(operation?.owner).toEqual(read);
			expect(
				registered(reading).filter(
					(one) => one.slot === "case_operation_owner",
				),
			).toEqual([]);
		}
	});
});

describe("the worker's record and the own arm in a block", () => {
	it("reads an update of the worker's record that takes a block as that update, never the reserved type's finding", async () => {
		const worker: CaseOperation = {
			uuid: testUuid("stc-worker"),
			id: "worker",
			action: "update",
			caseType: "commcare-user",
			target: { kind: "worker-record" },
			// A write condition keeps the update out of Case Management's worker slot.
			writes: [
				{
					property: "last_seen",
					value: term(formField(SEEN)),
					condition: eq(term(formField(SEEN)), literal("yes")),
				},
			],
		};
		const reading = await readCases(visitApp([worker]));
		expect(reading.findings.map((one) => one.code)).not.toContain(OUTSIDE);
		expect(reading.findings.map((one) => one.code)).not.toContain(
			"questions/savetocase-create-close-or-link-of-commcare-user-or-type-user",
		);
		const read = reading.forms
			.flatMap((form) => form.form.caseOperations ?? [])
			.find((one) => one.action === "update");
		expect(read).toMatchObject({
			caseType: "commcare-user",
			target: { kind: "worker-record" },
			placement: { kind: "save-to-case" },
		});
		// The row's presence conjunct is the emitter's, so only the authored condition is read.
		const condition = registered(reading).find(
			(one) => one.slot === "case_operation_write_condition",
		);
		expect(
			condition !== undefined &&
				sameXPathText(condition.text, "/data/seen = 'yes'", {
					ruleSet: "form",
				}),
		).toBe(true);
	});

	it("reads an own update of a question's answer with no condition, and one under a bracketed condition, each without the emitter's presence conjunct", async () => {
		const own: CaseOperation = {
			...ownVisited,
			writes: [
				{ property: "visited_at", value: now() },
				{ property: "note", value: term(formField(SEEN)) },
				{
					property: "seen_by",
					value: term(formField(SEEN)),
					condition: or(
						eq(term(formField(SEEN)), literal("a")),
						eq(term(formField(SEEN)), literal("b")),
					),
				},
			],
		};
		const doc = visitApp([own]);
		const reading = await readCases(doc);
		expect(reading.findings.map((one) => one.code)).not.toContain(OUTSIDE);
		const conditions = registered(reading).filter(
			(one) => one.slot === "case_operation_write_condition",
		);
		expect(conditions.map((one) => one.member)).toEqual([
			expect.objectContaining({ property: "seen_by" }),
		]);
		const text = conditions[0]?.text ?? "";
		expect(readFormSyntax(text).ok).toBe(true);
		expect(
			sameXPathText(text, "(/data/seen = 'a' or /data/seen = 'b')", {
				ruleSet: "form",
			}),
		).toBe(true);
		// Read through every stage, the block the emitter writes back is the stored one.
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	});
});

const SHARED_FORM = testUuid("stc-shared");
const NEW_NAME = testUuid("stc-new-name");
const VILLAGE = testUuid("stc-village");
const CONFIRM = testUuid("stc-confirm");

/** A follow-up of a menu that chooses several patients, whose own arm is one
 *  shared update of every chosen patient: a new name from a question (read
 *  through its trimmed value), an answer saved as it is only when confirmed,
 *  a computed value and the acting user as owner. */
function sharedUpdateApp(): BlueprintDoc {
	const own: CaseOperation = {
		uuid: testUuid("stc-shared-own"),
		id: "patient",
		action: "own",
		name: term(formField(NEW_NAME)),
		owner: actingUser(),
		writes: [
			{
				property: "village",
				value: term(formField(VILLAGE)),
				condition: eq(term(formField(CONFIRM)), literal("yes")),
			},
			{
				property: "label",
				value: concat(term(formField(VILLAGE)), term(literal("!"))),
			},
		],
	};
	return buildDoc(
		{
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "village", label: proseText("Village"), data_type: "text" },
						{ name: "label", label: proseText("Label"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf(
						[plainColumn(testUuid("stc-shared-name"), "case_name", "Name")],
						{ selection: { kind: "multiple", maximum: 10 } },
					),
					forms: [
						{
							uuid: "stc-shared",
							name: "Update chosen",
							type: "followup",
							fields: [
								f({ kind: "text", id: "new_name", uuid: NEW_NAME }),
								f({ kind: "text", id: "village", uuid: VILLAGE }),
								f({ kind: "text", id: "confirm", uuid: CONFIRM }),
							],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[SHARED_FORM] = {
				...built.forms[SHARED_FORM],
				caseOperations: [own],
			} as never;
		},
	);
}

describe("a several-case form's shared update of every chosen case", () => {
	it("reads back as the form's own arm, each row's presence taken off and the trimmed name read as its question", async () => {
		const doc = sharedUpdateApp();
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const want = READER_CANONICAL_CHOICES.reduce(
			(current, choice) => choice.apply(current),
			doc,
		);
		expect(caseChanges(outcome.draft.doc)).toEqual(caseChanges(want));
		// The trimmed value the name reads is generated, not a question of the form.
		expect(
			(outcome.draft.doc.fieldOrder[SHARED_FORM] ?? []).map(
				(uuid) => outcome.draft.doc.fields[uuid]?.id,
			),
		).toEqual(["new_name", "village", "confirm"]);
		// Only the confirmation is a condition the expression stage reads: each
		// row's presence and the group's are the emitter's own.
		const reading = await readCases(doc);
		const conditions = registered(reading).filter(
			(one) => one.slot === "case_operation_write_condition",
		);
		expect(conditions).toHaveLength(1);
		expect(
			sameXPathText(conditions[0]?.text ?? "", "/data/confirm = 'yes'", {
				ruleSet: "form",
			}),
		).toBe(true);
		expect(
			registered(reading).filter(
				(one) => one.slot === "case_operation_condition",
			),
		).toEqual([]);
	});
});
