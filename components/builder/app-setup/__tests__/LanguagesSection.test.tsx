// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	makeTranslationUnitId,
	type ProseTemplate,
	proseText,
} from "@/lib/domain";
import type { LanguageRegistrySearch } from "@/lib/domain/languageRegistry/load";
import { LanguagesSection } from "../LanguagesSection";

/* The picker's lazy registry chunk is mocked so no test imports the large
 * generated name catalog; the static registry (labels, scripts, regions,
 * directions) stays real. The fixture rows cover exactly the languages the
 * tests search for. */
const registryFixture = vi.hoisted((): LanguageRegistrySearch => {
	interface FixtureRow {
		readonly code: string;
		readonly englishName: string;
		readonly endonym?: string;
	}
	const rows: readonly FixtureRow[] = [
		{ code: "eng", englishName: "English", endonym: "English" },
		{ code: "fra", englishName: "French", endonym: "Français" },
		{ code: "spa", englishName: "Spanish", endonym: "Español" },
	];
	const englishName = (code: string) =>
		rows.find((row) => row.code === code)?.englishName;
	const languageOf = (value: { readonly language: string } | string) =>
		typeof value === "string" ? (value.split("-")[0] ?? value) : value.language;
	return {
		allLanguageSearchRows: () => rows,
		searchLanguages: (query: string, limit = Number.POSITIVE_INFINITY) => {
			const needle = query.trim().toLocaleLowerCase();
			const matches = rows.filter((row) =>
				[row.code, row.englishName, row.endonym ?? ""].some((text) =>
					text.toLocaleLowerCase().includes(needle),
				),
			);
			return { rows: matches.slice(0, limit), totalMatches: matches.length };
		},
		altEnglishLanguageName: () => undefined,
		englishLanguageName: englishName,
		languageDescriptor: (identity: { readonly language: string }) =>
			englishName(identity.language) ?? identity.language,
		resolvedLanguageDisplayLabel: (
			value: { readonly language: string } | string,
		) => {
			const code = languageOf(value);
			return (
				rows.find((row) => row.code === code)?.endonym ?? englishName(code)
			);
		},
		resolvedLanguageEnglishName: (
			value: { readonly language: string } | string,
		) => englishName(languageOf(value)),
	};
});

vi.mock("@/lib/domain/languageRegistry/load", () => ({
	loadLanguageRegistrySearch: () => Promise.resolve(registryFixture),
}));

const APP_ID = "languages-section-test";
const MODULE_UUID = testUuid("languages-module");
const FORM_UUID = testUuid("languages-form");
const FIELD_UUID = testUuid("languages-field");
const FIELD_LABEL_UNIT = makeTranslationUnitId("field", FIELD_UUID, "label");
const REF_LABEL: ProseTemplate = {
	parts: [
		{ kind: "text", text: "Worker " },
		{ kind: "user-ref", property: "username" },
	],
};
let store: BlueprintDocStore | undefined;

function CaptureStore() {
	store = useBlueprintDocApi();
	return null;
}

function docState() {
	if (store === undefined) throw new Error("Expected the document store.");
	return store.getState();
}

function baseDoc(): BlueprintDoc {
	return {
		appId: APP_ID,
		appName: "Care visits",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: { uuid: MODULE_UUID, id: "visits", name: "Visits" },
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
		fieldParent: {},
	};
}

function refLabelDoc(): BlueprintDoc {
	const doc = baseDoc();
	const field = doc.fields[FIELD_UUID];
	if (field === undefined || field.kind !== "text") {
		throw new Error("Expected the fixture text field.");
	}
	doc.fields[FIELD_UUID] = { ...field, label: structuredClone(REF_LABEL) };
	return doc;
}

/** Seed a Spanish target whose entries are exact copies of the source. */
function withSpanishOverlay(doc: BlueprintDoc): BlueprintDoc {
	const translations = Object.fromEntries(
		collectTranslationUnits(doc).map((unit) => [
			unit.id,
			{
				value: structuredClone(unit.source),
				sourceFingerprint: unit.sourceFingerprint,
				origin: "copied" as const,
				review: "needs-review" as const,
				translatedFrom: "eng",
			},
		]),
	);
	return {
		...doc,
		localization: {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: { spa: translations },
		},
	};
}

