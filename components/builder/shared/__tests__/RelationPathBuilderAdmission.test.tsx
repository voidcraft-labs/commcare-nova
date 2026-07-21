// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate";
import {
	buildValidityIndex,
	type ExpressionChangeAdmission,
	PredicateEditProvider,
} from "../editorContext";
import { RelationPathBuilder } from "../primitives/RelationPathBuilder";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "household",
		properties: [],
	},
	{
		name: "patient",
		parent_type: "household",
		properties: [],
	},
	{
		name: "visit",
		parent_type: "patient",
		properties: [],
	},
	{
		name: "lab_result",
		parent_type: "patient",
		properties: [],
	},
];

const BLOCK_REASON =
	"That connection cannot run in Search. Use information from this case instead.";

function renderBuilder(
	value: Parameters<typeof RelationPathBuilder>[0]["value"],
	onChange: Parameters<typeof RelationPathBuilder>[0]["onChange"],
	admitChange: (
		next: Parameters<typeof RelationPathBuilder>[0]["value"],
	) => ExpressionChangeAdmission,
) {
	return render(
		<PredicateEditProvider
			caseTypes={CASE_TYPES}
			currentCaseType="visit"
			knownInputs={[]}
			validityIndex={buildValidityIndex([])}
		>
			<RelationPathBuilder
				value={value}
				onChange={onChange}
				admitChange={admitChange}
			/>
		</PredicateEditProvider>,
	);
}

describe("RelationPathBuilder candidate admission", () => {
	it("disables an inadmissible parent step before it can mutate the path", () => {
		const onChange = vi.fn();
		renderBuilder(
			ancestorPath(relationStep("parent", "patient")),
			onChange,
			(next) =>
				next.kind === "ancestor" && next.via.length > 1
					? { admitted: false, reason: BLOCK_REASON }
					: { admitted: true },
		);

		const addParent = screen.getByRole("button", {
			name: "Add another parent",
		});
		expect((addParent as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(BLOCK_REASON)).toBeDefined();
		fireEvent.click(addParent);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("disables an inadmissible removal before opening confirmation", () => {
		const onChange = vi.fn();
		renderBuilder(
			ancestorPath(
				relationStep("parent", "patient"),
				relationStep("parent", "household"),
			),
			onChange,
			(next) =>
				next.kind === "ancestor" && next.via.length === 1
					? { admitted: false, reason: BLOCK_REASON }
					: { admitted: true },
		);

		const remove = screen.getByRole("button", {
			name: "Remove connection from Visit to Patient",
		});
		expect((remove as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getAllByText(BLOCK_REASON).length).toBeGreaterThan(0);
		fireEvent.click(remove);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("marks a rejected case-type option with the friendly reason", async () => {
		const onChange = vi.fn();
		renderBuilder(subcasePath("guardian", "household"), onChange, (next) =>
			next.kind === "subcase" && next.ofCaseType === "lab_result"
				? { admitted: false, reason: BLOCK_REASON }
				: { admitted: true },
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Child case type" }));
		const blocked = await screen.findByRole("option", {
			name: `Lab result ${BLOCK_REASON}`,
		});
		expect(blocked.getAttribute("aria-disabled")).toBe("true");
		fireEvent.pointerDown(blocked, { pointerType: "mouse" });
		fireEvent.click(blocked);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("combobox", { name: "Child case type" }));
		await settleBaseUiTransitions();
	});

	it("keeps a rejected connection-name draft local and explains the repair", async () => {
		const onChange = vi.fn();
		renderBuilder(
			ancestorPath(relationStep("guardian", "patient")),
			onChange,
			(next) =>
				next.kind === "ancestor" && next.via[0].identifier === "host"
					? { admitted: false, reason: BLOCK_REASON }
					: { admitted: true },
		);

		fireEvent.click(screen.getByRole("button", { name: "More settings" }));
		await settleBaseUiTransitions();
		const input = screen.getByRole("textbox", { name: "Connection name" });
		fireEvent.change(input, { target: { value: "host" } });
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByRole("alert").textContent).toBe(BLOCK_REASON);
		fireEvent.blur(input);
		expect(onChange).not.toHaveBeenCalled();
		expect((input as HTMLInputElement).value).toBe("host");
	});
});
