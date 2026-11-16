/**
 * The expression stage reads typing as a fact of the whole document: a
 * Hidden Value whose calculation binds to a date and time makes another
 * slot's comparison of it print lowered, so the stage must print every slot
 * against a document that holds every bound tree, rebuilt as a new object
 * (each typing fact is cached per document). The failures this holds: the
 * comparison judged against the provisional document's untyped Hidden Value
 * (printed bare, so Nova's own lowered text reads as unrecognized), and the
 * input document changed by the call.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { readExpressions } from "../index";
import { printSlot } from "../readExpression";
import { fieldNamed, readEnv, registration } from "./expressionReadFixture";

function surveyDoc(calculate: Expression) {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({ kind: "datetime", id: "start", label: "Start" }),
							f({ kind: "hidden", id: "h", calculate }),
							f({ kind: "text", id: "q1", label: "Q1" }),
						],
					},
				],
			},
		],
	});
}

const field = (uuid: string): Expression => ({
	kind: "term",
	term: { kind: "field", uuid: uuid as never },
});

describe("a reading's typing is the whole document's", () => {
	it("prints a comparison of a Hidden Value by the type its calculation gives", () => {
		const provisional = surveyDoc({
			kind: "term",
			term: { kind: "literal", value: "" },
		});
		const start = fieldNamed(provisional, "start");
		const hidden = fieldNamed(provisional, "h");
		const q1 = fieldNamed(provisional, "q1");
		const final = hydratePersistedBlueprint(toPersistableDoc(provisional));
		// The clock-keeping date: a date and time Core holds with its clock.
		const clockKeeping: Expression = {
			kind: "date-coerce",
			value: {
				kind: "format-date",
				date: field(start),
				pattern: "%Y-%m-%dT%H:%M:%S.%3%Z",
			},
		};
		(final.fields[hidden] as { calculate?: Expression }).calculate =
			clockKeeping;
		const calculate: SlotContextRef = {
			entity: "field",
			uuid: hidden,
			slot: "calculate",
		};
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: q1,
			slot: "relevant",
		};
		const comparison: Expression = {
			kind: "lt",
			left: field(hidden),
			right: field(start),
		};
		const env = readEnv();
		// Nova's own text for both slots, printed where the Hidden Value is a
		// date and time: the comparison is lowered.
		const pending = [
			registration(
				final,
				calculate,
				printSlot(final, calculate, clockKeeping, env),
			),
			registration(
				final,
				relevant,
				printSlot(final, relevant, comparison, env),
			),
		];
		const before = structuredClone(provisional);
		const reading = readExpressions(provisional, pending, env);
		expect(provisional).toEqual(before);
		expect(reading.circumstances).toEqual([]);
		expect(reading.bound).toEqual([clockKeeping, comparison]);
		expect(reading.doc).not.toBe(provisional);
	});
});
