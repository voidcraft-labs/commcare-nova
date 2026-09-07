import { describe, expect, it } from "vitest";
import {
	type EntryActivationState,
	reduceEntryActivation,
} from "../entryActivationModel";

describe("optional field editor activation owner", () => {
	const initial: EntryActivationState = { scope: "first:ui", key: null };
	it("forgets pending activation across a field change, including a return to that field", () => {
		const pending = reduceEntryActivation(initial, {
			type: "activate",
			scope: initial.scope,
			key: "hint",
		});
		const other = reduceEntryActivation(pending, {
			type: "scope",
			scope: "second:ui",
		});
		expect(other).toStrictEqual({ scope: "second:ui", key: null });
		expect(
			reduceEntryActivation(other, { type: "scope", scope: initial.scope }),
		).toStrictEqual(initial);
	});
	it("replaces the one pending key and preserves it through same-scope reads", () => {
		const hint = reduceEntryActivation(initial, {
			type: "activate",
			scope: initial.scope,
			key: "hint",
		});
		expect(
			reduceEntryActivation(hint, { type: "scope", scope: initial.scope }),
		).toBe(hint);
		const help = reduceEntryActivation(hint, {
			type: "activate",
			scope: initial.scope,
			key: "help",
		});
		expect(help.key).toBe("help");
		expect(hint.key).toBe("hint");
	});
	it("clears satisfied or canceled intent without changing scope and is idempotent", () => {
		const pending = reduceEntryActivation(initial, {
			type: "activate",
			scope: initial.scope,
			key: "hint",
		});
		const cleared = reduceEntryActivation(pending, { type: "clear" });
		expect(cleared).toStrictEqual(initial);
		expect(reduceEntryActivation(cleared, { type: "clear" })).toBe(cleared);
	});
	it("each section retains its own independent state", () => {
		const ui = reduceEntryActivation(initial, {
			type: "activate",
			scope: initial.scope,
			key: "hint",
		});
		const logic = reduceEntryActivation(
			{ scope: "first:logic", key: null },
			{ type: "activate", scope: "first:logic", key: "validate" },
		);
		expect(reduceEntryActivation(logic, { type: "clear" }).key).toBeNull();
		expect(ui.key).toBe("hint");
	});
});
