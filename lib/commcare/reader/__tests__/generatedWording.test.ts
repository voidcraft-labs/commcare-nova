/** A worker reading one overridden form button or case column keeps that
 * wording in the named language. The authored label and sibling outputs
 * survive adoption, a publish and read-back. */
import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { localAppStringTable } from "@/lib/commcare/appStrings";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	presentedSearchWording,
	workerPromptCheck,
} from "@/lib/commcare/generatedSearchWording";
import { readLocaleFileAsCore } from "@/lib/commcare/localeFile";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	workerLocalizedValues,
	workerOutputOverrides,
	workerWording,
} from "@/lib/doc/localizationWorkspace";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	localizeTranslationUnit,
	makeTranslationUnitId,
	snapshotTranslationUnits,
} from "@/lib/domain";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	imageMapColumn,
	imageMapEntry,
	plainColumn,
} from "@/lib/domain/modules";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { projectColumnDisplay } from "@/lib/preview/columnDisplay";
import { columnOutputWording } from "@/lib/preview/localizedCaseProperties";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { readHqApp } from "../index";
import { exportedBody, inputFor } from "./novaExport";

it("keeps source and secondary wording on the exact generated output", async () => {
	const original = localizationWireFixture("bilingual");
	const body = exportedBody(original);
	const translations = body.translations as Record<
		string,
		Record<string, string>
	>;
	const submit = "forms.m0f0.submit_label";
	const table = localAppStringTable(original, []);
	const header = Object.keys(table.languages.en).find(
		(key) => key.includes("case_short") && table.languages.en[key] === "Age",
	);
	if (!header) throw new Error("The fixture needs its age column");
	translations.es[submit] = "Guardar visita";
	translations.en[submit] = " ";
	translations.en["cchq.case"] = "Client details";
	translations.es[header] = "Age";
	const result = readHqApp(
		await inputFor(body, { appStrings: (doc) => localAppStringTable(doc, []) }),
		{ claims: "full" },
	);
	if (result.kind !== "read") throw new Error(JSON.stringify(result.findings));
	expect([...result.claims.records()]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				entry: "application-and-settings/translations-generated-wording",
				where: "/translations",
				at: "/translations/en/cchq.case",
				standing: "held",
			}),
		]),
	);
	const doc = result.draft.doc;
	expect(
		doc.localization?.generatedSourceWording?.[
			generatedWordingId("app", "caseTitle")
		]?.value,
	).toBe("Client details");
	expect(
		doc.modules[doc.moduleOrder[0]].caseListConfig?.columns[0].header,
	).toBe("Age");
	const module = doc.moduleOrder[0];
	const form = doc.formOrder[module][0];
	expect(
		workerWording(doc, "eng", generatedWordingId(form, "submitButton")),
	).toBe("\u00a0");
	const next = localAppStringTable(doc, []);
	expect(next.languages.es[submit]).toBe("Guardar visita");
	expect(next.languages.en[submit]).toBe(" ");
	expect(next.languages.es[header]).toBe("Age");
	expect(next.languages.es[header.replace("case_short", "case_long")]).toBe(
		"Edad",
	);
	expect(next.languages.en[header]).toBe("Age");
	expect(expandDoc(doc).translations?.es).toMatchObject({
		[submit]: "Guardar visita",
		[header]: "Age",
	});
});

it("moves an override with the form and forgets it when that form is removed", () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: ["Intake", "Follow up", "Notes"].map((name) => ({
					name,
					type: "survey" as const,
					fields: [f({ kind: "text", id: "note", label: "Note" })],
				})),
			},
		],
	});
	const module = doc.moduleOrder[0];
	const [first, second] = doc.formOrder[module];
	const id = generatedWordingId(second, "submitButton");
	const unit = snapshotTranslationUnits(doc).get(id);
	if (!unit) throw new Error("The form needs its submit control");
	const commit = (base: BlueprintDoc, changes: Mutation[]) => {
		const result = mutationCommitVerdict(
			base,
			changes,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!result.ok) throw new Error(JSON.stringify(result.findings));
		return result.nextDoc;
	};
	const given = commit(doc, [
		{
			kind: "setTranslation",
			language: "eng",
			unitId: id,
			entry: {
				value: "Finish follow up",
				origin: "human",
				review: "reviewed",
				sourceFingerprint: unit.sourceFingerprint,
				translatedFrom: "eng",
			},
		},
	]);
	expect(expandDoc(given).translations?.en["forms.m0f1.submit_label"]).toBe(
		"Finish follow up",
	);
	const moved = commit(given, [
		{ kind: "moveForm", uuid: second, toModuleUuid: module, after: null },
		{ kind: "renameForm", uuid: first, newId: "New intake" },
	]);
	expect(expandDoc(moved).translations?.en["forms.m0f0.submit_label"]).toBe(
		"Finish follow up",
	);
	expect(
		expandDoc(moved).translations?.en["forms.m0f1.submit_label"],
	).toBeUndefined();
	const cleared = commit(moved, [
		{ kind: "setTranslation", language: "eng", unitId: id, entry: null },
	]);
	expect(
		localAppStringTable(cleared, []).languages.en["forms.m0f0.submit_label"],
	).toBe("Submit");
	const removed = commit(moved, [{ kind: "removeForm", uuid: second }]);
	expect(removed.localization?.generatedSourceWording?.[id]).toBeUndefined();
	expect(
		expandDoc(removed).translations?.en["forms.m0f0.submit_label"],
	).toBeUndefined();
});

