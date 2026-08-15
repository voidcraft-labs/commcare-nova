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
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	BlueprintDocProvider,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import {
	collectTranslationUnits,
	effectiveAppLocalization,
	makeTranslationUnitId,
	type ProseTemplate,
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

	it("saves only locally edited language settings after a peer update", async () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		fireEvent.change(screen.getByLabelText("Worker-facing language name"), {
			target: { value: "Local English" },
		});

		if (store === undefined) throw new Error("Expected the document store.");
		const remote = prepareMutationCandidate(
			store.getState(),
			admitMutationBatch([
				{ kind: "updateLanguage", code: "en", patch: { direction: "rtl" } },
			]),
		);
		act(() => {
			store?.getState().beginRemoteApply();
			try {
				store?.getState().commitDoc(remote.nextDoc, remote.mutations);
			} finally {
				store?.getState().endRemoteApply();
			}
		});

		fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
		await waitFor(() => {
			expect(
				effectiveAppLocalization(store?.getState().localization).languages.en,
			).toEqual({ code: "en", name: "Local English", direction: "rtl" });
		});
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
		expect(
			screen.getByText(
				/Automatic translation from English to español is not evaluated/,
			),
		).toBeTruthy();
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

	it("searches the selected target's effective translation text", async () => {
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
		if (row === undefined || row === null) {
			throw new Error("Expected the field-label translation row.");
		}
		const editor = within(row).getByLabelText("Reference-safe translation");
		fireEvent.change(editor, { target: { value: "Nombre objetivo" } });
		fireEvent.click(
			within(row).getByRole("button", { name: "Save translation" }),
		);
		await screen.findByDisplayValue("Nombre objetivo");

		fireEvent.change(
			screen.getByRole("textbox", { name: "Search translatable strings" }),
			{ target: { value: "Nombre objetivo" } },
		);
		expect(
			(
				screen.getByRole("textbox", {
					name: "Reference-safe translation",
				}) as HTMLTextAreaElement
			).value,
		).toBe("Nombre objetivo");
		expect(screen.getByText("Showing 1 of 5 strings")).toBeTruthy();
	});

	it("names translation search and exposes the selected language state", async () => {
		renderSection();
		expect(
			screen.getByRole("textbox", { name: "Search translatable strings" }),
		).toBeTruthy();
		const englishControl = screen
			.getAllByText("English")
			.map((label) => label.closest("button"))
			.find((button) => button?.hasAttribute("aria-pressed"));
		expect(englishControl?.getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "es" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);
		await screen.findByRole("heading", { name: "español strings" });
		const spanishControl = screen
			.getAllByText("español")
			.map((label) => label.closest("button"))
			.find((button) => button?.hasAttribute("aria-pressed"));
		expect(spanishControl?.getAttribute("aria-pressed")).toBe("true");
		expect(englishControl?.getAttribute("aria-pressed")).toBe("false");
	});

	it("renders canonical source content in the source language direction", async () => {
		renderSection();
		if (store === undefined) throw new Error("Expected the document store.");
		act(() => {
			store
				?.getState()
				.applyMany([
					{ kind: "updateLanguage", code: "en", patch: { direction: "rtl" } },
				]);
		});
		await waitFor(() => {
			expect(
				screen
					.getAllByText("Care visits")
					.some((element) => element.getAttribute("dir") === "rtl"),
			).toBe(true);
		});
	});

	it("round-trips target literals that resemble protected-reference markers", async () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "es" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);
		await screen.findByRole("heading", { name: "español strings" });
		if (store === undefined) throw new Error("Expected the document store.");

		const source: ProseTemplate = {
			parts: [
				{ kind: "text", text: "Worker " },
				{ kind: "user-ref", property: "username" },
			],
		};
		act(() => {
			store?.getState().applyMany([
				{
					kind: "updateField",
					uuid: FIELD_UUID,
					targetKind: "text",
					patch: { label: source },
				},
			]);
		});
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
						value: {
							parts: [
								{ kind: "text", text: "Literal [[NOVA_REF_1]] " },
								{ kind: "user-ref", property: "username" },
							],
						},
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			]);
		});

		const input = (await screen.findByDisplayValue(
			"Literal [[NOVA_REF_1]] [[NOVA_REF__1]]",
		)) as HTMLTextAreaElement;
		const row = input.closest("article");
		if (row === null) throw new Error("Expected the translation row.");
		fireEvent.change(input, {
			target: {
				value: "Literal [[NOVA_REF_1]] [[NOVA_REF__1]] actualizado",
			},
		});
		fireEvent.click(
			within(row).getByRole("button", { name: "Save translation" }),
		);

		await waitFor(() => {
			expect(
				effectiveAppLocalization(store?.getState().localization).translations
					.es?.[unitId]?.value,
			).toEqual({
				parts: [
					{ kind: "text", text: "Literal [[NOVA_REF_1]] " },
					{ kind: "user-ref", property: "username" },
					{ kind: "text", text: " actualizado" },
				],
			});
		});
	});

	it("escapes newly entered literals that equal a protected-reference marker", async () => {
		renderSection();
		if (store === undefined) throw new Error("Expected the document store.");
		act(() => {
			store?.getState().applyMany([
				{
					kind: "updateField",
					uuid: FIELD_UUID,
					targetKind: "text",
					patch: {
						label: {
							parts: [
								{ kind: "text", text: "Worker " },
								{ kind: "user-ref", property: "username" },
							],
						},
					},
				},
			]);
		});
		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "es" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);
		await screen.findByRole("heading", { name: "español strings" });

		const input = (await screen.findByDisplayValue(
			"Worker [[NOVA_REF_1]]",
		)) as HTMLTextAreaElement;
		const row = input.closest("article");
		if (row === null) throw new Error("Expected the translation row.");
		fireEvent.change(input, {
			target: {
				value: "Literal \\[[NOVA_REF_1]] then [[NOVA_REF_1]] and \\\\ path",
			},
		});
		fireEvent.click(
			within(row).getByRole("button", { name: "Save translation" }),
		);

		const unitId = makeTranslationUnitId("field", FIELD_UUID, "label");
		await waitFor(() => {
			expect(
				effectiveAppLocalization(store?.getState().localization).translations
					.es?.[unitId]?.value,
			).toEqual({
				parts: [
					{ kind: "text", text: "Literal [[NOVA_REF_1]] then " },
					{ kind: "user-ref", property: "username" },
					{ kind: "text", text: " and \\ path" },
				],
			});
		});
	});

	it("keeps Save disabled while the visible protected prose is invalid", async () => {
		renderSection();
		if (store === undefined) throw new Error("Expected the document store.");
		act(() => {
			store?.getState().applyMany([
				{
					kind: "updateField",
					uuid: FIELD_UUID,
					targetKind: "text",
					patch: {
						label: {
							parts: [
								{ kind: "text", text: "Worker " },
								{ kind: "user-ref", property: "username" },
							],
						},
					},
				},
			]);
		});
		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "es" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);
		await screen.findByRole("heading", { name: "español strings" });

		const input = screen.getByDisplayValue(
			"Worker [[NOVA_REF_1]]",
		) as HTMLTextAreaElement;
		const row = input.closest("article");
		if (row === null) throw new Error("Expected the translation row.");
		const save = within(row).getByRole("button", { name: "Save translation" });
		fireEvent.change(input, {
			target: { value: "Trabajador [[NOVA_REF_1]]" },
		});
		expect((save as HTMLButtonElement).disabled).toBe(false);
		fireEvent.change(input, { target: { value: "Trabajador" } });

		expect((await within(row).findByRole("alert")).textContent).toContain(
			"Keep [[NOVA_REF_1]] exactly once.",
		);
		expect((save as HTMLButtonElement).disabled).toBe(true);
	});

	it("lets a missing source-identical value become an explicit reviewed translation", async () => {
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
		fireEvent.click(
			within(row).getByRole("button", { name: "Use source fallback" }),
		);
		await waitFor(() =>
			expect(
				effectiveAppLocalization(store?.getState().localization).translations
					.es?.[makeTranslationUnitId("field", FIELD_UUID, "label")],
			).toBeUndefined(),
		);

		const missingRow = screen
			.getAllByText("Care visits › Visits › Visit › Client name")
			.map((breadcrumb) => breadcrumb.closest("article"))
			.find((candidate) => candidate?.textContent?.includes("field label"));
		if (missingRow === undefined || missingRow === null) {
			throw new Error("Expected the missing field-label row.");
		}
		const save = within(missingRow).getByRole("button", {
			name: "Save translation",
		});
		expect((save as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(save);

		await waitFor(() =>
			expect(
				effectiveAppLocalization(store?.getState().localization).translations
					.es?.[makeTranslationUnitId("field", FIELD_UUID, "label")],
			).toMatchObject({ origin: "human", review: "reviewed" }),
		);
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

	it("falls back to a current copy source when a collaborator removes the selected language", async () => {
		renderSection();

		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "es" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);
		await screen.findByRole("heading", { name: "español strings" });

		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		fireEvent.click(
			screen.getByRole("combobox", { name: "Start with strings from" }),
		);
		await settleBaseUiTransitions();
		const spanish = screen.getByRole("option", { name: "español (es)" });
		fireEvent.pointerDown(spanish, { pointerType: "mouse" });
		fireEvent.click(spanish);
		await settleBaseUiTransitions();

		if (store === undefined) throw new Error("Expected the document store.");
		const remote = prepareMutationCandidate(
			store.getState(),
			admitMutationBatch([{ kind: "removeLanguage", code: "es" }]),
		);
		act(() => {
			store?.getState().beginRemoteApply();
			try {
				store?.getState().commitDoc(remote.nextDoc, remote.mutations);
			} finally {
				store?.getState().endRemoteApply();
			}
		});
		expect(
			effectiveAppLocalization(store.getState().localization).languageOrder,
		).toEqual(["en"]);
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "Start with strings from" })
					.textContent,
			).toContain("English (en)"),
		);
		fireEvent.change(screen.getByLabelText("Language code"), {
			target: { value: "fr" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Add and copy strings" }),
		);
		await screen.findByRole("heading", { name: "français strings" });

		const localization = effectiveAppLocalization(
			store.getState().localization,
		);
		expect(localization.languageOrder).toEqual(["en", "fr"]);
		expect(
			Object.values(localization.translations.fr ?? {}).every(
				(entry) => entry.translatedFrom === "en",
			),
		).toBe(true);
	});
});
