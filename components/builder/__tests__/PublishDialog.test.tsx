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
	HQ_FEATURE_FLAG_REQUIREMENTS,
	type HqFeatureFlagReport,
} from "@/lib/publish/hqFeatureFlags";

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

/* The dialog asks the server where the app already stands as soon as it
 * opens. That is a Server Action reaching auth and Postgres, which has no
 * business running in a component test — and left real it resolves after
 * the test ends, which is exactly the escaped-update the setup file
 * fails on. */
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

const caseSearch = HQ_FEATURE_FLAG_REQUIREMENTS[0];
const advancedCaseSearch = HQ_FEATURE_FLAG_REQUIREMENTS[1];
const downloadReport: HqFeatureFlagReport = {
	verification: "not_checked",
	required_flags: [caseSearch],
	missing_flags: [],
	unverified_flags: [caseSearch],
	support_email: "support@dimagi.com",
	docs_url: "https://docs.commcare.app/feature-flags",
	message:
		"This app requires Simple Case Search. The destination project space hasn't been checked.",
};

const prepublishReport: HqFeatureFlagReport = {
	...downloadReport,
	message:
		"This app requires Simple Case Search. No project space has been checked yet, so these are requirements, not flags known to be off.",
};

function featureFlagPreflight(domain?: string) {
	return Promise.resolve({
		ok: true as const,
		report: domain
			? {
					...prepublishReport,
					verification: "verified" as const,
					target_domain: domain,
					unverified_flags: [],
					message: `All required feature flags are enabled for the “${domain}” project space.`,
				}
			: prepublishReport,
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
		onLoadFeatureFlags: vi.fn((domain?: string) =>
			featureFlagPreflight(domain),
		),
		onDownloadJson: vi.fn().mockResolvedValue({
			ok: true,
			featureFlagReport: downloadReport,
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

	it("keeps all publish destinations in one modal", async () => {
		const onLoadFeatureFlags = vi.fn((domain?: string) =>
			featureFlagPreflight(domain),
		);
		renderDialog({ onLoadFeatureFlags });
		expect(screen.getByRole("dialog").textContent).toContain("Publish app");
		const publishOption = screen.getByRole("combobox", {
			name: "Publish option",
		});
		expect(publishOption.textContent).toContain("CommCare HQ");
		const selectedValueRow = publishOption.querySelector(
			"[data-slot=select-value] > span",
		);
		expect(selectedValueRow?.classList.contains("whitespace-nowrap")).toBe(
			true,
		);
		expect(
			selectedValueRow?.querySelector("span")?.classList.contains("truncate"),
		).toBe(true);
		const publishDescriptionId = publishOption.getAttribute("aria-describedby");
		expect(publishDescriptionId).toBe("publish-target-description");
		expect(
			document.getElementById(publishDescriptionId ?? "")?.textContent,
		).toBe("Upload directly to a connected project space");
		await screen.findByText("Feature flags are ready");
		expect(
			screen
				.getByRole("button", { name: "Upload" })
				.closest("[data-slot=dialog-footer]"),
		).not.toBeNull();

		fireEvent.click(publishOption);
		await settleBaseUiTransitions();
		const hqFileOption = screen.getByRole("option", {
			name: "CommCare HQ app file",
		});
		const hqFileDescriptionId = hqFileOption.getAttribute("aria-describedby");
		expect(hqFileDescriptionId).toBe("publish-target-web-description");
		expect(
			document.getElementById(hqFileDescriptionId ?? "")?.textContent,
		).toMatch(/Download a JSON file to import into CommCare HQ/i);
		fireEvent.pointerDown(hqFileOption, { pointerType: "mouse" });
		fireEvent.click(hqFileOption);
		await settleBaseUiTransitions();
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
		await screen.findByText("This app uses CommCare HQ feature flags");
		expect(
			screen.getAllByText("This app uses CommCare HQ feature flags"),
		).toHaveLength(1);
		await waitFor(() => expect(onLoadFeatureFlags).toHaveBeenCalledTimes(2));
		expect(
			screen.getByText(/Download a JSON file to import into CommCare HQ/i, {
				selector: 'p[data-slot="field-description"]',
			}),
		).toBeTruthy();

		await choosePublishOption("CommCare mobile app file");
		expect(screen.getByRole("button", { name: "Download CCZ" })).toBeTruthy();
		expect(
			screen.getAllByText("This app uses CommCare HQ feature flags"),
		).toHaveLength(1);
		expect(onLoadFeatureFlags).toHaveBeenCalledTimes(2);
	});

	it("keeps file publishing available to viewers without exposing HQ writes", async () => {
		mocks.renderCanEdit = false;
		mocks.sessionState.canEdit = false;
		renderDialog({ canUploadToHq: false });
		expect(
			screen.getByRole("combobox", { name: "Publish option" }).textContent,
		).toContain("CommCare HQ app file");
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
		await screen.findByText("This app uses CommCare HQ feature flags");

		fireEvent.click(screen.getByRole("combobox", { name: "Publish option" }));
		await settleBaseUiTransitions();
		expect(screen.queryByRole("option", { name: "CommCare HQ" })).toBeNull();
		const mobileOption = screen.getByRole("option", {
			name: "CommCare mobile app file",
		});
		fireEvent.pointerDown(mobileOption, { pointerType: "mouse" });
		fireEvent.click(mobileOption);
		await settleBaseUiTransitions();
		expect(screen.getByRole("button", { name: "Download CCZ" })).toBeTruthy();
	});

	it("keeps HQ requirements hidden until HQ is connected and offers recovery", async () => {
		const onLoadFeatureFlags = vi.fn((domain?: string) =>
			featureFlagPreflight(domain),
		);
		const onRefreshHqConnection = vi.fn();
		renderDialog({
			availableDomains: [],
			onLoadFeatureFlags,
			onRefreshHqConnection,
		});

		expect(screen.getByText("Connect CommCare HQ to upload")).toBeTruthy();
		expect(
			screen.getByText(
				/still choose a CommCare HQ app file or mobile app file/i,
			),
		).toBeTruthy();
		expect(onLoadFeatureFlags).not.toHaveBeenCalled();
		expect(
			screen.queryByText("This app uses CommCare HQ feature flags"),
		).toBeNull();
		const settings = screen.getByRole("link", { name: "Open Settings" });
		expect(settings.getAttribute("href")).toBe("/settings");
		expect(settings.getAttribute("target")).toBe("_blank");

		fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
		expect(onRefreshHqConnection).toHaveBeenCalledOnce();

		await choosePublishOption("CommCare HQ app file");
		await screen.findByText("This app uses CommCare HQ feature flags");
		expect(onLoadFeatureFlags).toHaveBeenCalledWith(
			undefined,
			expect.any(AbortSignal),
		);
		await choosePublishOption("CommCare HQ");
		expect(screen.getByText("Connect CommCare HQ to upload")).toBeTruthy();
		expect(
			screen.queryByText("This app uses CommCare HQ feature flags"),
		).toBeNull();
	});

	it("rechecks the live Project capability before starting an HQ upload", async () => {
		mocks.sessionState.canEdit = false;
		const { view } = renderDialog();
		const upload = await screen.findByRole("button", { name: "Upload" });
		await waitFor(() => expect(upload.hasAttribute("disabled")).toBe(false));
		fireEvent.click(upload);
		expect(mocks.fetch).not.toHaveBeenCalled();
		view.unmount();
	});

	it("explains unverified file requirements before download without calling them missing", async () => {
		const { props } = renderDialog();
		await choosePublishOption("CommCare HQ app file");

		await screen.findByText("This app uses CommCare HQ feature flags");
		expect(screen.getByRole("status").textContent).toContain(
			"The destination project space hasn't been checked",
		);
		expect(screen.getByRole("status").textContent).toContain(
			"If this flag needs to be enabled",
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(props.onDownloadJson).not.toHaveBeenCalled();
		expect(screen.queryByText("search_claim")).toBeNull();
		expect(screen.getAllByText("support@dimagi.com")).toHaveLength(1);
		expect(screen.queryByText(/isn't enabled/i)).toBeNull();

		fireEvent.click(
			await screen.findByRole("button", { name: "Download JSON" }),
		);

		const downloadComplete = await screen.findByText(
			"CommCare HQ app file downloaded",
		);
		expect(downloadComplete.closest('[role="status"]')).not.toBeNull();
		expect(
			screen.getByText(/destination project space hasn't been checked/i),
		).toBeTruthy();
		expect(screen.queryByText("search_claim")).toBeNull();
		expect(screen.getAllByText("support@dimagi.com")).toHaveLength(1);
		expect(screen.queryByText(/isn't enabled/i)).toBeNull();
		expect(props.onDownloadJson).toHaveBeenCalledOnce();
		const learnMore = screen.getByRole("link", {
			name: /Learn more about Simple Case Search/,
		});
		expect(learnMore.getAttribute("target")).toBe("_blank");
	});

	it("checks the selected HQ project space on open and refreshes on request", async () => {
		const onLoadFeatureFlags = vi.fn((domain?: string) =>
			featureFlagPreflight(domain),
		);
		renderDialog({ onLoadFeatureFlags });

		const readyStatus = await screen.findByText("Feature flags are ready");
		expect(readyStatus.closest('[role="status"]')).not.toBeNull();
		expect(onLoadFeatureFlags).toHaveBeenCalledWith(
			"project-space",
			expect.any(AbortSignal),
		);
		fireEvent.click(screen.getByRole("button", { name: "Check again" }));
		await waitFor(() => expect(onLoadFeatureFlags).toHaveBeenCalledTimes(2));
	});

	it("keeps publish actions blocked until a failed preflight succeeds", async () => {
		let attempts = 0;
		const onLoadFeatureFlags = vi.fn((domain?: string) => {
			attempts += 1;
			if (attempts <= 2) {
				return Promise.resolve({
					ok: false as const,
					message:
						"The feature flag check didn't finish. Try again in this window",
				});
			}
			return featureFlagPreflight(domain);
		});
		const { props } = renderDialog({ onLoadFeatureFlags });

		const errorMessage = await screen.findByText(
			"The feature flag check didn't finish. Try again in this window",
		);
		expect(errorMessage.closest('[role="alert"]')).not.toBeNull();
		const upload = screen.getByRole("button", { name: "Upload" });
		expect(upload.hasAttribute("disabled")).toBe(true);
		fireEvent.click(upload);
		expect(mocks.fetch).not.toHaveBeenCalled();

		await choosePublishOption("CommCare HQ app file");
		await screen.findByText(
			"The feature flag check didn't finish. Try again in this window",
		);
		const download = screen.getByRole("button", { name: "Download JSON" });
		expect(download.hasAttribute("disabled")).toBe(true);
		fireEvent.click(download);
		expect(props.onDownloadJson).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await screen.findByText("This app uses CommCare HQ feature flags");
		await waitFor(() => expect(download.hasAttribute("disabled")).toBe(false));
	});

	it("announces when the app doesn't need feature flags", async () => {
		const noFlagsReport: HqFeatureFlagReport = {
			verification: "not_required",
			target_domain: "project-space",
			required_flags: [],
			missing_flags: [],
			unverified_flags: [],
			support_email: "support@dimagi.com",
			docs_url: "https://docs.commcare.app/feature-flags",
			message:
				"This app doesn't use any features that need a CommCare HQ feature flag.",
		};
		renderDialog({
			onLoadFeatureFlags: vi.fn().mockResolvedValue({
				ok: true,
				report: noFlagsReport,
			}),
		});

		const status = await screen.findByRole("status");
		expect(status.textContent).toContain(
			"This app doesn't need any CommCare HQ feature flags",
		);
	});

	it("waits for an explicit project space before checking HQ flags", async () => {
		type FeatureFlagOutcome = Awaited<ReturnType<typeof featureFlagPreflight>>;
		const domainResolvers = new Map<
			string,
			(outcome: FeatureFlagOutcome) => void
		>();
		const onLoadFeatureFlags = vi.fn((domain?: string) => {
			if (!domain) return featureFlagPreflight();
			return new Promise<FeatureFlagOutcome>((resolve) => {
				domainResolvers.set(domain, resolve);
			});
		});
		renderDialog({
			availableDomains: [
				{ name: "alpha-space", displayName: "Alpha Space" },
				{ name: "beta-space", displayName: "Beta Space" },
			],
			onLoadFeatureFlags,
		});

		expect(onLoadFeatureFlags).not.toHaveBeenCalled();
		expect(
			screen.queryByText("This app uses CommCare HQ feature flags"),
		).toBeNull();
		fireEvent.click(screen.getByRole("combobox", { name: "Project space" }));
		fireEvent.click(await screen.findByRole("option", { name: "Alpha Space" }));

		expect(
			screen.queryByText("This app uses CommCare HQ feature flags"),
		).toBeNull();
		expect(
			screen.getByText("Checking feature flags for this project space"),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled"),
		).toBe(true);
		await waitFor(() =>
			expect(onLoadFeatureFlags).toHaveBeenLastCalledWith(
				"alpha-space",
				expect.any(AbortSignal),
			),
		);

		await act(async () => {
			domainResolvers.get("alpha-space")?.(
				await featureFlagPreflight("alpha-space"),
			);
		});
		await screen.findByText("Feature flags are ready");
	});

	it("keeps an inconclusive HQ check informational", async () => {
		const inconclusiveReport: HqFeatureFlagReport = {
			...prepublishReport,
			verification: "unavailable",
			target_domain: "project-space",
			missing_flags: [],
			unverified_flags: [caseSearch],
			message:
				"CommCare HQ could not confirm whether Simple Case Search is enabled for the project-space project space.",
		};
		renderDialog({
			onLoadFeatureFlags: vi.fn(async () => ({
				ok: true as const,
				report: inconclusiveReport,
			})),
		});

		await screen.findByText("Feature flag check incomplete");
		expect(screen.getByRole("status").textContent).toContain(
			"CommCare HQ couldn't confirm",
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("separates confirmed missing flags from flags HQ couldn't verify", async () => {
		const partialReport: HqFeatureFlagReport = {
			...prepublishReport,
			verification: "partial",
			target_domain: "project-space",
			required_flags: [caseSearch, advancedCaseSearch],
			missing_flags: [caseSearch],
			unverified_flags: [advancedCaseSearch],
			message:
				"Simple Case Search isn't enabled. CommCare HQ couldn't confirm Advanced Case Search.",
		};
		renderDialog({
			onLoadFeatureFlags: vi.fn(async () => ({
				ok: true as const,
				report: partialReport,
			})),
		});

		const missingNotice = await screen.findByRole("alert");
		const unverifiedTitle = await screen.findByText(
			"Feature flag check incomplete",
		);
		const unverifiedNotice = unverifiedTitle.closest('[role="status"]');
		expect(unverifiedNotice).not.toBeNull();
		expect(missingNotice.textContent).toContain("Simple Case Search");
		expect(missingNotice.textContent).not.toContain("Advanced Case Search");
		expect(missingNotice.textContent).toContain("To have this flag enabled");
		expect(unverifiedNotice?.textContent).toContain("Advanced Case Search");
		expect(unverifiedNotice?.textContent).not.toContain("Simple Case Search");
		expect(unverifiedNotice?.textContent).toContain(
			"If this flag needs to be enabled",
		);
	});

	it("surfaces flags HQ confirmed missing after a successful upload", async () => {
		const uploadReport: HqFeatureFlagReport = {
			...downloadReport,
			verification: "verified",
			target_domain: "project-space",
			missing_flags: [caseSearch],
			unverified_flags: [],
			message:
				"Simple Case Search (search_claim) isn't enabled for the project-space project space. The app was still published. Contact support@dimagi.com.",
		};
		mocks.fetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					url: "https://hq.example/app",
					warnings: [],
					feature_flag_requirements: uploadReport,
				}),
				{ status: 201, headers: { "Content-Type": "application/json" } },
			),
		);

		renderDialog();
		await screen.findByText("Feature flags are ready");
		fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
		await screen.findByText("Feature flags aren't enabled");
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(
			screen.getByText("Your app is on CommCare HQ").closest('[role="status"]'),
		).not.toBeNull();
		expect(
			screen.getByText(/isn't enabled for the “project-space” project space/i),
		).toBeTruthy();
		expect(screen.queryByText("search_claim")).toBeNull();
		expect(screen.getAllByText("support@dimagi.com")).toHaveLength(1);
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
						onLoadFeatureFlags={(domain, _signal) =>
							featureFlagPreflight(domain)
						}
						onDownloadJson={onDownloadJson}
						onDownloadCcz={vi.fn().mockResolvedValue({ ok: true })}
					/>
				</>
			);
		}

		render(<Harness />);
		await choosePublishOption("CommCare HQ app file");
		await screen.findByText("This app uses CommCare HQ feature flags");
		fireEvent.click(
			await screen.findByRole("button", { name: "Download JSON" }),
		);
		expect(onDownloadJson).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Reopen publish" }));
		await choosePublishOption("CommCare HQ app file");

		await act(async () => {
			resolveDownload?.({ ok: true, featureFlagReport: downloadReport });
			await Promise.resolve();
		});

		expect(screen.queryByText("CommCare HQ app file downloaded")).toBeNull();
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
	});
});
