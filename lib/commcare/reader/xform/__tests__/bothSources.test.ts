/**
 * A Hidden Value holding both a calculate and a default.
 *
 * Contract: Core runs a new form's `xforms-ready` setvalues in model order and
 * then evaluates every calculate (`FormDef.initialize` → `initAllTriggerables`),
 * so outside every repeat the calculate replaces the default before any screen
 * unless a later `xforms-ready` setvalue reads the node, directly or through
 * the calculates of what it reads. Where none does, the reading holds the
 * calculate alone, claims the question under the held entry and records the
 * form under `hidden-value-defaults-dropped`; where one does, or the Hidden
 * Value stands in a repeat, the question is refused once, under the entry Nova
 * does not yet hold.
 *
 * Plausible failures: a default a later setvalue reads dropped as unread (a
 * worker's saved value changes); a read through a calculation missed; an
 * earlier setvalue taken for a later one; the question refused twice, or held
 * with no record for the first publish.
 */

import { Element } from "domhandler";
import { append, findOne, prepend } from "domutils";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { parseXml } from "@/lib/commcare/xmlParse";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

const HELD =
	"questions/hidden-value-with-both-calculate-and-a-default-no-runtime-reads";
const REFUSED =
	"questions/hidden-value-with-both-calculate-and-a-default-by-any-expression";

const H = testUuid("both-h") as Uuid;

/** A survey holding `fields`, among them the Hidden Value `h` calculated as `2`. */
function survey(fields: ReturnType<typeof f>[]): BlueprintDoc {
	return buildDoc({
		modules: [
			{ name: "Visits", forms: [{ name: "Visit", type: "survey", fields }] },
		],
	});
}

const hidden = () => f({ kind: "hidden", id: "h", uuid: H, calculate: "2" });

/** The export with the setvalue `<setvalue event="xforms-ready" ref="/data/h" value="1"/>`
 *  put `where` the setvalue that sets `beside`. */
function withDefault(
	doc: BlueprintDoc,
	where: "before" | "after",
	beside: string,
): Record<string, unknown> {
	return exportedBody(doc, {
		xml: (xml) => {
			const root = parseXml(xml);
			const anchor = findOne(
				(element) =>
					element.name === "setvalue" &&
					element.attribs.ref === `/data/${beside}`,
				root.children.filter((child) => child instanceof Element),
				true,
			);
			if (anchor === null)
				throw new Error(`The export holds no setvalue that sets ${beside}.`);
			const added = new Element("setvalue", {
				event: "xforms-ready",
				ref: "/data/h",
				value: "1",
			});
			(where === "before" ? prepend : append)(anchor, added);
			return serializeXml(root);
		},
	});
}

async function read(body: Record<string, unknown>) {
	return readHqApp(await inputFor(body));
}

describe("a Hidden Value holding both a calculate and a default", () => {
	it("is its calculate alone where no later load-time value reads the default", async () => {
		const doc = survey([
			hidden(),
			f({ kind: "text", id: "n", label: "Note", default_value: "'x'" }),
		]);
		const outcome = await read(withDefault(doc, "before", "n"));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") return;
		const field = Object.values(outcome.draft.doc.fields).find(
			(one) => one.id === "h",
		);
		expect(field).toMatchObject({ kind: "hidden" });
		expect(
			field && "calculate" in field ? field.calculate : undefined,
		).toBeDefined();
		expect(field && "default_value" in field).toBe(false);
		expect(
			outcome.draft.facts.sameStateRewrites.filter(
				(record) => record.register === "hidden-value-defaults-dropped",
			),
		).toEqual([
			expect.objectContaining({
				entry: HELD,
				path: expect.stringMatching(/^\/_attachments\//),
			}),
		]);
	});

	it("is its calculate alone where only an earlier load-time value reads it", async () => {
		const doc = survey([
			f({ kind: "text", id: "n", label: "Note", default_value: "#form/h" }),
			hidden(),
		]);
		const outcome = await read(withDefault(doc, "after", "n"));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	});

	it("is refused once where a later load-time value reads the default", async () => {
		const doc = survey([
			hidden(),
			f({ kind: "text", id: "n", label: "Note", default_value: "#form/h" }),
		]);
		const outcome = await read(withDefault(doc, "before", "n"));
		expect(
			outcome.kind === "account"
				? outcome.findings.map((one) => [one.code, one.place])
				: [],
		).toEqual([
			[REFUSED, expect.objectContaining({ kind: "question", path: "h" })],
		]);
	});

	it("is refused once where a later load-time value reads it through a calculation", async () => {
		const doc = survey([
			hidden(),
			f({ kind: "hidden", id: "c", calculate: "#form/h * 2" }),
			f({ kind: "text", id: "n", label: "Note", default_value: "#form/c" }),
		]);
		const outcome = await read(withDefault(doc, "before", "n"));
		expect(
			outcome.kind === "account"
				? outcome.findings.map((one) => [one.code, one.place])
				: [],
		).toEqual([
			[REFUSED, expect.objectContaining({ kind: "question", path: "h" })],
		]);
	});

	it("is refused once in a repeat, where a row's default can outlast its calculate", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "r",
									children: [
										f({ kind: "hidden", id: "h", calculate: "2" }),
										f({
											kind: "text",
											id: "n",
											label: "Note",
											default_value: "'x'",
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const body = exportedBody(doc, {
			xml: (xml) => {
				const root = parseXml(xml);
				const anchor = findOne(
					(element) =>
						element.name === "setvalue" && element.attribs.ref === "/data/r/n",
					root.children.filter((child) => child instanceof Element),
					true,
				);
				if (anchor === null)
					throw new Error("The export holds no setvalue that sets r/n.");
				prepend(
					anchor,
					new Element("setvalue", {
						event: anchor.attribs.event ?? "jr-insert",
						ref: "/data/r/h",
						value: "1",
					}),
				);
				return serializeXml(root);
			},
		});
		const outcome = await read(body);
		expect(
			outcome.kind === "account"
				? outcome.findings.map((one) => [one.code, one.place])
				: [],
		).toEqual([
			[REFUSED, expect.objectContaining({ kind: "question", path: "r/h" })],
		]);
	});
});