it("keeps a screen reader's secondary-language image description on just its own mapping and uses it for the blank default locale", async () => {
	const asset = uuid(19) as unknown as MediaAssetId;
	const source = patients([
		plainColumn(uuid(1), "case_name", "Name"),
		imageMapColumn(uuid(2), "notes", "Icon", [imageMapEntry("a", asset)]),
	]);
	source.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra", "spa"],
		wireCodes: { eng: "en", fra: "fr", spa: "es" },
		translations: { fra: {}, spa: {} },
	};
	const manifest = manifestFor(source);
	const raw = exportedBody(source, { expand: { assets: manifest } });
	const tables = localAppStringTable(source, []);
	const key = Object.keys(tables.wordingUnits ?? {}).find(
		(k) => k.includes("case_short") && k.includes(".alt_text."),
	);
	if (!key) throw Error("The image mapping needs a case-list description");
	const words = "Dossier #1\nVisite";
	const entries = raw.translations as Record<string, Record<string, string>>;
	entries.fr[key] = words;
	entries.fr[`${key}-absent`] = "Wrong description";
	const read = readHqApp(
		await inputFor(raw, {
			appStrings: (doc) => localAppStringTable(doc, []),
			media: {
				resolve: () => ({ kind: "asset", assetId: asset, mediaKind: "image" }),
			},
		}),
		{ claims: "full" },
	);
	if (read.kind !== "read") throw Error(JSON.stringify(read.findings));
	const doc = read.draft.doc;
	const next = expandDoc(doc, { assets: manifest });
	expect(next.translations?.fr[key]).toBe(words);
	expect(next.translations?.fr[`${key}-absent`]).toBeUndefined();
	const installed = new AdmZip(
		compileCcz(next, doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
			assets: manifest,
		}),
	);
	for (const code of ["fr", "default"])
		expect(
			readLocaleFileAsCore(installed.readAsText(`${code}/app_strings.txt`)).get(
				key,
			),
		).toBe(words);
	for (const code of ["en", "es"]) {
		const local = readLocaleFileAsCore(
			installed.readAsText(`${code}/app_strings.txt`),
		);
		expect(local.has(key)).toBe(false);
		expect(next.translations?.[code]?.[key]).toBeUndefined();
		const defaults = readLocaleFileAsCore(
			installed.readAsText("default/app_strings.txt"),
		);
		expect(new Map([...defaults, ...local]).get(key)).toBe(words);
	}
	const module = doc.modules[doc.moduleOrder[0]];
	const column = module.caseListConfig?.columns.find(
		(c) => c.kind === "image-map",
	);
	if (!column) throw Error("The image mapping must survive adoption");
	const context = (language: string, detail: boolean) => ({
		...columnOutputWording(
			module.caseListConfig,
			module.caseType,
			doc.caseTypes ?? [],
			[],
			new Map(),
			workerOutputOverrides(doc, language),
			false,
			detail,
		),
		caseProperties: [],
		calculatedTemporalTypes: new Map(),
		today: new Date(0),
		projectProse: () => "",
	});
	const patient = {
		case_id: "1",
		case_type: "patient",
		case_name: "Patient",
		properties: { notes: "a" },
		parent_case_id: null,
		external_id: null,
		status: "open" as const,
		opened_on: null,
		modified_on: null,
		closed_on: null,
		owner_id: "worker",
		app_id: "app",
		calculated: {},
	};
	for (const language of ["eng", "fra", "spa"]) {
		const values = workerLocalizedValues(doc, language);
		const id = generatedWordingId(
			column.uuid,
			"caseRows",
			"image-description",
			"a",
		);
		expect(values.get(id)).toBe(words);
		expect(
			projectColumnDisplay(column, patient, context(language, false)),
		).toMatchObject({
			kind: "image",
			alt: words,
			text: "a",
		});
		expect(
			projectColumnDisplay(column, patient, context(language, true)),
		).toMatchObject({
			kind: "image",
			alt: "\u00a0",
		});
	}
});

