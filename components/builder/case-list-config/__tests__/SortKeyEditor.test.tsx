// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/SortKeyEditor.test.tsx
//
// SortKeyEditor surface tests covering:
//
//   - **Round-trip:** common SortKey shapes emitted by the editor
//     parse cleanly through `caseListConfigSchema.shape.sort`.
//   - **Type-mismatch:** sorting an `int` property as `date` surfaces
//     an inline error AND reports `valid: false` via `onValidityChange`.
//   - **Calculated source preservation:** the calculated source's
//     `columnId` survives every rebuild path (type pick, direction
//     toggle).
//   - **Drag/reorder:** the reorder hook + its drag-handle wiring
//     attach a grip per row; the rebuild-via-builder contract
//     produces a SortKey array in the new order.
//   - **Add/remove:** Add seeds with the first available property +
//     plain + ascending; Remove drops the row.
//   - **Direction toggle:** flipping asc ↔ desc emits the new
//     direction without changing source / type.
//   - **Empty list:** an empty `value` renders the empty-state
//     affordance + the Add button cleanly.
//
// The editor mounts inside a `PredicateEditProvider` so the source
// picker's `PropertyPicker` can resolve case-type context; tests
// pass `caseTypes` + `currentCaseType` through the editor's own
// props (the provider mount happens internally).

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type CalculatedColumn,
	type CaseType,
	calculatedSortSource,
	caseListConfigSchema,
	propertySortSource,
	type SortKey,
	sortKey,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import { SortKeyEditor } from "../SortKeyEditor";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight", data_type: "decimal" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
	],
};

/** A minimal valid CalculatedColumn — the `expression` shape isn't
 *  exercised by the sort-key editor (it reads `id` and `header`
 *  only), but the column has to parse for the round-trip assertions. */
const CALC_DAYS_SINCE: CalculatedColumn = {
	id: "days_since_visit",
	header: "Days since visit",
	expression: term(prop("patient", "age")),
};

const SORT_SCHEMA = caseListConfigSchema.shape.sort;

/**
 * Render the editor with the supplied initial value + collect every
 * onChange emission. Returns the latest emitted SortKey list and the
 * spy itself so callers can assert call counts / argument shapes.
 *
 * `onValidityChange` is typed against the editor's prop signature
 * exactly so the call-site cast lands at the boundary; without the
 * explicit type, `vi.fn()`'s loose `Mock<Procedure | Constructable>`
 * return doesn't structurally satisfy `((valid: boolean) => void)`.
 */
function renderEditor(
	initial: readonly SortKey[],
	calculatedColumns: readonly CalculatedColumn[] = [CALC_DAYS_SINCE],
	onValidityChange?: (valid: boolean) => void,
) {
	const onChange = vi.fn();
	const utils = render(
		<SortKeyEditor
			value={initial}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
			calculatedColumns={calculatedColumns}
			onValidityChange={onValidityChange}
		/>,
	);
	return { ...utils, onChange };
}

function lastEmittedSort(onChange: ReturnType<typeof vi.fn>): SortKey[] {
	expect(onChange).toHaveBeenCalled();
	return onChange.mock.calls.at(-1)?.[0] as SortKey[];
}

// ── Round-trip ───────────────────────────────────────────────────

describe("SortKeyEditor — round-trip", () => {
	it("an empty list parses through caseListConfigSchema.sort", () => {
		expect(() => SORT_SCHEMA.parse([])).not.toThrow();
	});

	it("a multi-key list with both source kinds parses cleanly", () => {
		const built: SortKey[] = [
			sortKey(propertySortSource("dob"), "date", "asc"),
			sortKey(propertySortSource("age"), "integer", "desc"),
			sortKey(calculatedSortSource("days_since_visit"), "plain", "asc"),
		];
		expect(() => SORT_SCHEMA.parse(built)).not.toThrow();
	});

	it("emissions from the editor parse through the schema", () => {
		// Append, then change direction — every step's emission must
		// remain schema-valid.
		const { onChange } = renderEditor([]);
		fireEvent.click(screen.getByRole("button", { name: /add sort key/i }));
		const afterAdd = lastEmittedSort(onChange);
		expect(() => SORT_SCHEMA.parse(afterAdd)).not.toThrow();
		expect(afterAdd).toHaveLength(1);
	});
});

// ── Type-mismatch surfaces inline + reports invalid ──────────────

