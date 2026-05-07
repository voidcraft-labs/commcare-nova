// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/SearchInputsSection.test.tsx
//
// SearchInputsSection surface tests covering:
//
//   - **Round-trip:** common SearchInputDef shapes emitted by the
//     editor parse cleanly through `caseListConfigSchema.shape.searchInputs`.
//   - **Add / remove:** Add seeds with a fresh `input_<...>` name
//     + empty label + `text` type. Remove drops the row.
//   - **Name validation — non-empty + uniqueness across siblings:**
//     duplicate names surface inline error AND propagate
//     `valid: false`.
//   - **Label validation — non-empty:** empty label surfaces inline
//     error AND propagates `valid: false`.
//   - **Type-coupling validation:** a Date input declared on a text
//     property surfaces an inline error AND flips `valid: false`
//     (per `feedback_always_in_valid_state.md` — hard validation,
//     not a soft warning).
//   - **Type pickers gate mode pickers:** the mode picker only
//     surfaces modes admitted by the picked `type`; switching the
//     type clears a no-longer-applicable mode.
//   - **Optional slots round-trip:** `property` / `via` / `mode` /
//     `default` / `xpath` round-trip cleanly when present and absent;
//     `via: selfPath()` collapses to absent at the schema layer
//     (matches the schema's "absent ≡ self" contract).
//   - **xpath-override branch:** when `xpath` is present, the
//     property + mode pickers are hidden and the type-coupling
//     check is bypassed.
//   - **Drag-drop:** one drag handle per row; the reorder hook's
//     splice contract produces a schema-valid array in the new
//     order.
//   - **Inner-expression validity propagates:** an invalid default
//     expression flips the editor's `valid: false`; clearing the
//     slot resets the verdict.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type CaseListConfig,
	type CaseType,
	caseListConfigSchema,
	exactMode,
	fuzzyMode,
	multiSelectContainsMode,
	rangeMode,
	type SearchInputDef,
	searchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	literal,
	matchAll,
	prop,
	relationStep,
	selfPath,
	term,
	today,
} from "@/lib/domain/predicate";
import { SearchInputsSection } from "../SearchInputsSection";

// ── Fixtures ──────────────────────────────────────────────────────
//
// The fixture's case type carries a representative spread of data
// types so each test can exercise the gates without redefining the
// shape per test. `parent` is the `parent_type` slot — the relation
// resolver walks `ancestor` paths through this single hop in the
// type-coupling tests.

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight", data_type: "decimal" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "tags", label: "Tags", data_type: "multi_select" },
		{ name: "status", label: "Status", data_type: "single_select" },
		{ name: "phone", label: "Phone", data_type: "text" },
	],
	parent_type: "household",
};

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [
		{ name: "village", label: "Village", data_type: "text" },
		{ name: "size", label: "Size", data_type: "int" },
	],
};

const CASE_TYPES = [PATIENT, HOUSEHOLD];

const SEARCH_INPUTS_SCHEMA = caseListConfigSchema.shape.searchInputs;

/**
 * Render the editor and capture every onChange + onValidityChange
 * emission. Matches the per-editor render-helper shape used across
 * the case-list-config test suite.
 */
function renderEditor(
	initial: readonly SearchInputDef[],
	onValidityChange?: (valid: boolean) => void,
) {
	const onChange = vi.fn();
	const utils = render(
		<SearchInputsSection
			value={initial}
			onChange={onChange}
			caseTypes={CASE_TYPES}
			currentCaseType="patient"
			onValidityChange={onValidityChange}
		/>,
	);
	return { ...utils, onChange };
}

function lastEmitted(
	onChange: ReturnType<typeof vi.fn>,
): readonly SearchInputDef[] {
	expect(onChange).toHaveBeenCalled();
	return onChange.mock.calls.at(-1)?.[0] as readonly SearchInputDef[];
}

// ── Round-trip ────────────────────────────────────────────────────

