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
 * that every Nova-born keyed create reads as outside Nova's shape, and an
 * app Nova published before refused, or brought in with no word of what its
 * first publish changes.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import {
	actingUser,
	eq,
	formField,
	literal,
	now,
	or,
	term,
	unowned,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { saveToCaseShapesApp } from "../../../../../proof/targeted/documents/saveToCaseShapes";
import { planPlacements } from "../../../placement";
import { serializeXml } from "../../../serializeXml";
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
import { readHqApp } from "../../index";
import { sameXPathText } from "../../syntaxCompare";
import { saveToCaseReading } from "../saveToCase";
import { type CaseReading, readCases } from "./caseReading";

const OUTSIDE = "questions/savetocase-block-outside-nova-s-own-block-shape";

/** Every text registered for the expression stage, by slot and member. */
function registered(
	reading: CaseReading,
): { slot: string; member: unknown; text: string }[] {
	return reading.ctx.pending.list().flatMap((one) =>
		one.ref.entity === "form" && one.ref.slot.startsWith("case_operation_")
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

describe("a value read through its wrapper", () => {
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
		const outcome = readHqApp(await inputFor(exportedBody(visitApp([keyed]))));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const doc = outcome.draft.doc;
		const seen = Object.values(doc.fields).find((field) => field.id === "seen");
		const create = Object.values(doc.forms)
			.flatMap((form) => form.caseOperations ?? [])
			.find((operation) => operation.action === "create");
		expect(create?.target).toEqual({ kind: "new", idFrom: seen?.uuid });
		expect(create?.placement).toMatchObject({ kind: "save-to-case" });
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
