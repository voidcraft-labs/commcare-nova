// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	formRailPath,
	moduleRailPath,
} from "@/components/builder/appTree/AppTreeRail";
import {
	INSERTION_TRIGGER_CLS,
	insertionTriggerStyle,
} from "@/components/builder/appTree/insertion/TreeInsertionAffordance";
import { ModuleActions } from "@/components/builder/appTree/ModuleActions";
import { moduleCaseTypeLabel } from "@/components/builder/appTree/ModuleCard";
import {
	CollapseChevron,
	TreeItemRow,
} from "@/components/builder/appTree/shared";
import { TreeRowDelete } from "@/components/builder/appTree/TreeRowDelete";

const access = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => access.canEdit,
}));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({ moveModule: vi.fn() }),
}));

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: () => ({ name: "Care" }),
}));

vi.mock("@/components/shadcn/tooltip", () => ({
	SimpleTooltip: ({ children }: { children: ReactElement }) => children,
}));

describe("structure tree controls", () => {
	const moduleUuid = "00000000-0000-4000-8000-000000000001" as never;
	const actionProps = {
		moduleUuid,
		moduleName: "Visits",
		parentModuleUuid: null,
		siblingModuleUuids: [moduleUuid],
		rootModuleUuids: [moduleUuid],
		childModuleUuidsByRoot: { [moduleUuid]: [] },
		hasChildren: false,
		searchActive: false,
		onPlacementCommitted: vi.fn(),
	};

	it("gives the collapse action a full touch target", () => {
		const onClick = vi.fn();
		render(<CollapseChevron label="Intake" isCollapsed onClick={onClick} />);

		const collapse = screen.getByRole("button", { name: "Expand Intake" });
		expect(collapse.getAttribute("data-slot")).toBe("button");
		expect(collapse.className).toContain("size-11");

		fireEvent.click(collapse);
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("uses an independent native selection button and truly disables locked rows", () => {
		const onSelect = vi.fn();
		render(
			<TreeItemRow label="Intake form" disabled onClick={onSelect}>
				<span>Intake form</span>
				<button type="button">Row options</button>
			</TreeItemRow>,
		);

		const selection = screen.getByRole("button", { name: "Intake form" });
		expect((selection as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(selection);
		expect(onSelect).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Row options" })).toBeDefined();
		expect(screen.queryByRole("treeitem")).toBeNull();
	});

	it("keeps one full Add action without bloating every exact-position seam", () => {
		expect(INSERTION_TRIGGER_CLS).not.toContain("h-11");
		expect(INSERTION_TRIGGER_CLS).not.toContain("-my-");
		expect(INSERTION_TRIGGER_CLS).not.toContain("-mt-");
		expect(INSERTION_TRIGGER_CLS).not.toContain("-mb-");
		expect(INSERTION_TRIGGER_CLS).toContain("nova-focusable-inset");
		expect(INSERTION_TRIGGER_CLS).toContain("group");
		expect(insertionTriggerStyle(false, false)?.height).toBe(8);
		expect(insertionTriggerStyle(true, false)?.height).toBe(44);
		expect(insertionTriggerStyle(false, true)).toBeUndefined();
	});

	it("presents stored case-type identifiers as ordinary user-facing labels", () => {
		expect(moduleCaseTypeLabel("maternal_health_client")).toBe(
			"Maternal health client cases",
		);
		expect(moduleCaseTypeLabel("patient_case")).toBe("Patient cases");
		expect(moduleCaseTypeLabel("Cases")).toBe("Cases");
	});

	it("disambiguates collapsed destinations with their menu path", () => {
		expect(moduleRailPath("Visits", "Care")).toBe("Care › Visits");
		expect(formRailPath("Care › Visits", "Intake")).toBe(
			"Care › Visits › Intake",
		);
	});

	it("keeps module actions at the 44px floor and hides them from viewers and locked states", () => {
		const { rerender } = render(<ModuleActions {...actionProps} />);
		const trigger = screen.getByRole("button", {
			name: "Module actions for Visits",
		});
		expect(trigger.className).toContain("size-11");

		access.canEdit = false;
		rerender(<ModuleActions {...actionProps} />);
		expect(
			screen.queryByRole("button", { name: "Module actions for Visits" }),
		).toBeNull();

		access.canEdit = true;
		rerender(<ModuleActions {...actionProps} locked />);
		expect(
			screen.queryByRole("button", { name: "Module actions for Visits" }),
		).toBeNull();
	});

	it("uses full-size shared actions and preserves focus for two-step delete", async () => {
		const onDelete = vi.fn(() => false);
		render(
			<div className="group">
				<TreeRowDelete label="Delete form" onDelete={onDelete} />
			</div>,
		);

		const arm = screen.getByRole("button", { name: "Delete form" });
		expect(arm.getAttribute("data-slot")).toBe("button");
		expect(arm.className).toContain("size-11");
		fireEvent.click(arm);

		const confirm = screen.getByRole("button", {
			name: "Confirm delete form",
		});
		const cancel = screen.getByRole("button", { name: "Cancel delete" });
		expect(confirm.textContent).toBe("Delete");
		// "Full-size shared actions" is the point of this test: the confirm is
		// the system button at its one height and its one text size, not a
		// downsized copy of it, so there is no text-xs to pin any more.
		expect(confirm.className).toContain("h-11");
		expect(confirm.className).toContain("nova-keycap-rose");
		expect(cancel.className).toContain("size-11");
		await waitFor(() => expect(document.activeElement).toBe(confirm));

		fireEvent.click(confirm);
		expect(onDelete).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Delete form" }),
			),
		);
	});
});
