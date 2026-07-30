// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	focusElement,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/domain";
import { CloseConditionSection } from "../CloseConditionSection";

vi.mock("@/components/ui/FieldPicker", () => ({
	FieldPicker: ({
		onChange,
	}: {
		readonly onChange: (uuid: string) => void;
	}) => (
		<button
			type="button"
			onClick={() => onChange("33333333-3333-4333-8333-333333333333")}
		>
			Choose Close reason
		</button>
	),
}));

const MODULE = testUuid("close-condition-module");
const FORM = testUuid("close-condition-form");
const FIELD = testUuid("33333333-3333-4333-8333-333333333333");

const initialDoc = toPersistableDoc(
	buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Close patient",
						type: "close",
						fields: [
							f({
								uuid: FIELD,
								kind: "text",
								id: "close_reason",
								label: "Close reason",
							}),
						],
					},
				],
			},
		],
	}),
);

function SavedCondition({ formUuid }: { readonly formUuid: Uuid }) {
	const condition = useForm(formUuid)?.closeCondition;
	return (
		<output aria-label="Saved close condition">
			{condition === undefined
				? "none"
				: `${condition.field}:${condition.answer}`}
		</output>
	);
}

function renderSection() {
	return render(
		<BlueprintDocProvider initialDoc={initialDoc}>
			<CloseConditionSection moduleUuid={MODULE} formUuid={FORM} />
			<SavedCondition formUuid={FORM} />
		</BlueprintDocProvider>,
	);
}

describe("CloseConditionSection", () => {
	it("keeps an incomplete conditional close local until a real field and answer exist", async () => {
		renderSection();
		const saved = screen.getByRole("status", {
			name: "Saved close condition",
		});
		expect(saved.textContent).toBe("none");

		fireEvent.click(screen.getByRole("button", { name: "Close Behavior" }));
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: "When condition is met",
			}),
		);
		await settleBaseUiTransitions();

		expect(saved.textContent).toBe("none");
		fireEvent.click(
			screen.getByRole("button", { name: "Choose Close reason" }),
		);

		expect(saved.textContent).toBe("none");
		const answer = screen.getByPlaceholderText("Plain text value");
		focusElement(answer);
		fireEvent.change(answer, { target: { value: "moved" } });
		fireEvent.blur(answer);

		await waitFor(() => {
			expect(saved.textContent).toBe(`${FIELD}:moved`);
		});
	});
});
