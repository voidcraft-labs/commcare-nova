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
 * and every Nova-born block would fail its re-emission), and an app Nova
 * published before refused, or brought in with no word of what its first
 * publish changes.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import {
	actingUser,
	formField,
	now,
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
