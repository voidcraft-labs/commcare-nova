/** A hidden question holds the starting answer seen by later load-time
 * assignments and the calculation that determines its eventual answer. */
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

async function expectBoth(body: Record<string, unknown>) {
	const outcome = await readHqApp(await inputFor(body));
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") throw new Error("Expected a complete reading");
	const field = Object.values(outcome.draft.doc.fields).find(
		(one) => one.id === "h",
	);
	expect(field).toMatchObject({
		kind: "hidden",
		calculate: { kind: "term", term: { kind: "literal", value: 2 } },
		default_value: { kind: "term", term: { kind: "literal", value: 1 } },
	});
	expect(
		outcome.draft.facts.sameStateRewrites.map((record) => record.register),
	).not.toContain("hidden-value-defaults-dropped");
}

describe("a Hidden Value holding both a calculate and a default", () => {
	it("keeps its starting answer where no later load-time value reads the default", async () => {
		const doc = survey([
			hidden(),
			f({ kind: "text", id: "n", label: "Note", default_value: "'x'" }),
		]);
		await expectBoth(withDefault(doc, "before", "n"));
	});

	it("keeps its starting answer where only an earlier load-time value reads it", async () => {
		const doc = survey([
			f({ kind: "text", id: "n", label: "Note", default_value: "#form/h" }),
			hidden(),
		]);
		await expectBoth(withDefault(doc, "after", "n"));
	});

	it("keeps both slots where a later load-time value reads the default", async () => {
		const doc = survey([
			hidden(),
			f({ kind: "text", id: "n", label: "Note", default_value: "#form/h" }),
		]);
		await expectBoth(withDefault(doc, "before", "n"));
	});

	it("keeps both slots where a later load-time value reads it through a calculation", async () => {
		const doc = survey([
			hidden(),
			f({ kind: "hidden", id: "c", calculate: "#form/h * 2" }),
			f({ kind: "text", id: "n", label: "Note", default_value: "#form/c" }),
		]);
		await expectBoth(withDefault(doc, "before", "n"));
	});

	it("keeps both slots in a repeat, where a row's default can outlast its calculate", async () => {
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
		await expectBoth(body);
	});
});
