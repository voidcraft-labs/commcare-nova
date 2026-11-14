/**
 * A form's load-time order (11.3): the steps are the source's setvalues in
 * document order, each default with the expression it was registered as, and a
 * pair of one event whose relative order differs between the source and Nova's
 * emission is a conflict exactly where one step reads the node the other sets.
 * An independent reordering is no conflict, and two events are never compared.
 */

import { describe, expect, it } from "vitest";
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
