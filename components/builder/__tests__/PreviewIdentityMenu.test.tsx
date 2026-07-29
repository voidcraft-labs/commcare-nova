// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { asUuid } from "@/lib/domain";
import { PreviewIdentityMenu } from "../PreviewIdentityMenu";

const { setSelectedMock, openAppSetupMock } = vi.hoisted(() => ({
	setSelectedMock: vi.fn(),
	openAppSetupMock: vi.fn(),
}));

const ASHA = asUuid("persona-asha");

vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	usePersonas: () => [{ uuid: ASHA, name: "Asha" }],
}));

vi.mock("@/lib/session/hooks", () => ({
	usePreviewing: () => true,
	usePreviewPersonaUuid: () => ASHA,
	useSetPreviewPersonaUuid: () => setSelectedMock,
}));

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ openAppSetup: openAppSetupMock }),
}));

describe("PreviewIdentityMenu", () => {
	it("exposes the current preview identity as a checked radio choice", async () => {
		render(<PreviewIdentityMenu />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /Running as Asha/,
			}),
		);

		const me = await screen.findByRole("menuitemradio", {
			name: /Preview as me/,
		});
		const asha = screen.getByRole("menuitemradio", {
			name: "Preview as Asha",
		});
		expect(me.getAttribute("aria-checked")).toBe("false");
		expect(asha.getAttribute("aria-checked")).toBe("true");

		fireEvent.click(me);
		await settleBaseUiTransitions();
		expect(setSelectedMock).toHaveBeenCalledWith(undefined);
	});
});
