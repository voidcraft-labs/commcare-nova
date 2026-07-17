// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintDoc, CaseListConfig } from "@/lib/domain";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";

const getState = vi.fn();

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocApi: () => ({ getState }),
}));

vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCaseListPreviewAction: vi.fn(),
}));

vi.mock("@/lib/preview/engine/caseDataBindingClient", () => ({
	pickBlueprintDoc: vi.fn((doc: BlueprintDoc) => doc),
}));

import { loadCaseListPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { useCaseListPreview } from "../useCaseListPreview";

const APP_ID = "preview-invalidation-app";
const CONFIG = { columns: [], searchInputs: [] } satisfies CaseListConfig;
const BLUEPRINT = {
	app: { name: "Test" },
	modules: {},
	moduleOrder: [],
	forms: {},
	formOrder: {},
	fields: {},
	fieldOrder: {},
	caseTypes: [],
} as unknown as BlueprintDoc;

beforeEach(() => {
	getState.mockReset();
	getState.mockReturnValue(BLUEPRINT);
	vi.mocked(loadCaseListPreviewAction).mockReset();
	vi.mocked(loadCaseListPreviewAction).mockResolvedValue({ kind: "empty" });
});

describe("useCaseListPreview case-data invalidation", () => {
	it("reloads the authoring Results and Details data after a case write", async () => {
		const { result } = renderHook(() =>
			useCaseListPreview({
				appId: APP_ID,
				caseListConfig: CONFIG,
				currentCaseType: "patient",
				previewObstacle: null,
			}),
		);

		await waitFor(() =>
			expect(result.current.state).toEqual({ kind: "empty" }),
		);
		expect(loadCaseListPreviewAction).toHaveBeenCalledTimes(1);

		act(() => invalidateCaseData(APP_ID, "patient"));

		await waitFor(() =>
			expect(loadCaseListPreviewAction).toHaveBeenCalledTimes(2),
		);
	});
});
