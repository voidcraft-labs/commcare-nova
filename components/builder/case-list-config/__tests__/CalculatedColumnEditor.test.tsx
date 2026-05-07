// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/CalculatedColumnEditor.test.tsx
//
// CalculatedColumnEditor surface tests covering:
//
//   - **Round-trip:** common CalculatedColumn shapes emitted by the
//     editor parse cleanly through `caseListConfigSchema.shape.calculatedColumns`.
//   - **Add / remove / reorder:** Add seeds with a fresh `calc_<...>`
//     id + empty header + Term-shaped empty-string literal. Remove
//     drops the row. Reorder produces the new array order via the
//     `useReorderableList` hook's splice contract.
//   - **Id validation — non-empty + uniqueness across siblings:**
//     duplicate ids surface inline error AND propagate
//     `valid: false`. Per `feedback_always_in_valid_state.md`, the
//     display chrome and validity verdict share a single
//     computation.
//   - **Header validation — non-empty:** empty header surfaces inline
//     error AND propagates `valid: false`.
//   - **Inner-expression validity propagates:** an invalid inner
//     expression flips the editor's `valid: false` even when the id
//     and header pass.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type CalculatedColumn,
	type CaseType,
	calculatedColumn,
	caseListConfigSchema,
} from "@/lib/domain";
import { literal, prop, term } from "@/lib/domain/predicate";
import { CalculatedColumnEditor } from "../CalculatedColumnEditor";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

const CALCULATED_SCHEMA = caseListConfigSchema.shape.calculatedColumns;

/**
 * Render the editor with the supplied initial value + collect every
 * onChange emission.
 */
function renderEditor(
	initial: readonly CalculatedColumn[],
	onValidityChange?: (valid: boolean) => void,
) {
	const onChange = vi.fn();
	const utils = render(
		<CalculatedColumnEditor
			value={initial}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
			knownInputs={[]}
			onValidityChange={onValidityChange}
		/>,
	);
	return { ...utils, onChange };
}

function lastEmitted(
	onChange: ReturnType<typeof vi.fn>,
): readonly CalculatedColumn[] {
	expect(onChange).toHaveBeenCalled();
	return onChange.mock.calls.at(-1)?.[0] as readonly CalculatedColumn[];
}

// ── Round-trip ───────────────────────────────────────────────────

describe("CalculatedColumnEditor — round-trip", () => {
	it("an empty list parses through the schema", () => {
		expect(() => CALCULATED_SCHEMA.parse([])).not.toThrow();
	});

	it("a populated list parses through the schema", () => {
		const built: CalculatedColumn[] = [
			calculatedColumn(
				"days_since_visit",
				"Days since visit",
				term(prop("patient", "age")),
			),
		];
		expect(() => CALCULATED_SCHEMA.parse(built)).not.toThrow();
	});

	it("the Add button emits a schema-valid seed row", () => {
		const { onChange } = renderEditor([]);
		fireEvent.click(
			screen.getByRole("button", { name: /add calculated column/i }),
		);
		const next = lastEmitted(onChange);
		expect(() => CALCULATED_SCHEMA.parse(next)).not.toThrow();
		expect(next).toHaveLength(1);
		// Seed shape: `calc_<...>` id, empty header, Term-shaped literal expression.
		const seed = next[0];
		if (seed === undefined) throw new Error("expected seed row");
		expect(seed.id).toMatch(/^calc_/);
		expect(seed.header).toBe("");
		expect(seed.expression.kind).toBe("term");
	});
});

// ── Empty state ──────────────────────────────────────────────────

describe("CalculatedColumnEditor — empty state", () => {
	it("renders an empty-state hint when the list is empty", () => {
		renderEditor([]);
		expect(screen.getByText(/no calculated columns/i)).toBeDefined();
	});

	it("the Add button is always rendered", () => {
		renderEditor([]);
		expect(
			screen.getByRole("button", { name: /add calculated column/i }),
		).toBeDefined();
	});
});

// ── Add / remove / reorder ───────────────────────────────────────

