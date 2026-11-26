/**
 * `case_references_data.save` of a form with Save to Case blocks.
 *
 * Contract: the stored map is read as derived where it equals the form
 * builder's computation over the stored source
 * (`xform/caseSaveReferences.ts::caseSaveReferencesOf`), which is what
 * Nova's emitter writes; a map that differs from it is
 * `forms-and-case-writes/case-references-data-save-differing-from-that-computation`;
 * and a form whose block is outside Nova's block shape has that finding
 * alone, which covers its map. The plausible failures: a map judged against
 * another computation than the source's, so every Nova-born form is refused,
 * or a map that differs read as derived, so HQ's case property inventory
 * changes at the first publish with no word of it.
 */
import { type Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { serializeXml } from "../../../serializeXml";
import { parseXml } from "../../../xmlParse";
import { type AppJson, readCases } from "./caseReading";

const F = "forms-and-case-writes";
const EQUAL = `${F}/case-references-data-save-equal-to-vellum-s-computation-from-the`;
const DIFFERING = `${F}/case-references-data-save-differing-from-that-computation`;
const OUTSIDE = "questions/savetocase-block-outside-nova-s-own-block-shape";
const FORM = testUuid("references-form");
const NOTE = testUuid("references-note");

const create: CaseOperation = {
	uuid: testUuid("references-photo"),
	id: "photo",
	action: "create",
	caseType: "photo",
	target: { kind: "new" },
	name: term(formField(NOTE)),
	writes: [{ property: "caption", value: term(formField(NOTE)) }],
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
							uuid: "references-form",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note", uuid: NOTE })],
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

/** The stored map of the one form. */
function saveOf(json: AppJson): Record<string, { properties: string[] }> {
	const form = json.modules[0]?.forms[0] as Record<string, unknown>;
	const references = form.case_references_data as {
		save: Record<string, { properties: string[] }>;
	};
	return references.save;
}

/** A write named close is read by the Form Designer as an action. */
function withCloseProperty(xml: string): string {
	const document = parseXml(xml);
	const all: Element[] = [];
	const walk = (node: { children?: unknown[] }) => {
		for (const child of (node.children ?? []) as Element[])
			if (isTag(child)) {
				all.push(child);
				walk(child);
			}
	};
	walk(document as { children?: unknown[] });
	const path = "/data/nova_operations/photo/case/update/caption";
	const property = all.find((node) => node.name === "caption");
	const bind = all.find(
		(node) => node.name === "bind" && node.attribs.nodeset === path,
	);
	if (!property || !bind) throw new Error("Expected a case write to caption.");
	property.name = "close";
	bind.attribs.nodeset = "/data/nova_operations/photo/case/update/close";
	return serializeXml(document);
}

function records(reading: Awaited<ReturnType<typeof readCases>>): string[] {
	return [...reading.ctx.close().claims.records()].map((one) => one.entry);
}

describe("case_references_data.save beside Save to Case blocks", () => {
	it("reads the map Nova's emitter wrote as derived", async () => {
		const reading = await readCases(app());
		expect(reading.findings.map((one) => one.code)).not.toContain(DIFFERING);
		expect(records(reading)).toContain(EQUAL);
	});

	it("refuses a map with one stored property removed", async () => {
		const reading = await readCases(app(), {
			edit: (json) => {
				const entry = Object.values(saveOf(json))[0];
				if (entry === undefined || !entry.properties.includes("caption"))
					throw new Error("The stored map lists the block's property.");
				entry.properties = entry.properties.filter((one) => one !== "caption");
			},
		});
		expect(
			reading.findings.filter((one) => one.code === DIFFERING),
		).toHaveLength(1);
	});

	it("raises only the block's finding for a form whose block is outside Nova's shape", async () => {
		const reading = await readCases(app(), { editSource: withCloseProperty });
		const codes = reading.findings.map((one) => one.code);
		expect(codes.filter((one) => one === OUTSIDE)).toHaveLength(1);
		expect(codes).not.toContain(DIFFERING);
	});
});
