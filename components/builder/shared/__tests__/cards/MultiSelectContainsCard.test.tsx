// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activateWithEnter,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import type { CaseType } from "@/lib/domain";
import {
	literal,
	multiSelectAny,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../../PredicateCardEditor";

const OPTIONS = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
	{ value: "c", label: "Gamma" },
	{ value: "d", label: "Delta" },
] as const;

function caseType(
	options: readonly { value: string; label: string }[] = OPTIONS,
): CaseType {
	return {
		name: "patient",
		properties: [
			{
				name: "tags",
				label: "Tags",
				data_type: "multi_select",
				options: [...options],
			},
		],
	};
}

function seed(...values: string[]): Predicate {
	const [first = "", ...rest] = values;
	return multiSelectAny(
		prop("patient", "tags"),
		literal(first),
		...rest.map((value) => literal(value)),
	);
}

function Controlled({
	initial,
	patient = caseType(),
}: {
	readonly initial: Predicate;
	readonly patient?: CaseType;
}) {
	const [value, setValue] = useState(initial);
	return (
		<PredicateCardEditor
			value={value}
			onChange={setValue}
			caseTypes={[patient]}
			currentCaseType="patient"
		/>
	);
}

afterEach(async () => {
	cleanup();
	await settleBaseUiTransitions();
});

describe("MultiSelectContainsCard", () => {
	it("uses Nova's information vocabulary for the picker and empty state", () => {
		render(<Controlled initial={seed("")} patient={caseType([])} />);
		expect(
			screen.getByRole("button", {
				name: "Multiple-choice information: Tags",
			}),
		).toBeDefined();
		expect(
			screen.getByText("This information has no choices yet"),
		).toBeDefined();
	});

	it("keeps storage values quiet when authored labels are unique", () => {
		render(
			<Controlled
				initial={seed("vip", "new")}
				patient={caseType([
					{ value: "vip", label: "Priority client" },
					{ value: "new", label: "New client" },
				])}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Remove Priority client" }),
		).toBeDefined();
		expect(screen.queryByText("(vip)")).toBeNull();
		expect(screen.queryByText("Saved as vip")).toBeNull();
	});

	it("reveals storage values only when duplicate labels need disambiguation", () => {
		render(
			<Controlled
				initial={seed("open_a", "closed")}
				patient={caseType([
					{ value: "open_a", label: "Open" },
					{ value: "open_b", label: "Open" },
					{ value: "closed", label: "Closed" },
				])}
			/>,
		);
		expect(screen.getByText("(open_a)")).toBeDefined();
		expect(
			screen.getByRole("button", {
				name: "Remove Open, saved as open_a",
			}),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add option" }));
		expect(screen.getByText("Saved as open_b")).toBeDefined();
	});

	it("removes an invalid non-string value by its authored chip index", async () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={multiSelectAny(
					prop("patient", "tags"),
					literal(7),
					literal("a"),
				)}
				onChange={onChange}
				caseTypes={[caseType()]}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Remove 7" }));
		// Removal restores focus to the surviving chip once React commits, and
		// that chip's tooltip opens on focus.
		await settleBaseUiTransitions();

		expect(onChange).toHaveBeenLastCalledWith(seed("a"));
	});

	it("focuses the next chip after keyboard deletion", async () => {
		render(<Controlled initial={seed("a", "b", "c")} />);
		activateWithEnter(screen.getByRole("button", { name: "Remove Beta" }));
		const next = screen.getByRole("button", { name: "Remove Gamma" });
		await waitFor(() => expect(document.activeElement).toBe(next));
	});

	it("focuses the previous chip when no next chip existed", async () => {
		render(<Controlled initial={seed("a", "b", "c", "d")} />);
		activateWithEnter(screen.getByRole("button", { name: "Remove Delta" }));
		const previous = screen.getByRole("button", { name: "Remove Gamma" });
		await waitFor(() => expect(document.activeElement).toBe(previous));
	});

	it("focuses Add option when the surviving chip is no longer removable", async () => {
		render(<Controlled initial={seed("a", "b")} />);
		activateWithEnter(screen.getByRole("button", { name: "Remove Alpha" }));
		const add = screen.getByRole("button", { name: "Add option" });
		await waitFor(() => expect(document.activeElement).toBe(add));
	});
});
