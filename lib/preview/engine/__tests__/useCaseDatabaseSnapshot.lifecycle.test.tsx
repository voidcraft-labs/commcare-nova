// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
	setCaseDatabaseState: vi.fn(),
}));

vi.mock("@/lib/collab/context", () => ({
	useReconcilerContext: () => null,
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocEq: () => ({ required: true, caseTypes: ["patient"] }),
}));

vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCaseDatabaseSnapshotAction: vi.fn(),
}));

vi.mock("@/lib/preview/hooks/caseDataInvalidation", () => ({
	useCaseDatabaseRevision: () => 0,
}));

vi.mock("@/lib/preview/hooks/useEngineController", () => ({
	useEngineController: () => ({
		setCaseDatabaseState: harness.setCaseDatabaseState,
	}),
}));

vi.mock("@/lib/preview/hooks/useReloadableResource", () => ({
	useReloadableResource: () => ({
		state: { kind: "loading" },
		fetching: false,
		reload: vi.fn(),
	}),
}));

vi.mock("@/lib/preview/hooks/useRestoreScopeKey", () => ({
	useRestoreScopeKey: () => "restore-scope",
}));

vi.mock("@/lib/session/hooks", () => ({
	useAccessPhase: () => "authorized",
	useAppId: () => "app-1",
	usePreviewPersonaUuid: () => undefined,
	useProjectScopeEpoch: () => 0,
}));

import { PreviewCaseDatabaseProvider } from "../useCaseDatabaseSnapshot";

class AbandonedRenderBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		return this.state.failed ? <div>Abandoned</div> : this.props.children;
	}
}

function BrokenChild(): never {
	throw new Error("abandon provider render");
}

describe("PreviewCaseDatabaseProvider commit lifecycle", () => {
	beforeEach(() => {
		harness.setCaseDatabaseState.mockReset();
	});

	it("installs required loading state during the committed layout phase", () => {
		render(
			<PreviewCaseDatabaseProvider>
				<div>Committed child</div>
			</PreviewCaseDatabaseProvider>,
		);

		expect(screen.getByText("Committed child")).toBeTruthy();
		expect(harness.setCaseDatabaseState).toHaveBeenCalledTimes(1);
		expect(harness.setCaseDatabaseState).toHaveBeenCalledWith({
			required: true,
			status: "loading",
		});
	});

	it("does not mutate the controller when React abandons an errored render", () => {
		render(
			<AbandonedRenderBoundary>
				<PreviewCaseDatabaseProvider>
					<BrokenChild />
				</PreviewCaseDatabaseProvider>
			</AbandonedRenderBoundary>,
		);

		expect(screen.getByText("Abandoned")).toBeTruthy();
		expect(harness.setCaseDatabaseState).not.toHaveBeenCalled();
	});
});
