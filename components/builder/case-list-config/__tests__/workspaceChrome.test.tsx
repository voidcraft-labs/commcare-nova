// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid, type Column } from "@/lib/domain";
import { CaseListCanvas } from "../canvas/CaseListCanvas";
import { SupportingColumnInventory } from "../canvas/ColumnInventory";
import { DisplayOrderStack } from "../DisplayOrderStack";

function column(
	uuid: string,
	order: string,
	visibility: Pick<Column, "visibleInList" | "visibleInDetail"> = {},
): Column {
	return {
		uuid: asUuid(uuid),
		order,
		kind: "plain",
		field: uuid,
		header: uuid,
		...visibility,
	};
}

describe("case workspace chrome", () => {
	it("opens a supporting inventory and names its aggregate error", async () => {
		const hidden = column("00000000-0000-4000-8000-000000000001", "a", {
			visibleInList: false,
		});

		render(
			<SupportingColumnInventory
				columns={[hidden]}
				surface="list"
				selectedUuid={null}
				brokenColumns={new Set([hidden.uuid])}
				onSelect={() => {}}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: /supporting fields 1 field needs attention 1/i,
		});
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(
			screen.getByRole("button", { name: new RegExp(hidden.header) }),
		).toBeDefined();
		// Base UI's controlled Collapsible settles its mount/open transition in
		// an animation frame. Flush it while the component is still mounted so
		// the async-leak detector does not inherit the pending Happy DOM task.
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
	});

	it("renders every field in canonical order and reorders from the keyboard", () => {
		const listOnly = column("00000000-0000-4000-8000-000000000011", "a", {
			visibleInDetail: false,
		});
		const supporting = column("00000000-0000-4000-8000-000000000012", "b", {
			visibleInList: false,
			visibleInDetail: false,
		});
		const detailOnly = column("00000000-0000-4000-8000-000000000013", "c", {
			visibleInList: false,
		});
		const onChange = vi.fn();

		render(
			<DisplayOrderStack
				value={[detailOnly, listOnly, supporting]}
				onChange={onChange}
			/>,
		);

		expect(screen.getByText("Supporting only")).toBeDefined();
		const firstHandle = screen.getByRole("button", {
			name: new RegExp(`reorder ${listOnly.header}`, "i"),
		});
		expect(firstHandle.getAttribute("aria-label")).toContain("position 1 of 3");
		fireEvent.keyDown(firstHandle, { key: "ArrowDown" });

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(
			onChange.mock.calls[0]?.[0].map((entry: Column) => entry.uuid),
		).toEqual([supporting.uuid, listOnly.uuid, detailOnly.uuid]);
		expect(screen.getByRole("status").textContent).toContain(
			"moved to position 2 of 3",
		);
	});

	it("keeps a filter-error notice findable when no list fields are shown", () => {
		const message = "Open Filter and repair its invalid condition.";

		render(
			<CaseListCanvas
				config={{ columns: [], searchInputs: [] }}
				brokenColumns={new Set()}
				moduleName="Patients"
				preview={{ kind: "paused", message }}
				selection={null}
				onSelect={() => {}}
				onAddColumn={() => {}}
				addColumnDisabledReason={undefined}
				generateSampleData={{
					status: { kind: "idle" },
					run: async () => {},
				}}
			/>,
		);

		expect(screen.getByText(message)).toBeDefined();
		expect(screen.queryByText(/generate realistic cases/i)).toBeNull();
	});
});
