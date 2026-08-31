// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import {
	PublishDialog,
	type PublishDownloadOutcome,
} from "@/components/builder/PublishDialog";
import {
	PROJECT_SPACE_ADVISORIES,
	PROJECT_SPACE_CAPABILITIES,
	PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
	type ProjectSpaceCompatibilityReport,
} from "@/lib/publish/projectSpaceCompatibility";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	renderCanEdit: true,
	noteDeploymentRecordsChanged: vi.fn(),
	sessionState: {
		accessPhase: "authorized" as const,
		canEdit: true,
		scopeEpoch: 0,
	},
}));

vi.mock("@/lib/deployment/actions", () => ({
	readDeploymentsAction: vi.fn(async () => ({ success: true, data: [] })),
	refreshDeploymentAction: vi.fn(),
}));
vi.mock("@/lib/collab/context", () => ({
	useReconcilerContext: () => null,
}));
vi.mock("@/lib/doc/hooks/useAppName", () => ({
	useAppName: () => "Maternal Health",
}));
vi.mock("@/lib/session/hooks", () => ({
	useAccessPhase: () => "authorized",
	useCanEdit: () => mocks.renderCanEdit,
	useNoteDeploymentRecordsChanged: () => mocks.noteDeploymentRecordsChanged,
}));
vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => mocks.sessionState,
	}),
}));

const caseSearch = {
	...PROJECT_SPACE_CAPABILITIES["case-search"],
	reasons: ["The Patients module searches across available cases."],
};
const caseAttachments = {
	...PROJECT_SPACE_CAPABILITIES["case-attachments"],
	reasons: ["The Visit photo question saves its file on the case."],
};
const largeSearch = {
	...PROJECT_SPACE_ADVISORIES["large-search-performance"],
	reasons: caseSearch.reasons,
};

const uncheckedReport: ProjectSpaceCompatibilityReport = {
	status: "not_checked",
	required_capabilities: [{ ...caseSearch, state: "not_checked" }],
	blockers: [],
	advisories: [
		{
			...largeSearch,
			state: "not_checked",
			message:
				"Nova can check this after you choose a CommCare HQ project space.",
		},
	],
	support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
	docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	message:
		"Choose a project space that supports everything this app uses before importing the file.",
};

function readyReport(domain: string): ProjectSpaceCompatibilityReport {
	return {
		status: "ready",
		target_domain: domain,
		required_capabilities: [{ ...caseSearch, state: "available" }],
		blockers: [],
		advisories: [
			{
				...largeSearch,
				state: "available",
				message: "This project space can optimize large Search results.",
			},
		],
		support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
		message: "This project space supports everything this app uses.",
	};
}

function blockedReport(domain: string): ProjectSpaceCompatibilityReport {
	const missing = { ...caseSearch, state: "missing" as const };
	const unverified = { ...caseAttachments, state: "unverified" as const };
	return {
		status: "blocked",
		target_domain: domain,
		required_capabilities: [missing, unverified],
		blockers: [missing, unverified],
		advisories: [
			{
				...largeSearch,
				state: "missing",
				message:
					"This project space can run the app, but large Search results may take longer to open.",
			},
		],
		support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
		message:
			"This project space isn't ready for this app. It doesn't support Case search. Nova couldn't confirm Attachments saved to cases. Nothing has been sent.",
	};
}

function compatibilityPreflight(domain?: string) {
	return Promise.resolve({
		ok: true as const,
		report: domain ? readyReport(domain) : uncheckedReport,
	});
}

function renderDialog(
	overrides: Partial<React.ComponentProps<typeof PublishDialog>> = {},
) {
	const props: React.ComponentProps<typeof PublishDialog> = {
		open: true,
		onClose: vi.fn(),
		getAppId: () => "app-1",
		availableDomains: [{ name: "project-space", displayName: "Project Space" }],
		connectionServer: "production",
		canUploadToHq: true,
		onOpenPublishing: vi.fn(),
		isRefreshingHqConnection: false,
		onRefreshHqConnection: vi.fn(),
		onLoadProjectSpaceCompatibility: vi.fn((domain?: string) =>
			compatibilityPreflight(domain),
		),
		onDownloadJson: vi.fn().mockResolvedValue({
			ok: true,
			projectSpaceCompatibility: uncheckedReport,
		}),
		onDownloadCcz: vi.fn().mockResolvedValue({ ok: true }),
		...overrides,
	};
	return { view: render(<PublishDialog {...props} />), props };
}

