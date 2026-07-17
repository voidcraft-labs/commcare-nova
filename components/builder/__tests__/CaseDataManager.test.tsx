// @vitest-environment happy-dom

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import type { LoadCaseCountResult } from "@/lib/preview/engine/caseDataBindingTypes";

const mocks = vi.hoisted(() => ({
	countState: { kind: "count", count: 0 } as
		| LoadCaseCountResult
		| { kind: "idle" }
		| { kind: "loading" },
	populate: vi.fn(),
	reset: vi.fn(),
	showToast: vi.fn(),
}));

vi.mock("@/lib/preview/hooks/useCaseDataBinding", () => ({
	useCaseCount: () => ({
		state: mocks.countState,
		fetching: false,
		reload: vi.fn(),
	}),
	usePopulateSampleCases: () => mocks.populate,
	useResetSampleCases: () => mocks.reset,
}));

vi.mock("@/lib/ui/toastStore", () => ({
	showToast: mocks.showToast,
}));

import { CaseDataManager } from "../CaseDataManager";

const PATIENT: CaseType = { name: "patient", properties: [] };

beforeEach(() => {
	mocks.countState = { kind: "count", count: 0 };
	mocks.populate.mockReset();
	mocks.reset.mockReset();
	mocks.showToast.mockReset();
});

function renderManager(canEdit = true, hasLinkedChildren = false) {
	return render(
		<CaseDataManager
			appId="app-case-manager"
			caseType={PATIENT}
			canEdit={canEdit}
			hasLinkedChildren={hasLinkedChildren}
		/>,
	);
}

describe("CaseDataManager", () => {
	it("shows the complete count and creates samples only when empty", async () => {
		mocks.populate.mockResolvedValue({ kind: "ok", inserted: 30 });
		renderManager();

		const trigger = screen.getByRole("button", {
			name: "Case data for Patient, 0 cases, shared across this app",
		});
		fireEvent.click(trigger);

		const popover = within(screen.getByRole("dialog"));
		expect(
			popover.getByText(
				(_content, element) =>
					element?.tagName === "P" && element.textContent === "0 cases",
			),
		).toBeTruthy();
		expect(screen.getByText(/No cases yet/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Add sample cases" }));

		await waitFor(() => expect(mocks.populate).toHaveBeenCalledTimes(1));
		expect(mocks.reset).not.toHaveBeenCalled();
		expect(mocks.showToast).toHaveBeenCalledWith(
			"info",
			"Sample cases created",
			"30 cases are ready to use in Preview.",
		);
	});

	it("requires an explicit destructive confirmation before replacing every case", async () => {
		mocks.countState = { kind: "count", count: 7 };
		mocks.reset.mockResolvedValue({ kind: "ok", inserted: 30 });
		renderManager();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Case data for Patient, 7 cases, shared across this app",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Replace all 7 Patient cases…" }),
		);

		expect(mocks.reset).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", { name: "Replace all 7 Patient cases?" }),
		).toBeTruthy();
		expect(
			screen.getByText(/including cases entered by hand or through Preview/i),
		).toBeTruthy();
		expect(screen.getByText(/This cannot be undone/i)).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Replace 7 Patient cases" }),
		);
		await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
		expect(mocks.populate).not.toHaveBeenCalled();
	});

	it("names the app-wide case scope shared by every module", () => {
		mocks.countState = { kind: "count", count: 7 };
		renderManager();

		const trigger = screen.getByRole("button", {
			name: "Case data for Patient, 7 cases, shared across this app",
		});
		expect(trigger.textContent).toContain("Case data");
		fireEvent.click(trigger);

		expect(
			screen.getByText(
				"All Patient cases in this app. Every module that works with Patient cases shares this data in Preview.",
			),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Replace all 7 Patient cases…" }),
		);

		expect(
			screen.getByText(
				/Every module that works with Patient cases will see the replacement\./,
			),
		).toBeTruthy();
	});

	it("discloses that replacing parents clears links on surviving child cases", () => {
		mocks.countState = { kind: "count", count: 7 };
		renderManager(true, true);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Case data for Patient, 7 cases, shared across this app",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Replace all 7 Patient cases…" }),
		);

		expect(
			screen.getByText(
				/Cases elsewhere in this app that are linked to these cases will be kept, but those links will be cleared/i,
			),
		).toBeTruthy();
	});

	it("keeps case counts visible but gates write controls for viewers", async () => {
		mocks.countState = { kind: "count", count: 12 };
		renderManager(false);

		const trigger = screen.getByRole("button", {
			name: "Case data for Patient, 12 cases, shared across this app",
		});
		fireEvent.click(trigger);
		expect(
			await screen.findByText("Only editors can create or replace case data."),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Add sample cases/i }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /Replace all/i })).toBeNull();

		// Close the floating panel and let Base UI restore focus before the
		// leak detector tears the test down.
		fireEvent.click(trigger);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
