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
	sessionState: {
		accessPhase: "authorized" as const,
		canEdit: true,
		scopeEpoch: 0,
	},
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
}));
vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => mocks.sessionState,
	}),
}));

const caseSearch = HQ_FEATURE_FLAG_REQUIREMENTS[0];
const downloadReport: HqFeatureFlagReport = {
	verification: "not_checked",
	required_flags: [caseSearch],
	missing_flags: [],
	unverified_flags: [caseSearch],
	support_email: "support@dimagi.com",
	docs_url: "https://docs.commcare.app/feature-flags",
	message:
		"This app requires Simple Case Search. Nova cannot check a downloaded file's destination.",
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
					message: `Nova verified that every required feature flag is enabled for the “${domain}” project space.`,
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
		canUploadToHq: true,
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
		renderDialog();
		expect(screen.getByRole("dialog").textContent).toContain("Publish app");
		expect(screen.getByRole("tab", { name: "CommCare HQ" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Web" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Mobile" })).toBeTruthy();
		await screen.findByText("Required feature flags verified");
	});

	it("keeps file publishing available to viewers without exposing HQ writes", async () => {
		mocks.renderCanEdit = false;
		mocks.sessionState.canEdit = false;
		renderDialog({ canUploadToHq: false });
		expect(screen.queryByRole("tab", { name: "CommCare HQ" })).toBeNull();
		expect(screen.getByRole("tab", { name: "Web" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
		await screen.findByText("Required in the destination project space");
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
		fireEvent.click(screen.getByRole("tab", { name: "Web" }));

		await screen.findByText("Required in the destination project space");
		expect(props.onDownloadJson).not.toHaveBeenCalled();
		expect(screen.getByText("search_claim")).toBeTruthy();
		expect(screen.getByText("support@dimagi.com")).toBeTruthy();
		expect(screen.queryByText(/is not enabled/i)).toBeNull();

		fireEvent.click(
			await screen.findByRole("button", { name: "Download JSON" }),
		);

		await screen.findByText("Web app file downloaded");
		expect(
			screen.getByText(/cannot check a downloaded file's destination/i),
		).toBeTruthy();
		expect(screen.getByText("search_claim")).toBeTruthy();
		expect(screen.getByText("support@dimagi.com")).toBeTruthy();
		expect(screen.queryByText(/is not enabled/i)).toBeNull();
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

		await screen.findByText("Required feature flags verified");
		expect(onLoadFeatureFlags).toHaveBeenCalledWith(
			"project-space",
			expect.any(AbortSignal),
		);
		fireEvent.click(screen.getByRole("button", { name: "Refresh check" }));
		await waitFor(() => expect(onLoadFeatureFlags).toHaveBeenCalledTimes(2));
	});

	it("surfaces flags HQ confirmed missing after a successful upload", async () => {
		const uploadReport: HqFeatureFlagReport = {
			...downloadReport,
			verification: "verified",
			target_domain: "project-space",
			missing_flags: [caseSearch],
			unverified_flags: [],
			message:
				"Simple Case Search (search_claim) is not enabled for the project-space project space. The app was still published. Contact support@dimagi.com.",
		};
		mocks.fetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					appUrl: "https://hq.example/app",
					warnings: [],
					feature_flag_requirements: uploadReport,
				}),
				{ status: 201, headers: { "Content-Type": "application/json" } },
			),
		);

		renderDialog();
		await screen.findByText("Required feature flags verified");
		fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
		await screen.findByText("CommCare HQ settings need attention");
		expect(
			screen.getByText(/is not enabled for the project-space/i),
		).toBeTruthy();
		expect(screen.getByText("support@dimagi.com")).toBeTruthy();
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
						canUploadToHq
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
		fireEvent.click(screen.getByRole("tab", { name: "Web" }));
		await screen.findByText("Required in the destination project space");
		fireEvent.click(
			await screen.findByRole("button", { name: "Download JSON" }),
		);
		expect(onDownloadJson).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Reopen publish" }));
		fireEvent.click(screen.getByRole("tab", { name: "Web" }));

		await act(async () => {
			resolveDownload?.({ ok: true, featureFlagReport: downloadReport });
			await Promise.resolve();
		});

		expect(screen.queryByText("Web app file downloaded")).toBeNull();
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
	});
});
