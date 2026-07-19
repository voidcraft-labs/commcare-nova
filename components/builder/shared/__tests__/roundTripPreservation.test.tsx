// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/roundTripPreservation.test.tsx
//
// Round-trip preservation contract for the picker primitives.
//
// `ExpressionPicker` and `RelationPathBuilder` are mounted at every
// value / relation slot in the editor. Higher-order ValueExpression
// arms (`arith` / `if` / `count` / etc.) mount their dedicated cards
// via `ExpressionPicker`, while every RelationPath shape mounts the
// complete path builder. Both paths MUST round-trip the source AST
// verbatim: rendering the editor with any saved shape must NOT trigger
// an `onChange` that overwrites it.
//
// Without these guarantees, a saved predicate emitted by any
// caller that produces non-canonical shapes at value / relation
// slots would silently lose its content the moment a user opens
// the editor.

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	arith,
	between,
	checkPredicate,
	coalesce,
	concat,
	count,
	dateCoerce,
	dateLiteral,
	double,
	eq,
	exists,
	gt,
	isBlank,
	isIn,
	isNull,
	literal,
	match,
	multiSelectAny,
	prop,
	relationStep,
	selfPath,
	subcasePath,
	term,
	today,
	unwrapList,
	within,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../ExpressionCardEditor";
import { buildValidityIndex, PredicateEditProvider } from "../editorContext";
import { PredicateCardEditor } from "../PredicateCardEditor";
import { RelationPathBuilder } from "../primitives/RelationPathBuilder";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "name", label: "Name", data_type: "text" },
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [{ value: "vip", label: "VIP" }],
		},
		{ name: "location", label: "Home", data_type: "geopoint" },
	],
};
const VISIT: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [{ name: "kind", label: "Kind", data_type: "text" }],
};
const CASE_TYPES = [HOUSEHOLD, PATIENT, VISIT];

