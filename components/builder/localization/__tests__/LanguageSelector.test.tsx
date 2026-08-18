// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { LanguageSelector } from "@/components/builder/localization/LanguageSelector";
import type { AppLanguageIdentity, LanguageTag } from "@/lib/domain";

const { openAppSetupMock, selectLanguageMock, languageState } = vi.hoisted(
	() => ({
		openAppSetupMock: vi.fn(),
		selectLanguageMock: vi.fn(),
		languageState: { current: undefined as unknown },
	}),
);

vi.mock(
	"@/components/builder/localization/BuilderLocalizationProvider",
	() => ({
		useBuilderLanguage: () => languageState.current,
	}),
);

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({ openAppSetup: openAppSetupMock }),
}));

interface AppLanguageEntry {
	readonly tag: LanguageTag;
	readonly identity: AppLanguageIdentity;
}

function installLanguages(
	selected: LanguageTag,
	languages: readonly AppLanguageEntry[],
) {
	const source = languages[0];
	if (source === undefined) throw new Error("at least one language required");
	languageState.current = {
		language: selected,
		identity:
			languages.find((entry) => entry.tag === selected)?.identity ??
			source.identity,
		sourceLanguage: source.tag,
		defaultLanguage: source.tag,
		languages,
		isSource: selected === source.tag,
		direction: "ltr" as const,
		selectLanguage: selectLanguageMock,
	};
}

describe("LanguageSelector", () => {
	beforeEach(() => {
		openAppSetupMock.mockReset();
		selectLanguageMock.mockReset();
	});

	it("opens a labelled radio menu and selects a worker-content language", async () => {
		installLanguages("fra", [
			{ tag: "fra", identity: { language: "fra" } },
			{ tag: "eng", identity: { language: "eng" } },
		]);
		render(<LanguageSelector />);

		fireEvent.click(
			screen.getByRole("button", { name: "Worker language: French" }),
		);

		expect(await screen.findByText("Language workers see")).toBeTruthy();
		const french = screen.getByRole("menuitemradio", { name: "Français" });
		const english = screen.getByRole("menuitemradio", { name: "English" });
		expect(french.getAttribute("aria-checked")).toBe("true");
		expect(english.getAttribute("aria-checked")).toBe("false");

		// Identity renders only through derived human labels; no ISO code
		// appears anywhere in the selector.
		expect(screen.queryByText("fra")).toBeNull();
		expect(screen.queryByText("eng")).toBeNull();

		fireEvent.click(english);
		await settleBaseUiTransitions();
		expect(selectLanguageMock).toHaveBeenCalledWith("eng");
	});

	it("disambiguates same-language siblings with qualifier labels", async () => {
		installLanguages("spa-MX", [
			{ tag: "spa", identity: { language: "spa" } },
			{ tag: "spa-MX", identity: { language: "spa", region: "MX" } },
		]);
		render(<LanguageSelector />);

		const trigger = screen.getByRole("button", {
			name: "Worker language: Spanish (Mexico)",
		});
		expect(trigger.textContent).toContain("Español de México");
		expect(trigger.textContent).toContain("Mexico");

		fireEvent.click(trigger);
		expect(await screen.findByText("Language workers see")).toBeTruthy();

		// Bare Spanish shares its language axis with the Mexico variant, so it
		// takes the "General" disambiguator instead of standing unqualified.
		const general = screen.getByRole("menuitemradio", {
			name: "Español General",
		});
		const mexico = screen.getByRole("menuitemradio", {
			name: "Español de México Mexico",
		});
		expect(general.getAttribute("aria-checked")).toBe("false");
		expect(mexico.getAttribute("aria-checked")).toBe("true");

		fireEvent.click(general);
		await settleBaseUiTransitions();
		expect(selectLanguageMock).toHaveBeenCalledWith("spa");
	});
});
