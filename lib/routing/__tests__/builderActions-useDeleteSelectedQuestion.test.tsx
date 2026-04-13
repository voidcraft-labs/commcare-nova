// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

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

import { useDeleteSelectedQuestion } from "@/lib/routing/builderActions";

describe("useDeleteSelectedQuestion", () => {
	it("throws without BlueprintDocProvider ancestor", () => {
		// Without BlueprintDocProvider the hook throws via useAssembledForm's
		// internal useBlueprintDocShallow call. Full positive-path integration
		// is covered in Task 11.
		expect(() => renderHook(() => useDeleteSelectedQuestion())).toThrow(
			/BlueprintDocProvider/,
		);
	});
});