describe("SearchInputsSection — round-trip", () => {
	it("an empty list parses through the schema", () => {
		expect(() => SEARCH_INPUTS_SCHEMA.parse([])).not.toThrow();
	});

	it("a populated list with every optional slot parses cleanly", () => {
		// Every optional slot exercised here. The `searchInputDef(...)`
		// builder routes the construction; the round-trip assertion is
		// against the shape `parse` returns vs the input — the builder's
		// optional-slot omission semantics keep them equal.
		const built: SearchInputDef[] = [
			searchInputDef("name_q", "Patient name", "text", {
				property: "name",
				mode: fuzzyMode(),
			}),
			searchInputDef("dob_range", "DOB range", "date-range", {
				property: "dob",
				mode: rangeMode(),
				default: today(),
			}),
			searchInputDef("tags_q", "Tags", "select", {
				property: "tags",
				mode: multiSelectContainsMode("any"),
			}),
			searchInputDef("village_q", "Village", "text", {
				property: "village",
				via: ancestorPath(relationStep("parent")),
				mode: exactMode(),
			}),
			searchInputDef("advanced", "Advanced", "text", {
				xpath: matchAll(),
			}),
		];
		const parsed = SEARCH_INPUTS_SCHEMA.parse(built);
		expect(parsed).toEqual(built);
	});

	it("the searchInputDef builder omits via: selfPath() — round-trip equality", () => {
		// The schema treats `via: undefined` as the canonical "no walk"
		// shape (per the schema's "absent ≡ self" contract). The
		// builder's omission semantics mean a row authored with
		// `selfPath()` parses identically to one authored without `via`.
		const withSelfVia = searchInputDef("a", "A", "text", {
			property: "name",
			via: selfPath(),
		});
		const withoutVia = searchInputDef("a", "A", "text", {
			property: "name",
		});
		expect(withSelfVia).toEqual(withoutVia);
		expect("via" in withSelfVia).toBe(false);
	});

	it("Add seeds with a schema-valid row", () => {
		const { onChange } = renderEditor([]);
		fireEvent.click(screen.getByRole("button", { name: /add search input/i }));
		const next = lastEmitted(onChange);
		expect(next).toHaveLength(1);
		const seed = next[0];
		if (seed === undefined) throw new Error("expected seed row");
		expect(seed.name).toMatch(/^input_/);
		expect(seed.label).toBe("");
		expect(seed.type).toBe("text");
		// Optional slots all absent at seed time.
		expect("property" in seed).toBe(false);
		expect("via" in seed).toBe(false);
		expect("mode" in seed).toBe(false);
		expect("default" in seed).toBe(false);
		expect("xpath" in seed).toBe(false);
		// Schema parses the emitted seed without modification.
		expect(() => SEARCH_INPUTS_SCHEMA.parse(next)).not.toThrow();
	});
});

// ── Empty state ───────────────────────────────────────────────────

describe("SearchInputsSection — empty state", () => {
	it("renders an empty-state hint when the list is empty", () => {
		renderEditor([]);
		expect(screen.getByText(/no search inputs/i)).toBeDefined();
	});

	it("the Add button always renders", () => {
		renderEditor([]);
		expect(
			screen.getByRole("button", { name: /add search input/i }),
		).toBeDefined();
	});
});

// ── Add / remove ─────────────────────────────────────────────────

describe("SearchInputsSection — add / remove", () => {
	it("Remove drops the row from the list", () => {
		const value: SearchInputDef[] = [
			searchInputDef("a", "A", "text"),
			searchInputDef("b", "B", "text"),
		];
		const { onChange } = renderEditor(value);
		const removeButtons = screen.getAllByRole("button", {
			name: /remove search input/i,
		});
		fireEvent.click(removeButtons[0]);
		const next = lastEmitted(onChange);
		expect(next).toHaveLength(1);
		expect(next[0]?.name).toBe("b");
	});

	it("renders one drag handle per row", () => {
		const value: SearchInputDef[] = [
			searchInputDef("a", "A", "text"),
			searchInputDef("b", "B", "text"),
			searchInputDef("c", "C", "text"),
		];
		const { container } = renderEditor(value);
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder search input"]',
		);
		expect(grips.length).toBe(3);
	});

	it("a rearranged search-input array parses cleanly through the schema", () => {
		// pragmatic-drag-and-drop's monitor flow can't be driven via
		// `fireEvent`; the shape the reorder hook would emit is the
		// rearranged plain array. The hook's splice contract is
		// exercised end-to-end by the SortKeyEditor / ColumnList tests
		// — here we just pin the shape that lands.
		const a = searchInputDef("a", "A", "text");
		const b = searchInputDef("b", "B", "text");
		const c = searchInputDef("c", "C", "text");
		const reordered = [c, a, b];
		expect(() => SEARCH_INPUTS_SCHEMA.parse(reordered)).not.toThrow();
	});
});

