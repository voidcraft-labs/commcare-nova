// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	focusElement,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import {
	asUuid,
	type CaseType,
	type LookupColumnId,
	type LookupTableId,
	type UserProperty,
} from "@/lib/domain";
import {
	ancestorPath,
	dateLiteral,
	input,
	literal,
	prop,
	relationStep,
	sessionContext,
	sessionUser,
	sessionUserProperty,
	tableColumn,
	term,
	timeLiteral,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [],
};

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};

const PATIENT_WITH_INFORMATION: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "case_name", label: "Case name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};

const TRANSITION_CASE_TYPES = [HOUSEHOLD, PATIENT_WITH_INFORMATION] as const;
const LOOKUP_TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const LOOKUP_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ac" as LookupColumnId;
const LOOKUP_LABEL_COLUMN =
	"018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const WORKER_PROPERTY_UUID = asUuid("worker-property-region");
const WORKER_PROPERTY: UserProperty = {
	uuid: WORKER_PROPERTY_UUID,
	slug: "assigned_region",
	label: "Assigned region",
};
const WORKER_CADRE_UUID = asUuid("worker-property-cadre");
const WORKER_CADRE: UserProperty = {
	uuid: WORKER_CADRE_UUID,
	slug: "cadre-code",
	label: "Cadre",
};

const REQUIRED_TERM = {
	accepts: "any" as const,
	nonEmpty: true,
	termOnly: true,
};

function renderRequiredTerm(value: ValueExpression) {
	const onChange = vi.fn();
	render(
		<ExpressionCardEditor
			value={value}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
			constraint={REQUIRED_TERM}
		/>,
	);
	return onChange;
}

function renderStatefulTerm(value: ValueExpression) {
	const onChange = vi.fn();
	function Harness() {
		const [current, setCurrent] = useState(value);
		return (
			<ExpressionCardEditor
				value={current}
				onChange={(next) => {
					onChange(next);
					setCurrent(next);
				}}
				caseTypes={TRANSITION_CASE_TYPES}
				currentCaseType="patient"
				knownInputs={[
					{
						uuid: asUuid("2214a815-64a0-4d91-85fa-1b3066ae65c9"),
						name: "client_name",
						label: "Client name",
						data_type: "text",
					},
					{
						uuid: asUuid("be272c54-4980-4e32-8944-26c03cae7b07"),
						name: "minimum_age",
						label: "Minimum age",
						data_type: "int",
					},
				]}
			/>
		);
	}
	render(<Harness />);
	return onChange;
}

describe("TermCard data-table row scope", () => {
	it("edits the active table's columns by their author labels", async () => {
		const onChange = vi.fn();
		const columns = [
			{
				id: LOOKUP_COLUMN,
				wireName: "code",
				label: "Region code",
				dataType: "text" as const,
			},
			{
				id: LOOKUP_LABEL_COLUMN,
				wireName: "label",
				label: "Region label",
				dataType: "text" as const,
			},
		];

		render(
			<ExpressionCardEditor
				value={term(tableColumn(LOOKUP_TABLE, LOOKUP_COLUMN))}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				lookupTables={[{ id: LOOKUP_TABLE, name: "Regions", columns }]}
				tableScope={{ tableId: LOOKUP_TABLE, columns }}
				caseDataScope="table-row"
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: "Data table column: Region code",
		});
		fireEvent.click(trigger);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /Region label/ }),
		);
		await settleBaseUiTransitions();

		expect(onChange).toHaveBeenLastCalledWith(
			term(tableColumn(LOOKUP_TABLE, LOOKUP_LABEL_COLUMN)),
		);
	});
});

async function chooseSource(name: string) {
	fireEvent.click(screen.getByRole("button", { name: /^Value source:/ }));
	fireEvent.click(await screen.findByRole("menuitemradio", { name }));
	await settleBaseUiTransitions();
}

async function chooseLiteralShape(name: string) {
	fireEvent.click(screen.getByRole("button", { name: /^Value source:/ }));
	fireEvent.click(await screen.findByRole("menuitem", { name: /^Value type/ }));
	fireEvent.click(await screen.findByRole("menuitem", { name }));
	await settleBaseUiTransitions();
}

