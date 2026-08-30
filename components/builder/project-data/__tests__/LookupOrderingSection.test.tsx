// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import { LookupOrderingSection } from "../LookupOrderingSection";
import type { ProjectDataWorkspace } from "../ProjectDataWorkspaceProvider";

const actions = vi.hoisted(() => ({
	moveColumn: vi.fn(),
	moveRow: vi.fn(),
}));

vi.mock("@/lib/lookup/actions", () => ({
	moveLookupColumnAction: actions.moveColumn,
	moveLookupRowAction: actions.moveRow,
}));

vi.mock("@/lib/session/hooks", () => ({
	useProjectId: () => "project-1",
}));

const TABLE_ID = lookupTableIdSchema.parse(
	"01990b9f-2044-7e05-8c67-1252ece21c9a",
);
const COLUMN_A = lookupColumnIdSchema.parse(
	"01990b9f-2044-7e05-8c67-1252ece21ca1",
);
const COLUMN_B = lookupColumnIdSchema.parse(
	"01990b9f-2044-7e05-8c67-1252ece21ca2",
);
const COLUMN_C = lookupColumnIdSchema.parse(
	"01990b9f-2044-7e05-8c67-1252ece21ca3",
);
const ROW_A = lookupRowIdSchema.parse("01990b9f-2044-7e05-8c67-1252ece21cb1");
const ROW_B = lookupRowIdSchema.parse("01990b9f-2044-7e05-8c67-1252ece21cb2");
const ROW_C = lookupRowIdSchema.parse("01990b9f-2044-7e05-8c67-1252ece21cb3");
const REVISION = lookupRevisionSchema.parse("7");

function column(
	id: typeof COLUMN_A | typeof COLUMN_B | typeof COLUMN_C,
	label: string,
) {
	return {
		id,
		label,
		wireName: label.toLowerCase(),
		dataType: "text" as const,
	};
}

function row(id: typeof ROW_A | typeof ROW_B | typeof ROW_C, value: string) {
	return {
		id,
		values: { [COLUMN_A]: value },
		valueBytes: value.length,
		createdBy: "user-1",
		updatedBy: "user-1",
		createdAt: "2026-08-29T00:00:00.000Z",
		updatedAt: "2026-08-29T00:00:00.000Z",
	};
}

function table(
	columns = [
		column(COLUMN_A, "Code"),
		column(COLUMN_B, "Label"),
		column(COLUMN_C, "Group"),
	],
	rows = [row(ROW_A, "a"), row(ROW_B, "b"), row(ROW_C, "c")],
): LookupTableSnapshot {
	return {
		projectId: "project-1",
		projectRevision: REVISION,
		id: TABLE_ID,
		name: "Facilities",
		tag: "facilities",
		columns,
		columnCount: columns.length,
		rows,
		rowCount: rows.length,
		dataBytes: rows.reduce((total, item) => total + item.valueBytes, 0),
		createdBy: "user-1",
		updatedBy: "user-1",
		createdAt: "2026-08-29T00:00:00.000Z",
		updatedAt: "2026-08-29T00:00:00.000Z",
		definitionRevision: REVISION,
		rowsRevision: REVISION,
		tableRevision: REVISION,
	};
}

function workspace(reload = vi.fn(async () => {})): ProjectDataWorkspace {
	return { reload } as unknown as ProjectDataWorkspace;
}

function success() {
	return {
		success: true as const,
		value: {
			projectRevision: lookupRevisionSchema.parse("8"),
			definitionRevision: lookupRevisionSchema.parse("8"),
			rowsRevision: REVISION,
			tableRevision: lookupRevisionSchema.parse("8"),
		},
	};
}

describe("LookupOrderingSection", () => {
	beforeEach(() => {
		actions.moveColumn.mockResolvedValue(success());
		actions.moveRow.mockResolvedValue(success());
	});

	it("moves a column against the displayed revision and keeps keyboard focus after refresh", async () => {
		const reload = vi.fn(async () => {});
		const current = table();
		const controller = workspace(reload);
		const { rerender } = render(
			<LookupOrderingSection
				kind="column"
				itemId={COLUMN_B}
				table={current}
				workspace={controller}
				canEdit
			/>,
		);

		expect(screen.getByText("Position 2 of 3")).toBeDefined();
		const moveLeft = screen.getByRole("button", { name: "Move left" });
		act(() => moveLeft.focus());
		fireEvent.click(moveLeft);

		await waitFor(() =>
			expect(actions.moveColumn).toHaveBeenCalledWith("project-1", {
				tableId: TABLE_ID,
				expectedTableRevision: REVISION,
				columnId: COLUMN_B,
				toIndex: 0,
			}),
		);
		expect((await screen.findByRole("status")).textContent).toBe(
			"Column moved earlier.",
		);
		expect(reload).toHaveBeenCalledTimes(1);

		rerender(
			<LookupOrderingSection
				kind="column"
				itemId={COLUMN_B}
				table={table([
					column(COLUMN_B, "Label"),
					column(COLUMN_A, "Code"),
					column(COLUMN_C, "Group"),
				])}
				workspace={controller}
				canEdit
			/>,
		);
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Move right" }),
		);
		expect(
			(screen.getByRole("button", { name: "Move left" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("uses row ordering, disables both edges, and explains a locally disabled edit", async () => {
		const current = table();
		const controller = workspace();
		const { rerender } = render(
			<LookupOrderingSection
				kind="row"
				itemId={ROW_A}
				table={current}
				workspace={controller}
				canEdit
			/>,
		);

		expect(
			(screen.getByRole("button", { name: "Move up" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Move down" }));
		await waitFor(() =>
			expect(actions.moveRow).toHaveBeenCalledWith("project-1", {
				tableId: TABLE_ID,
				expectedTableRevision: REVISION,
				rowId: ROW_A,
				toIndex: 1,
			}),
		);

		rerender(
			<LookupOrderingSection
				kind="row"
				itemId={ROW_C}
				table={current}
				workspace={controller}
				canEdit
				disabled
				disabledReason="Save or discard your row changes before moving this row."
			/>,
		);
		expect(
			(screen.getByRole("button", { name: "Move down" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: "Move up" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			screen.getByText(
				"Save or discard your row changes before moving this row.",
			),
		).toBeDefined();
	});

	it("shows position without edit controls to a viewer", () => {
		render(
			<LookupOrderingSection
				kind="column"
				itemId={COLUMN_B}
				table={table()}
				workspace={workspace()}
				canEdit={false}
			/>,
		);

		expect(screen.getByText("Position 2 of 3")).toBeDefined();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("reloads and asks for review instead of retrying a stale move", async () => {
		const reload = vi.fn(async () => {});
		actions.moveColumn.mockResolvedValue({
			success: false,
			code: "conflict",
			message: "This lookup table changed since it was loaded.",
			currentRevisions: {
				projectRevision: lookupRevisionSchema.parse("8"),
				definitionRevision: lookupRevisionSchema.parse("8"),
				rowsRevision: REVISION,
				tableRevision: lookupRevisionSchema.parse("8"),
			},
		});
		render(
			<LookupOrderingSection
				kind="column"
				itemId={COLUMN_B}
				table={table()}
				workspace={workspace(reload)}
				canEdit
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Move right" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Nova refreshed its order");
		expect(actions.moveColumn).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
