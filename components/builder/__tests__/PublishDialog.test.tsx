// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { PublishDialog } from "@/components/builder/PublishDialog";
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

function renderDialog(
	overrides: Partial<React.ComponentProps<typeof PublishDialog>> = {},
) {
	const props: React.ComponentProps<typeof PublishDialog> = {
		open: true,
		onClose: vi.fn(),
		getAppId: () => "app-1",
		availableDomains: [{ name: "project-space", displayName: "Project Space" }],
		canUploadToHq: true,
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
	});

	it("keeps file publishing available to viewers without exposing HQ writes", () => {
		mocks.renderCanEdit = false;
		mocks.sessionState.canEdit = false;
		renderDialog({ canUploadToHq: false });
		expect(screen.queryByRole("tab", { name: "CommCare HQ" })).toBeNull();
		expect(screen.getByRole("tab", { name: "Web" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
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

	it("explains unverified file requirements without calling them missing", async () => {
		const { props } = renderDialog();
		fireEvent.click(screen.getByRole("tab", { name: "Web" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Download JSON" }),
		);

		await screen.findByText("Required in the destination project space");
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
		fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
		await screen.findByText("CommCare HQ settings need attention");
		expect(
			screen.getByText(/is not enabled for the project-space/i),
		).toBeTruthy();
		expect(screen.getByText("support@dimagi.com")).toBeTruthy();
	});
});
