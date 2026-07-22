// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { UploadToHqDialog } from "@/components/builder/UploadToHqDialog";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	sessionState: {
		accessPhase: "authorized" as const,
		canEdit: false,
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
	/* Keep the stale rendered affordance visible: the handler must still read
	 * the current imperative store snapshot before starting the request. */
	useAccessPhase: () => "authorized",
	useCanEdit: () => true,
}));

vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => mocks.sessionState,
	}),
}));

describe("UploadToHqDialog", () => {
	beforeEach(() => {
		mocks.fetch.mockReset();
		vi.stubGlobal("fetch", mocks.fetch);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("rechecks the live Project capability before starting an HQ upload", async () => {
		const view = render(
			<UploadToHqDialog
				open
				onClose={vi.fn()}
				getAppId={() => "app-1"}
				availableDomains={[
					{ name: "project-space", displayName: "Project Space" },
				]}
			/>,
		);

		const upload = await screen.findByRole("button", { name: "Upload" });
		await waitFor(() => expect(upload.hasAttribute("disabled")).toBe(false));
		fireEvent.click(upload);

		expect(mocks.fetch).not.toHaveBeenCalled();
		await settleBaseUiTransitions();
		view.unmount();
		await settleBaseUiTransitions();
	});
});
