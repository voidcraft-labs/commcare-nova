// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/ComparisonCard.test.tsx
//
// LEGACY-DISPLAY test for the comparison card. The editor is now valid
// by construction — no sequence of picker choices can author a
// type-mismatched comparison (the right slot offers only types
// compatible with the subject). These cases therefore seed a
// pre-existing (legacy / hypothetical) invalid AST DIRECTLY and assert
// the display backstop still renders it AND surfaces the rose inline
// error — a saved-but-broken predicate a user opens must still show its
// problem, even though the editor would never let them create it.
//
// Pins the validity-index path lookup contract — operand-level errors
// (`["left"]`, `["right"]`) land next to the matching input;
// operator-level errors (`[]`, e.g. "ordered-types violation") land at
// the card shell's footer. Mounts through the full `PredicateCardEditor`
// so the validity index is the real one produced by `checkPredicate`.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	checkPredicate,
	eq,
	gt,
	input,
	literal,
	type Predicate,
	predicateSchema,
	prop,
	sessionContext,
	sessionUser,
} from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../../PredicateCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "name", label: "Name", data_type: "text" },
	],
};

describe("ComparisonCard — inline errors", () => {
	it("renders no error rows for a well-typed comparison", () => {
		const value = eq(prop("patient", "name"), literal("Alice"));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// No `aria-invalid` markers and no error-styled chrome.
		expect(container.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
	});

	it("renders inline error chrome for a legacy type-mismatched comparison", () => {
		// `gt(int, "string")` — a pre-existing invalid AST the editor
		// can't author (the right slot only offers int-compatible
		// values). The type checker rejects via the "not comparable"
		// rule; the display backstop surfaces it inline so a user
		// opening the saved predicate still sees the problem.
		const value = gt(prop("patient", "age"), literal("not-an-int"));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// At least one element gets the error border treatment via
		// the `border-nova-rose` accent the CardShell applies for
		// operator-level errors. The CSS class is the structural
		// signal here.
		const errorClassed = container.querySelector(".border-nova-rose\\/35");
		expect(errorClassed).not.toBeNull();
	});

	it("renders an error message for an unknown property", () => {
		const value = eq(prop("patient", "DOES_NOT_EXIST"), literal("x"));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// The editor translates checker detail into a stable, friendly
		// next action under the offending input.
		expect(container.textContent).toMatch(/Choose available case information/i);
	});
});

describe("ComparisonCard — exhaustive subject authoring", () => {
	const ctx = {
		caseTypes: [PATIENT],
		currentCaseType: "patient",
		knownInputs: [
			{ name: "name_search", data_type: "text" as const },
			{ name: "minimum_age", data_type: "int" as const },
		],
	};

	function renderEditor(value: Predicate, onChange = vi.fn()) {
		render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={ctx.caseTypes}
				currentCaseType={ctx.currentCaseType}
				knownInputs={ctx.knownInputs}
			/>,
		);
		return onChange;
	}

	it("keeps the common property subject compact", () => {
		renderEditor(eq(prop("patient", "name"), literal("Alice")));

		expect(
			screen.getByRole("button", {
				name: "Condition source: Case information",
			}),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: /^Case information: Case name/i }),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /Replace .* expression/i }),
		).toBeNull();
	});

	it("authors a search answer as the subject and stays valid", async () => {
		const onChange = renderEditor(
			eq(prop("patient", "name"), literal("Alice")),
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Condition source: Case information",
			}),
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /A search answer/i }),
		);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));

		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		const next = onChange.mock.calls[0]?.[0] as Predicate;
		expect(next.kind).toBe("eq");
		if (next.kind !== "eq") throw new Error("Expected an equality predicate");
		expect(next.left).toEqual({ kind: "term", term: input("name_search") });
		expect(checkPredicate(next, ctx).ok).toBe(true);
	});

	it("authors app information as the subject and stays valid", async () => {
		const onChange = renderEditor(
			eq(prop("patient", "name"), literal("Alice")),
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Condition source: Case information",
			}),
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /App information/i }),
		);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));

		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		const next = onChange.mock.calls[0]?.[0] as Predicate;
		expect(next.kind).toBe("eq");
		if (next.kind !== "eq") throw new Error("Expected an equality predicate");
		expect(next.left).toEqual({
			kind: "term",
			term: { kind: "session-context", field: "userid" },
		});
		expect(checkPredicate(next, ctx).ok).toBe(true);
	});

	it("collects a schema-valid user field before replacing case information", async () => {
		const onChange = renderEditor(
			eq(prop("patient", "name"), literal("Alice")),
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Condition source: Case information",
			}),
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /User information/i }),
		);

		const replace = screen.getByRole("button", { name: "Replace" });
		const field = screen.getByRole("textbox", { name: "User field name" });
		expect((replace as HTMLButtonElement).disabled).toBe(true);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(field, { target: { value: "bad field" } });
		expect((replace as HTMLButtonElement).disabled).toBe(true);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(field, { target: { value: "assigned_region" } });
		expect((replace as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(replace);

		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		const next = onChange.mock.calls[0]?.[0] as Predicate;
		expect(next.kind).toBe("eq");
		if (next.kind !== "eq") throw new Error("Expected an equality predicate");
		expect(next.left).toEqual({
			kind: "term",
			term: sessionUser("assigned_region"),
		});
		expect(predicateSchema.safeParse(next).success).toBe(true);
		expect(checkPredicate(next, ctx).ok).toBe(true);
	});

	it("names app information in familiar, specific language", async () => {
		renderEditor(eq(sessionContext("userid"), literal("worker-1")));

		expect(
			screen.getByRole("button", {
				name: "Condition source: App information",
			}),
		).toBeDefined();
		const fieldMenu = screen.getByRole("button", {
			name: "App information: Current user's ID",
		});
		fireEvent.click(fieldMenu);

		const userNameItem = await screen.findByRole("menuitem", {
			name: "Current user's name",
		});
		expect(userNameItem.className).toContain("rounded-lg");
		expect(
			userNameItem.closest('[data-slot="dropdown-menu-popup"]')?.className,
		).toContain("p-1");
		expect(
			screen.getByRole("menuitem", { name: "This device's ID" }),
		).toBeDefined();
	});

	it("authors a calculated numeric subject as a full expression", async () => {
		const onChange = renderEditor(gt(prop("patient", "age"), literal(18)));

		fireEvent.click(
			screen.getByRole("button", {
				name: "Condition source: Case information",
			}),
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Math/i }));
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));

		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		const next = onChange.mock.calls[0]?.[0] as Predicate;
		expect(next.kind).toBe("gt");
		if (next.kind !== "gt")
			throw new Error("Expected a greater-than predicate");
		expect(next.left.kind).toBe("arith");
		expect(checkPredicate(next, ctx).ok).toBe(true);
	});
});