it("keeps the complete wording of an authored and generated search check on the one search field", async () => {
	const source = localizationWireFixture("prompts");
	const raw = exportedBody(source);
	const key = "search_property.m0.status.validation.0.text";
	const entries = raw.translations as Record<string, Record<string, string>>;
	entries.es[key] = "Escriba el estado sin comillas.";
	const result = readHqApp(
		await inputFor(raw, { appStrings: (doc) => localAppStringTable(doc, []) }),
		{ claims: "full" },
	);
	if (result.kind !== "read") throw Error(JSON.stringify(result.findings));
	const doc = result.draft.doc;
	const menu = doc.moduleOrder[0];
	const input = doc.modules[menu].caseListConfig?.searchInputs.find(
		(one) => one.name === "status",
	);
	if (!input) throw Error("The search needs a status field");
	expect(workerPromptCheck(doc, menu, input.uuid, "spa")).toBe(entries.es[key]);
	expect(workerPromptCheck(doc, menu, input.uuid, "eng")).toBe(
		localAppStringTable(doc, []).languages.en[key],
	);
	expect(expandDoc(doc).translations?.es[key]).toBe(entries.es[key]);

	const id = generatedWordingId(input.uuid, "promptValidation");
	const saved = doc.localization?.translations.spa[id];
	if (!saved) throw Error("The imported check needs an override");
	const cleared = mutationCommitVerdict(
		doc,
		[
			{
				kind: "setTranslation",
				language: "spa",
				unitId: id,
				entry: { ...saved, value: "" },
			},
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!cleared.ok) throw Error(JSON.stringify(cleared.findings));
	expect(workerPromptCheck(cleared.nextDoc, menu, input.uuid, "spa")).toBe(
		localAppStringTable(source, []).languages.es[key],
	);
	// An independent HQ value stays attached if the underlying check changes.
	// A reviewed AI translation of that same actual compound message goes stale.
	if (input.kind === "hidden" || !input.validation)
		throw Error("Expected an authored check");
	const { uuid, ...content } = input;
	const edit: Mutation = {
		kind: "updateSearchInput",
		moduleUuid: menu,
		uuid,
		searchInput: {
			...content,
			validation: {
				...input.validation,
				message: "Use the spelling on the card.",
			},
		},
	};
	const changed = mutationCommitVerdict(
		doc,
		[edit],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!changed.ok) throw Error(JSON.stringify(changed.findings));
	expect(workerPromptCheck(changed.nextDoc, menu, uuid, "spa")).toBe(
		saved.value,
	);
	const rawUnit = snapshotTranslationUnits(doc).get(id);
	if (!rawUnit) throw Error("Missing generated check");
	const read = presentedSearchWording(
		doc,
		localizeTranslationUnit(doc, "spa", rawUnit),
	);
	expect(read.source).toBe(workerPromptCheck(doc, menu, uuid, "eng"));
	const drafted = mutationCommitVerdict(
		doc,
		[
			{
				kind: "setTranslation",
				unitId: id,
				language: "spa",
				entry: {
					...saved,
					origin: "ai",
					sourceFingerprint: read.sourceFingerprint,
				},
			},
			edit,
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!drafted.ok) throw Error(JSON.stringify(drafted.findings));
	const revised = presentedSearchWording(
		drafted.nextDoc,
		localizeTranslationUnit(drafted.nextDoc, "spa", rawUnit),
	);
	expect(revised.source).toContain("Use the spelling on the card.");
	expect(revised.sourceFingerprint).not.toBe(read.sourceFingerprint);
	expect(revised.status).toBe("out-of-date");
	expect(revised.explicit?.value).toBe(saved.value);
	expect(workerPromptCheck(drafted.nextDoc, menu, uuid, "spa")).toBe(
		revised.defaultText,
	);
	expect(expandDoc(drafted.nextDoc).translations?.es[key]).not.toBe(
		saved.value,
	);

	// A historical endpoint can edit the shared original and this field's
	// composed output together. Replaying it must check the source that the
	// second edit actually observed, including when restoring both originals.
	const guardId = makeTranslationUnitId("system", "search-validation", "quote");
	const write = (base: BlueprintDoc, id: string, value: string) => {
		const unit = snapshotTranslationUnits(base).get(id);
		if (!unit) throw Error("Expected the guard and the field check");
		const current = presentedSearchWording(
			base,
			localizeTranslationUnit(base, "eng", unit),
		);
		const verdict = mutationCommitVerdict(
			base,
			[
				{
					kind: "setTranslation",
					language: "eng",
					unitId: id,
					entry: {
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
						sourceFingerprint: current.sourceFingerprint,
						value,
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw Error(JSON.stringify(verdict.findings));
		return verdict.nextDoc;
	};
	const combined = write(
		write(doc, guardId, "Use one kind of quote."),
		id,
		"Enter a valid status.",
	);
	for (const [before, after] of [
		[doc, combined],
		[combined, doc],
	]) {
		const verdict = mutationCommitVerdict(
			before,
			diffDocsToMutations(before, after),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw Error(JSON.stringify(verdict.findings));
		expect(verdict.nextDoc.localization).toEqual(after.localization);
	}
});

it("uses the native title's placeholder rules on only the generated outputs that fill arguments", () => {
	// CommCare receives the literal argument marker.
	const wording = `Visit \${name}`;
	const doc = localizationWireFixture("bilingual");
	const mod = doc.moduleOrder[0],
		form = doc.formOrder[mod][0];
	function set(id: string) {
		const row = snapshotTranslationUnits(doc).get(id);
		if (!row) throw Error("The fixture needs a menu and a form");
		return mutationCommitVerdict(
			doc,
			[
				{
					kind: "setTranslation",
					language: "eng",
					unitId: row.id,
					entry: {
						origin: "human",
						review: "reviewed",
						value: wording,
						sourceFingerprint: row.sourceFingerprint,
						translatedFrom: "eng",
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
	}
	const refused = set(generatedWordingId(mod, "menuTitle"));
	expect(refused.ok).toBe(false);
	if (!refused.ok)
		expect(refused.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "APP_STRING_VALUE_UNREPRESENTABLE" }),
			]),
		);
	const saved = set(generatedWordingId(form, "submitButton"));
	expect(saved.ok).toBe(true);
	if (saved.ok)
		expect(
			expandDoc(saved.nextDoc).translations?.en["forms.m0f0.submit_label"],
		).toBe(wording);
});

it("reads a form menu label's own wording back as it was written, beside or without the form's name, equal or not", async () => {
	const base = localizationWireFixture("bilingual");
	const formUuid = base.formOrder[base.moduleOrder[0]][0];
	const name = makeTranslationUnitId("form", formUuid, "name");
	const title = generatedWordingId(formUuid, "formTitle");
	const fingerprint =
		snapshotTranslationUnits(base).get(title)?.sourceFingerprint;
	if (fingerprint === undefined)
		throw new Error("The form needs its menu label.");
	const wording = (value: string) => ({
		value,
		sourceFingerprint: fingerprint,
		origin: "human" as const,
		review: "reviewed" as const,
		translatedFrom: "eng",
	});
	const cases: readonly [string, string | undefined, string | undefined][] = [
		["the name translated alone", "Registrar", undefined],
		["the menu label alone", undefined, "Inscribir"],
		["both, different", "Registrar", "Inscribir"],
		["both, equal", "Registrar", "Registrar"],
	];
	for (const [label, named, titled] of cases) {
		const doc = structuredClone(base);
		const spanish = doc.localization?.translations.spa;
		if (spanish === undefined) throw new Error("The fixture holds Spanish.");
		if (named === undefined) delete spanish[name];
		if (titled !== undefined) spanish[title] = wording(titled);
		const result = readHqApp(
			await inputFor(exportedBody(doc), {
				appStrings: (read) => localAppStringTable(read, []),
			}),
		);
		if (result.kind !== "read")
			throw new Error(JSON.stringify(result.findings));
		const back = result.draft.doc;
		const backForm = back.formOrder[back.moduleOrder[0]][0];
		const read = back.localization?.translations.spa ?? {};
		expect(
			[
				read[makeTranslationUnitId("form", backForm, "name")]?.value,
				read[generatedWordingId(backForm, "formTitle")]?.value,
			],
			label,
		).toEqual([named, titled]);
	}
});
