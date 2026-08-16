// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { LanguageSelector } from "@/components/builder/localization/LanguageSelector";

const { openAppSetupMock, selectLanguageMock } = vi.hoisted(() => ({
	openAppSetupMock: vi.fn(),
	selectLanguageMock: vi.fn(),
}));

vi.mock(
	"@/components/builder/localization/BuilderLocalizationProvider",
	() => ({
		useBuilderLanguage: () => ({
			language: "fr",
			languages: [
				{ code: "fr", name: "français", direction: "ltr" },
				{ code: "en", name: "English", direction: "ltr" },
			],
			selectLanguage: selectLanguageMock,
		}),
	}),
);

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ openAppSetup: openAppSetupMock }),
}));

describe("LanguageSelector", () => {
	beforeEach(() => {
		openAppSetupMock.mockReset();
		selectLanguageMock.mockReset();
	});

	it("opens a labelled radio menu and selects a worker-content language", async () => {
		render(<LanguageSelector />);

		fireEvent.click(
			screen.getByRole("button", { name: "Worker language: français" }),
		);

		expect(await screen.findByText("Worker content language")).toBeTruthy();
		const french = screen.getByRole("menuitemradio", { name: "français fr" });
		const english = screen.getByRole("menuitemradio", { name: "English en" });
		expect(french.getAttribute("aria-checked")).toBe("true");
		expect(english.getAttribute("aria-checked")).toBe("false");

		fireEvent.click(english);
		await settleBaseUiTransitions();
		expect(selectLanguageMock).toHaveBeenCalledWith("en");
	});
});