function renderSection({
	doc = baseDoc(),
	lang,
}: {
	doc?: BlueprintDoc;
	lang?: string;
} = {}) {
	window.history.replaceState(
		null,
		"",
		lang === undefined
			? `/build/${APP_ID}/languages`
			: `/build/${APP_ID}/languages?lang=${lang}`,
	);
	return render(
		<BlueprintDocProvider appId={APP_ID} initialDoc={doc}>
			<BuilderLocalizationProvider>
				<CaptureStore />
				<LanguagesSection />
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>,
	);
}

/** Fold a peer's admitted batch into the store the way an inbound frame does. */
function applyRemote(mutations: Mutation[]) {
	if (store === undefined) throw new Error("Expected the document store.");
	const current = store;
	const remote = prepareMutationCandidate(
		current.getState(),
		admitMutationBatch(mutations),
	);
	act(() => {
		current.getState().beginRemoteApply();
		try {
			current.getState().commitDoc(remote.nextDoc, remote.mutations);
		} finally {
			current.getState().endRemoteApply();
		}
	});
}

/** Type a name into the picker's Language search and choose a result row. */
async function pickLanguage(query: string, optionName: RegExp) {
	const input = await screen.findByLabelText("Language");
	// A change event with no inputType reads as autofill to the Base UI
	// combobox, which then keeps its popup closed; a real InputEvent opens it.
	fireEvent.input(input, { target: { value: query }, inputType: "insertText" });
	const option = await screen.findByRole("option", { name: optionName });
	fireEvent.click(option);
	await settleBaseUiTransitions();
}

function fieldLabelRow() {
	const row = screen
		.getAllByText("Care visits › Visits › Visit › Client name")
		.map((breadcrumb) => breadcrumb.closest("article"))
		.find((candidate) => candidate?.textContent?.includes("Field label"));
	if (row === undefined || row === null) {
		throw new Error("Expected the field-label translation row.");
	}
	return row;
}

function languageCard(label: string) {
	const card = screen
		.getAllByText(label)
		.map((element) => element.closest("button"))
		.find((button) => button?.hasAttribute("aria-pressed"));
	if (card === undefined || card === null) {
		throw new Error(`Expected the ${label} language card.`);
	}
	return card;
}

