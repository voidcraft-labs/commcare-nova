/**
 * The boundary of a Save to Case block Nova reads as its own.
 *
 * Contract: a block is Nova's only in the shape Nova's emitter writes. A
 * block moved to the form root or into an authored group fails the position
 * test and is the one finding `questions/savetocase-block-outside-nova-s-own-block-shape`
 * at the block's place, read into no operation; a block the emitter would
 * write otherwise (an extra bind on a leaf, a guard missing beside it) fails
 * the re-emission test (`blockTreesEqual`), which holds the emitter's own
 * block equal to the stored one. The plausible failure: a block a person
 * placed in HQ's form builder read as Nova's, and moved on the first
 * publish, which would change an export path.
 */
import { Element } from "domhandler";
import { appendChild, removeElement } from "domutils";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { expandDoc } from "../../../expander";
import { serializeXml } from "../../../serializeXml";
import { parseXml } from "../../../xmlParse";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import { saveToCaseReading } from "../saveToCase";
import {
	blockTreesEqual,
	emittedFormSource,
	storedFormSource,
} from "../saveToCaseCompare";
import { readCases } from "./caseReading";

const OUTSIDE = "questions/savetocase-block-outside-nova-s-own-block-shape";
const FORM = testUuid("boundary-form");
const NOTE = testUuid("boundary-note");

const create: CaseOperation = {
	uuid: testUuid("boundary-photo"),
	id: "photo",
	action: "create",
	caseType: "photo",
	target: { kind: "new" },
	name: term(formField(NOTE)),
};

function app(): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "photo", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "boundary-form",
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", uuid: NOTE }),
								f({
									kind: "group",
									id: "details",
									children: [f({ kind: "text", id: "detail" })],
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
				caseOperations: [create],
			} as never;
		},
	);
}

type Node = {
	type?: string;
	name?: string;
	attribs?: Record<string, string>;
	children?: Node[];
	parent?: Node | null;
};

function elements(node: Node): Node[] {
	return [node, ...(node.children ?? []).flatMap(elements)].filter(
		(one) => one.type === "tag",
	);
}

/** The source with the block `photo` moved under the element at `to`, every
 *  bind and setvalue that names it moved with it. */
function moved(to: readonly string[]) {
	return (xml: string) => {
		const document = parseXml(xml) as unknown as Node;
		const all = elements(document);
		const data = all.find((one) => one.name === "data") as Node;
		let target = data;
		for (const name of to)
			target = (target.children ?? []).find((one) => one.name === name) as Node;
		const block = all.find(
			(one) =>
				one.name === "photo" && one.attribs?.["vellum:role"] === "SaveToCase",
		) as Node;
		const from = "/data/nova_operations/photo";
		const into = `/data/${[...to, "photo"].join("/")}`;
		removeElement(block as unknown as Element);
		appendChild(target as unknown as Element, block as unknown as Element);
		for (const one of all) {
			for (const key of ["nodeset", "ref"]) {
				const path = one.attribs?.[key];
				if (
					(one.name === "bind" || one.name === "setvalue") &&
					path !== undefined &&
					path.startsWith(from)
				)
					(one.attribs as Record<string, string>)[key] =
						into + path.slice(from.length);
			}
		}
		return serializeXml(document as never);
	};
}

describe("a Save to Case block outside the shape Nova writes", () => {
	for (const [where, to] of [
		["moved to the form root", []],
		["moved into an authored group", ["details"]],
	] as const)
		it(`is the one finding at its place, ${where}, and no operation`, async () => {
			const reading = await readCases(app(), { editSource: moved(to) });
			const outside = reading.findings.filter((one) => one.code === OUTSIDE);
			expect(outside).toHaveLength(1);
			expect(outside[0]?.place).toMatchObject({
				kind: "question",
				path: [...to, "photo"].join("/"),
			});
			const operations = reading.forms.flatMap(
				(form) => form.form.caseOperations ?? [],
			);
			expect(operations.filter((one) => one.action === "create")).toEqual([]);
		});
});

/** The emitted source of the one form, and a reading of it edited by `edit`. */
async function judged(edit: (xml: string) => string) {
	const doc = app();
	const emitted = expandDoc(doc);
	const xml = Object.values(
		emitted._attachments as Record<string, string>,
	).find((one) => one.includes("SaveToCase")) as string;
	const reading = await readCases(doc, { editSource: edit });
	const form = reading.forms[0];
	const proposal =
		form === undefined ? undefined : saveToCaseReading(form)?.proposals[0];
	if (form?.xform == null || proposal === undefined)
		throw new Error("The block is read.");
	const source = emittedFormSource(xml);
	if (source === undefined) throw new Error("The emitted form parses.");
	return blockTreesEqual(
		{ block: proposal.block, form: storedFormSource(form.xform.parsed) },
		source,
	);
}

