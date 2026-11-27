/**
 * A Save to Case block as CommCare HQ's form builder writes it, read.
 *
 * Contract: a block inside a repeat whose value reads an answer of the same
 * repeat by its absolute path, `/data/r/j`, the form builder's own spelling
 * (Vellum `tests/static/saveToCase/update_property.xml`: `calculate="/data/name"`
 * beside `vellum:calculate="#form/name"`), reads as the same operation Nova's
 * own print of the block gives, with no finding and no defect: Core resolves
 * the absolute path in the block's own entry, as it resolves Nova's
 * `current()` path. The stored value is the plain read of the answer, which
 * Nova prints from `current()`, so the reading's export is Nova's own export
 * byte for byte and reads back to the same document.
 *
 * The plausible failures: the slot held by the expression stage and the block
 * then refused as outside Nova's shape, because the block's comparison held
 * the source's text to Nova's print of it (what the reader did before), the
 * read held as a read of another entry of the repeat, or stored with a
 * spelling that prints the absolute path back.
 *
 * The builder also writes the create's name bare (`/data/r/k`), where Nova
 * writes every create's name inside its trim: CommCare HQ stores a name as
 * submitted, so that block is one Nova does not write, and it stays out as
 * outside Nova's own block shape, once, at the block, never as a defect.
 *
 * A save in the form builder of every Save to Case shape Nova writes respells
 * what no runtime reads otherwise: a `vellum:ref` or `vellum:nodeset` on each
 * group and repeat, a `vellum:jr__count` on a keyed create's repeat, and a
 * bind holding only its path on each group and repeat with none and on a
 * close-only block's `case/close` (Core binds such a node its defaults). Each
 * form reads as Nova's own export reads, with no finding and no defect. The
 * plausible failures: a shadow on a block's control claimed twice, which
 * stands as `unrecognized` at the form, and a bind that does nothing read as
 * a difference from Nova's block, which keeps every block out.
 */
import { Element, isTag } from "domhandler";
import { appendChild } from "domutils";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { saveToCaseShapesApp } from "@/proof/targeted/documents/saveToCaseShapes";
import { serializeXml } from "../../../serializeXml";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { parseXml } from "../../../xmlParse";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { readHqApp } from "./heldReading";

const id = (key: string) => testUuid(`builder-block-in-repeat-${key}`);
const MAKE = id("make");
const FORM = id("form");

/** A survey whose repeat `r` makes a clinic case in each row, named by the
 *  row's `k` and saving its `j`. */
