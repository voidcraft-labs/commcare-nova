// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, type Mock, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	dateLiteral,
	type Literal,
	literal,
	timeLiteral,
} from "@/lib/domain/predicate";
import { PredicateEditProvider } from "../editorContext";
import { LiteralValueInput } from "../primitives/LiteralValueInput";

const LONG_OPTION_LABEL =
	"Return every week until the household follow-up is complete";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight", data_type: "decimal" },
		{ name: "nickname", label: "Nickname", data_type: "text" },
		{ name: "visit_date", label: "Visit date", data_type: "date" },
		{ name: "visit_time", label: "Visit time", data_type: "time" },
		{
			name: "follow_up_plan",
			label: "Follow-up plan",
			data_type: "single_select",
			options: [
				{
					value: "weekly_until_complete",
					label: LONG_OPTION_LABEL,
				},
			],
		},
	],
};

function renderLiteralInput({
	value,
	propertyName,
	ariaLabel,
	nonEmpty = false,
	onChange = vi.fn<(next: Literal) => void>(),
}: {
	readonly value: ReturnType<typeof literal>;
	readonly propertyName: string;
	readonly ariaLabel: string;
	readonly nonEmpty?: boolean;
	readonly onChange?: Mock<(next: Literal) => void>;
}) {
	render(
		<PredicateEditProvider
			caseTypes={[PATIENT]}
			currentCaseType="patient"
			knownInputs={[]}
			validityIndex={new Map()}
		>
			<LiteralValueInput
				value={value}
				onChange={onChange}
				caseTypeName="patient"
				propertyName={propertyName}
				nonEmpty={nonEmpty}
				ariaLabel={ariaLabel}
			/>
		</PredicateEditProvider>,
	);
	return {
		input: screen.getByLabelText(ariaLabel) as HTMLInputElement,
		onChange,
	};
}

function renderIntegerLiteral(onChange = vi.fn()) {
	return renderLiteralInput({
		value: literal(7),
		propertyName: "age",
		ariaLabel: "Integer value",
		onChange,
	});
}

