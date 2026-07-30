// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaseType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type {
	CaseRowWithCalculated,
	LoadCaseDataResult,
} from "@/lib/preview/engine/caseDataBindingTypes";

const mocks = vi.hoisted(() => ({
	state: { kind: "missing" } as LoadCaseDataResult,
	reload: vi.fn(),
}));

vi.mock("@/lib/preview/hooks/useCaseDataBinding", () => ({
	useCaseData: () => ({
		state: mocks.state,
		reload: mocks.reload,
	}),
}));

vi.mock("@/lib/session/hooks", () => ({
	useAccessPhase: () => "authorized",
}));

import { CaseDetailDialog } from "../CaseDetailDialog";

const CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{
			name: "case_name",
			label: proseText("Case name"),
			data_type: "text",
		},
		{
			name: "external_id",
			label: proseText("External ID"),
			data_type: "text",
		},
		{
			name: "status",
			label: proseText("Status"),
			data_type: "text",
		},
		{
			name: "owner_id",
			label: proseText("Owner"),
			data_type: "text",
		},
		{
			name: "date_opened",
			label: proseText("Date opened"),
			data_type: "datetime",
		},
		{
			name: "last_modified",
			label: proseText("Last modified"),
			data_type: "datetime",
		},
		{
			name: "visit_count",
			label: proseText("Visit count"),
			data_type: "int",
		},
		{
			name: "missing_note",
			label: proseText("Missing note"),
			data_type: "text",
		},
	],
};

const OPENED = new Date("2026-07-01T02:03:04.000Z");
const MODIFIED = new Date("2026-07-29T11:12:13.000Z");

function rowByProperty(property: string) {
	const row = screen.getByText(property).closest("tr");
	if (row === null) {
		throw new Error(`Expected a table row for ${property}.`);
	}
	return within(row);
}

describe("CaseDetailDialog", () => {
	beforeEach(() => {
		mocks.reload.mockReset();
		mocks.state = {
			kind: "row",
			ancestors: [],
			row: {
				case_id: "case-1",
				app_id: "app-1",
				case_type: "patient",
				owner_id: "owner-7",
				status: "open",
				opened_on: OPENED,
				modified_on: MODIFIED,
				closed_on: null,
				case_name: "Stored patient name",
				external_id: "EXT-42",
				parent_case_id: null,
				properties: {
					case_name: "shadow case name",
					external_id: "shadow external id",
					status: "shadow status",
					owner_id: "shadow owner",
					date_opened: "shadow opened date",
					last_modified: "shadow modified date",
					visit_count: 7,
					retired_key: false,
				},
				calculated: {},
			} satisfies CaseRowWithCalculated,
		};
	});

	it("renders canonical scalars from their row columns and JSONB values from properties", async () => {
		// The dialog spells each property's authored label against the document;
		// every production mount sits inside the builder's provider.
		render(
			<BlueprintDocProvider appId="app-1">
				<CaseDetailDialog
					appId="app-1"
					caseType={CASE_TYPE}
					caseId="case-1"
					caseName="Patient details"
					onClose={vi.fn()}
				/>
			</BlueprintDocProvider>,
		);

		expect(await screen.findByRole("dialog")).toBeDefined();
		expect(
			rowByProperty("case_name").getByText("Stored patient name"),
		).toBeDefined();
		expect(rowByProperty("external_id").getByText("EXT-42")).toBeDefined();
		expect(rowByProperty("status").getByText("open")).toBeDefined();
		expect(rowByProperty("owner_id").getByText("owner-7")).toBeDefined();
		expect(
			rowByProperty("date_opened").getByText(OPENED.toISOString()),
		).toBeDefined();
		expect(
			rowByProperty("last_modified").getByText(MODIFIED.toISOString()),
		).toBeDefined();
		expect(rowByProperty("visit_count").getByText("7")).toBeDefined();

		// A saved key absent from the current declaration remains visible, while a
		// declared property absent from both scalar columns and JSONB reads Empty.
		expect(rowByProperty("retired_key").getByText("false")).toBeDefined();
		expect(rowByProperty("missing_note").getByText("Empty")).toBeDefined();

		expect(screen.queryByText("shadow case name")).toBeNull();
		expect(screen.queryByText("shadow external id")).toBeNull();
		expect(screen.queryByText("shadow status")).toBeNull();
		expect(screen.queryByText("shadow owner")).toBeNull();
		expect(screen.queryByText("shadow opened date")).toBeNull();
		expect(screen.queryByText("shadow modified date")).toBeNull();
	});
});