function clinicsInARepeat(): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-1",
			appName: "Clinics",
			caseTypes: [
				{
					name: "clinic",
					properties: [{ name: "clinic_name", label: "Clinic name" }],
				},
			],
			modules: [
				{
					uuid: id("menu"),
					name: "Survey",
					forms: [
						{
							uuid: FORM,
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									uuid: id("r"),
									id: "r",
									label: "Clinics",
									repeat_mode: "user_controlled",
									children: [
										f({ kind: "text", uuid: id("k"), id: "k", label: "Kind" }),
										f({ kind: "text", uuid: id("j"), id: "j", label: "Name" }),
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
				caseOperations: [
					{
						uuid: MAKE,
						id: "make_clinic",
						action: "create",
						caseType: "clinic",
						target: { kind: "new" },
						name: term(formField(id("k"))),
						forEach: { repeat: id("r") },
						writes: [
							{ property: "clinic_name", value: term(formField(id("j"))) },
						],
					},
				],
			} as never;
		},
	);
}

/** Every element of a parsed source, in document order. */
function elementsOf(node: { children?: unknown[] }): Element[] {
	const all: Element[] = [];
	for (const child of (node.children ?? []) as Element[])
		if (isTag(child)) all.push(child, ...elementsOf(child));
	return all;
}

const UPDATE = "/case/update/clinic_name";
const NAME = "/case/create/case_name";

/** The form's source with each named bind of the block as the form builder
 *  writes it: the absolute path of the row's answer, and its `#form/` shadow. */
function writtenByTheBuilder(
	binds: Readonly<Record<string, string>>,
): (xml: string) => string {
	return (xml) => {
		const document = parseXml(xml);
		const all = elementsOf(document as { children?: unknown[] });
		for (const [nodeset, question] of Object.entries(binds)) {
			const bind = all.find(
				(one) => one.name === "bind" && one.attribs.nodeset?.endsWith(nodeset),
			);
			if (bind === undefined)
				throw new Error(`The form's source has no bind on ${nodeset}.`);
			bind.attribs.calculate = `/data/r/${question}`;
			bind.attribs["vellum:calculate"] = `#form/r/${question}`;
		}
		return serializeXml(document);
	};
}

/** The value's bind of the one form of an export. */
function valueBind(body: Record<string, unknown>): Record<string, string> {
	const [xml] = Object.values(body._attachments as Record<string, string>);
	const bind = elementsOf(
		parseXml(xml as string) as { children?: unknown[] },
	).find((one) => one.name === "bind" && one.attribs.nodeset?.endsWith(UPDATE));
	if (bind === undefined)
		throw new Error("The export has no bind on the block's value.");
	return bind.attribs;
}

async function readBody(doc: BlueprintDoc, body: Record<string, unknown>) {
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
}

it.each([
	["/data/k", "term", "/data/k"],
	["concat(/data/k, ' ')", "concat", "concat(/data/k, &apos; &apos;)"],
])(
	"keeps the bare case name %s from a standalone Survey",
	async (calculate, kind, wire) => {
		const doc = buildDoc(
			{
				appId: "app-1",
				appName: "Clinics",
				caseTypes: [{ name: "clinic", properties: [] }],
				modules: [
					{
						name: "Survey",
						forms: [
							{
								uuid: FORM,
								name: "Survey",
								type: "survey",
								fields: [
									f({ kind: "text", uuid: id("k"), id: "k", label: "Name" }),
								],
							},
						],
					},
				],
			},
			(built) => {
				built.forms[FORM] = {
					...built.forms[FORM],
					caseOperations: [
						{
							uuid: MAKE,
							id: "make_clinic",
							action: "create",
							caseType: "clinic",
							target: { kind: "new" },
							name: term(formField(id("k"))),
						},
					],
				} as never;
			},
		);
		const storedBody = exportedBody(doc, {
			xml(source) {
				const xml = parseXml(source);
				const bind = elementsOf(xml as { children?: unknown[] }).find(
					(node) =>
						node.name === "bind" && node.attribs.nodeset?.endsWith(NAME),
				);
				if (bind === undefined)
					throw new Error("The form has no case name bind.");
				bind.attribs.calculate = calculate;
				return serializeXml(xml);
			},
		});
		const result = await readBody(doc, storedBody);
		if (result.kind !== "read")
			throw new Error(JSON.stringify(result.findings));
		expect(result.draft.doc.forms[FORM]?.caseOperations?.[0]).toMatchObject({
			action: "create",
			keepNameText: true,
			name: { kind },
		});
		const printed = exportedBody(result.draft.doc);
		const [xml] = Object.values(printed._attachments as Record<string, string>);
		expect(xml).toContain(`calculate="${wire}"`);
		const again = await readBody(doc, printed);
		if (again.kind !== "read") throw new Error(JSON.stringify(again.findings));
		expect(again.draft.doc.forms[FORM]?.caseOperations).toEqual(
			result.draft.doc.forms[FORM]?.caseOperations,
		);
	},
);

describe("a Save to Case block the form builder wrote inside a repeat", () => {
	it("reads a value read by its absolute path into the same repeat as the block's own read", async () => {
		const doc = clinicsInARepeat();
		const body = exportedBody(doc, {
			xml: writtenByTheBuilder({ [UPDATE]: "j" }),
		});
		// The source holds the builder's spelling, which Nova's own print does not.
		expect(valueBind(body).calculate).toBe("/data/r/j");
		expect(valueBind(exportedBody(doc)).calculate).not.toBe("/data/r/j");

		const outcome = await readBody(doc, body);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The source did not read.");
		const read = outcome.draft.doc;
		// Core resolves both spellings to the block's own entry, so the reading
		// reports no rewrite a worker sees (`default-reads-current` is none).
		expect(
			outcome.draft.facts.rewrites
				.map((one) => one.id)
				.filter((one) => one !== "default-reads-current"),
		).toEqual([]);
		const want = READER_CANONICAL_CHOICES.reduce(
			(current, choice) => choice.apply(current),
			doc,
		);

		// The held operation: the create of each row, its value the plain read
		// of the row's own answer, with no spelling that would print it back
		// as the absolute path.
		const [operation] = read.forms[FORM]?.caseOperations ?? [];
		expect(read.forms[FORM]?.caseOperations).toEqual(
			want.forms[FORM]?.caseOperations,
		);
		expect(operation?.action).toBe("create");
		expect(
			operation?.action === "create" ? operation.forEach?.repeat : undefined,
		).toBe(id("r"));
		expect(
			operation?.action === "create" ? operation.writes : undefined,
		).toEqual([{ property: "clinic_name", value: term(formField(id("j"))) }]);
		expect(JSON.stringify(operation)).not.toContain('"spelling"');

		// Read back: the reading prints Nova's own export, which reads to itself.
		const printed = exportedBody(read);
		expect(printed).toEqual(exportedBody(want));
		expect(valueBind(printed).calculate).not.toBe("/data/r/j");
		const again = await readBody(read, printed);
		expect(again.defects).toEqual([]);
		if (again.kind !== "read") throw new Error("The export did not read.");
		expect(again.draft.doc.forms[FORM]?.caseOperations).toEqual(
			read.forms[FORM]?.caseOperations,
		);
		expect((again.draft.doc.forms as Record<Uuid, unknown>)[FORM]).toEqual(
			(read.forms as Record<Uuid, unknown>)[FORM],
		);
	});

	it("keeps out a create whose name the builder writes bare, which CommCare HQ stores untrimmed", async () => {
		// The builder writes the name `/data/r/k` with no trim. Nova writes every
		// create's name inside its trim, as Core reads it (`CaseXmlParser.createCase`
		// trims `case_name`), and CommCare HQ stores the name as submitted
		// (`update_strategy.py::_apply_update_action`, no strip), so the bare name
		// is one Nova does not write: the block is outside Nova's own shape, a
		// finding at the block's place and never a defect, whatever the row reads.
		const doc = clinicsInARepeat();
		const body = exportedBody(doc, {
			xml: writtenByTheBuilder({ [NAME]: "k", [UPDATE]: "j" }),
		});
		const outcome = await readBody(doc, body);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "account")
			throw new Error("A bare name was held as a trimmed one.");
		const outside = outcome.findings.filter(
			(one) =>
				one.code ===
				"questions/savetocase-block-outside-nova-s-own-block-shape",
		);
		expect(outside).toHaveLength(1);
		expect(outside[0]?.place).toMatchObject({
			kind: "question",
			path: "r/nova_operations/make_clinic",
		});
		expect(outcome.findings).toEqual(outside);
	});
});