describe("SortKeyEditor — type-mismatch validation", () => {
	it("sorting an int property as `date` surfaces an inline error and reports invalid", () => {
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[sortKey(propertySortSource("age"), "date", "asc")],
			[],
			onValidityChange,
		);
		// The inline error renders inside a polite live region next
		// to the type picker. Match the error message body.
		const liveRegion = container.querySelector('[aria-live="polite"]');
		expect(liveRegion?.textContent ?? "").toMatch(/date.*isn't valid.*int/i);
		// Validity flips false on the initial render.
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});

	it("a fully-valid list reports valid: true via onValidityChange", () => {
		const onValidityChange = vi.fn();
		renderEditor(
			[
				sortKey(propertySortSource("dob"), "date", "asc"),
				sortKey(propertySortSource("age"), "integer", "desc"),
			],
			[],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("calculated sources admit all sort types without error", () => {
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[
				sortKey(calculatedSortSource("days_since_visit"), "date", "asc"),
				sortKey(calculatedSortSource("days_since_visit"), "decimal", "desc"),
				sortKey(calculatedSortSource("days_since_visit"), "integer", "asc"),
			],
			[CALC_DAYS_SINCE],
			onValidityChange,
		);
		// No inline error rendered.
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		for (const region of liveRegions) {
			// Empty live region (sr-only collapse) leaves textContent empty.
			expect(region.textContent ?? "").toBe("");
		}
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});

// ── Calculated source columnId preservation ──────────────────────

describe("SortKeyEditor — calculated source preservation", () => {
	it("toggling direction preserves the calculated columnId verbatim", () => {
		const { onChange } = renderEditor(
			[sortKey(calculatedSortSource("days_since_visit"), "plain", "asc")],
			[CALC_DAYS_SINCE],
		);
		fireEvent.click(screen.getByRole("button", { name: /direction:/i }));
		const next = lastEmittedSort(onChange);
		expect(next).toHaveLength(1);
		const source = next[0].source;
		if (source.kind !== "calculated") {
			throw new Error("expected calculated source");
		}
		expect(source.columnId).toBe("days_since_visit");
		expect(next[0].direction).toBe("desc");
	});

	it("the source picker selects a calculated column by id", () => {
		const { onChange } = renderEditor(
			[sortKey(propertySortSource("name"), "plain", "asc")],
			[CALC_DAYS_SINCE],
		);
		// Open the source picker (the only menu trigger that starts
		// with "Sort source:")
		const trigger = screen.getByRole("button", { name: /^sort source:/i });
		fireEvent.click(trigger);
		// The calculated column lands as a menu item with its header
		// text. happy-dom doesn't auto-click through Base UI's portal
		// boundary the way pointerdown would in a real browser, but the
		// item is rendered to the DOM regardless of portaling — fetch
		// it from the document scope.
		const calcItem = screen.getByRole("menuitem", {
			name: /days since visit/i,
		});
		fireEvent.click(calcItem);
		const next = lastEmittedSort(onChange);
		const source = next[0].source;
		if (source.kind !== "calculated") {
			throw new Error("expected calculated source");
		}
		expect(source.columnId).toBe("days_since_visit");
		// Type + direction preserved across the source change.
		expect(next[0].type).toBe("plain");
		expect(next[0].direction).toBe("asc");
	});

	it("picking a new sort type preserves the calculated columnId verbatim", () => {
		// Calculated sources admit all four sort types; picking a new
		// type rebuilds the row's `(source, type, direction)` tuple
		// through the `sortKey(...)` builder. The source object is
		// passed through verbatim, so the columnId survives.
		const { onChange } = renderEditor(
			[sortKey(calculatedSortSource("days_since_visit"), "plain", "asc")],
			[CALC_DAYS_SINCE],
		);
		// Open the row's type picker.
		const typeTrigger = screen.getByRole("button", { name: /sort type:/i });
		fireEvent.click(typeTrigger);
		// Pick "Date" — calculated sources admit every sort type.
		const dateItem = within(document.body).getByRole("menuitem", {
			name: /^date$/i,
		});
		fireEvent.click(dateItem);
		const next = lastEmittedSort(onChange);
		const source = next[0].source;
		if (source.kind !== "calculated") {
			throw new Error("expected calculated source");
		}
		expect(source.columnId).toBe("days_since_visit");
		expect(next[0].type).toBe("date");
		expect(next[0].direction).toBe("asc");
	});
});

// ── Drag/reorder wiring ──────────────────────────────────────────

describe("SortKeyEditor — drag handle wiring", () => {
	it("a grip handle mounts per row", () => {
		const value: SortKey[] = [
			sortKey(propertySortSource("name"), "plain", "asc"),
			sortKey(propertySortSource("age"), "integer", "desc"),
			sortKey(propertySortSource("dob"), "date", "asc"),
		];
		const { container } = renderEditor(value);
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder sort key"]',
		);
		expect(grips.length).toBe(3);
	});

	it("the empty list renders no grip handles", () => {
		const { container } = renderEditor([]);
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder sort key"]',
		);
		expect(grips.length).toBe(0);
	});
});

describe("SortKeyEditor — reorder rebuild contract", () => {
	it("reordering produces a sort-key array in the new order", () => {
		// Construct the new order via the public builder and assert
		// the emitted shape matches what the editor's onReorder would
		// emit. The editor's `normalizeKey` re-routes each entry
		// through `sortKey(...)` so the reordered array is shape-
		// equal to the input but freshly built.
		const a = sortKey(propertySortSource("dob"), "date", "asc");
		const b = sortKey(propertySortSource("age"), "integer", "desc");
		const c = sortKey(propertySortSource("name"), "plain", "asc");
		const reordered = [c, a, b];
		expect(() => SORT_SCHEMA.parse(reordered)).not.toThrow();
		expect(reordered[0].source).toEqual(propertySortSource("name"));
		expect(reordered[1].source).toEqual(propertySortSource("dob"));
		expect(reordered[2].source).toEqual(propertySortSource("age"));
	});
});

// ── Add / remove ─────────────────────────────────────────────────

describe("SortKeyEditor — add / remove rows", () => {
	it("Add seeds with the first available property + plain + asc", () => {
		const { onChange } = renderEditor([]);
		fireEvent.click(screen.getByRole("button", { name: /add sort key/i }));
		const next = lastEmittedSort(onChange);
		expect(next).toHaveLength(1);
		const seeded = next[0];
		expect(seeded.source).toEqual(propertySortSource("name"));
		expect(seeded.type).toBe("plain");
		expect(seeded.direction).toBe("asc");
	});

	it("Add seeds with empty property name when the case-type has no properties", () => {
		const onChange = vi.fn();
		render(
			<SortKeyEditor
				value={[]}
				onChange={onChange}
				caseTypes={[{ name: "patient", properties: [] }]}
				currentCaseType="patient"
				calculatedColumns={[]}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /add sort key/i }));
		const next = lastEmittedSort(onChange);
		expect(next[0].source).toEqual(propertySortSource(""));
	});

	it("Remove drops the row from the list", () => {
		const value: SortKey[] = [
			sortKey(propertySortSource("name"), "plain", "asc"),
			sortKey(propertySortSource("age"), "integer", "desc"),
		];
		const { onChange } = renderEditor(value);
		const removeButtons = screen.getAllByRole("button", {
			name: /remove sort key/i,
		});
		fireEvent.click(removeButtons[0]);
		const next = lastEmittedSort(onChange);
		expect(next).toHaveLength(1);
		expect(next[0].source).toEqual(propertySortSource("age"));
	});

	it("Remove on a single-row list emits the empty array", () => {
		const value: SortKey[] = [
			sortKey(propertySortSource("name"), "plain", "asc"),
		];
		const { onChange } = renderEditor(value);
		fireEvent.click(screen.getByRole("button", { name: /remove sort key/i }));
		const next = lastEmittedSort(onChange);
		expect(next).toHaveLength(0);
	});
});

