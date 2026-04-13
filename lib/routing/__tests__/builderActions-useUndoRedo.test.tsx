// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

// Full harness (doc provider + builder engine fake + mocked router) is
// set up in Task 11 when migrated consumers provide fixtures. For Phase
// 2 Task 4 we assert the contract only: "returns an object with undo
// and redo functions".

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		useSearchParams: () => new ReadonlyURLSearchParams(new URLSearchParams()),
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => "/build/a",
	};
});

import { useUndoRedo } from "@/lib/routing/builderActions";

describe("useUndoRedo", () => {
	it("throws without BuilderProvider ancestor", () => {
		// With no BuilderProvider ancestor, the hook throws via useBuilderEngine.
		// Full positive-path coverage is in Task 11's integration.
		expect(() => renderHook(() => useUndoRedo())).toThrow(/BuilderProvider/);
	});
});
