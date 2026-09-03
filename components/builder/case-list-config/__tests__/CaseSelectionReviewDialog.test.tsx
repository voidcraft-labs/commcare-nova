// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseSelectionTransition } from "@/lib/doc/caseSelectionMutations";
import { CaseSelectionReviewDialog } from "../CaseSelectionReviewDialog";

const SOURCE_MODULE_UUID = testUuid("case-selection-review-source-module");
const LINKED_MODULE_UUID = testUuid("case-selection-review-linked-module");

const transitions: readonly CaseSelectionTransition[] = [
	{
		moduleUuid: SOURCE_MODULE_UUID,
		moduleName: "Visits",
		selection: { kind: "multiple", maximum: 12 },
		clearsPersistentTile: true,
		reasons: [],
	},
	{
		moduleUuid: LINKED_MODULE_UUID,
		moduleName: "Review visits",
		selection: { kind: "multiple", maximum: 20 },
		clearsPersistentTile: true,
		reasons: [],
	},
];

describe("CaseSelectionReviewDialog", () => {
	it("names the several-case, starting-answer, linked-module, and tile consequences", async () => {
		const onConfirm = vi.fn();
		render(
			<CaseSelectionReviewDialog
				sourceModuleUuid={SOURCE_MODULE_UUID}
				current={undefined}
				requested={{ kind: "multiple", maximum: 12 }}
				transitions={transitions}
				startingAnswers={[
					{
						key: "status",
						fieldName: "Status",
						formName: "Visit",
					},
				]}
				attachmentAnswers={[
					{
						key: "photo",
						fieldName: "Photo",
						formName: "Visit",
						mode: "url",
					},
				]}
				blockers={[]}
				finalFocus={() => null}
				onCancel={vi.fn()}
				onConfirm={onConfirm}
			/>,
		);
		await settleBaseUiTransitions();

		expect(
			screen.getByRole("heading", {
				name: "Apply one form to several cases?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(/Existing case information does not fill/),
		).toBeDefined();
		expect(
			screen.getByText(/“Status” in “Visit” has a starting answer/),
		).toBeDefined();
		expect(
			screen.getByText(/“Photo” in “Visit” saves the stored file link/),
		).toBeDefined();
		expect(
			screen.getByText(/“Review visits” will also use up to 20 cases/),
		).toBeDefined();
		expect(
			screen.getAllByText(/Results tile will no longer stay above forms/),
		).toHaveLength(2);

		fireEvent.click(screen.getByRole("button", { name: "Use several cases" }));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("keeps a blocked transition mutation-free and opens its exact owner", async () => {
		const onOpen = vi.fn();
		const onConfirm = vi.fn();
		render(
			<CaseSelectionReviewDialog
				sourceModuleUuid={SOURCE_MODULE_UUID}
				current={undefined}
				requested={{ kind: "multiple", maximum: 12 }}
				transitions={[]}
				startingAnswers={[]}
				attachmentAnswers={[]}
				blockers={[
					{
						key: "link",
						message: "Visit has a direct one-case link.",
						actionLabel: "Open Visit's link",
						onOpen,
					},
				]}
				finalFocus={() => null}
				onCancel={vi.fn()}
				onConfirm={onConfirm}
			/>,
		);
		await settleBaseUiTransitions();

		expect(
			screen.getByRole("heading", {
				name: "Review this workflow before using several cases",
			}),
		).toBeDefined();
		expect(
			screen.getByText(
				"Nothing has changed. Each item below explains what needs attention. When an item has a matching editor, you can open it here. Once these items are resolved, this setting will be available.",
			),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Use several cases" }),
		).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Open Visit's link" }));
		expect(onOpen).toHaveBeenCalledOnce();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("announces when concurrent edits refresh the review", async () => {
		const baseProps = {
			sourceModuleUuid: SOURCE_MODULE_UUID,
			current: undefined,
			requested: { kind: "multiple" as const, maximum: 12 },
			transitions,
			startingAnswers: [],
			attachmentAnswers: [],
			blockers: [],
			finalFocus: () => null,
			onCancel: vi.fn(),
			onConfirm: vi.fn(),
		};
		const { rerender } = render(<CaseSelectionReviewDialog {...baseProps} />);
		await settleBaseUiTransitions();
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("");

		rerender(
			<CaseSelectionReviewDialog
				{...baseProps}
				refreshNotice="The workflow changed while this review was open. I refreshed the details below for another look before you confirm."
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain(
			"I refreshed the details below",
		);
	});

	it("explains the return to one case before confirming it", async () => {
		render(
			<CaseSelectionReviewDialog
				sourceModuleUuid={SOURCE_MODULE_UUID}
				current={{ kind: "multiple", maximum: 12 }}
				requested={undefined}
				transitions={[
					{
						moduleUuid: SOURCE_MODULE_UUID,
						moduleName: "Visits",
						selection: undefined,
						clearsPersistentTile: false,
						reasons: [],
					},
				]}
				startingAnswers={[]}
				attachmentAnswers={[]}
				blockers={[]}
				finalFocus={() => null}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		await settleBaseUiTransitions();

		expect(
			screen.getByRole("heading", { name: "Return to one case at a time?" }),
		).toBeDefined();
		expect(
			screen.getByText(/Its saved information will fill the form/),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Keep several cases" }),
		).toBeDefined();
	});

	it("names a limit-only confirmation with the new limit", async () => {
		render(
			<CaseSelectionReviewDialog
				sourceModuleUuid={SOURCE_MODULE_UUID}
				current={{ kind: "multiple", maximum: 12 }}
				requested={{ kind: "multiple", maximum: 8 }}
				transitions={[
					{
						moduleUuid: SOURCE_MODULE_UUID,
						moduleName: "Visits",
						selection: { kind: "multiple", maximum: 8 },
						clearsPersistentTile: false,
						reasons: [],
					},
				]}
				startingAnswers={[]}
				attachmentAnswers={[]}
				blockers={[]}
				finalFocus={() => null}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		await settleBaseUiTransitions();

		expect(
			screen.getByRole("button", { name: "Set limit to 8" }),
		).toBeDefined();
	});
});
