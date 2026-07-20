// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	eq,
	input,
	literal,
	type Predicate,
	prop,
	whenInput,
} from "@/lib/domain/predicate";
import { PredicateWorkbench } from "../PredicateWorkbench";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [{ name: "region", label: "Region", data_type: "text" }],
	},
];

const NORTH = eq(prop("patient", "region"), literal("North"));

function ControlledWorkbench({ initial }: { readonly initial: Predicate }) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<output data-testid="saved-condition">{JSON.stringify(value)}</output>
			<PredicateWorkbench
				value={value}
				onChange={setValue}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={[
					{ name: "query", label: "Client search", data_type: "text" },
				]}
			/>
		</>
	);
}

function savedCondition(): Predicate {
	return JSON.parse(
		screen.getByTestId("saved-condition").textContent ?? "null",
	);
}

async function chooseSpecialCondition(
	trigger: HTMLElement,
	label: "Always match" | "Never match",
): Promise<HTMLElement> {
	fireEvent.click(trigger);
	expect(await screen.findByText("Special conditions")).toBeDefined();
	// Recursive structure is composed through the workbench. This existing
	// sentence menu only gains the two whole-condition outcomes.
	expect(
		screen.queryByRole("menuitem", { name: /^All conditions match/ }),
	).toBeNull();
	expect(screen.queryByRole("menuitem", { name: /^Exclude when/ })).toBeNull();
	const option = await screen.findByRole("menuitem", {
		name: new RegExp(`^${label}`),
	});
	fireEvent.click(option);
	return screen.findByRole("alertdialog");
}

afterEach(async () => {
	cleanup();
	// Base UI releases menu focus and scroll locks on the next macrotask.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

describe("PredicateWorkbench special-condition authoring", () => {
	it.each([
		["Always match", "match-all"],
		["Never match", "match-none"],
	] as const)(
		"replaces a root comparison with %s after consequence confirmation",
		async (label, expectedKind) => {
			render(<ControlledWorkbench initial={NORTH} />);
			const originalTrigger = screen.getByRole("button", {
				name: "Condition is",
			});

			let dialog = await chooseSpecialCondition(originalTrigger, label);
			expect(savedCondition().kind).toBe("eq");
			fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
			await waitFor(() => {
				expect(screen.queryByRole("alertdialog")).toBeNull();
				expect(document.activeElement).toBe(originalTrigger);
			});
			expect(savedCondition().kind).toBe("eq");

			dialog = await chooseSpecialCondition(originalTrigger, label);
			fireEvent.click(
				within(dialog).getByRole("button", { name: "Change condition" }),
			);

			await waitFor(() => {
				expect(savedCondition().kind).toBe(expectedKind);
				expect(screen.queryByRole("alertdialog")).toBeNull();
			});
			const replacementTrigger = screen.getByRole("button", {
				name: `Condition ${label}`,
			});
			await waitFor(() =>
				expect(document.activeElement).toBe(replacementTrigger),
			);
		},
	);

	it("authors a special condition inside a recursive wrapper", async () => {
		render(<ControlledWorkbench initial={whenInput(input("query"), NORTH)} />);
		const originalTrigger = screen.getByRole("button", {
			name: "Condition is",
		});
		const dialog = await chooseSpecialCondition(originalTrigger, "Never match");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Change condition" }),
		);

		await waitFor(() => {
			expect(savedCondition()).toMatchObject({
				kind: "when-input-present",
				clause: { kind: "match-none" },
			});
		});
		const replacementTrigger = screen.getByRole("button", {
			name: "Condition Never match",
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(replacementTrigger),
		);
	});
});
