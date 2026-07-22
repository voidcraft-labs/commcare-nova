// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Uuid } from "@/lib/doc/types";
import type { CaseType } from "@/lib/domain";
import type {
	LoadCaseCountResult,
	PopulateSampleCasesResult,
} from "@/lib/preview/engine/caseDataBindingTypes";
import { BuilderSessionProvider } from "@/lib/session/provider";

const mocks = vi.hoisted(() => ({
	countState: { kind: "count", count: 0 } as
		| LoadCaseCountResult
		| { kind: "idle" }
		| { kind: "loading" },
	parkedState: { kind: "entries", entries: [] } as unknown,
	populate: vi.fn(),
	reset: vi.fn(),
	reloadCount: vi.fn(),
	showToast: vi.fn(),
	openDataReview: vi.fn(),
	setPreviewing: vi.fn(),
}));

vi.mock("@/lib/preview/hooks/useCaseDataBinding", () => ({
	useCaseCount: () => ({
		state: mocks.countState,
		fetching: false,
		reload: mocks.reloadCount,
	}),
	useParkedValues: () => ({
		state: mocks.parkedState,
		fetching: false,
		reload: vi.fn(),
	}),
	usePopulateSampleCases: () => mocks.populate,
	useResetSampleCases: () => mocks.reset,
}));

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ openDataReview: mocks.openDataReview }),
}));

vi.mock("@/lib/session/hooks", () => ({
	useAccessPhase: () => "authorized",
	useProjectScopeEpoch: () => 0,
	useSetPreviewing: () => mocks.setPreviewing,
}));

vi.mock("@/lib/ui/toastStore", () => ({
	showToast: mocks.showToast,
}));

import { CaseDataManager } from "../CaseDataManager";

const PATIENT: CaseType = { name: "patient", properties: [] };
const CLIENTS: CaseType = { name: "clients", properties: [] };
const EMPTY_TRIGGER_LABEL =
	"Case data for Patient. 0 cases. Case data is shared throughout your app";
const POPULATED_TRIGGER_LABEL =
	"Case data for Patient. 7 cases. Case data is shared throughout your app";
const UNAVAILABLE_TRIGGER_LABEL =
	"Case data for Patient. Case count unavailable. Case data is shared throughout your app";

/** The popover description's full text, chip and all — the case-type
 *  name renders as a reference-style chip inside the paragraph, so
 *  assertions match the paragraph's assembled textContent rather than
 *  one text node. The chip carries the case type's NAME (the id the
 *  `#patient/…` references use), not a humanized label. */
const scopeDescription =
	(verb: "Add or replace" | "View", label: string) =>
	(_content: string, element: Element | null) =>
		element?.tagName === "P" &&
		element.textContent ===
			`${verb} the cases saved for the ${label} case type. They’re used throughout your app and in Preview.`;

beforeEach(() => {
	mocks.countState = { kind: "count", count: 0 };
	mocks.populate.mockReset();
	mocks.reset.mockReset();
	mocks.reloadCount.mockReset();
	mocks.showToast.mockReset();
});

function renderManager(
	canEdit = true,
	hasLinkedChildren = false,
	caseType = PATIENT,
) {
	return render(
		<BuilderSessionProvider
			init={{
				projectId: "project-case-manager",
				role: canEdit ? "editor" : "viewer",
				canEdit,
			}}
		>
			<CaseDataManager
				appId="app-case-manager"
				moduleUuid={"00000000-0000-7000-8000-000000000001" as Uuid}
				caseType={caseType}
				canEdit={canEdit}
				hasLinkedChildren={hasLinkedChildren}
			/>
		</BuilderSessionProvider>,
	);
}