describe("the re-emission test", () => {
	it("holds Nova's own block equal to the block the emitter writes", async () => {
		expect(await judged((xml) => xml)).toBe(true);
	});

	it("tells a block with an extra bind on a leaf apart", async () => {
		const extra = (xml: string) => {
			const document = parseXml(xml) as unknown as Node;
			const model = elements(document).find(
				(one) => one.name === "model",
			) as Node;
			appendChild(
				model as unknown as Element,
				new Element("bind", {
					nodeset: "/data/nova_operations/photo/case/create/case_name",
					required: "true()",
				}),
			);
			return serializeXml(document as never);
		};
		expect(await judged(extra)).toBe(false);
	});

	it("tells a block whose guard is missing apart", async () => {
		const missing = (xml: string) => {
			const document = parseXml(xml) as unknown as Node;
			for (const one of elements(document))
				if (
					one.name?.startsWith("nova_guard_photo") === true ||
					(one.name === "bind" &&
						(one.attribs?.nodeset ?? "").includes("/nova_guard_photo"))
				)
					removeElement(one as unknown as Element);
			return serializeXml(document as never);
		};
		expect(await judged(missing)).toBe(false);
	});
});

/** The guard's `@case_id` bind of `photo`'s text guard, its calculate replaced. */
function guardEdited(xml: string): string {
	const document = parseXml(xml) as unknown as Node;
	for (const one of elements(document))
		if (
			one.name === "bind" &&
			(one.attribs?.nodeset ?? "").includes("/nova_guard_photo") &&
			(one.attribs?.nodeset ?? "").endsWith("/case/update/case_type")
		)
			(one.attribs as Record<string, string>).calculate = "'patient'";
	return serializeXml(document as never);
}

describe("a block the emitter would write otherwise, read through every stage", () => {
	const extraBind = (xml: string) => {
		const document = parseXml(xml) as unknown as Node;
		const model = elements(document).find(
			(one) => one.name === "model",
		) as Node;
		appendChild(
			model as unknown as Element,
			new Element("bind", {
				nodeset: "/data/nova_operations/photo/case/create/case_name",
				required: "true()",
			}),
		);
		return serializeXml(document as never);
	};
	const missingGuard = (xml: string) => {
		const document = parseXml(xml) as unknown as Node;
		for (const one of elements(document))
			if (
				one.name?.startsWith("nova_guard_photo") === true ||
				(one.name === "bind" &&
					(one.attribs?.nodeset ?? "").includes("/nova_guard_photo"))
			)
				removeElement(one as unknown as Element);
		return serializeXml(document as never);
	};
	for (const [what, edit] of [
		["an extra bind on a leaf", extraBind],
		["its guard missing", missingGuard],
		["its guard's row edited", guardEdited],
	] as const)
		it(`is the one finding at the block's place, with ${what}, and the stored save map is covered by it`, async () => {
			const outcome = readHqApp(
				await inputFor(exportedBody(app(), { xml: edit })),
			);
			expect(outcome.kind).toBe("account");
			const findings = outcome.kind === "account" ? outcome.findings : [];
			const outside = findings.filter((one) => one.code === OUTSIDE);
			expect(outside).toHaveLength(1);
			expect(outside[0]?.place).toMatchObject({
				kind: "question",
				path: "nova_operations/photo",
			});
			expect(findings.map((one) => one.code)).not.toContain(
				"forms-and-case-writes/case-references-data-save-differing-from-that-computation",
			);
		});

	it("reads Nova's own block, its guard included, with no finding", async () => {
		const outcome = readHqApp(await inputFor(exportedBody(app())));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	});
});

/** The source with the root create's id setvalue given `value`. */
function createIdSetTo(value: string) {
	return (xml: string) => {
		const document = parseXml(xml) as unknown as Node;
		for (const one of elements(document))
			if (
				one.name === "setvalue" &&
				(one.attribs?.ref ?? "").endsWith("/photo/case/@case_id")
			)
				(one.attribs as Record<string, string>).value = value;
		return serializeXml(document as never);
	};
}

describe("a root create's authored id", () => {
	for (const [what, value, entry] of [
		[
			"blank on every opening",
			"''",
			"questions/savetocase-create-at-the-form-root-whose-authored-case-id-xpath",
		],
		[
			"the bare answer of a question with no starting value",
			"/data/note",
			"questions/savetocase-create-at-the-form-root-whose-authored-case-id-xpath",
		],
		[
			"any other expression",
			"concat('visit-', uuid())",
			"questions/savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside",
		],
	] as const)
		it(`is its entry once where it is ${what}, and no operation`, async () => {
			const reading = await readCases(app(), {
				editSource: createIdSetTo(value),
			});
			expect(reading.findings.filter((one) => one.code === entry)).toHaveLength(
				1,
			);
			expect(
				reading.forms
					.flatMap((form) => form.form.caseOperations ?? [])
					.filter((one) => one.action === "create"),
			).toEqual([]);
		});
});
