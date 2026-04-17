import { assert, describe, expect, it } from "vitest";
import type { EditFocusData } from "@/lib/signalGrid/editFocus";
import { computeEditFocus } from "@/lib/signalGrid/editFocus";

/**
 * Build a minimal `EditFocusData` fixture from a compact description.
 *
 * Each entry in `modules` is an array of question counts per form.
 * Example: `[[3, 5], [2]]` = 2 modules, module 0 has 2 forms (3q, 5q),
 * module 1 has 1 form (2q). UUIDs are generated as `m0`, `f0_0`, `q_*`.
 */
function fixture(modules: number[][]): EditFocusData {
	const moduleOrder: string[] = [];
	const formOrder: Record<string, string[]> = {};
	const fieldOrder: Record<string, string[]> = {};
	let qCounter = 0;

	for (let mi = 0; mi < modules.length; mi++) {
		const moduleId = `m${mi}`;
		moduleOrder.push(moduleId);
		formOrder[moduleId] = [];

		for (let fi = 0; fi < modules[mi].length; fi++) {
			const formId = `f${mi}_${fi}`;
			formOrder[moduleId].push(formId);
			fieldOrder[formId] = [];

			for (let qi = 0; qi < modules[mi][fi]; qi++) {
				const qId = `q_${qCounter++}`;
				fieldOrder[formId].push(qId);
			}
		}
	}

	return { moduleOrder, formOrder, fieldOrder };
}

