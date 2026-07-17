// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Uuid } from "@/lib/doc/types";
import type { Location } from "@/lib/routing/types";

const mocks = vi.hoisted(() => ({
	previewing: true,
	location: {
		kind: "cases",
		moduleUuid: "module-1" as Uuid,
		caseId: "case-1",
	} as Location,
	replace: vi.fn(),
}));

vi.mock("@/lib/session/hooks", () => ({
	usePreviewing: () => mocks.previewing,
}));

vi.mock("@/lib/routing/hooks", () => ({
	useLocation: () => mocks.location,
	useNavigate: () => ({ replace: mocks.replace }),
}));

import { PreviewToggle } from "../PreviewToggle";

beforeEach(() => {
	mocks.previewing = true;
	mocks.location = {
		kind: "cases",
		moduleUuid: "module-1" as Uuid,
		caseId: "case-1",
	};
	mocks.replace.mockReset();
});

describe("PreviewToggle", () => {
	it("leaves a running record for the Results authoring canvas", () => {
		const setPreviewing = vi.fn();
		render(<PreviewToggle onSetPreviewing={setPreviewing} />);

		fireEvent.click(screen.getByRole("button", { name: "Back to edit" }));

		expect(mocks.replace).toHaveBeenCalledWith({
			kind: "cases",
			moduleUuid: "module-1",
		});
		expect(setPreviewing).toHaveBeenCalledWith(false);
		expect(
			screen
				.getByRole("button", { name: "Back to edit" })
				.hasAttribute("aria-pressed"),
		).toBe(false);
	});

	it("uses the ordinary preview toggle away from a record", () => {
		mocks.previewing = false;
		mocks.location = { kind: "home" };
		const setPreviewing = vi.fn();
		render(<PreviewToggle onSetPreviewing={setPreviewing} />);

		fireEvent.click(screen.getByRole("button", { name: "Preview" }));

		expect(mocks.replace).not.toHaveBeenCalled();
		expect(setPreviewing).toHaveBeenCalledWith(true);
	});
});