describe("CaseDataManager", () => {
	it("opens on its explanation instead of scrolling directly to an action", async () => {
		mocks.countState = { kind: "count", count: 7 };
		renderManager();

		fireEvent.click(
			screen.getByRole("button", {
				name: POPULATED_TRIGGER_LABEL,
			}),
		);

		const title = screen.getByRole("heading", { name: "Case data" });
		await waitFor(() => expect(document.activeElement).toBe(title));
		expect(screen.getByRole("button", { name: "Replace case data" })).not.toBe(
			document.activeElement,
		);
	});

	it("shows the complete count and creates samples only when empty", async () => {
		mocks.populate.mockResolvedValue({ kind: "ok", inserted: 1 });
		renderManager();

		const trigger = screen.getByRole("button", {
			name: EMPTY_TRIGGER_LABEL,
		});
		fireEvent.click(trigger);

		const popover = within(screen.getByRole("dialog"));
		expect(
			popover.getByText(
				(_content, element) =>
					element?.tagName === "P" && element.textContent === "0 cases",
			),
		).toBeTruthy();
		expect(
			screen.getByText("Add sample cases to try Search, Results, and Details"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Add sample cases" }));

		await waitFor(() => expect(mocks.populate).toHaveBeenCalledTimes(1));
		expect(mocks.reset).not.toHaveBeenCalled();
		expect(mocks.showToast).toHaveBeenCalledWith(
			"info",
			"Sample cases created",
			"1 case is ready to use in Preview",
		);
	});

	it("requires an explicit destructive confirmation before replacing every case", async () => {
		mocks.countState = { kind: "count", count: 7 };
		mocks.reset.mockResolvedValue({ kind: "ok", inserted: 30 });
		renderManager();

		fireEvent.click(
			screen.getByRole("button", {
				name: POPULATED_TRIGGER_LABEL,
			}),
		);
		const replaceCaseData = screen.getByRole("button", {
			name: "Replace case data",
		});
		expect(replaceCaseData.className).toContain("bg-destructive");
		fireEvent.click(replaceCaseData);

		expect(mocks.reset).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", {
				name: "Replace all 7 cases?",
			}),
		).toBeTruthy();
		expect(screen.getByRole("alertdialog").textContent).toContain(
			"All “Patient” cases will be replaced throughout the app",
		);
		expect(
			screen.getByText(/including cases added by hand or through Preview/i),
		).toBeTruthy();
		expect(screen.getByText(/You can't undo this/i)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
		expect(mocks.populate).not.toHaveBeenCalled();
		expect(mocks.showToast).toHaveBeenCalledWith(
			"info",
			"Case data replaced",
			"30 cases are ready to use in Preview",
		);
	});

	it("names the app-wide case scope shared by every module", () => {
		mocks.countState = { kind: "count", count: 7 };
		renderManager();

		const trigger = screen.getByRole("button", {
			name: POPULATED_TRIGGER_LABEL,
		});
		expect(trigger.textContent).toContain("Case data");
		expect(
			within(trigger)
				.getByText("Case data")
				.parentElement?.classList.contains("hidden"),
		).toBe(false);
		fireEvent.click(trigger);

		expect(
			screen.getByText(scopeDescription("Add or replace", "patient")),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Replace case data" }));

		expect(
			screen.getByText(
				/New sample cases will appear everywhere this case type is used\./,
			),
		).toBeTruthy();
	});

	it("discloses that replacing parents clears links on surviving child cases", () => {
		mocks.countState = { kind: "count", count: 7 };
		renderManager(true, true);

		fireEvent.click(
			screen.getByRole("button", {
				name: POPULATED_TRIGGER_LABEL,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Replace case data" }));

		expect(
			screen.getByText(
				/Linked cases will stay, but they’ll lose their links to the cases you’re replacing/i,
			),
		).toBeTruthy();
	});

	it("keeps case counts visible but gates write controls for viewers", async () => {
		mocks.countState = { kind: "count", count: 0 };
		renderManager(false);

		const trigger = screen.getByRole("button", {
			name: EMPTY_TRIGGER_LABEL,
		});
		fireEvent.click(trigger);
		expect(
			await screen.findByText(
				"No case data is available for Search, Results, or Details",
			),
		).toBeTruthy();
		expect(screen.getByText(scopeDescription("View", "patient"))).toBeTruthy();
		expect(
			screen.queryByText(scopeDescription("Add or replace", "patient")),
		).toBeNull();
		expect(
			screen.getByText(
				"You can view case data, but you can’t add or replace it",
			),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Add sample cases/i }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Replace case data" }),
		).toBeNull();

		// Close the floating panel and let Base UI restore focus before the
		// leak detector tears the test down.
		fireEvent.click(trigger);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("keeps count failures friendly and offers the hook's retry action", () => {
		mocks.countState = {
			kind: "error",
			message: "password authentication failed for database nova",
		};
		renderManager();

		fireEvent.click(
			screen.getByRole("button", {
				name: UNAVAILABLE_TRIGGER_LABEL,
			}),
		);

		expect(screen.getByText("Case data didn’t load")).toBeTruthy();
		expect(screen.getByText("Try again to view case data")).toBeTruthy();
		expect(screen.queryByText(/password authentication/i)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(mocks.reloadCount).toHaveBeenCalledTimes(1);
	});

	it("never exposes a sample-data action's server message", async () => {
		mocks.populate.mockResolvedValue({
			kind: "error",
			message: "insert into cases violated internal_constraint_42",
		});
		renderManager();

		fireEvent.click(
			screen.getByRole("button", {
				name: EMPTY_TRIGGER_LABEL,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Add sample cases" }));

		expect(
			await screen.findByText("Nova couldn't add sample cases. Try again."),
		).toBeTruthy();
		expect(screen.queryByText(/internal_constraint_42/i)).toBeNull();
	});

	it("keeps sample creation open through outside press and Escape until a failure is visible", async () => {
		let resolvePopulate!: (result: PopulateSampleCasesResult) => void;
		mocks.populate.mockImplementation(
			() =>
				new Promise<PopulateSampleCasesResult>((resolve) => {
					resolvePopulate = resolve;
				}),
		);
		renderManager();

		fireEvent.click(screen.getByRole("button", { name: EMPTY_TRIGGER_LABEL }));
		fireEvent.click(screen.getByRole("button", { name: "Add sample cases" }));
		await waitFor(() => expect(mocks.populate).toHaveBeenCalledOnce());
		const pendingTitle = screen.getByRole("heading", { name: "Case data" });
		await waitFor(() => expect(document.activeElement).toBe(pendingTitle));
		expect(pendingTitle.tabIndex).toBe(0);
		expect(screen.getByRole("status").textContent).toBe("Adding sample cases…");

		fireEvent.pointerDown(document.body, {
			button: 0,
			pointerType: "mouse",
		});
		document.body.focus();
		await waitFor(() => expect(document.activeElement).toBe(pendingTitle));
		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
			code: "Escape",
		});
		const pendingDialog = screen.getByRole("dialog", { name: "Case data" });
		expect(pendingDialog).toBeDefined();
		expect(pendingDialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).toBe(pendingTitle);
		const pendingFocusGuards = Array.from(
			document.querySelectorAll<HTMLElement>("[data-base-ui-focus-guard]"),
		);
		expect(pendingFocusGuards.length).toBeGreaterThanOrEqual(2);
		pendingFocusGuards.at(-1)?.focus();
		await waitFor(() => expect(document.activeElement).toBe(pendingTitle));

		await act(async () => {
			resolvePopulate({
				kind: "error",
				message: "database internals must stay hidden",
			});
			await Promise.resolve();
		});
		expect(
			await screen.findByText("Nova couldn't add sample cases. Try again."),
		).toBeTruthy();
		expect(screen.queryByText(/database internals/i)).toBeNull();

		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
			code: "Escape",
		});
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "Case data" })).toBeNull(),
		);
	});

	it("keeps replacement confirmation open through Escape until a failure is visible", async () => {
		mocks.countState = { kind: "count", count: 7 };
		let resolveReset!: (result: PopulateSampleCasesResult) => void;
		mocks.reset.mockImplementation(
			() =>
				new Promise<PopulateSampleCasesResult>((resolve) => {
					resolveReset = resolve;
				}),
		);
		renderManager();

		fireEvent.click(
			screen.getByRole("button", { name: POPULATED_TRIGGER_LABEL }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Replace case data" }));
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		await waitFor(() => expect(mocks.reset).toHaveBeenCalledOnce());
		const pendingTitle = screen.getByRole("heading", {
			name: "Replace all 7 cases?",
		});
		await waitFor(() => expect(document.activeElement).toBe(pendingTitle));
		expect(pendingTitle.tabIndex).toBe(0);
		expect(screen.getByRole("status").textContent).toBe("Replacing case data…");
		const overlay = document.querySelector<HTMLElement>(
			"[data-slot='alert-dialog-overlay']",
		);
		expect(overlay).not.toBeNull();
		fireEvent.pointerDown(overlay as HTMLElement, {
			button: 0,
			pointerType: "mouse",
		});
		document.body.focus();
		await waitFor(() => expect(document.activeElement).toBe(pendingTitle));

		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
			code: "Escape",
		});
		const alertDialog = screen.getByRole("alertdialog");
		expect(alertDialog).toBeDefined();
		expect(alertDialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).toBe(pendingTitle);
		const pendingFocusGuards = Array.from(
			document.querySelectorAll<HTMLElement>("[data-base-ui-focus-guard]"),
		);
		expect(pendingFocusGuards.length).toBeGreaterThanOrEqual(2);
		pendingFocusGuards.at(-1)?.focus();
		await waitFor(() => expect(document.activeElement).toBe(pendingTitle));

		await act(async () => {
			resolveReset({
				kind: "error",
				message: "database internals must stay hidden",
			});
			await Promise.resolve();
		});
		expect(
			await screen.findByText(
				"Your current cases weren't changed. Nova couldn't replace the case data. Try again.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/database internals/i)).toBeNull();

		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
			code: "Escape",
		});
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("names plural authored case types without producing double plurals", async () => {
		mocks.countState = { kind: "count", count: 7 };
		renderManager(true, false, CLIENTS);

		const trigger = screen.getByRole("button", {
			name: "Case data for Clients. 7 cases. Case data is shared throughout your app",
		});
		fireEvent.click(trigger);
		expect(
			screen.getByText(scopeDescription("Add or replace", "clients")),
		).toBeTruthy();
		expect(screen.queryByText(/Clients cases/i)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Replace case data" }));
		expect(
			screen.getByRole("heading", {
				name: "Replace all 7 cases?",
			}),
		).toBeTruthy();
		expect(screen.getByRole("alertdialog").textContent).toContain(
			"All “Clients” cases will be replaced throughout the app",
		);
		expect(screen.getByRole("alertdialog").textContent).not.toContain(
			"Clients cases",
		);

		// Let Base UI finish its initial-focus task, then close the modal before
		// teardown so the async-leak gate observes the same settled lifecycle as a
		// user leaving the confirmation.
		await waitFor(() =>
			expect(
				screen.getByRole("alertdialog").contains(document.activeElement),
			).toBe(true),
		);
		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
			code: "Escape",
		});
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});