describe("computeEditFocus", () => {
	it("returns null for an empty doc (no modules)", () => {
		const data: EditFocusData = {
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
		};
		expect(computeEditFocus(data, { moduleIndex: 0 })).toBeNull();
	});

	it("returns null when scope is null", () => {
		const data = fixture([[5]]);
		expect(computeEditFocus(data, null)).toBeNull();
	});

	it("returns null when all forms have zero questions", () => {
		const data = fixture([[0, 0]]);
		expect(computeEditFocus(data, { moduleIndex: 0 })).toBeNull();
	});

	it("returns null when the targeted module has no forms", () => {
		/* Module 0 has forms, but scope targets module 1 which doesn't exist */
		const data = fixture([[5]]);
		expect(computeEditFocus(data, { moduleIndex: 1 })).toBeNull();
	});

	it("returns null when targeted form has zero questions", () => {
		const data = fixture([[0]]);
		expect(computeEditFocus(data, { moduleIndex: 0, formIndex: 0 })).toBeNull();
	});

	// ── Module-level scope ──────────────────────────────────────────────

	it("module-level scope spans all of the module's forms", () => {
		/* 2 modules: m0 has 3+5=8 questions, m1 has 2 questions. Total=10. */
		const data = fixture([[3, 5], [2]]);
		const focus = computeEditFocus(data, { moduleIndex: 0 });
		assert(focus);

		/* m0 spans questions 0-7 out of 10 → start=0, end=0.8.
		 * 0.8 > MIN_EDIT_ZONE, so clamping doesn't widen. */
		expect(focus.start).toBeCloseTo(0, 5);
		expect(focus.end).toBeCloseTo(0.8, 5);
	});

	it("module-level scope for the second module", () => {
		const data = fixture([[3, 5], [2]]);
		const focus = computeEditFocus(data, { moduleIndex: 1 });
		assert(focus);

		/* m1 spans questions 8-9 out of 10 → start=0.8, end=1.0.
		 * width=0.2 > MIN_EDIT_ZONE(0.15), so no clamping. */
		expect(focus.start).toBeCloseTo(0.8, 5);
		expect(focus.end).toBeCloseTo(1.0, 5);
	});

	// ── Form-level scope ────────────────────────────────────────────────

	it("form-level scope spans the form's question range", () => {
		/* Module 0: form 0 has 3q, form 1 has 5q. Total=8. */
		const data = fixture([[3, 5]]);
		const focus = computeEditFocus(data, { moduleIndex: 0, formIndex: 1 });
		assert(focus);

		/* Form 1 starts at q3, ends at q7 → start=3/8=0.375, end=8/8=1.0.
		 * width=0.625 > MIN_EDIT_ZONE. */
		expect(focus.start).toBeCloseTo(0.375, 5);
		expect(focus.end).toBeCloseTo(1.0, 5);
	});

	// ── Question-level scope ────────────────────────────────────────────

	it("question-level scope centers a zone around the question position", () => {
		/* 1 module, 1 form, 5 questions. Scope targets question index 2. */
		const data = fixture([[5]]);
		const focus = computeEditFocus(data, {
			moduleIndex: 0,
			formIndex: 0,
			questionIndex: 2,
		});
		assert(focus);

		/* qPos = (0 + 2) / 5 = 0.4.
		 * halfZone = max(0.075, (5/5) * 0.3) = max(0.075, 0.3) = 0.3.
		 * raw: [0.1, 0.7] → width=0.6 > MIN. */
		expect(focus.start).toBeCloseTo(0.1, 5);
		expect(focus.end).toBeCloseTo(0.7, 5);
	});

	it("question-level scope clamps to [0,1] when zone overflows left", () => {
		/* 1 module, 1 form, 5 questions. Scope targets question 0 (leftmost). */
		const data = fixture([[5]]);
		const focus = computeEditFocus(data, {
			moduleIndex: 0,
			formIndex: 0,
			questionIndex: 0,
		});
		assert(focus);

		/* qPos = 0 / 5 = 0. halfZone = 0.3. raw: [-0.3, 0.3].
		 * After clamping start<0: start=0, end=0.6. */
		expect(focus.start).toBeCloseTo(0, 5);
		expect(focus.end).toBeCloseTo(0.6, 5);
	});

	it("question-level scope clamps to [0,1] when zone overflows right", () => {
		/* 1 module, 1 form, 5 questions. Scope targets question 4 (rightmost). */
		const data = fixture([[5]]);
		const focus = computeEditFocus(data, {
			moduleIndex: 0,
			formIndex: 0,
			questionIndex: 4,
		});
		assert(focus);

		/* qPos = 4 / 5 = 0.8. halfZone = 0.3. raw: [0.5, 1.1].
		 * After clamping end>1: start=0.4, end=1. */
		expect(focus.start).toBeCloseTo(0.4, 5);
		expect(focus.end).toBeCloseTo(1.0, 5);
	});

	it("question index is clamped to the form's question count", () => {
		/* Question index 99 exceeds the form's 5 questions — treated as last (index 4). */
		const data = fixture([[5]]);
		const overflowed = computeEditFocus(data, {
			moduleIndex: 0,
			formIndex: 0,
			questionIndex: 99,
		});
		const lastQuestion = computeEditFocus(data, {
			moduleIndex: 0,
			formIndex: 0,
			questionIndex: 4,
		});
		expect(overflowed).toEqual(lastQuestion);
	});

	// ── MIN_EDIT_ZONE enforcement ───────────────────────────────────────

	it("enforces minimum zone width for small forms", () => {
		/* 2 modules: m0 has 1 question, m1 has 99 questions. Total=100.
		 * Module-level scope for m0: raw range is [0, 0.01] — well below MIN_EDIT_ZONE.
		 * Should be widened to 0.15 centered at 0.005 → [0, 0.15] after left clamp. */
		const data = fixture([[1], [99]]);
		const focus = computeEditFocus(data, { moduleIndex: 0 });
		assert(focus);
		expect(focus.end - focus.start).toBeGreaterThanOrEqual(0.15 - 1e-10);
		expect(focus.start).toBeGreaterThanOrEqual(0);
		expect(focus.end).toBeLessThanOrEqual(1);
	});

	// ── Nested questions (groups/repeats) ───────────────────────────────

	it("counts nested questions (group children) toward total", () => {
		/* Build a fixture with groups manually: form has 2 top-level questions,
		 * one of which is a group with 3 children → total = 5 (2 top + 3 nested). */
		const data: EditFocusData = {
			moduleOrder: ["m0"],
			formOrder: { m0: ["f0"] },
			fieldOrder: {
				f0: ["q_plain", "q_group"],
				q_group: ["q_child1", "q_child2", "q_child3"],
			},
		};
		const focus = computeEditFocus(data, { moduleIndex: 0, formIndex: 0 });
		assert(focus);

		/* Total = 2 (top-level) + 3 (group children) = 5.
		 * Form spans [0, 5/5] = [0, 1]. Already full width. */
		expect(focus.start).toBeCloseTo(0, 5);
		expect(focus.end).toBeCloseTo(1.0, 5);
	});
});