// ── Name validation ──────────────────────────────────────────────

describe("SearchInputsSection — name validation", () => {
	it("an empty name surfaces inline error + reports invalid", () => {
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[searchInputDef("", "Label", "text")],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/name is required/i);
	});

	it("two rows with the same name surface inline error + report invalid", () => {
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[
				searchInputDef("shared", "First", "text"),
				searchInputDef("shared", "Second", "text"),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/already used by row 1/i);
	});

	it("non-overlapping names report valid", () => {
		const onValidityChange = vi.fn();
		renderEditor(
			[searchInputDef("a", "A", "text"), searchInputDef("b", "B", "text")],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});

// ── Label validation ─────────────────────────────────────────────

describe("SearchInputsSection — label validation", () => {
	it("an empty label surfaces inline error + reports invalid", () => {
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[searchInputDef("ok_name", "", "text")],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/label is required/i);
	});

	it("a populated label reports valid", () => {
		const onValidityChange = vi.fn();
		renderEditor(
			[searchInputDef("ok_name", "Visible label", "text")],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});

// ── Type-coupling validation (per spec line 225) ─────────────────
//
// Spec language uses "warning"; per `feedback_always_in_valid_state.md`
// this implementation surfaces type-coupling mismatches as hard
// errors that flip `valid: false` (an app declaring a Date input on
// a text property is structurally meaningless and shouldn't ride
// through to wire emission).

describe("SearchInputsSection — type-coupling validation", () => {
	it("Date input declared on a text property surfaces inline error + reports invalid", () => {
		// Spec test: "a Date input declared on a text property
		// surfaces a warning" (per spec line 225). Hard-validation
		// translation: the row reports `valid: false` AND the inline
		// error renders with the type-coupling vocabulary.
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[
				searchInputDef("dob_q", "DOB", "date", {
					property: "name", // text-typed; mismatch.
				}),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/Date input is not valid for text property/i);
	});

	it("Fuzzy mode declared on an int property surfaces inline error + reports invalid", () => {
		// Mode-vs-property gate: `fuzzy` is text-shaped only.
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[
				searchInputDef("age_q", "Age", "text", {
					property: "age",
					mode: fuzzyMode(),
				}),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/Fuzzy mode is not valid for int property/i);
	});

	it("Range mode declared on a multi-select property surfaces inline error", () => {
		// `range` requires totally-ordered data types.
		const onValidityChange = vi.fn();
		const { container } = renderEditor(
			[
				searchInputDef("tags_range", "Tags range", "text", {
					property: "tags",
					mode: rangeMode(),
				}),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
		const liveRegions = container.querySelectorAll('[aria-live="polite"]');
		const allText = Array.from(liveRegions)
			.map((r) => r.textContent ?? "")
			.join("\n");
		expect(allText).toMatch(/Range mode is not valid for multi_select/i);
	});

	it("Date input declared on a date property reports valid", () => {
		// Positive — picking the right property makes the type-coupling
		// check pass and the row reports `valid: true`.
		const onValidityChange = vi.fn();
		renderEditor(
			[
				searchInputDef("dob_q", "DOB", "date", {
					property: "dob",
				}),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("type-coupling check is bypassed when xpath is present", () => {
		// xpath-override branch — the (property, mode) derivation is
		// ignored at the wire layer when `xpath` is present, so the
		// type-coupling check follows. The row reports `valid: true`
		// even with what would otherwise be a mismatch.
		const onValidityChange = vi.fn();
		renderEditor(
			[
				searchInputDef("dob_q", "DOB", "date", {
					property: "name", // would mismatch without xpath.
					xpath: matchAll(),
				}),
			],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});

// ── Type-picker gates mode picker ────────────────────────────────

describe("SearchInputsSection — type picker gates mode picker", () => {
	it("the mode picker only surfaces modes admitted by the picked type", () => {
		// `text` admits exact / fuzzy / starts-with / phonetic /
		// fuzzy-date / multi-select-contains. `barcode` admits exact
		// only. Compare the rendered menu items against each.
		const { rerender } = render(
			<SearchInputsSection
				value={[searchInputDef("a", "A", "text")]}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// Open the mode menu for the text-typed row.
		const modeTrigger = screen.getByRole("button", {
			name: /search input 1 mode:/i,
		});
		fireEvent.click(modeTrigger);
		// `text` admits 6 modes + the "Default" item = 7 total.
		// Use `queryAllByText` for the negative assertion — `getAllByText`
		// throws on zero matches; `queryAllByText` returns the empty
		// array (the contract for "expected absent").
		expect(screen.getAllByText("Fuzzy").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Phonetic").length).toBeGreaterThan(0);
		expect(screen.queryAllByText("Range").length).toBe(0);

		// Close the menu before rerendering — happy-dom keeps the
		// portal alive otherwise.
		fireEvent.keyDown(modeTrigger, { key: "Escape" });

		// Rerender with the type narrowed to `barcode` — the menu
		// content tightens.
		rerender(
			<SearchInputsSection
				value={[searchInputDef("a", "A", "barcode")]}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const barcodeModeTrigger = screen.getByRole("button", {
			name: /search input 1 mode:/i,
		});
		fireEvent.click(barcodeModeTrigger);
		// `barcode` admits `exact` only (plus the "Default" item).
		expect(screen.queryByText("Fuzzy")).toBeNull();
		expect(screen.queryByText("Phonetic")).toBeNull();
		expect(screen.queryByText("Range")).toBeNull();
	});

	it("changing type drops a no-longer-applicable mode", () => {
		// `text` + `fuzzy` is admissible. Switching to `barcode`
		// (admits only `exact`) clears the mode slot so the next
		// emission omits it; the wire layer then picks the per-type
		// default.
		const onChange = vi.fn();
		render(
			<SearchInputsSection
				value={[
					searchInputDef("a", "A", "text", {
						mode: fuzzyMode(),
					}),
				]}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// Pick `barcode` from the type menu.
		const typeTrigger = screen.getByRole("button", {
			name: /search input 1 type:/i,
		});
		fireEvent.click(typeTrigger);
		const barcodeItem = screen.getByRole("menuitem", { name: /^barcode$/i });
		fireEvent.click(barcodeItem);
		const next = lastEmitted(onChange);
		const row = next[0];
		if (row === undefined) throw new Error("expected row");
		expect(row.type).toBe("barcode");
		expect("mode" in row).toBe(false);
	});

	it("changing type preserves an applicable mode", () => {
		// Both `text` and `select` admit `multi-select-contains`;
		// switching from text → select preserves the user's
		// `multiSelectContainsMode("all")` slot.
		const onChange = vi.fn();
		render(
			<SearchInputsSection
				value={[
					searchInputDef("tags_q", "Tags", "text", {
						mode: multiSelectContainsMode("all"),
					}),
				]}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const typeTrigger = screen.getByRole("button", {
			name: /search input 1 type:/i,
		});
		fireEvent.click(typeTrigger);
		const selectItem = screen.getByRole("menuitem", { name: /^select$/i });
		fireEvent.click(selectItem);
		const next = lastEmitted(onChange);
		const row = next[0];
		if (row === undefined) throw new Error("expected row");
		expect(row.type).toBe("select");
		expect(row.mode).toEqual(multiSelectContainsMode("all"));
	});
});

// ── xpath-override branch ────────────────────────────────────────

describe("SearchInputsSection — xpath-override branch", () => {
	it("renders the override banner when xpath is present", () => {
		renderEditor([
			searchInputDef("advanced", "Advanced", "text", {
				xpath: matchAll(),
			}),
		]);
		expect(screen.getByText(/Advanced override active/i)).toBeDefined();
	});

	it("hides the property + mode pickers when xpath is present", () => {
		const { container } = renderEditor([
			searchInputDef("advanced", "Advanced", "text", {
				xpath: matchAll(),
			}),
		]);
		// The "Add property" affordance is only rendered in the
		// non-xpath branch; the property block in the xpath-present
		// branch is fully hidden.
		expect(
			container.querySelector('button[aria-label="Add property reference"]'),
		).toBeNull();
		// Same for the mode picker — the `Search input 1 mode:` button
		// is only mounted in the non-xpath branch.
		expect(
			container.querySelector('button[aria-label^="Search input 1 mode:"]'),
		).toBeNull();
	});

	it("does NOT render the override banner when xpath is absent", () => {
		renderEditor([searchInputDef("plain", "Plain", "text")]);
		expect(screen.queryByText(/Advanced override active/i)).toBeNull();
	});
});

// ── Optional slots round-trip ────────────────────────────────────

describe("SearchInputsSection — optional slots round-trip", () => {
	it("present slots round-trip through the schema verbatim", () => {
		const built: SearchInputDef[] = [
			searchInputDef("dob_range", "DOB range", "date-range", {
				property: "dob",
				mode: rangeMode(),
				default: today(),
			}),
		];
		const parsed = SEARCH_INPUTS_SCHEMA.parse(built);
		expect(parsed).toEqual(built);
	});

	it("absent slots stay absent through the schema", () => {
		const built: SearchInputDef[] = [
			searchInputDef("name_q", "Patient", "text"),
		];
		const parsed = SEARCH_INPUTS_SCHEMA.parse(built);
		expect(parsed).toEqual(built);
		// Optional slots are structurally absent.
		const row = parsed[0];
		if (row === undefined) throw new Error("expected row");
		expect("property" in row).toBe(false);
		expect("via" in row).toBe(false);
		expect("mode" in row).toBe(false);
		expect("default" in row).toBe(false);
		expect("xpath" in row).toBe(false);
	});

	it("via with an ancestor walk round-trips", () => {
		// Non-self via — preserved on the row's wire shape.
		const built: SearchInputDef[] = [
			searchInputDef("village_q", "Village", "text", {
				property: "village",
				via: ancestorPath(relationStep("parent")),
				mode: exactMode(),
			}),
		];
		const parsed = SEARCH_INPUTS_SCHEMA.parse(built);
		expect(parsed).toEqual(built);
	});

	it("default expression survives header / label edits", () => {
		// A row with an authored default expression must round-trip
		// across name / label edits without dropping the slot.
		const initial: SearchInputDef[] = [
			searchInputDef("dob_q", "DOB", "date", {
				property: "dob",
				default: today(),
			}),
		];
		const onChange = vi.fn();
		render(
			<SearchInputsSection
				value={initial}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// Trip the label input via focus → change → blur (canonical
		// BlurCommit user path; same shape as
		// CalculatedColumnEditor.test.tsx exercises).
		const labelInput = screen.getByLabelText(
			/search input 1 label/i,
		) as HTMLInputElement;
		labelInput.focus();
		fireEvent.change(labelInput, { target: { value: "Date of birth" } });
		fireEvent.blur(labelInput);
		const next = lastEmitted(onChange);
		const row = next[0];
		if (row === undefined) throw new Error("expected row");
		expect(row.label).toBe("Date of birth");
		expect(row.default).toEqual(today());
		// Schema round-trip — the emitted shape parses cleanly.
		expect(() => SEARCH_INPUTS_SCHEMA.parse(next)).not.toThrow();
	});

	it("an empty-string property is the mid-edit state — no spurious type-coupling errors fire", () => {
		// `property: ""` is the "I clicked Add property but haven't
		// picked yet" state. The `resolveProperty` helper returns
		// `undefined` for empty-string, so the type-coupling check
		// skips and the row reports `valid: true` as long as name +
		// label are non-empty. The picker chrome surfaces its own
		// "Pick a property" placeholder via `PropertyRefPicker` —
		// that's a UI signal, not a validity signal.
		const onValidityChange = vi.fn();
		renderEditor(
			[searchInputDef("dob_q", "DOB", "date", { property: "" })],
			onValidityChange,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("removeProperty preserves the via slot for re-add", () => {
		// A user with a property + relation walk who removes the
		// property keeps the walk on the row; re-adding a property
		// picks up the previously-authored walk. The schema admits
		// "via without property" — both are independent optionals —
		// so the row stays parseable across the remove.
		const onChange = vi.fn();
		const initial: SearchInputDef[] = [
			searchInputDef("village_q", "Village", "text", {
				property: "village",
				via: ancestorPath(relationStep("parent")),
			}),
		];
		render(
			<SearchInputsSection
				value={initial}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const removeBtn = screen.getByRole("button", {
			name: /remove property reference/i,
		});
		fireEvent.click(removeBtn);
		const next = lastEmitted(onChange);
		const row = next[0];
		if (row === undefined) throw new Error("expected row");
		// Property removed; via preserved verbatim.
		expect("property" in row).toBe(false);
		expect(row.via).toEqual(ancestorPath(relationStep("parent")));
		// Schema round-trip — the emitted shape stays parseable.
		expect(() => SEARCH_INPUTS_SCHEMA.parse(next)).not.toThrow();
	});
});

// ── Inner-validity propagation ───────────────────────────────────

describe("SearchInputsSection — inner-validity propagation", () => {
	it("an invalid default expression flips the editor's valid: false", async () => {
		// The `default` slot mounts `ExpressionCardEditor` which type-
		// checks the inner expression. A reference to a non-existent
		// property fails `checkValueExpression` and the inner editor's
		// `onValidityChange(false)` propagates.
		const onValidityChange = vi.fn();
		const value: SearchInputDef[] = [
			searchInputDef("name_q", "Patient", "text", {
				default: term(prop("patient", "name")),
			}),
		];
		const { rerender } = render(
			<SearchInputsSection
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		// Initial verdict — the inner expression resolves the
		// `patient.name` property, the editor reports `valid: true`.
		expect(onValidityChange).toHaveBeenLastCalledWith(true);

		// Rerender with a `caseTypes` shape that no longer declares the
		// patient case type — the inner expression's prop reference
		// becomes a type-checker error; the inner editor flips to
		// `valid: false` and the section's aggregated verdict picks
		// up the flip via the version counter + memo deps wiring.
		rerender(
			<SearchInputsSection
				value={value}
				onChange={() => {}}
				caseTypes={[{ name: "stranger", properties: [] }]}
				currentCaseType="stranger"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});
});

// ── Builder discipline ───────────────────────────────────────────

describe("SearchInputsSection — builder discipline", () => {
	it("seed row routes through searchInputDef + matches the builder shape", () => {
		const { onChange } = renderEditor([]);
		fireEvent.click(screen.getByRole("button", { name: /add search input/i }));
		const next = lastEmitted(onChange);
		const seed = next[0];
		if (seed === undefined) throw new Error("expected seed row");
		// Re-build the seed via the builder against the same name +
		// type — should be structurally equal.
		expect(seed).toEqual(searchInputDef(seed.name, "", "text"));
	});

	it("editing the label rebuilds via searchInputDef and preserves siblings", () => {
		const onChange = vi.fn();
		const value: SearchInputDef[] = [
			searchInputDef("a", "First", "text"),
			searchInputDef("b", "Second", "date", { property: "dob" }),
		];
		render(
			<SearchInputsSection
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		const firstLabel = screen.getByLabelText(
			/search input 1 label/i,
		) as HTMLInputElement;
		firstLabel.focus();
		fireEvent.change(firstLabel, { target: { value: "Renamed" } });
		fireEvent.blur(firstLabel);
		const next = lastEmitted(onChange);
		// First row's label updated; second row passed through verbatim.
		expect(next[0]?.label).toBe("Renamed");
		expect(next[1]).toEqual(value[1]);
		expect(() => SEARCH_INPUTS_SCHEMA.parse(next)).not.toThrow();
	});
});

// ── Mode + quantifier toggle ─────────────────────────────────────

describe("SearchInputsSection — multi-select-contains quantifier", () => {
	it("flipping the quantifier rebuilds the row's mode", () => {
		const onChange = vi.fn();
		render(
			<SearchInputsSection
				value={[
					searchInputDef("tags_q", "Tags", "select", {
						property: "tags",
						mode: multiSelectContainsMode("any"),
					}),
				]}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// The "All" segment of the toggle.
		const toggleGroup = screen.getByRole("group", {
			name: /multi-select quantifier/i,
		});
		const allBtn = within(toggleGroup).getByRole("button", { name: /^all$/i });
		fireEvent.click(allBtn);
		const next = lastEmitted(onChange);
		expect(next[0]?.mode).toEqual(multiSelectContainsMode("all"));
	});
});

// ── Round-trip preservation across edit ──────────────────────────

describe("SearchInputsSection — config round-trip", () => {
	it("a fully-populated config carrying every search-input shape parses through caseListConfigSchema", () => {
		const cfg: CaseListConfig = {
			columns: [],
			sort: [],
			calculatedColumns: [],
			searchInputs: [
				searchInputDef("name_q", "Name", "text", {
					property: "name",
					mode: fuzzyMode(),
				}),
				searchInputDef("dob_range", "DOB", "date-range", {
					property: "dob",
					default: today(),
				}),
				searchInputDef("village_q", "Village", "text", {
					property: "village",
					via: ancestorPath(relationStep("parent")),
				}),
				searchInputDef("advanced", "Advanced", "text", {
					xpath: matchAll(),
				}),
				searchInputDef("with_default_string", "Default", "text", {
					default: term(literal("seed")),
				}),
			],
		};
		expect(() => caseListConfigSchema.parse(cfg)).not.toThrow();
	});
});
