// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render as rtlRender,
	screen,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaseType, LookupColumnId, LookupTableId } from "@/lib/domain";
import {
	arith,
	dateAdd,
	eq,
	literal,
	now,
	prop,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { PredicateWorkbench } from "../PredicateWorkbench";

// The surfaces here spell authored prose against the document; every production
// mount sits inside the builder's provider. Wrapping at `render` reproduces it
// and carries through each `rerender`.
function DocumentProvider({ children }: { readonly children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="test-app">{children}</BlueprintDocProvider>
	);
}

function render(ui: ReactElement) {
	return rtlRender(ui, { wrapper: DocumentProvider });
}

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "age", label: proseText("Age"), data_type: "int" },
			{ name: "score", label: proseText("Score"), data_type: "int" },
			{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
			{
				name: "last_seen",
				label: proseText("Last seen"),
				data_type: "datetime",
			},
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
	lookupTables,
}: {
	readonly value?: Parameters<typeof PredicateWorkbench>[0]["value"];
	readonly target?: Parameters<
		typeof PredicateWorkbench
	>[0]["evaluationTarget"];
	readonly lookupTables?: Parameters<
		typeof PredicateWorkbench
	>[0]["lookupTables"];
} = {}) {
	render(
		<PredicateWorkbench
			value={value}
			onChange={() => {}}
			caseTypes={CASE_TYPES}
			currentCaseType="patient"
			evaluationTarget={target}
			lookupTables={lookupTables}
		/>,
	);
}

function openValueSource(button: HTMLElement): HTMLElement {
	fireEvent.click(button);
	return screen.getByRole("menuitemradio", {
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

	it("applies case-search admission when the rule also runs on device", () => {
		renderWorkbench({ target: "on-device-and-case-search" });

		const otherCaseInformation = openValueSource(
			screen.getByRole("button", { name: "Value source: A value" }),
		);

		expect(otherCaseInformation.getAttribute("aria-disabled")).toBe("true");
		expect(otherCaseInformation.textContent).toContain(
			"This condition already uses case information",
		);
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

	it("does not re-admit an unsupported current source", () => {
		renderWorkbench({
			value: eq(prop("patient", "age"), prop("patient", "score")),
		});

		const source = screen.getByRole("button", {
			name: "Value source: Other case information",
		});
		fireEvent.click(source);
		const activeSource = screen.getByRole("menuitemradio", {
			name: /^Other case information/,
		});
		const replacement = screen.getByRole("menuitemradio", {
			name: /^A value/,
		});

		expect(activeSource.getAttribute("aria-disabled")).toBe("true");
		expect(replacement.getAttribute("aria-disabled")).not.toBe("true");
	});

	it("disables calendar intervals before an on-device edit", () => {
		renderWorkbench({
			value: eq(
				prop("patient", "dob"),
				dateAdd(today(), "days", term(literal(1))),
			),
			target: "on-device",
		});

		fireEvent.click(screen.getByRole("button", { name: "Edit adjusted date" }));
		const interval = screen.getByRole("combobox", {
			name: "Interval Days",
		});
		expect(interval.getAttribute("aria-invalid")).not.toBe("true");

		fireEvent.click(interval);
		const months = screen.getByRole("option", {
			name: /Months.*Month and year calculations aren't available here/i,
		});
		const days = screen.getByRole("option", { name: "Days" });
		expect(months.getAttribute("aria-disabled")).toBe("true");
		expect(days.getAttribute("aria-disabled")).not.toBe("true");
	});

	it("keeps native month calculations available in a server search", () => {
		renderWorkbench({
			value: eq(
				prop("patient", "dob"),
				dateAdd(today(), "months", term(literal(1))),
			),
			target: "case-search",
		});

		fireEvent.click(screen.getByRole("button", { name: "Edit adjusted date" }));
		const interval = screen.getByRole("combobox", {
			name: "Interval Months",
		});
		expect(interval.getAttribute("aria-invalid")).not.toBe("true");
		fireEvent.click(interval);
		expect(
			screen
				.getByRole("option", { name: "Months" })
				.getAttribute("aria-disabled"),
		).not.toBe("true");
	});

	it("withholds a new datetime calculation before an on-device commit", async () => {
		renderWorkbench({
			value: eq(prop("patient", "last_seen"), literal(null)),
			target: "on-device",
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Value source: A value" }),
		);
		const adjustDate = await screen.findByRole("menuitem", {
			name: /Adjust a date.*time would be lost/i,
		});
		expect(adjustDate.getAttribute("aria-disabled")).toBe("true");
	});

	it("withholds an unseedable table lookup without crashing the value menu", async () => {
		renderWorkbench({
			value: eq(prop("patient", "last_seen"), literal(null)),
			target: "on-device",
			lookupTables: [
				{
					id: "00000000-0000-7000-8000-000000000001" as LookupTableId,
					name: "Facilities",
					columns: [
						{
							id: "10000000-0000-7000-8000-000000000001" as LookupColumnId,
							wireName: "name",
							label: "Name",
							dataType: "text",
						},
					],
				},
			],
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Value source: A value" }),
		);
		const tableLookup = await screen.findByRole("menuitem", {
			name: /Look up a table value.*Add a Project data column/i,
		});
		expect(tableLookup.getAttribute("aria-disabled")).toBe("true");
	});

	it("does not offer a whole-date base that would break a datetime parent slot", () => {
		renderWorkbench({
			value: eq(
				prop("patient", "last_seen"),
				dateAdd(now(), "days", term(literal(1))),
			),
			target: "on-device",
		});

		fireEvent.click(screen.getByRole("button", { name: "Edit adjusted date" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Edit current date and time" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Change value type" }));
		const todayChoice = screen.getByRole("menuitem", {
			name: /^Today's date/,
		});
		expect(todayChoice.getAttribute("aria-disabled")).toBe("true");
	});
});