function renderStatefulExpression(
	initialValue: Parameters<typeof ExpressionCardEditor>[0]["value"],
	onChange: (next: Parameters<typeof ExpressionCardEditor>[0]["value"]) => void,
) {
	function Harness() {
		const [value, setValue] = useState(initialValue);
		return (
			<ExpressionCardEditor
				value={value}
				onChange={(next) => {
					onChange(next);
					setValue(next);
				}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>
		);
	}

	return render(<Harness />);
}

function renderRelationPath(
	value: Parameters<typeof RelationPathBuilder>[0]["value"],
	onChange: Parameters<typeof RelationPathBuilder>[0]["onChange"],
	options: {
		readonly origin?: string;
		readonly caseTypes?: readonly CaseType[];
		readonly allowSelf?: boolean;
	} = {},
) {
	return render(
		<PredicateEditProvider
			caseTypes={options.caseTypes ?? CASE_TYPES}
			currentCaseType={options.origin ?? "visit"}
			knownInputs={[]}
			validityIndex={buildValidityIndex([])}
		>
			<RelationPathBuilder
				value={value}
				onChange={onChange}
				allowSelf={options.allowSelf}
			/>
		</PredicateEditProvider>,
	);
}

function renderStatefulRelationPath(
	initialValue: Extract<
		Parameters<typeof RelationPathBuilder>[0]["value"],
		{ kind: "ancestor" }
	>,
	onChange: (next: Parameters<typeof RelationPathBuilder>[0]["value"]) => void,
) {
	function Harness() {
		const [value, setValue] = useState(initialValue);
		return (
			<PredicateEditProvider
				caseTypes={CASE_TYPES}
				currentCaseType="visit"
				knownInputs={[]}
				validityIndex={buildValidityIndex([])}
			>
				<RelationPathBuilder
					value={value}
					onChange={(next) => {
						onChange(next);
						if (next.kind === "ancestor") setValue(next);
					}}
				/>
			</PredicateEditProvider>
		);
	}

	return render(<Harness />);
}

/** Base UI Select requires the pointer-down that starts a real option press. */
function pressSelectOption(option: HTMLElement) {
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
}

function openRelationshipSettings(index = 0) {
	const triggers = screen.getAllByRole("button", { name: /More settings/i });
	fireEvent.click(triggers[index]);
}

function openRootExpressionKindMenu() {
	const [rootTrigger] = screen.getAllByRole("button", {
		name: "Change value type",
	});
	fireEvent.click(rootTrigger);
}

async function waitForSelectToClose() {
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

describe("ExpressionPicker — non-Term round-trip preservation", () => {
	// Higher-order ValueExpression arms (`arith`, `count`, `today`,
	// etc.) mount via their per-kind cards through the registry-
	// driven dispatch. Round-trip preservation: rendering the editor
	// with any non-Term value must NOT trigger a spurious `onChange`
	// on mount, AND the authored shape must remain reachable from
	// the saved AST without destruction. The tests below pin the
	// no-spurious-onChange half; the per-kind cards' shapes are
	// pinned by their own card tests.

	it("`arith` value round-trips without firing onChange on mount", () => {
		// `eq(prop, arith(literal, literal, "+"))` — the right side
		// is a higher-order `arith` expression. Mounting the editor
		// renders the matching ArithCard via the registry; the
		// round-trip contract is the no-spurious-onChange assertion.
		const value = eq(
			prop("patient", "age"),
			arith("+", term(literal(1)), term(literal(2))),
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// Arithmetic card label appears on the right-side expression
		// — the registry surfaced the arith arm via its dedicated
		// card rather than through the old badge.
		expect(container.textContent).toMatch(/Math/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("`count` value round-trips without firing onChange on mount", () => {
		const value = eq(prop("patient", "age"), count(subcasePath("parent")));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// Count card label appears on the right-side expression. The
		// kind is reachable from the saved AST without rewrite.
		expect(container.textContent).toMatch(/Count related/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("`today()` constant round-trips without firing onChange on mount", () => {
		const value = eq(prop("patient", "age"), today());
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// Today card surfaces a "today" or "current date" copy through
		// the inert status row.
		expect(container.textContent).toMatch(/today/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("Term-wrapped value mounts the TermCard without firing onChange", () => {
		const value = eq(prop("patient", "age"), literal(5));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// Terms render UNBOXED — no slot title; the source chip
		// ("A value") is the term's friendly visible identity.
		expect(container.textContent).toMatch(/A value/);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps a deep value untouched until an incompatible replacement is confirmed", async () => {
		const inner = arith("*", term(literal(2)), term(literal(3)));
		const value = arith("+", inner, term(literal(4)));
		const snapshot = structuredClone(value);
		const onChange = vi.fn();
		renderStatefulExpression(value, onChange);
		const [changeValueType] = screen.getAllByRole("button", {
			name: "Change value type",
		});
		if (changeValueType === undefined)
			throw new Error("Missing root value menu");

		openRootExpressionKindMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: /^First available value/i,
			}),
		);

		expect(
			await screen.findByRole("heading", {
				name: "Replace “Math” with “First available value”?",
			}),
		).toBeDefined();
		expect(screen.getByText(/current values and settings/i)).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		expect(value).toEqual(snapshot);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(changeValueType);
		});
		expect(onChange).not.toHaveBeenCalled();
		expect(value).toEqual(snapshot);

		openRootExpressionKindMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: /^First available value/i,
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(changeValueType);
		});

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0].kind).toBe("coalesce");
		expect(value).toEqual(snapshot);
	});

	it("moves focus from a replaced calculation to the new value source", async () => {
		const value = arith("+", term(literal(2)), term(literal(4)));
		const onChange = vi.fn();
		renderStatefulExpression(value, onChange);
		const [changeValueType] = screen.getAllByRole("button", {
			name: "Change value type",
		});
		if (changeValueType === undefined)
			throw new Error("Missing root value menu");

		openRootExpressionKindMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Value\b/i }));
		expect(
			await screen.findByRole("heading", {
				name: "Replace “Math” with “Value”?",
			}),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(changeValueType);
		});
		expect(onChange).not.toHaveBeenCalled();

		openRootExpressionKindMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Value\b/i }));
		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
		await waitFor(() => {
			const valueSource = screen.getByRole("button", {
				name: "Value source: A value",
			});
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(valueSource);
		});
		expect(changeValueType.isConnected).toBe(false);
		expect(onChange).toHaveBeenCalledWith(term(literal("")));
	});

	it("preserves every ordered child when Combine text becomes First available value", async () => {
		const first = arith("+", term(literal(1)), term(literal(2)));
		const second = double(term(literal("5")));
		const value = concat(first, second);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		openRootExpressionKindMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: /^First available value/i,
			}),
		);

		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0];
		expect(next).toEqual(coalesce(first, second));
		expect(next.values[0]).toBe(first);
		expect(next.values[1]).toBe(second);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("preserves a deep unary child when changing how it is read", async () => {
		const child = concat(term(literal("8")), term(literal("5")));
		const value = double(child);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		openRootExpressionKindMenu();
		const dateTarget = (await screen.findAllByRole("menuitem")).find(
			(item) =>
				item.textContent?.startsWith("Read as a date") === true &&
				item.textContent?.startsWith("Read as a date and time") === false,
		);
		if (dateTarget === undefined) throw new Error("Missing date target");
		fireEvent.click(dateTarget);

		expect(onChange).toHaveBeenCalledWith(dateCoerce(child));
		expect(onChange.mock.calls[0][0].value).toBe(child);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("asks before moving an imported date into a numeric reader", async () => {
		const child = term(dateLiteral("2025-06-15"));
		const value = dateCoerce(child);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		openRootExpressionKindMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /^Read as a number/i }),
		);

		expect(
			await screen.findByRole("heading", {
				name: "Replace “Read as a date” with “Read as a number”?",
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(value.value).toBe(child);
	});

	it("confirms a plain value becoming a calculation before replacing it", async () => {
		const value = term(literal("42"));
		const onChange = vi.fn();
		renderStatefulExpression(value, onChange);

		const valueSource = screen.getByRole("button", {
			name: "Value source: A value",
		});
		fireEvent.click(valueSource);
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Math/i }));
		expect(
			await screen.findByRole("heading", {
				name: "Use “Math” instead?",
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(valueSource);
		});
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(valueSource);
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Math/i }));
		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
		await waitFor(() => {
			const [changeValueType] = screen.getAllByRole("button", {
				name: "Change value type",
			});
			expect(changeValueType).toBeDefined();
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(changeValueType);
		});
		expect(valueSource.isConnected).toBe(false);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0].kind).toBe("arith");
		expect(value).toEqual(term(literal("42")));
	});

	it("keeps a compatible plain value without a loss confirmation", async () => {
		const value = term(literal("2025-06-15"));
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Value source: A value" }),
		);
		const dateTarget = (await screen.findAllByRole("menuitem")).find(
			(item) =>
				item.textContent?.startsWith("Read as a date") === true &&
				item.textContent?.startsWith("Read as a date and time") === false,
		);
		if (dateTarget === undefined) throw new Error("Missing date target");
		fireEvent.click(dateTarget);

		expect(onChange).toHaveBeenCalledWith(dateCoerce(value));
		expect(onChange.mock.calls[0][0].value).toBe(value);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("replaces an empty placeholder directly because no authored value is lost", async () => {
		const value = term(literal(""));
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Value source: A value" }),
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Math/i }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0].kind).toBe("arith");
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("keeps round-trip-only values editable without offering them as new targets", async () => {
		const imported = unwrapList(term(literal('["one"]')));
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={imported}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(screen.getByText("Saved selections")).toBeDefined();
		openRootExpressionKindMenu();
		const current = await screen.findByRole("menuitem", {
			name: /^Saved selections/i,
		});
		expect(current.getAttribute("aria-disabled")).toBe("true");
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("RelationPathBuilder — lossless editing surface", () => {
	it("uses connection vocabulary for directions and the saved-name setting", async () => {
		renderRelationPath(
			ancestorPath(relationStep("parent", "household")),
			vi.fn(),
			{ origin: "patient" },
		);

		expect(
			screen.getByText("Follow one or more connections upward"),
		).toBeDefined();
		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		expect(
			await screen.findByRole("option", {
				name: "Parent or ancestor Follow one or more connections upward",
			}),
		).toBeDefined();
		expect(
			screen.getByRole("option", {
				name: "Child case Follow a connection to a child case",
			}),
		).toBeDefined();
		expect(
			screen.getByRole("option", {
				name: "Any related case Follow the connection in either direction",
			}),
		).toBeDefined();
		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		await waitForSelectToClose();

		openRelationshipSettings();
		expect(
			screen.getByRole("textbox", { name: "Connection name" }),
		).toBeDefined();
		expect(
			screen.getByText(
				"Use the saved name that distinguishes this connection, such as parent or host",
			),
		).toBeDefined();
		expect(screen.queryByText(/relationship/i)).toBeNull();
	});

	it("renders every step of a multi-hop ancestor walk", () => {
		// Two-hop walk: visit → patient → household. Both relationships
		// remain visible and editable without rewriting the source path.
		const value = exists(
			ancestorPath(relationStep("parent"), relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="visit"
			/>,
		);
		expect(container.textContent).toMatch(/Visit to Patient/i);
		expect(container.textContent).toMatch(/Patient to Household/i);
		expect(
			screen.queryByRole("textbox", { name: "Connection name" }),
		).toBeNull();
		openRelationshipSettings(0);
		openRelationshipSettings(1);
		expect(screen.getAllByDisplayValue("parent")).toHaveLength(2);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders an ancestor step's case-type qualifier", () => {
		// Single-hop ancestor with a `throughCaseType` qualifier on
		// the step. The selected value is visible without any mount edit.
		const value = exists(ancestorPath(relationStep("parent", "household")));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/household/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders an editable `any-relation` walk", () => {
		const value = exists(anyRelationPath("parent"));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Any related case/i);
		openRelationshipSettings();
		expect(screen.getByDisplayValue("parent")).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders an editable qualified subcase walk", () => {
		// `subcasePath("parent", "visit")` — `ofCaseType` qualifier
		// remains present in the child-case editor.
		const value = exists(subcasePath("parent", "visit"));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Child case/i);
		expect(container.textContent).toMatch(/visit/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders the editing surface for a canonical single-step ancestor walk", () => {
		const value = exists(ancestorPath(relationStep("parent")));
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		openRelationshipSettings();
		expect(screen.getByDisplayValue("parent")).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("stages a link name until blur and commits a valid edit once", () => {
		const value = ancestorPath(
			relationStep("parent", "patient"),
			relationStep("parent", "household"),
		);
		const onChange = vi.fn();
		renderRelationPath(value, onChange);
		openRelationshipSettings(1);

		const input = screen.getByRole("textbox", {
			name: "Connection name",
		});
		fireEvent.change(input, { target: { value: "host_link" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(
			ancestorPath(
				relationStep("parent", "patient"),
				relationStep("host_link", "household"),
			),
		);
	});

	it("keeps an invalid link-name draft local and explains how to fix it", () => {
		const onChange = vi.fn();
		renderRelationPath(
			ancestorPath(relationStep("parent", "patient")),
			onChange,
		);
		openRelationshipSettings();

		const input = screen.getByRole("textbox", {
			name: "Connection name",
		});
		fireEvent.change(input, { target: { value: "parent-link" } });
		expect(screen.getByRole("alert").textContent).toMatch(
			/letters, numbers, and underscores/i,
		);
		fireEvent.blur(input);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "guardian_link" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(
			ancestorPath(relationStep("guardian_link", "patient")),
		);
	});

	it("offers only the actual parent type and keeps an old value readable", async () => {
		const onChange = vi.fn();
		renderRelationPath(
			ancestorPath(relationStep("parent", "household")),
			onChange,
		);

		const trigger = screen.getByRole("combobox", {
			name: "Related case type",
		});
		expect(trigger.textContent).toMatch(/Household is unavailable/i);
		fireEvent.click(trigger);
		expect(
			(
				await screen.findByRole("option", { name: /Household.*Unavailable/i })
			).getAttribute("aria-disabled"),
		).toBe("true");
		expect(screen.queryByRole("option", { name: "Visit" })).toBeNull();
		pressSelectOption(screen.getByRole("option", { name: "Patient" }));
		await waitForSelectToClose();

		expect(onChange).toHaveBeenCalledWith(
			ancestorPath(relationStep("parent", "patient")),
		);
	});

	it("offers only direct child case types and requires a choice when several exist", async () => {
		const labResult: CaseType = {
			name: "lab_result",
			parent_type: "patient",
			properties: [],
		};
		const onChange = vi.fn();
		renderRelationPath(subcasePath("parent", "household"), onChange, {
			origin: "patient",
			caseTypes: [...CASE_TYPES, labResult],
		});

		const trigger = screen.getByRole("combobox", { name: "Child case type" });
		expect(trigger.textContent).toMatch(/Household is unavailable/i);
		fireEvent.click(trigger);
		expect(screen.getByRole("option", { name: "Visit" })).toBeDefined();
		expect(screen.getByRole("option", { name: "Lab result" })).toBeDefined();
		expect(screen.queryByRole("option", { name: "Patient" })).toBeNull();
		pressSelectOption(screen.getByRole("option", { name: "Lab result" }));
		await waitForSelectToClose();

		expect(onChange).toHaveBeenCalledWith(subcasePath("parent", "lab_result"));
	});

	it("keeps either-direction available when the case has a parent", async () => {
		renderRelationPath(
			ancestorPath(relationStep("parent", "patient")),
			vi.fn(),
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		expect(
			(await screen.findByRole("option", { name: /^Child case/ })).getAttribute(
				"aria-disabled",
			),
		).toBeNull();
		expect(
			screen
				.getByRole("option", { name: /^Any related case/ })
				.getAttribute("aria-disabled"),
		).toBeNull();
		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		await waitForSelectToClose();
	});

	it("creates a complete custom child connection from a graph leaf in one commit", async () => {
		const onChange = vi.fn();
		renderRelationPath(
			ancestorPath(relationStep("parent", "patient")),
			onChange,
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		pressSelectOption(
			await screen.findByRole("option", { name: /^Child case/ }),
		);
		await waitForSelectToClose();
		expect(
			screen.getByRole("heading", { name: "Use a saved connection" }),
		).toBeDefined();
		expect(
			screen.getByRole("dialog", { name: "Use a saved connection" }),
		).toBeDefined();
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(screen.getByRole("textbox", { name: "Connection name" }), {
			target: { value: "guardian_link" },
		});
		fireEvent.click(
			screen.getByRole("combobox", { name: "Related case type" }),
		);
		pressSelectOption(await screen.findByRole("option", { name: "Household" }));
		await waitForSelectToClose();
		fireEvent.click(screen.getByRole("button", { name: "Use connection" }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(
			subcasePath("guardian_link", "household"),
		);
	});

	it("adds another parent only when the catalog has one", () => {
		const onChange = vi.fn();
		const { unmount } = renderRelationPath(
			ancestorPath(relationStep("parent", "patient")),
			onChange,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add another parent" }));
		expect(onChange).toHaveBeenCalledWith(
			ancestorPath(relationStep("parent", "patient"), relationStep("parent")),
		);
		unmount();

		renderRelationPath(
			ancestorPath(relationStep("parent", "household")),
			vi.fn(),
			{ origin: "patient" },
		);
		expect(
			screen.queryByRole("button", { name: "Add another parent" }),
		).toBeNull();
	});

	it("preserves a custom connection's explicit destination when an earlier step is removed", () => {
		const onChange = vi.fn();
		renderRelationPath(
			ancestorPath(
				relationStep("guardian", "patient"),
				relationStep("host", "household"),
			),
			onChange,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove connection from Visit to Patient",
			}),
		);
		expect(onChange).toHaveBeenCalledWith(
			ancestorPath(relationStep("host", "household")),
		);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("names a changed destination before removing an ancestor connection", async () => {
		const onChange = vi.fn();
		renderRelationPath(
			ancestorPath(
				relationStep("parent", "patient"),
				relationStep("parent", "household"),
			),
			onChange,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove connection from Visit to Patient",
			}),
		);
		await screen.findByRole("alertdialog");
		expect(
			screen.getByRole("heading", {
				name: "Remove this connection?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(
				/A remaining connection will lead to Patient instead of Household\. The remaining connections will update automatically\./,
			),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
		expect(onChange).toHaveBeenCalledWith(
			ancestorPath(relationStep("parent", "patient")),
		);
	});

	it("restores focus to the connection that takes a removed step's place", async () => {
		const onChange = vi.fn();
		renderStatefulRelationPath(
			ancestorPath(
				relationStep("guardian", "patient"),
				relationStep("host", "household"),
			),
			onChange,
		);
		openRelationshipSettings(0);

		const remove = screen.getByRole("button", {
			name: "Remove connection from Visit to Patient",
		});
		remove.focus();
		fireEvent.click(remove);

		await waitFor(() => {
			const survivingName = screen.getByRole("textbox", {
				name: "Connection name",
			});
			expect((survivingName as HTMLInputElement).value).toBe("host");
			expect(document.activeElement).toBe(survivingName);
		});
	});

	it("cancels or confirms replacing every step of an imported connection and restores focus", async () => {
		const value = ancestorPath(
			relationStep("guardian", "patient"),
			relationStep("host", "household"),
		);
		const snapshot = structuredClone(value);
		const onChange = vi.fn();
		renderRelationPath(value, onChange);

		const kindTrigger = screen.getByRole("combobox", { name: "Where to look" });
		fireEvent.click(kindTrigger);
		pressSelectOption(
			await screen.findByRole("option", { name: /^This case/ }),
		);
		await waitForSelectToClose();

		expect(
			await screen.findByRole("heading", {
				name: "Use information from this case?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(/2 parent connections will be removed/),
		).toBeDefined();
		expect(screen.getByRole("alertdialog").textContent).not.toMatch(
			/step|path|case-type choice/i,
		);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(kindTrigger));
		expect(onChange).not.toHaveBeenCalled();
		expect(value).toEqual(snapshot);

		fireEvent.click(kindTrigger);
		pressSelectOption(
			await screen.findByRole("option", { name: /^This case/ }),
		);
		await waitForSelectToClose();
		fireEvent.click(
			await screen.findByRole("button", { name: "Replace connection" }),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(kindTrigger));
		expect(onChange).toHaveBeenCalledWith(selfPath());
		expect(value).toEqual(snapshot);
	});

	it("preserves the name and case type between child connection directions", async () => {
		const value = subcasePath("host", "visit");
		const onChange = vi.fn();
		renderRelationPath(value, onChange, { origin: "patient" });

		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		pressSelectOption(
			await screen.findByRole("option", { name: /^Any related case/ }),
		);
		await waitForSelectToClose();

		expect(onChange).toHaveBeenCalledWith(anyRelationPath("host", "visit"));
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("confirms before replacing an either-direction parent target with a child", async () => {
		const onChange = vi.fn();
		renderRelationPath(anyRelationPath("parent", "household"), onChange, {
			origin: "patient",
		});

		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		pressSelectOption(
			await screen.findByRole("option", { name: /^Child case/ }),
		);
		await waitForSelectToClose();
		expect(
			screen.getByRole("heading", {
				name: "Look at a child case instead?",
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Replace connection" }));
		expect(onChange).toHaveBeenCalledWith(subcasePath("parent", "visit"));
	});

	it("keeps an either-direction child target when narrowing to child only", async () => {
		const onChange = vi.fn();
		renderRelationPath(anyRelationPath("host", "visit"), onChange, {
			origin: "patient",
		});

		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		pressSelectOption(
			await screen.findByRole("option", { name: /^Child case/ }),
		);
		await waitForSelectToClose();
		expect(onChange).toHaveBeenCalledWith(subcasePath("host", "visit"));
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("switches to a valid child destination without changing the nested filter", async () => {
		const where = eq(literal("north"), literal("north"));
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={exists(ancestorPath(relationStep("parent", "household")), where)}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Where to look" }));
		pressSelectOption(
			await screen.findByRole("option", { name: /^Child case/ }),
		);
		await waitForSelectToClose();
		expect(
			screen.getByRole("heading", {
				name: "Look at a child case instead?",
			}),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Replace connection" }));
		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		const next = onChange.mock.calls[0][0];
		// Store the currently resolved child explicitly even when there is only
		// one. Adding a second child case type later must not make this saved
		// connection ambiguous.
		expect(next.via).toEqual(subcasePath("parent", "visit"));
		expect(next.where).toBe(where);
		expect(
			checkPredicate(next, {
				caseTypes: CASE_TYPES,
				knownInputs: [],
				currentCaseType: "patient",
			}).ok,
		).toBe(true);
	});
});

describe("ExpressionPicker — exhaustive left-subject editing", () => {
	// Every Predicate operator with a `left: ValueExpression` slot
	// must round-trip non-Term values without destruction and mount
	// the real expression card. A calculated subject is editable in
	// place; it never collapses to a read-only replacement badge.
	//
	// The five surfaces: `compare` (ComparisonCard) / `in` (InCard) /
	// `between` (BetweenCard) / `is-null` (IsNullCard) / `is-blank`
	// (IsBlankCard).

	const NON_TERM_LEFT = arith("+", term(literal(1)), term(literal(2)));

	it("ComparisonCard preserves a non-Term left", () => {
		// Construct via parse rather than the typed builders because
		// `gt` requires ordered operands at type-check time and the
		// builder type narrowing rejects `left: arith(...)` shapes
		// directly. The runtime builder accepts the wider shape; we
		// reach it via the typed builder with a cast for the test.
		const value = gt(NON_TERM_LEFT, term(literal(18)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Math/i);
		expect(
			screen.getByRole("button", { name: "Change value type" }),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("InCard preserves a non-Term left", () => {
		const value = isIn(NON_TERM_LEFT, literal(1), literal(2), literal(3));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Math/i);
		expect(
			screen.getByRole("button", { name: "Change value type" }),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("InCard moves focus to the next value's remove action after deletion", async () => {
		const initial = isIn(
			prop("patient", "age"),
			literal(1),
			literal(2),
			literal(3),
		);
		function Harness() {
			const [value, setValue] = useState(initial);
			return (
				<PredicateCardEditor
					value={value}
					onChange={(next) => {
						if (next.kind === "in") setValue(next);
					}}
					caseTypes={CASE_TYPES}
					currentCaseType="patient"
				/>
			);
		}
		render(<Harness />);

		const removeActions = screen.getAllByRole("button", {
			name: "Remove value",
		});
		const nextAction = removeActions[1];
		removeActions[0].focus();
		await act(async () => {
			fireEvent.click(removeActions[0]);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(document.activeElement).toBe(nextAction);
		expect(
			screen.getAllByRole("button", { name: "Remove value" }),
		).toHaveLength(2);
	});

	it("BetweenCard preserves a non-Term left", () => {
		const value = between(NON_TERM_LEFT, {
			lower: literal(0),
			upper: literal(100),
		});
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Math/i);
		expect(
			screen.getByRole("button", { name: "Change value type" }),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("IsNullCard preserves a non-Term left", () => {
		const value = isNull(NON_TERM_LEFT);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Math/i);
		expect(
			screen.getByRole("button", { name: "Change value type" }),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("IsBlankCard preserves a non-Term left", () => {
		const value = isBlank(NON_TERM_LEFT);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Math/i);
		expect(
			screen.getByRole("button", { name: "Change value type" }),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("absence checks reject a direct value but allow a calculation", async () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={isBlank(prop("patient", "name"))}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Condition source: Case information",
			}),
		);
		const literal = await screen.findByRole("menuitem", { name: /^A value/i });
		expect(literal.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Math/i }));
		expect(
			await screen.findByRole("heading", {
				name: "Use “Math” instead?",
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));

		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		const next = onChange.mock.calls[0]?.[0] as ReturnType<typeof isBlank>;
		expect(next.left.kind).toBe("arith");
		expect(
			checkPredicate(next, {
				caseTypes: CASE_TYPES,
				knownInputs: [],
				currentCaseType: "patient",
			}).ok,
		).toBe(true);
	});
});

describe("PropertyRefPicker — `prop.via` round-trip preservation", () => {
	// Every property editor (ExpressionPicker's property Term arm +
	// property-only slots) must
	// round-trip a `prop` Term carrying a non-self `via:
	// RelationPath` walk verbatim. The schema admits `via` as
	// optional on `propertyRefSchema`; rebuilding via two-arg
	// `prop(caseType, name)` after the user picks a property
	// would silently drop the walk. The picker exposes the complete
	// walk under Uses information from and never rewrites it on mount.
	//
	// Eight surfaces total — five subject cards + three
	// property-only cards.

	const VIA = ancestorPath(relationStep("parent"));

	function expectEditableRelation(
		container: HTMLElement,
		onChange: ReturnType<typeof vi.fn>,
	) {
		const readFrom = screen.getByRole("button", {
			name: /Uses information from Parent case: Household/i,
		});
		expect(readFrom.textContent).not.toMatch(/through/i);
		expect(container.textContent).not.toMatch(/Connection name/i);
		openRelationshipSettings();
		expect(container.textContent).toMatch(/Connection name/i);
		expect(onChange).not.toHaveBeenCalled();
	}

	it("leads with the parent destination and keeps the default relationship name in More settings", () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={isBlank(term(prop("patient", "region", VIA)))}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const readFrom = screen.getByRole("button", {
			name: /Uses information from Parent case: Household/i,
		});
		expect(readFrom.textContent).not.toMatch(/through|saved connection name/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps an explicitly typed imported relationship name behind More settings", () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={isBlank(
					term(
						prop(
							"patient",
							"region",
							ancestorPath(relationStep("guardian_link", "household")),
						),
					),
				)}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		const readFrom = screen.getByRole("button", {
			name: /Uses information from Parent case: Household/i,
		});
		expect(readFrom.textContent).not.toMatch(/guardian|through/i);
		openRelationshipSettings();
		expect(
			(screen.getByLabelText("Connection name") as HTMLInputElement).value,
		).toBe("guardian_link");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("uses the summary to explain an ambiguous imported child path", () => {
		const labResult: CaseType = {
			name: "lab_result",
			parent_type: "patient",
			properties: [{ name: "kind", label: "Kind", data_type: "text" }],
		};
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={isBlank(term(prop("patient", "kind", subcasePath("care_link"))))}
				onChange={onChange}
				caseTypes={[...CASE_TYPES, labResult]}
				currentCaseType="patient"
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: /Uses information from Child case Choose a child case type · Saved connection: Care link/i,
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	// ── ValueExpression subject cards (5) ───────────────────────────

	it("ComparisonCard preserves and exposes prop.via on render", () => {
		const value = gt(term(prop("patient", "age", VIA)), term(literal(18)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});

	it("InCard preserves and exposes prop.via on render", () => {
		const value = isIn(
			term(prop("patient", "age", VIA)),
			literal(1),
			literal(2),
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});

	it("BetweenCard preserves and exposes prop.via on render", () => {
		const value = between(term(prop("patient", "age", VIA)), {
			lower: literal(0),
			upper: literal(100),
		});
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});

	it("IsNullCard preserves and exposes prop.via on render", () => {
		const value = isNull(term(prop("patient", "age", VIA)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});

	it("IsBlankCard preserves and exposes prop.via on render", () => {
		const value = isBlank(term(prop("patient", "age", VIA)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});

	// ── Property-only cards (3) ─────────────────────────────────────

	it("MatchCard preserves and exposes prop.via on render", () => {
		const value = match(
			prop("patient", "name", VIA),
			term(literal("alice")),
			"fuzzy",
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});

	it("MultiSelectContainsCard preserves and exposes prop.via on render", () => {
		const value = multiSelectAny(prop("patient", "tags", VIA), literal("vip"));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});

	it("WithinDistanceCard preserves and exposes prop.via on render", () => {
		const value = within(
			prop("patient", "location", VIA),
			term(literal("0 0")),
			1,
			"miles",
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expectEditableRelation(container, onChange);
	});
});

describe('PropertyRefPicker — `via.kind === "self"` is canonical', () => {
	// `selfPath()` is semantically equivalent to "no walk" — the
	// `isCanonicalPropertyRef` guard accepts both `via === undefined`
	// AND `via.kind === "self"` as canonical shapes that round-trip
	// through the editing surface (no badge). One test per mode
	// pins the symmetry: the editing surface renders, and picking a
	// different property name preserves `via.kind === "self"` in the
	// emitted result rather than dropping or rebadging it.

	const SELF_VIA = selfPath();

	it("keeps the ordinary current-case source out of the default path and reveals it from the information menu", async () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={isBlank(term(prop("patient", "name")))}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		expect(
			screen.queryByRole("button", {
				name: /Uses information from This case/i,
			}),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Choose another case" }),
		).toBeNull();
		expect(
			screen.queryByRole("combobox", { name: "Where to look" }),
		).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: /^Case information:/i }),
		);
		const useAnotherCase = await screen.findByRole("menuitem", {
			name: /^Use information from another case/i,
		});
		// Happy DOM does not synthesize a native click from Enter. Dispatch the
		// keyboard sequence plus its zero-detail activation so the Base UI item
		// follows the same path as a real keyboard selection.
		useAnotherCase.focus();
		fireEvent.keyDown(useAnotherCase, { key: "Enter", code: "Enter" });
		fireEvent.click(useAnotherCase, { detail: 0 });
		fireEvent.keyUp(useAnotherCase, { key: "Enter", code: "Enter" });

		expect(
			screen.getByRole("combobox", { name: "Where to look" }),
		).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: /Uses information from This case/i,
			}),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("a ValueExpression subject renders the editing surface for prop with via=self", async () => {
		// IsBlankCard exercises ExpressionPicker's property Term arm.
		const value = isBlank(term(prop("patient", "name", SELF_VIA)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// No badge — the canonical guard accepted via=self.
		expect(container.textContent).not.toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		// Picking a different property must preserve via=self verbatim.
		// The picker rebuilds via `prop(caseType, name, via)` (three-arg
		// form) so the via slot survives the edit.
		const propertyTrigger = screen.getByRole("button", {
			name: /^Case information:/i,
		});
		fireEvent.click(propertyTrigger);
		// `findBy` (not `getBy`) so the menu's open transition settles
		// inside `act` before we read the option: Base UI's
		// `FloatingFocusManager` schedules an initial-focus `queueMicrotask`
		// on open, and a synchronous `getBy` would leave that microtask
		// undrained at test end (flagged under `--detectAsyncLeaks`).
		const ageOption = await screen.findByRole("menuitem", { name: /^age/i });
		fireEvent.click(ageOption);
		// `waitFor` so the menu's close transition settles inside `act`:
		// selecting an option closes the menu, and Base UI's focus manager
		// schedules a focus-restore `setTimeout` on close that a synchronous
		// assertion would leave undrained (flagged under `--detectAsyncLeaks`).
		await waitFor(() => {
			expect(onChange).toHaveBeenCalledTimes(1);
		});
		const next = onChange.mock.calls[0][0] as {
			left: {
				term: { kind: string; property: string; via?: { kind: string } };
			};
		};
		expect(next.left.term.kind).toBe("prop");
		expect(next.left.term.property).toBe("age");
		expect(next.left.term.via?.kind).toBe("self");
	});

	it("property-only mode renders the editing surface for prop with via=self", async () => {
		// MatchCard exercises the property-only mode. Same canonical
		// contract: via=self is editable in place, and the via slot
		// survives a property name change.
		const value = match(
			prop("patient", "name", SELF_VIA),
			term(literal("alice")),
			"fuzzy",
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).not.toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		// Pick the dropdown trigger by its accessible label
		// ("Case information: <current>"). The match card filters its picker
		// to text-shaped properties; `name` is text-shaped so the
		// picker accepts it.
		const propertyTrigger = screen.getByRole("button", {
			name: /^Case information:/i,
		});
		fireEvent.click(propertyTrigger);
		// `findBy` settles the menu-open `queueMicrotask` Base UI's
		// `FloatingFocusManager` schedules for initial focus (see the
		// LEFT-slot test above for the leak rationale).
		const tagsOption = await screen.findByRole("menuitem", { name: /^tags/i });
		fireEvent.click(tagsOption);
		// `waitFor` settles the menu-close focus-restore `setTimeout` (see
		// the LEFT-slot test above for the leak rationale).
		await waitFor(() => {
			expect(onChange).toHaveBeenCalledTimes(1);
		});
		const next = onChange.mock.calls[0][0] as {
			property: { kind: string; property: string; via?: { kind: string } };
		};
		expect(next.property.kind).toBe("prop");
		expect(next.property.property).toBe("tags");
		expect(next.property.via?.kind).toBe("self");
	});
});