describe("TermCard required literal recovery", () => {
	it("keeps a cleared text draft visible until it is corrected", () => {
		const onChange = renderRequiredTerm(term(literal("original")));
		const input = screen.getByRole("textbox", { name: "Text value" });

		focusElement(input as HTMLInputElement);
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);

		expect((input as HTMLInputElement).value).toBe("");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByRole("alert").textContent).toBe("Enter a value");
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: "corrected" } });
		fireEvent.blur(input);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(onChange).toHaveBeenLastCalledWith(term(literal("corrected")));
	});

	it.each([
		{
			name: "date",
			label: "Date value",
			initial: term(dateLiteral("2026-07-17")),
			corrected: "2026-08-18",
			expected: term(dateLiteral("2026-08-18")),
		},
		{
			name: "time",
			label: "Time value",
			initial: term(timeLiteral("09:30")),
			corrected: "10:45",
			expected: term(timeLiteral("10:45")),
		},
	])(
		"keeps a cleared required $name draft visible until it is corrected",
		({ label, initial, corrected, expected }) => {
			const onChange = renderRequiredTerm(initial);
			const input = screen.getByLabelText(label);

			focusElement(input as HTMLInputElement);
			fireEvent.change(input, { target: { value: "" } });

			expect((input as HTMLInputElement).value).toBe("");
			expect(input.getAttribute("aria-invalid")).toBe("true");
			expect(screen.getByRole("alert").textContent).toBe("Enter a value");
			expect(onChange).not.toHaveBeenCalled();

			fireEvent.change(input, { target: { value: corrected } });

			expect(screen.queryByRole("alert")).toBeNull();
			expect(onChange).toHaveBeenLastCalledWith(expected);
		},
	);
});

describe("TermCard number literal recovery", () => {
	it.each(["12oops", "1e"])(
		"preserves the malformed %s draft and commits only its correction",
		(malformedDraft) => {
			const onChange = vi.fn();
			render(
				<ExpressionCardEditor
					value={term(literal(7.5))}
					onChange={onChange}
					caseTypes={[PATIENT]}
					currentCaseType="patient"
				/>,
			);
			const input = screen.getByLabelText("Number value") as HTMLInputElement;

			focusElement(input);
			fireEvent.change(input, { target: { value: malformedDraft } });
			fireEvent.blur(input);

			expect(input.value).toBe(malformedDraft);
			expect(input.getAttribute("aria-invalid")).toBe("true");
			const error = screen.getByRole("alert");
			expect(error.textContent).toBe("Enter a number");
			expect(input.getAttribute("aria-describedby")).toBe(error.id);
			expect(onChange).not.toHaveBeenCalled();

			focusElement(input);
			fireEvent.change(input, { target: { value: "12.25" } });
			expect(input.getAttribute("aria-invalid")).toBeNull();
			expect(screen.queryByText("Enter a number")).toBeNull();
			fireEvent.blur(input);

			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith(term(literal(12.25)));
		},
	);
});