describe("LanguagesSection", () => {
	beforeEach(() => {
		store = undefined;
	});

	afterEach(() => {
		window.history.replaceState(null, "", "/");
	});

	it("adds a picker-chosen language and copies every current string from the source", async () => {
		renderSection();

		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		await pickLanguage("Spanish", /Español/);
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Add language",
			}),
		);

		await screen.findByRole("heading", { name: "Español phrases" });
		expect(
			screen.getByText(/translate from English to Spanish for you/),
		).toBeTruthy();
		const localization = docState().localization;
		expect(localization?.sourceLanguage).toBe("eng");
		expect(localization?.defaultLanguage).toBe("eng");
		expect(localization?.languageOrder).toEqual(["eng", "spa"]);
		const entries = Object.values(localization?.translations.spa ?? {});
		expect(entries).toHaveLength(5);
		expect(
			entries.every(
				(entry) =>
					entry.origin === "copied" &&
					entry.review === "needs-review" &&
					entry.translatedFrom === "eng",
			),
		).toBe(true);
	});

	it("changes the sole source language through the picker", async () => {
		renderSection();

		fireEvent.click(screen.getByRole("button", { name: "Change language" }));
		await pickLanguage("French", /Français/);
		fireEvent.click(screen.getByRole("button", { name: "Save language" }));

		await waitFor(() => {
			expect(docState().localization).toEqual({
				sourceLanguage: "fra",
				defaultLanguage: "fra",
				languageOrder: ["fra"],
				translations: {},
			});
		});
		await screen.findByRole("heading", { name: "Français phrases" });
	});

	it("saves a reviewed human translation for the selected target", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()), lang: "spa" });

		const row = fieldLabelRow();
		fireEvent.change(within(row).getByLabelText("Reference-safe translation"), {
			target: { value: "Nombre del cliente" },
		});
		fireEvent.click(
			within(row).getByRole("button", { name: "Save translation" }),
		);

		await waitFor(() => {
			const entry =
				docState().localization?.translations.spa?.[FIELD_LABEL_UNIT];
			expect(entry).toMatchObject({
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			});
			expect(JSON.stringify(entry?.value)).toContain("Nombre del cliente");
		});
	});

	it("searches the selected target's effective translation text", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()), lang: "spa" });

		const row = fieldLabelRow();
		fireEvent.change(within(row).getByLabelText("Reference-safe translation"), {
			target: { value: "Nombre objetivo" },
		});
		fireEvent.click(
			within(row).getByRole("button", { name: "Save translation" }),
		);
		await screen.findByDisplayValue("Nombre objetivo");

		fireEvent.change(screen.getByRole("textbox", { name: "Search phrases" }), {
			target: { value: "Nombre objetivo" },
		});
		expect(
			(
				screen.getByRole("textbox", {
					name: "Reference-safe translation",
				}) as HTMLTextAreaElement
			).value,
		).toBe("Nombre objetivo");
		expect(screen.getByText("Showing 1 of 5 phrases")).toBeTruthy();
	});

	it("falls back to the default inventory when a peer removes the selected target", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()), lang: "spa" });
		await screen.findByRole("heading", { name: "Español phrases" });

		applyRemote([{ kind: "removeLanguage", code: "spa" }]);

		await screen.findByRole("heading", { name: "English phrases" });
		expect(
			screen.getByText("Every phrase workers see in your app", {
				exact: false,
			}),
		).toBeTruthy();
		expect(docState().localization).toBeUndefined();
	});

	it("selects language cards and names translation search", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()) });
		expect(
			screen.getByRole("textbox", { name: "Search phrases" }),
		).toBeTruthy();

		const english = languageCard("English");
		const spanish = languageCard("Español");
		expect(english.getAttribute("aria-pressed")).toBe("true");
		expect(spanish.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(spanish);

		await screen.findByRole("heading", { name: "Español phrases" });
		expect(spanish.getAttribute("aria-pressed")).toBe("true");
		expect(english.getAttribute("aria-pressed")).toBe("false");
	});

	it("makes a target language the default", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()) });

		fireEvent.click(screen.getByRole("button", { name: "Make default" }));

		await waitFor(() => {
			expect(docState().localization).toMatchObject({
				sourceLanguage: "eng",
				defaultLanguage: "spa",
				languageOrder: ["spa", "eng"],
			});
		});
	});

	it("removes a target language and returns to the canonical English-only state", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()) });

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove language" }),
		);

		await waitFor(() => expect(docState().localization).toBeUndefined());
		await screen.findByRole("heading", { name: "English phrases" });
	});

	it("renders canonical source content in the source language direction", async () => {
		renderSection();

		applyRemote([
			{ kind: "relabelSourceLanguage", language: { language: "arb" } },
		]);

		await waitFor(() => {
			expect(
				screen
					.getAllByText("Care visits")
					.some((element) => element.getAttribute("dir") === "rtl"),
			).toBe(true);
		});
	});

	it("round-trips target literals that resemble protected-reference markers", async () => {
		renderSection({ doc: withSpanishOverlay(refLabelDoc()), lang: "spa" });
		const unit = collectTranslationUnits(docState()).find(
			(candidate) => candidate.id === FIELD_LABEL_UNIT,
		);
		if (unit === undefined) throw new Error("Expected the field-label unit.");
		act(() => {
			store?.getState().applyMany([
				{
					kind: "setTranslation",
					language: "spa",
					unitId: FIELD_LABEL_UNIT,
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
						translatedFrom: "eng",
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
			target: { value: "Literal [[NOVA_REF_1]] [[NOVA_REF__1]] actualizado" },
		});
		fireEvent.click(
			within(row).getByRole("button", { name: "Save translation" }),
		);

		await waitFor(() => {
			expect(
				docState().localization?.translations.spa?.[FIELD_LABEL_UNIT]?.value,
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
		renderSection({ doc: withSpanishOverlay(refLabelDoc()), lang: "spa" });

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

		await waitFor(() => {
			expect(
				docState().localization?.translations.spa?.[FIELD_LABEL_UNIT]?.value,
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
		renderSection({ doc: withSpanishOverlay(refLabelDoc()), lang: "spa" });

		const input = (await screen.findByDisplayValue(
			"Worker [[NOVA_REF_1]]",
		)) as HTMLTextAreaElement;
		const row = input.closest("article");
		if (row === null) throw new Error("Expected the translation row.");
		const save = within(row).getByRole("button", { name: "Save translation" });
		fireEvent.change(input, { target: { value: "Trabajador [[NOVA_REF_1]]" } });
		expect((save as HTMLButtonElement).disabled).toBe(false);
		fireEvent.change(input, { target: { value: "Trabajador" } });

		expect((await within(row).findByRole("alert")).textContent).toContain(
			"Keep [[NOVA_REF_1]] exactly once.",
		);
		expect((save as HTMLButtonElement).disabled).toBe(true);
	});

	it("lets a missing source-identical value become an explicit reviewed translation", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()), lang: "spa" });

		fireEvent.click(
			within(fieldLabelRow()).getByRole("button", {
				name: "Use the original text",
			}),
		);
		await waitFor(() =>
			expect(
				docState().localization?.translations.spa?.[FIELD_LABEL_UNIT],
			).toBeUndefined(),
		);

		const save = within(fieldLabelRow()).getByRole("button", {
			name: "Save translation",
		});
		expect((save as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(save);

		await waitFor(() =>
			expect(
				docState().localization?.translations.spa?.[FIELD_LABEL_UNIT],
			).toMatchObject({ origin: "human", review: "reviewed" }),
		);
	});

	it("reconciles an open translation draft when a remote edit changes its entry", async () => {
		renderSection({ doc: withSpanishOverlay(baseDoc()), lang: "spa" });

		fireEvent.change(
			within(fieldLabelRow()).getByLabelText("Reference-safe translation"),
			{ target: { value: "Borrador local" } },
		);

		const unit = collectTranslationUnits(docState()).find(
			(candidate) => candidate.id === FIELD_LABEL_UNIT,
		);
		if (unit === undefined) throw new Error("Expected the field-label unit.");
		act(() => {
			store?.getState().applyMany([
				{
					kind: "setTranslation",
					language: "spa",
					unitId: FIELD_LABEL_UNIT,
					entry: {
						value: proseText("Nombre remoto"),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
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
		renderSection({ doc: withSpanishOverlay(baseDoc()) });

		fireEvent.click(screen.getByRole("button", { name: "Add language" }));
		await screen.findByLabelText("Language");
		fireEvent.click(screen.getByRole("combobox", { name: "Copy text from" }));
		await settleBaseUiTransitions();
		const spanish = await screen.findByRole("option", { name: /Español/ });
		fireEvent.pointerDown(spanish, { pointerType: "mouse" });
		fireEvent.click(spanish);
		await settleBaseUiTransitions();

		applyRemote([{ kind: "removeLanguage", code: "spa" }]);
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "Copy text from" }).textContent,
			).toContain("English"),
		);

		await pickLanguage("French", /Français/);
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Add language",
			}),
		);
		await screen.findByRole("heading", { name: "Français phrases" });

		const localization = docState().localization;
		expect(localization?.languageOrder).toEqual(["eng", "fra"]);
		const entries = Object.values(localization?.translations.fra ?? {});
		expect(entries).toHaveLength(5);
		expect(entries.every((entry) => entry.translatedFrom === "eng")).toBe(true);
	});
});
