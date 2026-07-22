// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDocumentExtraction } from "../useDocumentExtraction";

const mocks = vi.hoisted(() => ({
	triggerAssetExtraction: vi.fn(),
}));

vi.mock("../mediaClient", () => ({
	triggerAssetExtraction: mocks.triggerAssetExtraction,
}));

describe("useDocumentExtraction", () => {
	it("does not start a missing extraction for a view-only file browser", () => {
		const { result } = renderHook(() =>
			useDocumentExtraction(
				{ id: "document-1", kind: "pdf" },
				undefined,
				undefined,
				undefined,
				false,
			),
		);

		expect(result.current.status).toBeNull();
		expect(mocks.triggerAssetExtraction).not.toHaveBeenCalled();
		result.current.retry();
		expect(mocks.triggerAssetExtraction).not.toHaveBeenCalled();
	});
});