describe("TermCard source transitions", () => {
	it("exposes the current value source as a checked radio choice", async () => {
		renderStatefulTerm(term(literal("saved")));

		fireEvent.click(screen.getByRole("button", { name: /^Value source:/ }));
		const literalSource = await screen.findByRole("menuitemradio", {
			name: "A value",
		});
		const caseSource = screen.getByRole("menuitemradio", {
			name: "Other case information",
		});

		expect(literalSource.getAttribute("aria-checked")).toBe("true");
		expect(caseSource.getAttribute("aria-checked")).toBe("false");
	});

	it("keeps a missing saved search answer readable when no search fields remain", async () => {
		render(
			<ExpressionCardEditor
				value={term(input(asUuid("c533d6a4-0c9a-4151-8504-79192efbe69e")))}
				onChange={vi.fn()}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				knownInputs={[]}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: "Value source: A search answer",
			}),
		).toBeDefined();
		const savedAnswer = screen.getByRole("button", {
			name: "Search answer: Search field, no longer available",
		});
		expect(savedAnswer.textContent).toContain("Search field");
		expect(savedAnswer.textContent).toContain("No longer available");
		expect(screen.queryByText("retired_status")).toBeNull();

		fireEvent.click(savedAnswer);

		expect(
			await screen.findByText("Search field is no longer available"),
		).toBeDefined();
		expect(
			screen.getByText(
				"Choose another value source, or add this search field again",
			),
		).toBeDefined();
	});

	it("offers compatible search answers as replacements for a missing saved answer", async () => {
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={term(input(asUuid("c533d6a4-0c9a-4151-8504-79192efbe69e")))}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				knownInputs={[
					{
						uuid: asUuid("6c9c4fba-c968-4ff0-8491-bf0e10af4bc2"),
						name: "active_status",
						label: "Active status",
						data_type: "text",
					},
				]}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Search answer: Search field, no longer available",
			}),
		);

		expect(
			await screen.findByText("Search field is no longer available"),
		).toBeDefined();
		expect(
			screen.getByText(
				"Choose another search answer below, or add this search field again",
			),
		).toBeDefined();
		fireEvent.click(
			screen.getByRole("menuitem", { name: "Active status Text" }),
		);

		expect(onChange).toHaveBeenCalledWith(
			term(input(asUuid("6c9c4fba-c968-4ff0-8491-bf0e10af4bc2"))),
		);
	});

	it("cancels exactly, restores focus, and keeps a related-property draft", async () => {
		const relatedProperty = term(
			prop(
				"patient",
				"region",
				ancestorPath(relationStep("parent", "household")),
			),
		);
		const onChange = renderStatefulTerm(relatedProperty);

		await chooseSource("A value");
		expect(
			screen.getByRole("alertdialog", {
				name: "Use a value instead?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(
				"This replaces the selected case information and its connection. You can undo this change.",
			),
		).toBeDefined();
		expect(screen.getByRole("alertdialog").textContent).not.toMatch(
			/property|relationship|path/i,
		);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(
				screen.getByRole("button", {
					name: "Value source: Other case information",
				}),
			);
		});
		expect(onChange).not.toHaveBeenCalled();

		await chooseSource("A value");
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Value source: A value" }),
			);
		});
		expect(onChange).toHaveBeenLastCalledWith(term(literal("")));

		await chooseSource("Other case information");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onChange).toHaveBeenLastCalledWith(relatedProperty);
	});

	it("keeps the chosen search answer while trying another source", async () => {
		const saved = term(input(asUuid("2214a815-64a0-4d91-85fa-1b3066ae65c9")));
		const onChange = renderStatefulTerm(saved);
		expect(
			screen.getByRole("button", { name: "Search answer: Client name" }),
		).toBeDefined();
		expect(screen.queryByText("client_name")).toBeNull();

		await chooseSource("Other user field");
		expect(
			screen.getByRole("alertdialog", {
				name: "Use other user field instead?",
			}),
		).toBeDefined();
		const field = screen.getByRole("textbox", { name: "User field name" });
		expect(
			(screen.getByRole("button", { name: "Replace" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.change(field, { target: { value: "assigned_region" } });
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onChange).toHaveBeenLastCalledWith(
			term(sessionUser("assigned_region")),
		);

		await chooseSource("A search answer");
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onChange).toHaveBeenLastCalledWith(saved);
	});

	it.each([
		{
			name: "user information",
			initial: term(sessionUser("assigned_region")),
			target: "App information",
			title: "Use app information instead?",
			back: "Other user field",
		},
		{
			name: "app information",
			initial: term(sessionContext("deviceid")),
			target: "Other user field",
			title: "Use other user field instead?",
			back: "App information",
		},
	])(
		"keeps saved $name while trying another source",
		async ({ initial, target, title, back }) => {
			const onChange = renderStatefulTerm(initial);
			await chooseSource(target);
			expect(screen.getByRole("alertdialog", { name: title })).toBeDefined();
			if (target === "Other user field") {
				fireEvent.change(
					screen.getByRole("textbox", { name: "User field name" }),
					{ target: { value: "assigned_region" } },
				);
			}
			fireEvent.click(screen.getByRole("button", { name: "Replace" }));
			await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

			await chooseSource(back);
			if (target === "Other user field") {
				fireEvent.click(screen.getByRole("button", { name: "Replace" }));
				await waitFor(() =>
					expect(screen.queryByRole("alertdialog")).toBeNull(),
				);
			} else {
				expect(screen.queryByRole("alertdialog")).toBeNull();
			}
			expect(onChange).toHaveBeenLastCalledWith(initial);
		},
	);

	it("collects a valid user field before leaving an empty generated value", async () => {
		const onChange = renderStatefulTerm(term(literal("")));

		await chooseSource("Other user field");
		const dialog = screen.getByRole("alertdialog", {
			name: "Which user information?",
		});
		const useField = screen.getByRole("button", { name: "Use field" });
		expect((useField as HTMLButtonElement).disabled).toBe(true);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(screen.getByRole("textbox", { name: "User field name" }), {
			target: { value: "bad field" },
		});
		expect(dialog.textContent).toContain("Start with a letter or underscore");
		expect((useField as HTMLButtonElement).disabled).toBe(true);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(screen.getByRole("textbox", { name: "User field name" }), {
			target: { value: "assigned_region" },
		});
		fireEvent.click(useField);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onChange).toHaveBeenLastCalledWith(
			term(sessionUser("assigned_region")),
		);

		await chooseSource("A value");
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onChange).toHaveBeenLastCalledWith(term(literal("")));
	});

	it("keeps malformed edits local until an existing user field is corrected", () => {
		const onChange = renderStatefulTerm(term(sessionUser("assigned_region")));
		const field = screen.getByRole("textbox", {
			name: "User information field",
		}) as HTMLInputElement;

		focusElement(field);
		fireEvent.change(field, { target: { value: "bad field" } });
		fireEvent.blur(field);

		expect(field.value).toBe("bad field");
		expect(field.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByRole("alert").textContent).toContain(
			"Start with a letter or underscore",
		);
		expect(onChange).not.toHaveBeenCalled();

		focusElement(field);
		fireEvent.change(field, { target: { value: "service_area" } });
		fireEvent.blur(field);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(term(sessionUser("service_area")));
	});

	it("keeps a raw external field raw even when it exactly matches a custom slug", () => {
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={term(sessionUser("external_region"))}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				userProperties={[WORKER_PROPERTY]}
			/>,
		);
		const field = screen.getByRole("textbox", {
			name: "User information field",
		});

		focusElement(field as HTMLInputElement);
		fireEvent.change(field, { target: { value: "assigned_region" } });
		fireEvent.blur(field);

		expect(onChange).toHaveBeenCalledWith(term(sessionUser("assigned_region")));
	});

	it("accepts hyphens in an explicit raw external field", () => {
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={term(sessionUser("external_region"))}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				userProperties={[WORKER_PROPERTY]}
			/>,
		);
		const field = screen.getByRole("textbox", {
			name: "User information field",
		});

		focusElement(field as HTMLInputElement);
		fireEvent.change(field, { target: { value: "district-code" } });
		fireEvent.blur(field);

		expect(onChange).toHaveBeenCalledWith(term(sessionUser("district-code")));
	});

	it("selects custom worker information only through its UUID catalog", async () => {
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={term(sessionUserProperty(WORKER_PROPERTY_UUID))}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				userProperties={[WORKER_PROPERTY, WORKER_CADRE]}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Worker information: Assigned region, assigned_region",
			}),
		);
		expect(
			(
				await screen.findByRole("menuitemradio", {
					name: "Assigned region assigned_region",
				})
			).getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: "Cadre cadre-code",
			}),
		);
		await settleBaseUiTransitions();

		expect(onChange).toHaveBeenCalledWith(
			term(sessionUserProperty(WORKER_CADRE_UUID)),
		);
		expect(
			screen.queryByRole("textbox", { name: "User information field" }),
		).toBeNull();
	});

	it("renders a custom worker identity through its current label and slug after rename", async () => {
		const onChange = vi.fn();
		const value = term(sessionUserProperty(WORKER_PROPERTY_UUID));
		const { rerender } = render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				userProperties={[WORKER_PROPERTY]}
			/>,
		);
		expect(
			screen.getByRole("button", {
				name: "Worker information: Assigned region, assigned_region",
			}),
		).toBeDefined();

		rerender(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				userProperties={[
					{
						...WORKER_PROPERTY,
						slug: "supervision_area",
						label: "Supervision area",
					},
				]}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: "Worker information: Supervision area, supervision_area",
				}),
			).toBeDefined(),
		);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("seeds the explicit custom source from the UUID catalog without a text fallback", async () => {
		const onChange = vi.fn();
		function Harness() {
			const [current, setCurrent] = useState<ValueExpression>(
				term(literal("")),
			);
			return (
				<ExpressionCardEditor
					value={current}
					onChange={(next) => {
						onChange(next);
						setCurrent(next);
					}}
					caseTypes={[PATIENT]}
					currentCaseType="patient"
					userProperties={[WORKER_PROPERTY]}
				/>
			);
		}
		render(<Harness />);

		await chooseSource("Worker information");

		expect(onChange).toHaveBeenLastCalledWith(
			term(sessionUserProperty(WORKER_PROPERTY_UUID)),
		);
		expect(
			screen.getByRole("button", {
				name: "Worker information: Assigned region, assigned_region",
			}),
		).toBeDefined();
		expect(
			screen.queryByRole("textbox", { name: "User information field" }),
		).toBeNull();
	});

	it("shows a clear recovery path instead of exposing a missing identity", () => {
		const onValidityChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={term(sessionUserProperty(WORKER_PROPERTY_UUID))}
				onChange={vi.fn()}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				userProperties={[]}
				onValidityChange={onValidityChange}
			/>,
		);

		const unavailable = screen.getByRole("alert");
		expect(unavailable.textContent).toContain("Worker information unavailable");
		expect(unavailable.textContent).toContain("Choose another value source");
		expect(unavailable.textContent).not.toContain(WORKER_PROPERTY_UUID);
		expect(
			screen.queryByRole("textbox", { name: "User information field" }),
		).toBeNull();
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});
});

