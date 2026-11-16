/**
 * A form's load-time order (11.3): the steps are the source's setvalues in
 * document order, each default with the expression it was registered as, and a
 * pair of one event whose relative order differs between the source and Nova's
 * emission is a conflict exactly where one step reads the node the other sets.
 * An independent reordering is no conflict, and two events are never compared.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import { emittedLoadOrder } from "../afterBinding";
import {
	effectiveLoadOrder,
	type LoadStep,
	loadOrderConflicts,
} from "../loadOrder";
import { readForm, xformSource } from "./formReading";

const step = (
	target: string,
	event: LoadStep["event"] = "xforms-ready",
): LoadStep => ({
	event,
	target,
});

/** Reads each step's targets by hand. */
function reading(reads: Readonly<Record<string, readonly string[]>>) {
	return (one: LoadStep) => new Set(reads[one.target] ?? []);
}

describe("loadOrderConflicts", () => {
	it("finds a reordered pair where one reads the node the other sets", () => {
		const b = step("b");
		const a = step("a");
		const c = step("c");
		const conflicts = loadOrderConflicts(
			[b, a, c],
			[a, b, c],
			reading({ b: ["a"] }),
		);
		expect(conflicts).toEqual([{ reader: b, read: a }]);
	});

	it("passes a reordered pair that reads neither node", () => {
		const b = step("b");
		const a = step("a");
		expect(loadOrderConflicts([b, a], [a, b], reading({ b: ["c"] }))).toEqual(
			[],
		);
	});

	it("passes a dependent pair whose order the emission keeps", () => {
		const a = step("a");
		const b = step("b");
		expect(loadOrderConflicts([a, b], [a, b], reading({ b: ["a"] }))).toEqual(
			[],
		);
	});

	it("never compares two events", () => {
		const b = step("r/b", "jr-insert");
		const a = step("a");
		expect(
			loadOrderConflicts([b, a], [a, b], reading({ "r/b": ["a"] })),
		).toEqual([]);
	});
});

describe("effectiveLoadOrder", () => {
	it("gives the source's setvalues in document order, each default with its registration", async () => {
		const read = await readForm(
			xformSource({
				data: "<a/><b/>",
				model: `<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>
					<setvalue event="xforms-ready" ref="/data/b" value="/data/a"/>
					<setvalue event="xforms-ready" ref="/data/a" value="'x'"/>`,
				body: `<input ref="/data/a"><label>A</label></input><input ref="/data/b"><label>B</label></input>`,
			}),
			{ mint: true },
		);
		const order = effectiveLoadOrder(read.xform ?? ({} as never));
		expect(
			order.map((one) => [one.event, one.target, one.pending?.text]),
		).toEqual([
			["xforms-ready", "b", "/data/a"],
			["xforms-ready", "a", "'x'"],
		]);
		expect(order.map((one) => one.pending?.ref)).toEqual([
			expect.objectContaining({ slot: "default_value" }),
			expect.objectContaining({ slot: "default_value" }),
		]);
		const position: Readonly<Record<string, number>> = { a: 0, b: 1 };
		const emitted = emittedLoadOrder(order, (one) => position[one.target] ?? 2);
		expect(emitted.map((one) => one.target)).toEqual(["a", "b"]);
		expect(
			loadOrderConflicts(order, emitted, reading({ b: ["a"] })).map(
				({ reader, read: set }) => [reader.target, set.target],
			),
		).toEqual([["b", "a"]]);
	});
});

/** A survey whose count-placement query repeat `visits`, inside the repeat `outer`, holds a
 *  question `note` whose default is the row's id. */
function rowIdDefaultDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Rounds",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								id: "outer",
								children: [
									f({
										kind: "repeat",
										id: "visits",
										repeat_mode: "query_bound",
										data_source: { ids_query: "'a b'" },
										children: [
											f({
												kind: "text",
												id: "note",
												default_value: "current()/../@id",
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
}

/** The `<setvalue>` element of a source whose `ref` ends in `/<name>`. */
function setvalueNaming(xml: string, name: string): string {
	for (let start = xml.indexOf("<setvalue"); start !== -1; ) {
		const end = xml.indexOf("/>", start) + 2;
		const element = xml.slice(start, end);
		if (element.includes(`/${name}"`)) return element;
		start = xml.indexOf("<setvalue", end);
	}
	throw new Error(`The source holds no setvalue that sets ${name}.`);
}

/** The codes of every finding of a whole reading of `body`. */
async function readingCodes(
	body: Readonly<Record<string, unknown>>,
): Promise<string[]> {
	const outcome = readHqApp(await inputFor(body));
	return outcome.kind === "account"
		? outcome.findings.map((finding) => finding.code)
		: [];
}

describe("a count-placement row's own load-time values", () => {
	const LOAD_ORDER =
		"questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes";

	it("places the row's id before an authored row default that reads it, as Nova writes them", async () => {
		const doc = rowIdDefaultDoc();
		const body = exportedBody(doc);
		const xml = Object.values(
			body._attachments as Record<string, string>,
		)[0] as string;
		// Nova writes the row's id first in the row, then the default that reads it.
		expect(
			xml.indexOf(setvalueNaming(xml, "nova_query_id_visits")),
		).toBeLessThan(xml.indexOf(setvalueNaming(xml, "note")));
		expect(await readingCodes(body)).not.toContain(LOAD_ORDER);
	});

	it("refuses a row default standing before the row's own id, where it reads that id", async () => {
		const doc = rowIdDefaultDoc();
		const body = exportedBody(doc, {
			xml: (xml) => {
				const id = setvalueNaming(xml, "nova_query_id_visits");
				const note = setvalueNaming(xml, "note");
				return xml.replace(note, "").replace(id, `${note}${id}`);
			},
		});
		expect(await readingCodes(body)).toContain(LOAD_ORDER);
	});
});
