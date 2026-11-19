/**
 * The process-wide answers held by their text.
 *
 * Contract: what is held weighs at most the budget, by the weight the cache
 * is given, so a cache of parsed documents is bounded by the nodes it holds
 * and never by the length of the texts, which an app's author controls the
 * ratio of. The oldest answers go first; an answer heavier than the whole
 * budget is answered and never held, so it evicts nothing.
 */

import { describe, expect, it } from "vitest";
import { HeldByText } from "../heldByText";

describe("answers held by their text", () => {
	it("evicts the oldest answers once their weight passes the budget", () => {
		let asked = 0;
		const held = new HeldByText<number>(10, (answer) => answer);
		const answer = (weight: number) => () => {
			asked += 1;
			return weight;
		};
		held.of("a", answer(4));
		held.of("b", answer(4));
		held.of("c", answer(4));
		expect(asked).toBe(3);
		/* "a" went to make room for "c"; "b" and "c" are held. */
		held.of("b", answer(4));
		held.of("c", answer(4));
		expect(asked).toBe(3);
		held.of("a", answer(4));
		expect(asked).toBe(4);
	});

	it("answers an answer heavier than the budget and holds it not, evicting nothing", () => {
		let asked = 0;
		const held = new HeldByText<number>(10, (answer) => answer);
		const answer = (weight: number) => () => {
			asked += 1;
			return weight;
		};
		held.of("small", answer(3));
		expect(held.of("huge", answer(11))).toBe(11);
		held.of("huge", answer(11));
		held.of("small", answer(3));
		expect(asked).toBe(3);
	});

	it("weighs an answer by its text's length where it is given no weight", () => {
		let asked = 0;
		const held = new HeldByText<string>(5);
		const answer = () => {
			asked += 1;
			return "x";
		};
		held.of("abc", answer);
		held.of("de", answer);
		held.of("abc", answer);
		expect(asked).toBe(2);
		held.of("f", answer);
		held.of("abc", answer);
		expect(asked).toBe(4);
	});
});