describe("CalculatedColumnEditor — add / remove / reorder", () => {
	it("Remove drops the row from the list", () => {
		const value: CalculatedColumn[] = [
			calculatedColumn("a", "Header A", term(literal(""))),
			calculatedColumn("b", "Header B", term(literal(""))),
		];
		const { onChange } = renderEditor(value);
		const removeButtons = screen.getAllByRole("button", {
			name: /remove calculated column/i,
		});
		fireEvent.click(removeButtons[0]);
		const next = lastEmitted(onChange);
		expect(next).toHaveLength(1);
		expect(next[0]?.id).toBe("b");
	});

	it("renders one drag handle per row", () => {
		const value: CalculatedColumn[] = [
			calculatedColumn("a", "Header A", term(literal(""))),
			calculatedColumn("b", "Header B", term(literal(""))),
			calculatedColumn("c", "Header C", term(literal(""))),
		];
		const { container } = renderEditor(value);
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder calculated column"]',
		);
		expect(grips.length).toBe(3);
	});

	it("a rearranged calculated-column array parses cleanly through the schema", () => {
		// Mirrors `SortKeyEditor`'s reorder-shape test: pragmatic-drag-
		// and-drop's monitor flow can't be driven via `fireEvent`, so
		// we pin the schema-valid shape that the reorder hook would
		// emit. The editor's "splice and pass through" rebuild is
		// empirically traversed by every other test in this file
		// that mutates `value` on render.
		const a = calculatedColumn("a", "Header A", term(literal("")));
		const b = calculatedColumn("b", "Header B", term(literal("")));
		const c = calculatedColumn("c", "Header C", term(literal("")));
		const reordered = [c, a, b];
		expect(() => CALCULATED_SCHEMA.parse(reordered)).not.toThrow();
	});
});

// ── Id validation: non-empty + uniqueness ────────────────────────

