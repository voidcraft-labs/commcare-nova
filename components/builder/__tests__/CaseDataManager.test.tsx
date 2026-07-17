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
	it("shows the explicit unfiltered count and creates samples only when empty", async () => {
		mocks.populate.mockResolvedValue({ kind: "ok", inserted: 30 });
		renderManager();

		const trigger = screen.getByRole("button", {
			name: "Case data, 0 cases",
		});
		fireEvent.click(trigger);

		expect(
			within(screen.getByRole("dialog")).getByText("0 cases"),
		).toBeTruthy();
		expect(screen.getByText(/This total is unfiltered/i)).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Create sample cases" }),
		);

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

		fireEvent.click(screen.getByRole("button", { name: "Case data, 7 cases" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Replace all 7 cases…" }),
		);

		expect(mocks.reset).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", { name: "Replace all 7 cases?" }),
		).toBeTruthy();
		expect(
			screen.getByText(/including cases entered by hand or through Preview/i),
		).toBeTruthy();
		expect(screen.getByText(/This cannot be undone/i)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Replace 7 cases" }));
		await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
		expect(mocks.populate).not.toHaveBeenCalled();
	});

	it("discloses that replacing parents clears links on surviving child cases", () => {
		mocks.countState = { kind: "count", count: 7 };
		renderManager(true, true);

		fireEvent.click(screen.getByRole("button", { name: "Case data, 7 cases" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Replace all 7 cases…" }),
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
			name: "Case data, 12 cases",
		});
		fireEvent.click(trigger);
		expect(
			await screen.findByText("Only editors can create or replace case data."),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Create sample cases/i }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /Replace all/i })).toBeNull();

		// Close the floating panel and let Base UI restore focus before the
		// leak detector tears the test down.
		fireEvent.click(trigger);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
