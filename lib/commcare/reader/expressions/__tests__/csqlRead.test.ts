/**
 * A search filter row read back through its CSQL. The contract: a row is held
 * only where the production CSQL emitter writes it back, its whole wrapper
 * (exact) or the same CSQL and device values with Nova's guards around them
 * (guards), and every row it cannot hold claims the entry its shape names.
 * The failures this catches: HQ's documented quoted-answer row, in either
 * quote mark, not held at the guards level; HQ's server-side `today()` left
 * unrecognized; Nova's own lists, fixed and calculated, and its presence
 * cascade not read back as the tree that wrote them; a system date compared
 * with a date held, or left unrecognized, where Nova can't evaluate it; a
 * text property ordered claimed as anything but the record rule set's
 * wider vocabulary; a property name built at run time held; an
 * unparenthesized later argument held.
 */
import { describe, expect, it } from "vitest";
import {
	eq,
	input,
	literal,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { emitCsql } from "../../../csql/emitter";
import { searchWireShape } from "../../../suite/case-search/searchWireShape";
import { searchInputInstanceId } from "../../../suite/case-search/types";
import { serializeWire } from "../../../xpath/wire/serialize";
import { readSearchFilterRow } from "../csqlRead";
import {
	CSQL_READER_VECTORS,
	csqlRow,
	csqlVectorDoc,
	REGION,
	rowContext,
	rowEnv,
} from "./csqlVectors";

const doc = csqlVectorDoc();
const env = rowEnv(doc);
const filter = rowContext(doc);
const condition = rowContext(doc, "search_input_predicate");
const ANSWER = "instance('search-input:results')/input/field[@name = 'region']";
const village = prop("patient", "village");

/** Nova's own row for a predicate in a context, as the HQ JSON holds it. */
function novaRow(predicate: Expression, context: typeof filter): string {
	const mod = doc.modules[context.slot.uuid];
	const shape = mod?.caseSearchConfig
		? searchWireShape(mod.caseSearchConfig)
		: undefined;
	const wire = emitCsql(predicate, {
		types: context,
		bindings: {
			...(shape === undefined
				? {}
				: { searchInputInstanceId: searchInputInstanceId(shape) }),
		},
	}).wrapper;
	return serializeWire(wire, { target: "hq-json", interpolation: "none" }).text;
}

describe("a search filter row's CSQL", () => {
	it.each(CSQL_READER_VECTORS)("reads $id as its vector says", (vector) => {
		const reading = readSearchFilterRow(csqlRow(vector.csql), filter, env);
		if ("held" in vector.reads) {
			expect(reading).toMatchObject({
				ok: true,
				level: vector.reads.held,
				rewrites: vector.reads.rewrites,
			});
			return;
		}
		expect(reading).toMatchObject({
			ok: false,
			claim: { entryId: vector.reads.entry },
		});
	});

	it("holds HQ's documented quoted answer at the guards level, in either quote mark", () => {
		for (const text of [
			`concat('village = "', ${ANSWER}, '"')`,
			`concat("village = '", ${ANSWER}, "'")`,
		]) {
			const reading = readSearchFilterRow(text, filter, env);
			expect(reading).toEqual({
				ok: true,
				predicate: eq(village, term(input(REGION))),
				level: "guards",
				rewrites: ["search-value-guards"],
			});
		}
	});

	it("reads Nova's own presence cascade back as the tree that wrote it, exactly", () => {
		const predicate = whenInput(
			input(REGION),
			eq(village, term(input(REGION))),
		);
		expect(
			readSearchFilterRow(novaRow(predicate, filter), filter, env),
		).toEqual({ ok: true, predicate, level: "exact", rewrites: [] });
	});

	it("reads a list of fixed values and one with a calculated item", () => {
		const fixed: Expression = eq(village, {
			kind: "value-list",
			items: [term(literal("north")), term(literal("south"))],
		});
		const calculated: Expression = whenInput(
			input(REGION),
			eq(village, {
				kind: "value-list",
				items: [term(literal("north")), term(input(REGION))],
			}),
		);
		for (const predicate of [fixed, calculated])
			expect(
				readSearchFilterRow(novaRow(predicate, condition), condition, env),
			).toEqual({ ok: true, predicate, level: "exact", rewrites: [] });
	});

	it("refuses a property name the device builds as computed at run time", () => {
		const reading = readSearchFilterRow(
			`concat(${ANSWER}, " = 'x'")`,
			filter,
			env,
		);
		expect(reading).toMatchObject({
			ok: false,
			claim: {
				entryId:
					"case-search/property-names-operators-or-function-names-computed-at-runtime",
			},
		});
	});

	it("leaves text no CSQL reading holds unrecognized", () => {
		expect(readSearchFilterRow("'village ='", filter, env)).toEqual({
			ok: false,
			unrecognized: true,
		});
	});
});