describe("LiteralValueInput integer validation", () => {
	it("does not make a blank value look like zero", () => {
		const { input } = renderLiteralInput({
			value: literal(null),
			propertyName: "age",
			ariaLabel: "Blank integer value",
		});

		expect(input.value).toBe("");
		expect(input.placeholder).toBe("");
	});

	it.each([
		["a decimal", "1.5"],
		["a blank value", ""],
	])("preserves %s without changing the literal", (_label, draft) => {
		const { input, onChange } = renderIntegerLiteral();
		expect(input.step).toBe("1");

		input.focus();
		fireEvent.change(input, { target: { value: draft } });
		fireEvent.blur(input);

		expect(input.value).toBe(draft);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const error = screen.getByRole("alert");
		expect(error.textContent).toBe("Enter a whole number");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("clears the error and commits a corrected finite integer", () => {
		const { input, onChange } = renderIntegerLiteral();
		input.focus();
		fireEvent.change(input, { target: { value: "1.5" } });
		fireEvent.blur(input);
		expect(input.getAttribute("aria-invalid")).toBe("true");

		input.focus();
		fireEvent.change(input, { target: { value: "-2" } });
		expect(input.getAttribute("aria-invalid")).toBeNull();
		expect(screen.queryByText("Enter a whole number")).toBeNull();
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(literal(-2));
	});
});

describe("LiteralValueInput decimal validation", () => {
	it("does not make a blank value look like a selected number", () => {
		const { input } = renderLiteralInput({
			value: literal(null),
			propertyName: "weight",
			ariaLabel: "Blank decimal value",
		});

		expect(input.value).toBe("");
		expect(input.placeholder).toBe("");
	});

	it.each(["12oops", "1e"])(
		"preserves the malformed %s draft and commits only its correction",
		(malformedDraft) => {
			const { input, onChange } = renderLiteralInput({
				value: literal(7.5),
				propertyName: "weight",
				ariaLabel: "Decimal value",
			});

			input.focus();
			fireEvent.change(input, { target: { value: malformedDraft } });
			fireEvent.blur(input);

			expect(input.value).toBe(malformedDraft);
			expect(input.getAttribute("aria-invalid")).toBe("true");
			const error = screen.getByRole("alert");
			expect(error.textContent).toBe("Enter a number");
			expect(input.getAttribute("aria-describedby")).toBe(error.id);
			expect(onChange).not.toHaveBeenCalled();

			input.focus();
			fireEvent.change(input, { target: { value: "12.25" } });
			expect(input.getAttribute("aria-invalid")).toBeNull();
			expect(screen.queryByText("Enter a number")).toBeNull();
			fireEvent.blur(input);

			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith(literal(12.25));
		},
	);

	it("keeps the existing optional empty-number commit", () => {
		const { input, onChange } = renderLiteralInput({
			value: literal(7.5),
			propertyName: "weight",
			ariaLabel: "Optional decimal value",
		});
		input.focus();
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledWith(literal(null));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("LiteralValueInput required text validation", () => {
	it("preserves a cleared draft and commits after correction", () => {
		const { input, onChange } = renderLiteralInput({
			value: literal("Alice"),
			propertyName: "nickname",
			ariaLabel: "Required text value",
			nonEmpty: true,
		});

		input.focus();
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);
		expect(input.value).toBe("");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const error = screen.getByRole("alert");
		expect(error.textContent).toBe("Enter a value");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
		expect(onChange).not.toHaveBeenCalled();

		input.focus();
		fireEvent.change(input, { target: { value: "Bob" } });
		expect(input.getAttribute("aria-invalid")).toBeNull();
		expect(screen.queryByText("Enter a value")).toBeNull();
		fireEvent.blur(input);
		expect(onChange).toHaveBeenCalledWith(literal("Bob"));
	});

	it("keeps the existing optional empty-string commit", () => {
		const { input, onChange } = renderLiteralInput({
			value: literal("Alice"),
			propertyName: "nickname",
			ariaLabel: "Optional text value",
		});
		input.focus();
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledWith(literal(""));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("LiteralValueInput required date and time validation", () => {
	it.each([
		{
			label: "date",
			propertyName: "visit_date",
			ariaLabel: "Required date value",
			value: dateLiteral("2026-07-17"),
			correction: "2026-08-18",
			expected: dateLiteral("2026-08-18"),
		},
		{
			label: "time",
			propertyName: "visit_time",
			ariaLabel: "Required time value",
			value: timeLiteral("09:30"),
			correction: "10:45",
			expected: timeLiteral("10:45"),
		},
	])("preserves a cleared $label and commits its correction", (fixture) => {
		const { input, onChange } = renderLiteralInput({
			value: fixture.value,
			propertyName: fixture.propertyName,
			ariaLabel: fixture.ariaLabel,
			nonEmpty: true,
		});

		input.focus();
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);
		expect(input.value).toBe("");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const error = screen.getByRole("alert");
		expect(error.textContent).toBe("Enter a value");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
		expect(onChange).not.toHaveBeenCalled();

		input.focus();
		fireEvent.change(input, { target: { value: fixture.correction } });
		expect(input.getAttribute("aria-invalid")).toBeNull();
		expect(screen.queryByText("Enter a value")).toBeNull();
		expect(onChange).toHaveBeenCalledWith(fixture.expected);
	});

	it("keeps the existing optional empty date commit", () => {
		const { input, onChange } = renderLiteralInput({
			value: dateLiteral("2026-07-17"),
			propertyName: "visit_date",
			ariaLabel: "Optional date value",
		});
		fireEvent.change(input, { target: { value: "" } });

		expect(onChange).toHaveBeenCalledWith(dateLiteral(""));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("LiteralValueInput choice labels", () => {
	it("keeps complete authored choices readable in the trigger and menu", async () => {
		render(
			<PredicateEditProvider
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				knownInputs={[]}
				validityIndex={new Map()}
			>
				<LiteralValueInput
					value={literal("weekly_until_complete")}
					onChange={() => {}}
					caseTypeName="patient"
					propertyName="follow_up_plan"
					ariaLabel="Follow-up value"
				/>
			</PredicateEditProvider>,
		);

		const trigger = screen.getByRole("button", {
			name: `Follow-up value: ${LONG_OPTION_LABEL}`,
		});
		const selectedLabel = screen.getByText(LONG_OPTION_LABEL);
		expect(trigger.className).toContain("whitespace-normal");
		expect(selectedLabel.className).toContain("break-words");
		expect(selectedLabel.className).not.toContain("truncate");

		fireEvent.click(trigger);
		const option = await screen.findByRole("menuitem", {
			name: new RegExp(LONG_OPTION_LABEL, "i"),
		});
		expect(option.className).toContain("whitespace-normal");
		expect(screen.getAllByText(LONG_OPTION_LABEL)[1]?.className).toContain(
			"break-words",
		);
	});
});
