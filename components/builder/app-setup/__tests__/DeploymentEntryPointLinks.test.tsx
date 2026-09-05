// @vitest-environment happy-dom
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { DeploymentView } from "@/lib/deployment/actions";
import { DeploymentEntryPointLinks } from "../DeploymentEntryPointLinks";

const mocks = vi.hoisted(() => ({
	call: vi.fn(),
	barrier: vi.fn(),
	current: vi.fn(() => true),
	canEdit: true,
	entries: [] as unknown[],
}));
const reconciler = { reconciler: { waitForHumanSaveBarrier: mocks.barrier } };
vi.mock("@/lib/collab/context", () => ({
	useReconcilerContext: () => reconciler,
}));
vi.mock("@/lib/deployment/actions", () => ({
	getEntryPointLinkAction: (...args: unknown[]) => mocks.call(...args),
}));
vi.mock("@/lib/doc/hooks/useEntryPoints", () => ({
	useEntryPoints: () => ({ entries: mocks.entries, isCurrent: mocks.current }),
}));
vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ openAppSetup: vi.fn() }),
}));
vi.mock("@/lib/session/hooks", () => ({ useCanEdit: () => mocks.canEdit }));
const uuid = testUuid("hq-entry");
const moduleUuid = testUuid("hq-module");
const view = {
	deployment: { deployment: { server: "india", domain: "test-space" } },
} as DeploymentView;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.current.mockReturnValue(true);
	mocks.barrier.mockResolvedValue({ kind: "saved" });
	mocks.canEdit = true;
	mocks.entries = [
		{
			label: "Visit",
			entryPoint: { uuid, id: "visit" },
			requiredSelections: [
				{
					moduleUuid,
					caseType: "patient",
					cardinality: "multiple",
					maximum: 3,
				},
			],
		},
	];
	mocks.call.mockResolvedValue({
		success: false,
		message: "Release this app first, then try again.",
	});
});
describe("published entry point links", () => {
	it("sends external IDs in order to the selected server and retains them on refusal", async () => {
		render(<DeploymentEntryPointLinks appId="app" view={view} />);
		fireEvent.click(screen.getByRole("button", { name: "Visit" }));
		fireEvent.change(screen.getByLabelText("patient case IDs"), {
			target: { value: "hq-second\nhq-first" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Generate HQ link" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"Release this app",
			),
		);
		expect(mocks.call).toHaveBeenCalledWith({
			appId: "app",
			server: "india",
			domain: "test-space",
			entryPointUuid: uuid,
			selections: [{ moduleUuid, caseIds: ["hq-second", "hq-first"] }],
		});
		expect(
			(screen.getByLabelText("patient case IDs") as HTMLTextAreaElement).value,
		).toBe("hq-second\nhq-first");
	});
	it("does not expose a late link when document authority changes", async () => {
		let resolve: (value: unknown) => void = () => {};
		mocks.call.mockReturnValue(
			new Promise((value) => {
				resolve = value;
			}),
		);
		render(<DeploymentEntryPointLinks appId="app" view={view} />);
		fireEvent.click(screen.getByRole("button", { name: "Visit" }));
		fireEvent.change(screen.getByLabelText("patient case IDs"), {
			target: { value: "hq-one" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Generate HQ link" }));
		await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce());
		mocks.current.mockReturnValue(false);
		await act(async () =>
			resolve({
				success: true,
				data: {
					url: "https://india.commcarehq.org/link",
					checkedAt: "2026-09-04T00:00:00Z",
				},
			}),
		);
		expect(screen.queryByLabelText("CommCare HQ deep link")).toBeNull();
	});
	it("rechecks before copying and never copies after the fresh verifier refuses", async () => {
		const clipboard = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockResolvedValue();
		mocks.call
			.mockResolvedValueOnce({
				success: true,
				data: {
					url: "https://india.commcarehq.org/link",
					checkedAt: "2026-09-04T00:00:00Z",
				},
			})
			.mockResolvedValueOnce({
				success: false,
				message: "The released build changed. Check it again after publishing.",
			});
		render(<DeploymentEntryPointLinks appId="app" view={view} />);
		fireEvent.click(screen.getByRole("button", { name: "Visit" }));
		fireEvent.change(screen.getByLabelText("patient case IDs"), {
			target: { value: "hq-one" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Generate HQ link" }));
		await screen.findByRole("button", { name: "Copy HQ link" });
		fireEvent.click(screen.getByRole("button", { name: "Copy HQ link" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"released build changed",
			),
		);
		expect(mocks.call).toHaveBeenCalledTimes(2);
		expect(clipboard).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("CommCare HQ deep link")).toBeNull();
		clipboard.mockRestore();
	});
	it("waits for the canonical save and refuses without calling HQ when saving stops", async () => {
		mocks.barrier.mockResolvedValue({ kind: "blocked" });
		render(<DeploymentEntryPointLinks appId="app" view={view} />);
		fireEvent.click(screen.getByRole("button", { name: "Visit" }));
		fireEvent.change(screen.getByLabelText("patient case IDs"), {
			target: { value: "hq-one" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Generate HQ link" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("finish saving"),
		);
		expect(mocks.barrier).toHaveBeenCalledOnce();
		expect(mocks.call).not.toHaveBeenCalled();
		expect(
			(screen.getByLabelText("patient case IDs") as HTMLTextAreaElement).value,
		).toBe("hq-one");
	});
	it("does not offer verification writes to viewers", () => {
		mocks.canEdit = false;
		render(<DeploymentEntryPointLinks appId="app" view={view} />);
		fireEvent.click(screen.getByRole("button", { name: "Visit" }));
		expect(
			screen.queryByRole("button", { name: "Generate HQ link" }),
		).toBeNull();
		expect(mocks.call).not.toHaveBeenCalled();
	});
});
