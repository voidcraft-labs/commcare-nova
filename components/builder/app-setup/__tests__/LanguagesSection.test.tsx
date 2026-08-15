// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	BlueprintDocProvider,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import {
	collectTranslationUnits,
	effectiveAppLocalization,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
import { LanguagesSection } from "../LanguagesSection";

const APP_ID = "languages-section-test";
const MODULE_UUID = testUuid("languages-module");
const FORM_UUID = testUuid("languages-form");
const FIELD_UUID = testUuid("languages-field");
let store: BlueprintDocStore | undefined;

function CaptureStore() {
	store = useBlueprintDocApi();
	return null;
}

function renderSection() {
	return render(
		<BlueprintDocProvider
			appId={APP_ID}
			initialDoc={{
				appId: APP_ID,
				appName: "Care visits",
				connectType: null,
				caseTypes: null,
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "visits",
						name: "Visits",
					},
				},
				forms: {
					[FORM_UUID]: {
						uuid: FORM_UUID,
						id: "visit",
						name: "Visit",
						type: "survey",
					},
				},
				fields: {
					[FIELD_UUID]: {
						uuid: FIELD_UUID,
						id: "client_name",
						kind: "text",
						label: proseText("Client name"),
						hint: proseText("Use the name on their card"),
					},
				},
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: [FORM_UUID] },
				fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
			}}
		>
			<BuilderLocalizationProvider>
				<CaptureStore />
				<LanguagesSection />
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>,
	);
}

describe("LanguagesSection", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", `/build/${APP_ID}/languages`);
		store = undefined;
	});

	afterEach(() => {
		window.history.replaceState(null, "", "/");
	});

	it("adds every current string by copying an existing language, then saves a reviewed human translation", async () => {
		renderSection();

		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "es" },
		});
		expect(
			(screen.getByLabelText("Worker-facing language name") as HTMLInputElement)
				.value,
		).toBe("español");
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);

		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "español strings" }),
			).toBeTruthy(),
		);
		const current = store?.getState();
		if (current === undefined) throw new Error("Expected the document store.");
		const localization = effectiveAppLocalization(current.localization);
		expect(localization.languageOrder).toEqual(["en", "es"]);
		expect(Object.keys(localization.translations.es ?? {})).toHaveLength(5);
		expect(
			Object.values(localization.translations.es ?? {}).every(
				(entry) => entry.origin === "copied" && entry.review === "needs-review",
			),
		).toBe(true);

		const row = screen
			.getAllByText("Care visits › Visits › Visit › Client name")
			.map((breadcrumb) => breadcrumb.closest("article"))
			.find((candidate) => candidate?.textContent?.includes("field label"));
		if (row === undefined || row === null) {
			throw new Error("Expected the translation row.");
		}
		const input = within(row).getByLabelText("Reference-safe translation");
		fireEvent.change(input, { target: { value: "Nombre del cliente" } });
		fireEvent.click(
			within(row).getByRole("button", { name: "Save translation" }),
		);

		await waitFor(() => {
			const entries = effectiveAppLocalization(store?.getState().localization)
				.translations.es;
			expect(
				Object.values(entries ?? {}).some(
					(entry) =>
						entry.origin === "human" &&
						entry.review === "reviewed" &&
						JSON.stringify(entry.value).includes("Nombre del cliente"),
				),
			).toBe(true);
		});
	});

	it("reconciles an open translation draft when a remote edit changes its entry", async () => {
		renderSection();

		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "es" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);
		await screen.findByRole("heading", { name: "español strings" });

		const row = screen
			.getAllByText("Care visits › Visits › Visit › Client name")
			.map((breadcrumb) => breadcrumb.closest("article"))
			.find((candidate) => candidate?.textContent?.includes("field label"));
		if (row === undefined || row === null || store === undefined) {
			throw new Error("Expected the field-label translation row and store.");
		}
		const input = within(row).getByLabelText("Reference-safe translation");
		fireEvent.change(input, { target: { value: "Borrador local" } });

		const unitId = makeTranslationUnitId("field", FIELD_UUID, "label");
		const unit = collectTranslationUnits(store.getState()).find(
			(candidate) => candidate.id === unitId,
		);
		if (unit === undefined) throw new Error("Expected the field-label unit.");
		act(() => {
			store?.getState().applyMany([
				{
					kind: "setTranslation",
					language: "es",
					unitId,
					entry: {
						value: proseText("Nombre remoto"),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			]);
		});

		await waitFor(() =>
			expect(screen.getByDisplayValue("Nombre remoto")).toBeTruthy(),
		);
		expect(screen.queryByDisplayValue("Borrador local")).toBeNull();
	});
});