/** `#form/…`, the form builder's shadow of an absolute path under `/data/`. */
function formShadow(path: string): string {
	const root = "/data/";
	if (!path.startsWith(root))
		throw new Error(`The fixture expected a path under ${root}, not ${path}.`);
	return `#form/${path.slice(root.length)}`;
}

/** The data path of an element of the form's instance, from `/data` down. */
function dataPathOf(element: Element): string {
	const steps: string[] = [];
	for (
		let at: Element | null = element;
		at !== null && at.name !== "data";
		at = at.parent as Element | null
	)
		steps.unshift(at.name);
	return `/data/${steps.join("/")}`;
}

/** A form's source as a save in HQ's form builder respells it, none of which a runtime reads:
 *  each group's and repeat's shadow, a keyed create's count shadow, and a bind of its path alone
 *  on each group and repeat with none and on each close-only block's `case/close`
 *  (`saveToCase.js`, the close's `relevant` left blank). */
function savedByTheBuilder(xml: string): string {
	const document = parseXml(xml);
	const all = elementsOf(document as { children?: unknown[] });
	const model = all.find((one) => one.name === "model");
	if (model === undefined) throw new Error("The form's source has no model.");
	const bound = new Set(
		all.filter((one) => one.name === "bind").map((one) => one.attribs.nodeset),
	);
	const bindPath = (path: string, shadow: boolean) => {
		if (bound.has(path)) return;
		bound.add(path);
		appendChild(
			model,
			new Element(
				"bind",
				shadow
					? { "vellum:nodeset": formShadow(path), nodeset: path }
					: { nodeset: path },
			),
		);
	};
	for (const control of all) {
		if (control.name !== "group" && control.name !== "repeat") continue;
		const path = control.attribs.ref ?? control.attribs.nodeset;
		if (path === undefined) continue;
		control.attribs[
			control.name === "group" ? "vellum:ref" : "vellum:nodeset"
		] = formShadow(path);
		const count = control.attribs["jr:count"];
		// A model iteration's count is the repeat's own `@count`, which the builder names by no hashtag.
		if (count !== undefined && path !== "/data/nova_selected_cases/item")
			control.attribs["vellum:jr__count"] = formShadow(count);
		bindPath(path, true);
	}
	for (const close of all)
		if (
			close.name === "close" &&
			(close.parent as Element | null)?.name === "case"
		)
			bindPath(dataPathOf(close), false);
	return serializeXml(document);
}

describe("every Save to Case shape Nova writes, saved in the form builder", () => {
	it("reads as Nova's own export reads", async () => {
		const doc = saveToCaseShapesApp();
		const read = async (body: Record<string, unknown>) =>
			readHqApp(
				await inputFor(body, {
					resolver: matchingResolver(
						doc.appId,
						externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
					),
					knownCaseTypes: knownCaseTypesOf(doc),
				}),
			);
		const saved = exportedBody(doc, { xml: savedByTheBuilder });
		const sources = Object.values(saved._attachments as Record<string, string>);
		expect(sources.some((xml) => xml.includes("vellum:jr__count"))).toBe(true);
		expect(sources.some((xml) => xml.includes('/case/close"/>'))).toBe(true);

		const outcome = await read(saved);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		expect(outcome.defects).toEqual([]);
		const plain = await read(exportedBody(doc));
		if (outcome.kind !== "read" || plain.kind !== "read")
			throw new Error("A source did not read.");
		expect(outcome.draft.doc).toEqual(plain.draft.doc);
	});
});
