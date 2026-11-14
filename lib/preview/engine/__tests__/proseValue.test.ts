/**
 * A calculated value in a text, in Preview's form engine.
 *
 * Each value lowers in its prose slot at the Preview target and is printed
 * by the device's string rule; its reads are wording edges of the trigger
 * graph, so a label redraws when anything its value reads changes. The
 * vectors are the ones the proof lane holds Core to (`proseValue.vectors.ts`).
 *
 * Plausible failures: a label that keeps its first text after the answer it
 * reads changes, a value printed otherwise than Core prints it, or a
 * validation message that drops its value or wraps it in a count.
 */

import { describe, expect, it } from "vitest";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import {
	PROSE_VALUE_ANSWERS,
	PROSE_VALUE_MESSAGES,
	PROSE_VALUE_VECTORS,
	proseValueVectorDoc,
	VECTOR_UUIDS,
} from "./proseValue.vectors";

function answeredEngine(): FormEngine {
	const input = buildEngineInput(
		proseValueVectorDoc(),
		VECTOR_UUIDS.form,
		null,
	);
	if (input === undefined)
		throw new Error("The vector form has no engine input.");
	const engine = new FormEngine(input);
	for (const [id, value] of Object.entries(PROSE_VALUE_ANSWERS))
		engine.setValue(`/data/${id}`, value);
	return engine;
}

describe("a calculated value in Preview", () => {
	it.each(PROSE_VALUE_VECTORS)("prints $id as Core prints it", (vector) => {
		expect(answeredEngine().getState(`/data/${vector.id}`).resolvedLabel).toBe(
			vector.text,
		);
	});

	it("redraws a label when an answer its value reads changes", () => {
		const engine = answeredEngine();
		expect(engine.getState("/data/a_text").resolvedLabel).toBe("Ama and more");
		engine.setValue("/data/word", "Kofi");
		expect(engine.getState("/data/a_text").resolvedLabel).toBe("Kofi and more");
		engine.setValue("/data/count", "1");
		expect(engine.getState("/data/a_yes_or_no").resolvedLabel).toBe("false");
		expect(engine.getState("/data/a_whole_number").resolvedLabel).toBe("2");
	});

	it.each(PROSE_VALUE_MESSAGES)(
		"composes the validation message $id with its value",
		(message) => {
			const engine = answeredEngine();
			const path = `/data/${message.id}`;
			engine.setValue(path, "0");
			engine.touch(path);
			const state = engine.getState(path);
			expect(state.valid).toBe(false);
			expect(state.errorMessage).toBe(message.text);
		},
	);
});