describe("TermCard literal type transitions", () => {
	it("keeps type choices out of the ordinary row and keyboard-accessible in value options", async () => {
		const onChange = renderStatefulTerm(term(literal("")));
		expect(screen.queryByRole("button", { name: /^Value type:/ })).toBeNull();

		const sourceTrigger = screen.getByRole("button", {
			name: /^Value source:/,
		});
		focusElement(sourceTrigger);
		fireEvent.keyDown(sourceTrigger, { key: "ArrowDown", code: "ArrowDown" });
		const typeOptions = await screen.findByRole("menuitem", {
			name: /^Value type Text/,
		});
		focusElement(typeOptions);
		fireEvent.keyDown(typeOptions, { key: "ArrowRight", code: "ArrowRight" });
		const number = await screen.findByRole("menuitem", { name: "Number" });
		focusElement(number);
		fireEvent.keyDown(number, { key: "Enter", code: "Enter" });
		// Happy DOM does not synthesize the activation click generated by Enter.
		fireEvent.click(number, { detail: 0 });
		fireEvent.keyUp(number, { key: "Enter", code: "Enter" });

		await waitFor(() =>
			expect(onChange).toHaveBeenLastCalledWith(term(literal(0))),
		);
	});

	it("cancels or replaces a typed date qualifier and restores focus", async () => {
		const saved = term(dateLiteral("2026-07-17"));
		const onChange = renderStatefulTerm(saved);

		await chooseLiteralShape("Text");
		expect(
			screen.getByRole("alertdialog", {
				name: "Change this value to text?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(
				"This replaces the saved date value. You can undo this change.",
			),
		).toBeDefined();
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Value source: A value" }),
			);
		});
		expect(onChange).not.toHaveBeenCalled();

		await chooseLiteralShape("Text");
		fireEvent.click(screen.getByRole("button", { name: "Change value" }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Value source: A value" }),
			);
		});
		expect(onChange).toHaveBeenLastCalledWith(term(literal("")));

		await chooseLiteralShape("Date");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onChange).toHaveBeenLastCalledWith(saved);
	});

	it.each([
		{ name: "number", initial: term(literal(0)), back: "Number" },
		{ name: "boolean", initial: term(literal(false)), back: "Yes or no" },
	])(
		"confirms and retains an authored $name value",
		async ({ initial, back }) => {
			const onChange = renderStatefulTerm(initial);
			await chooseLiteralShape("Text");
			expect(
				screen.getByRole("alertdialog", {
					name: "Change this value to text?",
				}),
			).toBeDefined();
			fireEvent.click(screen.getByRole("button", { name: "Change value" }));
			await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

			await chooseLiteralShape(back);
			expect(screen.queryByRole("alertdialog")).toBeNull();
			expect(onChange).toHaveBeenLastCalledWith(initial);
		},
	);

	it("does not warn for empty typed dates or untouched generated values", async () => {
		const emptyDateChange = renderStatefulTerm(term(dateLiteral("")));
		await chooseLiteralShape("Number");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(emptyDateChange).toHaveBeenLastCalledWith(term(literal(0)));

		await chooseLiteralShape("Text");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(emptyDateChange).toHaveBeenLastCalledWith(term(literal("")));
	});
});