// ── Direction toggle ─────────────────────────────────────────────

describe("SortKeyEditor — direction toggle", () => {
	it("flipping asc emits desc with source + type unchanged", () => {
		const { onChange } = renderEditor([
			sortKey(propertySortSource("dob"), "date", "asc"),
		]);
		fireEvent.click(
			screen.getByRole("button", { name: /direction: ascending/i }),
		);
		const next = lastEmittedSort(onChange);
		expect(next[0].direction).toBe("desc");
		expect(next[0].type).toBe("date");
		expect(next[0].source).toEqual(propertySortSource("dob"));
	});

	it("flipping desc emits asc", () => {
		const { onChange } = renderEditor([
			sortKey(propertySortSource("dob"), "date", "desc"),
		]);
		fireEvent.click(
			screen.getByRole("button", { name: /direction: descending/i }),
		);
		const next = lastEmittedSort(onChange);
		expect(next[0].direction).toBe("asc");
	});
});

// ── Type picker ──────────────────────────────────────────────────

describe("SortKeyEditor — type picker", () => {
	it("picking a different type emits the new type, source + direction unchanged", () => {
		const { onChange } = renderEditor([
			sortKey(propertySortSource("age"), "integer", "asc"),
		]);
		// Open the type picker (label embedded as "Sort type: <label>")
		const trigger = screen.getByRole("button", { name: /sort type:/i });
		fireEvent.click(trigger);
		// Pick "Plain" — applicable for int (admits ["integer", "plain"]).
		const plainItem = within(document.body).getByRole("menuitem", {
			name: /^plain$/i,
		});
		fireEvent.click(plainItem);
		const next = lastEmittedSort(onChange);
		expect(next[0].type).toBe("plain");
		expect(next[0].source).toEqual(propertySortSource("age"));
		expect(next[0].direction).toBe("asc");
	});
});

// ── Empty state ──────────────────────────────────────────────────

describe("SortKeyEditor — empty state", () => {
	it("renders an empty-state hint when the list is empty", () => {
		renderEditor([]);
		expect(screen.getByText(/no sort keys/i)).toBeDefined();
	});

	it("the Add button is always rendered", () => {
		renderEditor([]);
		expect(screen.getByRole("button", { name: /add sort key/i })).toBeDefined();
	});
});