describe("CalculatedColumnEditor — id validation", () => {
	it("an empty id surfaces inline error + reports invalid", () => {
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[calculatedColumn("", "Header", term(literal("")))],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		// The inline error renders inside the polite live region.
		const liveRegion = container.querySelector('[aria-live="polite"]');
		expect(liveRegion?.textContent ?? "").toMatch(/id is required/i);
	});

	it("two columns with the same id surface inline error + report invalid", () => {
		const onValidityChange = vi.fn();
		// First occurrence wins; the second carries the duplicate flag.
		const { container } = renderEditor(
			[
				calculatedColumn("shared", "Header A", term(literal(""))),
				calculatedColumn("shared", "Header B", term(literal(""))),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		// At least one inline error mentions "already used by row".
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/already used by row 1/i);
	});

	it("non-overlapping ids report valid", () => {
		const onValidityChange = vi.fn();
		renderEditor(
			[
				calculatedColumn("a", "Header A", term(literal(""))),
				calculatedColumn("b", "Header B", term(literal(""))),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});

// ── Header validation ────────────────────────────────────────────

describe("CalculatedColumnEditor — header validation", () => {
	it("an empty header surfaces inline error + reports invalid", () => {
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[calculatedColumn("ok_id", "", term(literal("")))],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/header is required/i);
	});

	it("a populated header reports valid", () => {
		const onValidityChange = vi.fn();
		renderEditor(
			[calculatedColumn("ok_id", "Visible Header", term(literal("")))],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});

// ── Builder discipline (round-trip across edits) ─────────────────

describe("CalculatedColumnEditor — builder discipline", () => {
	it("seed expression for a fresh row is Term-shaped + parses clean", () => {
		const { onChange } = renderEditor([]);
		fireEvent.click(
			screen.getByRole("button", { name: /add calculated column/i }),
		);
		const next = lastEmitted(onChange);
		const seed = next[0];
		if (seed === undefined) throw new Error("expected seed row");
		// Term-shaped literal: `{ kind: "term", term: { kind: "literal", value: "" } }`
		expect(seed.expression.kind).toBe("term");
		if (seed.expression.kind === "term") {
			expect(seed.expression.term.kind).toBe("literal");
		}
	});

	it("preserves expression AST across header / id edits", () => {
		// A persisted CalculatedColumn carrying a non-trivial
		// expression must round-trip through the editor untouched
		// when the user edits only the header / id.
		const expr = term(prop("patient", "age"));
		const value: CalculatedColumn[] = [
			calculatedColumn("days_since", "Days since", expr),
		];
		const onChange = vi.fn();
		const { rerender } = render(
			<CalculatedColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// No spurious onChange on mount.
		expect(onChange).not.toHaveBeenCalled();
		// Re-render — still no rewrite.
		rerender(
			<CalculatedColumnEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(onChange).not.toHaveBeenCalled();
		// Verify the value parses through the schema as-is.
		expect(() => CALCULATED_SCHEMA.parse(value)).not.toThrow();
	});

	it("preserves the optional `sort` slot across header edits", () => {
		// `CalculatedColumn.sort?: SortConfig` is the optional per-
		// column sort declaration. The row's mutators thread
		// `value.sort` through `calculatedColumn(...)` on every
		// rebuild path; without this test, a regression that drops
		// `value.sort` on header / id edits would silently strip the
		// authored sort config.
		const expr = term(prop("patient", "age"));
		const initial: CalculatedColumn[] = [
			calculatedColumn("days_since", "Days since", expr, {
				type: "date",
				direction: "desc",
			}),
		];
		const onChange = vi.fn();
		render(
			<CalculatedColumnEditor
				value={initial}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// Trip the header input via focus → change → blur. The
		// BlurCommit input gates commits on focus equality
		// (`document.activeElement === inputRef.current`), so the
		// `change` alone wouldn't fire onChange; the canonical user
		// path is `input.focus()` (sets `document.activeElement`),
		// `change`, then `blur`. Use `input.focus()` rather than
		// `fireEvent.focus(...)` — the existing column-card edit
		// tests use the same shape; `fireEvent.focus` dispatches the
		// event but doesn't move `document.activeElement` under
		// happy-dom, so the blur-commit's `draft === value` check
		// would short-circuit on the post-blur re-sync.
		const headerInput = screen.getByLabelText(
			/calculated column 1 header/i,
		) as HTMLInputElement;
		headerInput.focus();
		fireEvent.change(headerInput, { target: { value: "Renamed" } });
		fireEvent.blur(headerInput);
		const next = lastEmitted(onChange);
		expect(next).toHaveLength(1);
		// Header committed.
		expect(next[0]?.header).toBe("Renamed");
		// Sort slot preserved verbatim.
		expect(next[0]?.sort).toEqual({ type: "date", direction: "desc" });
		// Schema round-trip.
		expect(() => CALCULATED_SCHEMA.parse(next)).not.toThrow();
	});
});

// ── External-prop validity flip ──────────────────────────────────
//
// The aggregated `isValid` verdict combines per-row structural
// errors (id / header) AND every row's inner-expression validity.
// The inner verdict flows through the parallel `innerValidRef`
// shadow array; a render-trigger counter (`innerValidityVersion`)
// recomputes the `useMemo` so the verdict picks up the freshly-
// updated ref.
//
// Pre-fix: the version counter was missing from the memo's deps —
// a `caseTypes` / `knownInputs` change that flipped a previously-
// valid inner expression to invalid would update the ref + bump
// the version, but the memo's referentially-stable `[value]` /
// `[value, errorsPerRow]` deps would short-circuit and return the
// cached stale `isValid`. The downstream `useEffect([isValid])`
// wouldn't fire and the parent never received the
// `onValidityChange(false)` notification.
//
// Post-fix: the version is in the deps; a flip recomputes the
// verdict and propagates to the parent.

// ── Reorder-then-flip regression ─────────────────────────────────
//
// Pre-fix: the inner-validity shadow was an index-keyed boolean
// array. After a reorder, an inner-flip on the moved row would write
// against the row's NEW index, which was already occupied by a
// different row's stale verdict. The flip would silently no-op (both
// values matched), the aggregation would walk the unchanged shadow,
// and the parent's `onValidityChange(true)` never fired even though
// every row was structurally valid. User couldn't save.
//
// Post-fix: `useInnerValidityShadow` uses a `WeakMap<Row, boolean>`
// keyed by row reference. The reorder hook splices existing
// references into the new array order, so the WeakMap entries
// survive the reorder; the inner-flip writes against the row's
// reference (not its index) and the aggregation reads each row's
// verdict via `shadow.get(row) ?? true`. Reorder + flip propagates
// correctly.

describe("CalculatedColumnEditor — reorder-then-flip propagation", () => {
	it("propagates valid:true after reorder + inner-flip on the moved row", async () => {
		// Phase 1 — Mount with [A_invalid, B_valid, C_valid]. A's
		// expression references `patient.age`; the initial caseTypes
		// shape DOESN'T declare `age`, so A's inner verdict is false.
		// B + C reference `patient.name` (declared) and resolve to
		// true.
		const PATIENT_NO_AGE: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		const PATIENT_WITH_AGE: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
			],
		};

		const A = calculatedColumn("a", "Header A", term(prop("patient", "age")));
		const B = calculatedColumn("b", "Header B", term(prop("patient", "name")));
		const C = calculatedColumn("c", "Header C", term(prop("patient", "name")));

		const onValidityChange = vi.fn();
		const { rerender } = render(
			<CalculatedColumnEditor
				value={[A, B, C]}
				onChange={() => {}}
				caseTypes={[PATIENT_NO_AGE]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);

		// Phase 1 verdict — A is invalid → aggregate false.
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});

		// Phase 2 — Rerender with the rows in a new order: [C, A, B].
		// CRITICAL: the SAME object references must thread through (the
		// reorder hook splices references into the new array order, so
		// WeakMap entries persist). Pass the same A/B/C constants.
		rerender(
			<CalculatedColumnEditor
				value={[C, A, B]}
				onChange={() => {}}
				caseTypes={[PATIENT_NO_AGE]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);

		// Phase 2 verdict — A is still invalid (just at a new index).
		// Aggregate stays false. With both INDEX-keyed and WEAKMAP-
		// keyed shadows, the verdict is correct here — the bug only
		// surfaces on the next flip.
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});

		// Phase 3 — Rerender with caseTypes that DOES declare `age`.
		// A's inner expression now type-checks; the inner editor's
		// `onValidityChange(true)` fires for A. With WEAKMAP keying,
		// the shadow's entry for the A reference flips to true; the
		// aggregation walks [C, A, B] and reads true / true / true →
		// reports valid:true to the parent.
		//
		// With the pre-fix INDEX keying, the inner-flip would write
		// shadow[1] = true (A's new index) — but shadow[1] was already
		// true (B's value when the shadow was originally laid out for
		// [A, B, C], where B was at index 1). The setter's no-op gate
		// would skip the version bump; the aggregation would never
		// recompute; the parent would never see valid:true. THIS IS
		// THE BUG THE FIX RESOLVES.
		rerender(
			<CalculatedColumnEditor
				value={[C, A, B]}
				onChange={() => {}}
				caseTypes={[PATIENT_WITH_AGE]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);

		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});
});

describe("CalculatedColumnEditor — external-prop validity flip", () => {
	it("propagates validity false when a caseTypes change makes a calculated expression's property reference stale", async () => {
		// Initial render: a calculated column whose expression reads
		// `patient.age`. With the original `caseTypes` (PATIENT
		// declares `age`), the inner expression type-checks clean and
		// the editor reports `valid: true`.
		//
		// Re-render: swap to a `caseTypes` shape that does NOT declare
		// `age`. The inner ExpressionCardEditor's `checkValueExpression`
		// runs against the new context and flips its verdict to false;
		// the wrapper picks up the flip via the version counter +
		// memo-deps wiring and propagates `valid: false` to the parent.
		const onValidityChange = vi.fn();
		const value: CalculatedColumn[] = [
			calculatedColumn(
				"days_since_age",
				"Days since age",
				term(prop("patient", "age")),
			),
		];
		const { rerender } = render(
			<CalculatedColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		// Initial verdict — inner expression resolves, validity is true.
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});

		// Re-render with a case-types list that no longer declares
		// `age`. The inner expression's `prop("patient", "age")`
		// reference becomes a type-checker error; the inner editor
		// flips to `valid: false`.
		const PATIENT_NO_AGE: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		rerender(
			<CalculatedColumnEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT_NO_AGE]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);

		// The flip propagates through the version counter + memo-deps
		// wiring; the parent's onValidityChange fires with false.
		// Without the fix (version missing from deps), this assertion
		// fails — `useMemo` returns the cached true and the parent
		// never sees the transition.
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
	});
});