async function choosePublishOption(name: string) {
	fireEvent.click(screen.getByRole("combobox", { name: "Publish option" }));
	await settleBaseUiTransitions();
	const option = screen.getByRole("option", { name });
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
	await settleBaseUiTransitions();
}

describe("PublishDialog", () => {
	beforeEach(() => {
		mocks.fetch.mockReset();
		mocks.renderCanEdit = true;
		mocks.sessionState.accessPhase = "authorized";
		mocks.sessionState.canEdit = true;
		mocks.sessionState.scopeEpoch = 0;
		vi.stubGlobal("fetch", mocks.fetch);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await settleBaseUiTransitions();
	});

	it("keeps direct upload and both file downloads in one modal", async () => {
		const onLoadProjectSpaceCompatibility = vi.fn((domain?: string) =>
			compatibilityPreflight(domain),
		);
		renderDialog({ onLoadProjectSpaceCompatibility });

		expect(screen.getByRole("dialog").textContent).toContain("Publish app");
		await screen.findByText("This project space can run the app");
		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(false);

		await choosePublishOption("CommCare HQ app file");
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
		await screen.findByText("Choose a project space that can run this app");

		await choosePublishOption("CommCare mobile app file");
		expect(screen.getByRole("button", { name: "Download CCZ" })).toBeTruthy();
		expect(
			screen.getByText("Choose a project space that can run this app"),
		).toBeTruthy();
		expect(onLoadProjectSpaceCompatibility).toHaveBeenCalledTimes(2);
	});

	it("keeps file downloads available to viewers without exposing direct upload", async () => {
		mocks.renderCanEdit = false;
		mocks.sessionState.canEdit = false;
		renderDialog({ canUploadToHq: false });

		expect(
			screen.getByRole("combobox", { name: "Publish option" }).textContent,
		).toContain("CommCare HQ app file");
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
		await screen.findByText("Choose a project space that can run this app");

		fireEvent.click(screen.getByRole("combobox", { name: "Publish option" }));
		await settleBaseUiTransitions();
		expect(screen.queryByRole("option", { name: "CommCare HQ" })).toBeNull();
	});

	it("offers connection recovery while leaving file options available", async () => {
		const onLoadProjectSpaceCompatibility = vi.fn((domain?: string) =>
			compatibilityPreflight(domain),
		);
		const onRefreshHqConnection = vi.fn();
		renderDialog({
			availableDomains: [],
			onLoadProjectSpaceCompatibility,
			onRefreshHqConnection,
		});

		expect(screen.getByText("Connect CommCare HQ to upload")).toBeTruthy();
		expect(onLoadProjectSpaceCompatibility).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
		expect(onRefreshHqConnection).toHaveBeenCalledOnce();

		await choosePublishOption("CommCare HQ app file");
		await screen.findByText("Choose a project space that can run this app");
		expect(onLoadProjectSpaceCompatibility).toHaveBeenCalledWith(
			undefined,
			expect.any(AbortSignal),
		);
	});

	it("rechecks live edit authority before starting a direct upload", async () => {
		mocks.sessionState.canEdit = false;
		const { view } = renderDialog();
		const upload = await screen.findByRole("button", { name: "Upload" });
		await waitFor(() => expect(upload.hasAttribute("disabled")).toBe(false));
		fireEvent.click(upload);
		expect(mocks.fetch).not.toHaveBeenCalled();
		view.unmount();
	});

	it("explains file requirements without exposing support codes", async () => {
		const { props } = renderDialog();
		await choosePublishOption("CommCare HQ app file");

		const statusTitle = await screen.findByText(
			"Choose a project space that can run this app",
		);
		const status = statusTitle.closest('[role="status"]');
		expect(status?.textContent).toContain("Case search");
		expect(status?.textContent).toContain(
			"Choose a project space that supports everything this app uses",
		);
		expect(status?.textContent).not.toMatch(/search_claim|slug|namespace/i);
		expect(screen.queryByRole("alert")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
		await screen.findByText("CommCare HQ app file downloaded");
		expect(props.onDownloadJson).toHaveBeenCalledOnce();
		expect(document.body.textContent).not.toMatch(/search_claim/);
	});

	it("checks the selected project space on open and on an explicit retry", async () => {
		const onLoadProjectSpaceCompatibility = vi.fn((domain?: string) =>
			compatibilityPreflight(domain),
		);
		renderDialog({ onLoadProjectSpaceCompatibility });

		await screen.findByText("This project space can run the app");
		expect(onLoadProjectSpaceCompatibility).toHaveBeenCalledWith(
			"project-space",
			expect.any(AbortSignal),
		);
		fireEvent.click(screen.getByRole("button", { name: "Check again" }));
		await waitFor(() =>
			expect(onLoadProjectSpaceCompatibility).toHaveBeenCalledTimes(2),
		);
	});

	it("blocks direct upload when compatibility cannot be checked but leaves downloads available", async () => {
		const onLoadProjectSpaceCompatibility = vi.fn(async () => ({
			ok: false as const,
			message:
				"Nova couldn't check whether this project space can run the app. Try again in this window",
		}));
		const { props } = renderDialog({ onLoadProjectSpaceCompatibility });

		const error = await screen.findByText(
			"Nova couldn't check whether this project space can run the app. Try again in this window",
		);
		expect(error.closest('[role="alert"]')).not.toBeNull();
		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(true);

		await choosePublishOption("CommCare HQ app file");
		const download = screen.getByRole("button", { name: "Download JSON" });
		expect(download.hasAttribute("disabled")).toBe(false);
		fireEvent.click(download);
		await waitFor(() => expect(props.onDownloadJson).toHaveBeenCalledOnce());
	});

	it("states when the app needs no special project-space support", async () => {
		const report: ProjectSpaceCompatibilityReport = {
			status: "not_needed",
			target_domain: "project-space",
			required_capabilities: [],
			blockers: [],
			advisories: [],
			support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
			docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
			message: "This app doesn't need any special project-space support.",
		};
		renderDialog({
			onLoadProjectSpaceCompatibility: vi.fn().mockResolvedValue({
				ok: true,
				report,
			}),
		});

		const status = await screen.findByRole("status");
		expect(status.textContent).toContain(
			"This app doesn't need additional project-space support",
		);
		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(false);
	});

	it("waits for a project-space choice before checking a multi-space connection", async () => {
		type CompatibilityOutcome = Awaited<
			ReturnType<typeof compatibilityPreflight>
		>;
		const domainResolvers = new Map<
			string,
			(outcome: CompatibilityOutcome) => void
		>();
		const onLoadProjectSpaceCompatibility = vi.fn((domain?: string) => {
			if (!domain) return compatibilityPreflight();
			return new Promise<CompatibilityOutcome>((resolve) => {
				domainResolvers.set(domain, resolve);
			});
		});
		renderDialog({
			availableDomains: [
				{ name: "alpha-space", displayName: "Alpha Space" },
				{ name: "beta-space", displayName: "Beta Space" },
			],
			onLoadProjectSpaceCompatibility,
		});

		expect(onLoadProjectSpaceCompatibility).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("combobox", { name: "Project space" }));
		fireEvent.click(await screen.findByRole("option", { name: "Alpha Space" }));
		expect(
			screen.getByText("Checking whether this project space can run the app"),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(true);

		await waitFor(() =>
			expect(onLoadProjectSpaceCompatibility).toHaveBeenLastCalledWith(
				"alpha-space",
				expect.any(AbortSignal),
			),
		);
		await act(async () => {
			domainResolvers.get("alpha-space")?.(
				await compatibilityPreflight("alpha-space"),
			);
		});
		await screen.findByText("This project space can run the app");
	});

	it("blocks missing and unverified required support without hiding an advisory", async () => {
		renderDialog({
			onLoadProjectSpaceCompatibility: vi.fn(async (domain?: string) => ({
				ok: true as const,
				report: blockedReport(domain ?? "project-space"),
			})),
		});

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain(
			"Nova couldn't confirm this project space can run the app",
		);
		expect(alert.textContent).toContain("Case search");
		expect(alert.textContent).toContain("Attachments saved to cases");
		expect(alert.textContent).toContain("Dimagi Support");
		expect(
			screen.getByText("Large searches may open more slowly"),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(true);
		expect(document.body.textContent).not.toMatch(
			/search_claim|slug|namespace/i,
		);
	});

	it("never lets a performance advisory disable direct upload", async () => {
		const ready = readyReport("project-space");
		const report: ProjectSpaceCompatibilityReport = {
			...ready,
			advisories: [
				{
					...largeSearch,
					state: "missing",
					message:
						"This project space can run the app, but large Search results may take longer to open.",
				},
			],
		};
		renderDialog({
			onLoadProjectSpaceCompatibility: vi.fn(async () => ({
				ok: true as const,
				report,
			})),
		});

		await screen.findByText("Large searches may open more slowly");
		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(false);
	});

	it("does not reuse an earlier compatibility answer after the dialog reopens", async () => {
		type CompatibilityOutcome = Awaited<
			ReturnType<typeof compatibilityPreflight>
		>;
		let resolveRecheck: ((outcome: CompatibilityOutcome) => void) | undefined;
		const onLoadProjectSpaceCompatibility = vi
			.fn<(domain?: string) => Promise<CompatibilityOutcome>>()
			.mockImplementationOnce((domain) => compatibilityPreflight(domain))
			.mockImplementationOnce(
				() =>
					new Promise<CompatibilityOutcome>((resolve) => {
						resolveRecheck = resolve;
					}),
			);

		function Harness() {
			const [open, setOpen] = useState(true);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Reopen publish
					</button>
					<PublishDialog
						open={open}
						onClose={() => setOpen(false)}
						getAppId={() => "app-1"}
						availableDomains={[
							{ name: "project-space", displayName: "Project Space" },
						]}
						connectionServer="production"
						canUploadToHq
						onOpenPublishing={vi.fn()}
						isRefreshingHqConnection={false}
						onRefreshHqConnection={vi.fn()}
						onLoadProjectSpaceCompatibility={onLoadProjectSpaceCompatibility}
						onDownloadJson={vi.fn().mockResolvedValue({ ok: true })}
						onDownloadCcz={vi.fn().mockResolvedValue({ ok: true })}
					/>
				</>
			);
		}

		render(<Harness />);
		const upload = await screen.findByRole("button", { name: "Upload" });
		await waitFor(() => expect(upload.hasAttribute("disabled")).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Reopen publish" }));

		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(true);
		await screen.findByText(
			"Checking whether this project space can run the app",
		);
		await act(async () => {
			resolveRecheck?.(await compatibilityPreflight("project-space"));
		});
	});

	it("shows one compatibility alert when the upload preflight refuses", async () => {
		mocks.fetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: false,
					refusal: {
						phase: "preflight",
						failure: {
							code: "project_space_incompatible",
							message: "Duplicate refusal detail",
							details: [],
						},
						resourceConflicts: [],
					},
					warnings: [],
					preview_project_space: null,
					project_space_compatibility: blockedReport("project-space"),
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		renderDialog();
		const upload = await screen.findByRole("button", { name: "Upload" });
		await waitFor(() => expect(upload.hasAttribute("disabled")).toBe(false));

		fireEvent.click(upload);
		await screen.findByText("Nova couldn't finish publishing");
		const alerts = screen.getAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.textContent).toContain("Case search");
		expect(alerts[0]?.textContent).not.toContain("Duplicate refusal detail");
	});

	it("ignores a download completion from a closed dialog after it reopens", async () => {
		let resolveDownload:
			| ((outcome: PublishDownloadOutcome) => void)
			| undefined;
		const onDownloadJson = vi.fn(
			() =>
				new Promise<PublishDownloadOutcome>((resolve) => {
					resolveDownload = resolve;
				}),
		);

		function Harness() {
			const [open, setOpen] = useState(true);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Reopen publish
					</button>
					<PublishDialog
						open={open}
						onClose={() => setOpen(false)}
						getAppId={() => "app-1"}
						availableDomains={[
							{ name: "project-space", displayName: "Project Space" },
						]}
						connectionServer="production"
						canUploadToHq
						onOpenPublishing={vi.fn()}
						isRefreshingHqConnection={false}
						onRefreshHqConnection={vi.fn()}
						onLoadProjectSpaceCompatibility={(domain) =>
							compatibilityPreflight(domain)
						}
						onDownloadJson={onDownloadJson}
						onDownloadCcz={vi.fn().mockResolvedValue({ ok: true })}
					/>
				</>
			);
		}

		render(<Harness />);
		await choosePublishOption("CommCare HQ app file");
		await screen.findByText("Choose a project space that can run this app");
		fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
		expect(onDownloadJson).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Reopen publish" }));
		await choosePublishOption("CommCare HQ app file");

		await act(async () => {
			resolveDownload?.({
				ok: true,
				projectSpaceCompatibility: uncheckedReport,
			});
			await Promise.resolve();
		});

		expect(screen.queryByText("CommCare HQ app file downloaded")).toBeNull();
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
	});
});
