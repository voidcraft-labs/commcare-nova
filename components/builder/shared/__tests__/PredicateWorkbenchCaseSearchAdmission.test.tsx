// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { arith, eq, literal, prop, term } from "@/lib/domain/predicate";
import { PredicateWorkbench } from "../PredicateWorkbench";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "age", label: "Age", data_type: "int" },
			{ name: "score", label: "Score", data_type: "int" },
		],
	},
];

afterEach(async () => {
	cleanup();
	// Base UI releases menu focus and scroll locks on the next macrotask.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

function renderWorkbench({
	value = eq(prop("patient", "age"), literal(18)),
	target = "case-search",
}: {
	readonly value?: Parameters<typeof PredicateWorkbench>[0]["value"];
	readonly target?: Parameters<
		typeof PredicateWorkbench
	>[0]["evaluationTarget"];
} = {}) {
	render(
		<PredicateWorkbench
			value={value}
			onChange={() => {}}
			caseTypes={CASE_TYPES}
			currentCaseType="patient"
			evaluationTarget={target}
		/>,
	);
}

function openValueSource(button: HTMLElement): HTMLElement {
	fireEvent.click(button);
	return screen.getByRole("menuitem", {
		name: /^Other case information/,
	});
}

describe("PredicateWorkbench case-search admission", () => {
	it("explains and disables a second case-information source before it reaches the gate", () => {
		renderWorkbench();

		const otherCaseInformation = openValueSource(
			screen.getByRole("button", { name: "Value source: A value" }),
		);

		expect(otherCaseInformation.getAttribute("aria-disabled")).toBe("true");
		expect(otherCaseInformation.textContent).toContain(
			"This condition already uses case information",
		);
		expect(otherCaseInformation.textContent).not.toMatch(/CSQL|server query/i);
	});

	it("keeps the same property-to-property choice available for an on-device rule", () => {
		renderWorkbench({ target: "on-device" });

		const otherCaseInformation = openValueSource(
			screen.getByRole("button", { name: "Value source: A value" }),
		);

		expect(otherCaseInformation.getAttribute("aria-disabled")).not.toBe("true");
	});

	it("catches a case-information source nested inside a calculation", async () => {
		renderWorkbench({
			value: eq(
				prop("patient", "age"),
				arith("+", term(literal(1)), term(literal(2))),
			),
		});

		fireEvent.click(screen.getByRole("button", { name: "Edit math" }));
		const valueSources = await screen.findAllByRole("button", {
			name: "Value source: A value",
		});
		const otherCaseInformation = openValueSource(valueSources[0]);

		expect(otherCaseInformation.getAttribute("aria-disabled")).toBe("true");
		expect(otherCaseInformation.textContent).toContain(
			"This condition already uses case information",
		);
	});

	it("keeps an imported unsupported source open so the author can replace it", () => {
		renderWorkbench({
			value: eq(prop("patient", "age"), prop("patient", "score")),
		});

		const source = screen.getByRole("button", {
			name: "Value source: Other case information",
		});
		fireEvent.click(source);
		const activeSource = screen.getByRole("menuitem", {
			name: /^Other case information/,
		});
		const replacement = screen.getByRole("menuitem", { name: /^A value/ });

		expect(activeSource.getAttribute("aria-disabled")).not.toBe("true");
		expect(replacement.getAttribute("aria-disabled")).not.toBe("true");
	});
});
