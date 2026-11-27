/** A worker reading one overridden form button or case column keeps that
 * wording in the named language. The authored label and sibling outputs
 * survive adoption, a publish and read-back. */
import { DOMParser } from "@xmldom/xmldom";
import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import {
	REGISTER,
	ROUTE,
	SOURCE,
	twoMenus,
	VISIT,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { searchEmissionFixture } from "@/lib/commcare/__tests__/searchEmissionFixture";
import { localAppStringTable } from "@/lib/commcare/appStrings";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import {
	presentedSearchWording,
	workerPromptCheck,
} from "@/lib/commcare/generatedSearchWording";
import { generatedWordingKeys } from "@/lib/commcare/generatedWording";
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
import {
	detailTabWordingId,
	generatedWordingId,
} from "@/lib/domain/generatedWording";
import {
	imageMapColumn,
	imageMapEntry,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain/modules";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { EMPTY_AFTER_SUBMIT_STACK } from "@/lib/preview/afterSubmitStack";
import { bindAppTestAction } from "@/lib/preview/app-tests/addresses";
import { projectColumnDisplay } from "@/lib/preview/columnDisplay";
import { columnOutputWording } from "@/lib/preview/localizedCaseProperties";
import { previewEntryBadge } from "@/lib/preview/menuProjection";
import {
	projectWorkerModule,
	workerDetailTabTitle,
} from "@/lib/preview/workerModule";
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

it("keeps Search group worker wording on the route’s group when menus and groups move", async () => {
	const initial = twoMenus();
	initial.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: { spa: {} },
	};
	for (const owner of [ROUTE, SOURCE]) {
		const list = initial.modules[owner].caseListConfig;
		if (!list) throw Error("Missing case list");
		const first = testUuid(`${owner}-first-group`);
		const second = testUuid(`${owner}-second-group`);
		list.searchInputGroups = [
			{
				uuid: first,
				label: owner === ROUTE ? "Route details" : "Source details",
			},
			{ uuid: second, label: "Other details" },
		];
		list.searchInputs = [
			{
				...simpleSearchInputDef(
					testUuid(`${owner}-name-input`),
					"case_name",
					"Name",
					"text",
					"case_name",
				),
				group: first,
			},
			{
				...simpleSearchInputDef(
					testUuid(`${owner}-id-input`),
					"case_id",
					"Case ID",
					"text",
					"case_id",
				),
				group: second,
			},
		];
	}
	const raw = exportedBody(initial);
	const modules = raw.modules as ReturnType<typeof expandDoc>["modules"];
	const heading = modules[0].search_config.properties[0];
	heading.label = { en: "Route details", es: "Datos de la ruta" };
	const key = "search_property.m0.group_header_0";
	const translations = raw.translations as Record<
		string,
		Record<string, string>
	>;
	translations.en[key] = "Find a client";
	const read = async (body: ReturnType<typeof exportedBody>) => {
		const result = readHqApp(
			await inputFor(body, {
				appStrings: (doc) => localAppStringTable(doc, []),
			}),
			{ claims: "full" },
		);
		if (result.kind !== "read") throw Error(JSON.stringify(result.findings));
		expect([...result.claims.records()]).toContainEqual(
			expect.objectContaining({
				entry: "application-and-settings/translations-generated-wording",
				at: `/translations/en/${key}`,
			}),
		);
		return result.draft.doc;
	};
	const respelt = structuredClone(raw);
	const oldSearch = (respelt.modules as typeof modules)[0].search_config;
	oldSearch.properties[0].name = "group_header_2";
	oldSearch.properties[0].group_key = "group_header_2";
	oldSearch.properties[1].group_key = "group_header_2";
	oldSearch.properties[2].name = "legacy_heading";
	oldSearch.properties[2].group_key = "legacy_heading";
	oldSearch.properties[3].group_key = "legacy_heading";
	(respelt.translations as typeof translations).en[
		"search_property.m0.group_header_2"
	] = "Legacy worker wording";
	const legacy = readHqApp(
		await inputFor(respelt, {
			appStrings: (doc) => localAppStringTable(doc, []),
		}),
		{ claims: "full" },
	);
	if (legacy.kind !== "account")
		throw Error("The legacy override should stop the read");
	expect(legacy.findings).toContainEqual(
		expect.objectContaining({
			code: "application-and-settings/translations-generated-key-anything-else",
		}),
	);
	expect([...legacy.claims.records()]).toContainEqual(
		expect.objectContaining({
			entry:
				"application-and-settings/translations-generated-key-anything-else",
			at: "/translations/en/search_property.m0.group_header_2",
		}),
	);
	expect([...legacy.claims.records()]).not.toContainEqual(
		expect.objectContaining({
			entry: "application-and-settings/translations-generated-wording",
			at: `/translations/en/${key}`,
		}),
	);

	// A valid first group cannot rescue an unassigned prompt later in the
	// same Search or let its generated key stand for a partially read panel.
	const ungrouped = structuredClone(raw);
	delete (ungrouped.modules as typeof modules)[0].search_config.properties[3]
		.group_key;
	const malformed = readHqApp(
		await inputFor(ungrouped, {
			appStrings: (doc) => localAppStringTable(doc, []),
		}),
		{ claims: "full" },
	);
	if (malformed.kind !== "account")
		throw Error("The malformed layout should stop the read");
	expect(malformed.findings).toContainEqual(
		expect.objectContaining({
			code: "case-search/groups-present-and-an-input-without-group-key",
		}),
	);
	expect([...malformed.claims.records()]).not.toContainEqual(
		expect.objectContaining({
			entry: "application-and-settings/translations-generated-wording",
			at: `/translations/en/${key}`,
		}),
	);

	const adopted = await read(raw);
	for (const doc of [adopted, await read(exportedBody(adopted))]) {
		const [route, source] = doc.moduleOrder;
		const wire = expandDoc(doc);
		expect(wire.modules[0].search_config.properties[0].label).toEqual(
			heading.label,
		);
		expect(wire.translations?.en[key]).toBe("Find a client");
		expect(wire.translations?.es[key]).toBeUndefined();
		const archive = new AdmZip(
			compileCcz(wire, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const table = (locale: string) =>
			readLocaleFileAsCore(archive.readAsText(`${locale}/app_strings.txt`));
		expect(table("en").get(key)).toBe("Find a client");
		expect(table("es").get(key)).toBe("Datos de la ruta");
		expect(table("en").get("search_property.m1.group_header_0")).toBe(
			"Source details",
		);
		const projected = (owner: typeof route, language: string) =>
			projectWorkerModule(doc, language, owner)?.caseListConfig
				?.searchInputGroups?.[0].label;
		expect(projected(route, "eng")).toBe("Find a client");
		expect(projected(route, "spa")).toBe("Datos de la ruta");
		expect(projected(source, "eng")).toBe("Source details");
	}
	const [route, source] = adopted.moduleOrder;
	const reordered = structuredClone(adopted);
	reordered.moduleOrder = [source, route];
	const list = reordered.modules[route].caseListConfig;
	if (!list?.searchInputGroups) throw Error("The route lost its headings");
	list.searchInputGroups.reverse();
	list.searchInputs.reverse();
	const changed = mutationCommitVerdict(
		adopted,
		diffDocsToMutations(adopted, reordered),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!changed.ok) throw Error(JSON.stringify(changed.findings));
	expect(changed.nextDoc.moduleOrder).toEqual([source, route]);
	expect(
		changed.nextDoc.modules[route].caseListConfig?.searchInputs[0].group,
	).toBe(
		changed.nextDoc.modules[route].caseListConfig?.searchInputGroups?.[0].uuid,
	);
	const wire = expandDoc(changed.nextDoc);
	expect(wire.translations?.en[key]).toBeUndefined();
	expect(
		wire.translations?.en["search_property.m1.group_header_0"],
	).toBeUndefined();
	expect(wire.translations?.en["search_property.m1.group_header_2"]).toBe(
		"Find a client",
	);
});

it("rekeys only a unique live legacy Search heading and records both source positions", async () => {
	const oldKey = "search_property.m0.g";
	const currentKey = "search_property.m0.group_header_0";
	const changes = "legacy-search-group-wording-rekeyed";
	const source = searchEmissionFixture("grouped-prompts");
	const body = exportedBody(source);
	const menus = body.modules as ReturnType<typeof expandDoc>["modules"];
	menus[0].search_config.properties[0].name = "g";
	menus[0].search_config.properties[0].group_key = "g";
	menus[0].search_config.properties[1].group_key = "g";
	body.translations = { en: { [oldKey]: "Find a client" } };
	const read = async () =>
		readHqApp(
			await inputFor(body, {
				appStrings: (doc) => localAppStringTable(doc, []),
			}),
			{ claims: "full" },
		);
	const before = await read();
	if (before.kind !== "read") throw Error(JSON.stringify(before.findings));
	const printed = expandDoc(before.draft.doc);
	expect(printed.translations?.en[oldKey]).toBeUndefined();
	expect(printed.translations?.en[currentKey]).toBe("Find a client");
	expect(printed.modules[0].search_config.properties[0].label).toEqual({
		en: "Personal details",
	});
	expect(
		localAppStringTable(before.draft.doc, []).languages.en[currentKey],
	).toBe("Find a client");
	expect(
		before.draft.facts.sameStateRewrites
			.filter((item) => item.register === changes)
			.map((item) => item.path),
	).toEqual([
		"/modules/0/search_config/properties/0/group_key",
		`/translations/en/${oldKey}`,
		`/translations/en/${currentKey}`,
	]);
	const canonical = readHqApp(
		await inputFor(exportedBody(before.draft.doc), {
			appStrings: (doc) => localAppStringTable(doc, []),
		}),
		{ claims: "full" },
	);
	if (canonical.kind !== "read")
		throw Error(JSON.stringify(canonical.findings));
	expect(
		canonical.draft.facts.sameStateRewrites.some(
			(row) => row.register === changes,
		),
	).toBe(false);
	expect(
		localAppStringTable(canonical.draft.doc, []).languages.en[currentKey],
	).toBe("Find a client");
	(body.translations as Record<string, Record<string, string>>).en[currentKey] =
		"Other saved words";
	const dormant = await read();
	if (dormant.kind !== "read") throw Error(JSON.stringify(dormant.findings));
	expect(expandDoc(dormant.draft.doc).translations?.en[currentKey]).toBe(
		"Find a client",
	);
	expect(
		dormant.draft.facts.sameStateRewrites.filter(
			(row) => row.register === changes,
		),
	).toHaveLength(3);

	(body.translations as Record<string, Record<string, string>>).en[currentKey] =
		"Find a client";
	const duplicate = await read();
	if (duplicate.kind !== "read")
		throw Error(JSON.stringify(duplicate.findings));
	expect(expandDoc(duplicate.draft.doc).translations?.en).toMatchObject({
		[currentKey]: "Find a client",
	});
	expect(
		expandDoc(duplicate.draft.doc).translations?.en?.[oldKey],
	).toBeUndefined();
	expect(duplicate.draft.facts.unusedTranslationKeys).not.toContain(
		`/translations/en/${currentKey}`,
	);
	expect([...duplicate.claims.records()]).toContainEqual(
		expect.objectContaining({
			entry: "application-and-settings/translations-generated-wording",
			at: `/translations/en/${currentKey}`,
		}),
	);

	body.langs = ["en", "es"];
	body.build_langs = ["en", "es"];
	body.translations = { en: { [oldKey]: "Find a client" } };
	const incomplete = await read();
	if (incomplete.kind !== "account")
		throw Error("An absent ordinary locale needs its own fallback review");
	expect(incomplete.findings).toContainEqual(
		expect.objectContaining({
			code: "application-and-settings/translations-generated-key-anything-else",
			detail: { name: oldKey },
		}),
	);

	menus[0].search_config.properties[0].label.es = "Datos personales";
	const bilingual = await read();
	if (bilingual.kind !== "read")
		throw Error(JSON.stringify(bilingual.findings));
	const table = localAppStringTable(bilingual.draft.doc, []);
	expect(table.languages.en[currentKey]).toBe("Find a client");
	expect(table.languages.es[currentKey]).toBe("Datos personales");
	menus[0].search_config.properties.splice(1, 1);
	const orphan = await read();
	if (orphan.kind !== "account")
		throw Error(
			"An unoccupied heading cannot establish active generated wording",
		);
	expect(orphan.findings).toContainEqual(
		expect.objectContaining({
			code: "application-and-settings/translations-generated-key-anything-else",
			detail: { name: oldKey },
		}),
	);
});

it("refuses a Search heading with a hidden-only group when a different prompt shares its displayed key", async () => {
	const body = exportedBody(searchEmissionFixture("grouped-prompts"));
	const menus = body.modules as ReturnType<typeof expandDoc>["modules"];
	const rows = menus[0].search_config.properties;
	Object.assign(rows[0], { name: "g", group_key: "g" });
	Object.assign(rows[1], { hidden: true, group_key: "g" });
	rows.push({
		...rows[3],
		name: "g",
		label: { en: "Account code" },
		exclude: true,
	});
	const result = readHqApp(
		await inputFor(body, { appStrings: (doc) => localAppStringTable(doc, []) }),
		{ claims: "full" },
	);
	if (result.kind !== "account")
		throw Error("The displayed heading and prompt cannot share one locale key");
	expect(result.findings).toContainEqual(
		expect.objectContaining({
			code: "case-search/search-group-shares-its-display-key-with-a-field",
			detail: { name: "g" },
		}),
	);
});

it("keeps a menu badge override separate from its ordinary badge in the editor and the worker", async () => {
	const source = localizationWireFixture("bilingual");
	const uuid = source.moduleOrder[0];
	const raw = exportedBody({
		...source,
		modules: {
			...source.modules,
			[uuid]: { ...source.modules[uuid], badge: { kind: "text", text: "New" } },
		},
	});
	const modules = raw.modules as ReturnType<typeof expandDoc>["modules"];
	const text = { en: "New", es: "Nuevo" };
	modules[0].custom_icons = [
		{ doc_type: "CustomIcon", form: "badge", text, xpath: null },
	];
	const entries = raw.translations as Record<string, Record<string, string>>;
	const key = "modules.m0.badge";
	entries.en[key] = "Urgent";
	const read = async (body: ReturnType<typeof exportedBody>) => {
		const result = readHqApp(
			await inputFor(body, {
				appStrings: (doc) => localAppStringTable(doc, []),
			}),
			{ claims: "full" },
		);
		if (result.kind !== "read") throw Error(JSON.stringify(result.findings));
		expect([...result.claims.records()]).toContainEqual(
			expect.objectContaining({
				entry: "application-and-settings/translations-generated-wording",
				at: `/translations/en/${key}`,
			}),
		);
		return result.draft.doc;
	};
	const adopted = await read(raw);
	for (const doc of [adopted, await read(exportedBody(adopted))]) {
		const moduleUuid = doc.moduleOrder[0];
		const wire = expandDoc(doc);
		expect(doc.modules[moduleUuid].badge).toEqual({
			kind: "text",
			text: "New",
		});
		expect(wire.modules[0].custom_icons).toMatchObject([{ text }]);
		expect(wire.translations?.en[key]).toBe("Urgent");
		expect(wire.translations?.es[key]).toBeUndefined();
		const strings = localAppStringTable(doc, []).languages;
		expect(strings.en[key]).toBe("Urgent");
		expect(strings.es[key]).toBe("Nuevo");
		const preview = (
			language: string,
			platform: "web-apps" | "android",
			authoring: boolean,
		) =>
			previewEntryBadge({
				doc,
				entry: { kind: "menu", moduleUuid },
				platform,
				authoring,
				localizedValues: workerLocalizedValues(doc, language),
				session: { context: {}, user: {}, userPropertySlugs: {} },
				lookup: { kind: "idle" },
			});
		expect(preview("eng", "web-apps", true)).toBe("New");
		expect(preview("eng", "web-apps", false)).toBe("Urgent");
		expect(preview("eng", "android", false)).toBe("Urg..");
		expect(preview("spa", "web-apps", false)).toBe("Nuevo");
	}
	entries.en[key] = `\${visit_count}`;
	const unsafe = readHqApp(
		await inputFor(raw, { appStrings: (doc) => localAppStringTable(doc, []) }),
		{ claims: "full" },
	);
	if (unsafe.kind !== "account")
		throw Error("The badge must keep literal text.");
	expect(unsafe.findings.map((finding) => finding.code)).toContain(
		"application-and-settings/name-or-label-holding-a-placeholder-a-screen-fills",
	);
});

it("keeps a form badge on its source command and every listed route", async () => {
	const source = twoMenus();
	source.forms[VISIT].badge = { kind: "text", text: "Ready" };
	source.forms[REGISTER].badge = { kind: "text", text: "New" };
	const key = "forms.m1f1.badge";
	const raw = exportedBody(source);
	raw.translations = {
		en: {
			...((raw.translations as { en?: object })?.en ?? {}),
			[key]: "Urgent",
		},
	};
	const result = readHqApp(
		await inputFor(raw, { appStrings: (doc) => localAppStringTable(doc, []) }),
		{ claims: "full" },
	);
	if (result.kind !== "read") throw Error(JSON.stringify(result.findings));
	expect([...result.claims.records()]).toContainEqual(
		expect.objectContaining({
			entry: "application-and-settings/translations-generated-wording",
			at: `/translations/en/${key}`,
		}),
	);
	const doc = result.draft.doc;
	const [routeUuid, sourceUuid] = doc.moduleOrder;
	const [register, visit] = doc.formOrder[sourceUuid];
	const id = generatedWordingId(visit, "formBadgeText");
	expect(doc.localization?.generatedSourceWording?.[id]?.value).toBe("Urgent");
	expect(doc.forms[visit].badge).toEqual({ kind: "text", text: "Ready" });
	const wire = expandDoc(doc);
	expect(wire.modules[0].forms).toEqual([]);
	expect(wire.modules[1].forms[1].custom_icons).toMatchObject([
		{ text: { en: "Ready" } },
	]);
	expect(wire.translations?.en[key]).toBe("Urgent");
	const archive = new AdmZip(
		compileCcz(wire, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	);
	const suite = new DOMParser().parseFromString(
		archive.readAsText("suite.xml"),
		"application/xml",
	);
	const bearing = Array.from(suite.getElementsByTagName("command")).filter(
		(command) =>
			Array.from(command.getElementsByTagName("locale")).some(
				(locale) => locale.getAttribute("id") === key,
			),
	);
	expect(bearing.map((command) => command.getAttribute("id"))).toEqual([
		"m0-f1",
		"m1-f1",
	]);
	const table = readLocaleFileAsCore(archive.readAsText("en/app_strings.txt"));
	expect(table.get("forms.m0f1.badge")).toBeUndefined();
	expect(table.get("forms.m1f0.badge")).toBe("New");
	expect(table.get(key)).toBe("Urgent");
	const localizedValues = workerLocalizedValues(doc, "eng");
	const preview = (
		moduleUuid: typeof sourceUuid,
		formUuid: typeof visit,
		authoring = false,
	) =>
		previewEntryBadge({
			doc,
			entry: { kind: "form", moduleUuid, formUuid },
			platform: "web-apps",
			authoring,
			localizedValues,
			session: { context: {}, user: {}, userPropertySlugs: {} },
			lookup: { kind: "idle" },
		});
	expect(preview(sourceUuid, visit)).toBe("Urgent");
	expect(preview(routeUuid, visit)).toBe("Urgent");
	expect(preview(sourceUuid, visit, true)).toBe("Ready");
	expect(preview(sourceUuid, register)).toBe("New");

	const reordered = { ...doc, moduleOrder: [sourceUuid, routeUuid] };
	expect(expandDoc(reordered).translations?.en["forms.m0f1.badge"]).toBe(
		"Urgent",
	);
	expect(expandDoc(reordered).translations?.en[key]).toBeUndefined();
	const calculated: BlueprintDoc = {
		...doc,
		forms: {
			...doc.forms,
			[visit]: {
				...doc.forms[visit],
				badge: {
					kind: "calculation",
					expression: { kind: "term", term: { kind: "literal", value: 3 } },
				},
			},
		},
	};
	expect(snapshotTranslationUnits(calculated).get(id)?.generated?.dormant).toBe(
		true,
	);
	expect(expandDoc(calculated).translations?.en[key]).toBeUndefined();
	expect(localAppStringTable(calculated, []).languages.en[key]).toBeUndefined();
	expect(workerWording(calculated, "eng", id)).toBeUndefined();
});

it("does not register a form badge for the synthetic empty-Search registration command", () => {
	const doc = twoMenus();
	const host = doc.modules[SOURCE];
	host.caseListRegistrationForm = {
		kind: "after-empty-search",
		formUuid: REGISTER,
	};
	host.caseSearchConfig = { formsReadSearch: true };
	const plan = emissionPlan(doc);
	expect([...plan.synthetic.values()].map((one) => one.formUuid)).toEqual([
		REGISTER,
	]);
	const keys = generatedWordingKeys(doc, plan);
	expect(keys.has("forms.m2f0.badge")).toBe(false);
});

it("owns a lookup heading on its list route, including the short Search detail's copy", async () => {
	const initial = twoMenus();
	for (const [module, heading] of [
		[ROUTE, "Confidence"],
		[SOURCE, "Source score"],
	]) {
		const list = initial.modules[module].caseListConfig;
		if (!list) throw Error("Missing route detail.");
		list.deviceLookup = {
			action: "org.nova.proof.LOOKUP",
			label: "Find a patient",
			extras: [{ name: "mode", value: "scan" }],
			responses: ["result"],
			resultHeading: heading,
		};
	}
	initial.modules[ROUTE].caseSearchConfig = {
		searchScreenTitle: "Find a patient",
	};
	initial.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: { spa: {} },
	};
	const raw = exportedBody(initial);
	const modules = raw.modules as ReturnType<typeof expandDoc>["modules"];
	modules[0].case_details.short.lookup_field_header = {
		en: "Confidence",
		es: "Confianza",
	};
	const key = "case_lists.m0.callout.header";
	const translations = raw.translations as Record<
		string,
		Record<string, string>
	>;
	translations.en[key] = "Match score";
	const read = async (body: ReturnType<typeof exportedBody>) => {
		const result = readHqApp(
			await inputFor(body, {
				appStrings: (doc) => localAppStringTable(doc, []),
			}),
			{ claims: "full" },
		);
		if (result.kind !== "read") throw Error(JSON.stringify(result.findings));
		expect([...result.claims.records()]).toContainEqual(
			expect.objectContaining({
				entry: "application-and-settings/translations-generated-wording",
				at: `/translations/en/${key}`,
			}),
		);
		return result.draft.doc;
	};
	const adopted = await read(raw);
	for (const doc of [adopted, await read(exportedBody(adopted))]) {
		const [route, source] = doc.moduleOrder;
		const wire = expandDoc(doc);
		expect(doc.modules[route].caseListConfig?.deviceLookup?.resultHeading).toBe(
			"Confidence",
		);
		expect(wire.modules[0].case_details.short.lookup_field_header).toEqual({
			en: "Confidence",
			es: "Confianza",
		});
		expect(wire.translations?.en[key]).toBe("Match score");
		expect(wire.translations?.es[key]).toBeUndefined();
		const archive = new AdmZip(
			compileCcz(wire, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const suite = new DOMParser().parseFromString(
			archive.readAsText("suite.xml"),
			"application/xml",
		);
		const detailIds = Array.from(suite.getElementsByTagName("detail"))
			.filter((detail) =>
				Array.from(detail.getElementsByTagName("locale")).some(
					(locale) => locale.getAttribute("id") === key,
				),
			)
			.map((detail) => detail.getAttribute("id"));
		expect(detailIds.sort()).toEqual(["m0_case_short", "m0_search_short"]);
		const table = (locale: string) =>
			readLocaleFileAsCore(archive.readAsText(`${locale}/app_strings.txt`));
		expect(table("en").get(key)).toBe("Match score");
		expect(table("es").get(key)).toBe("Confianza");
		expect(table("en").get("case_lists.m1.callout.header")).toBe(
			"Source score",
		);
		const projected = (uuid: typeof route, language: string) =>
			projectWorkerModule(doc, language, uuid)?.caseListConfig?.deviceLookup
				?.resultHeading;
		expect(projected(route, "eng")).toBe("Match score");
		expect(projected(route, "spa")).toBe("Confianza");
		expect(projected(source, "eng")).toBe("Source score");
	}
	const [route, source] = adopted.moduleOrder;
	const mod = adopted.modules[route];
	const list = mod.caseListConfig;
	const lookup = list?.deviceLookup;
	if (!list || !lookup) throw Error("The route lost its lookup.");
	const id = generatedWordingId(route, "lookupResultHeading");
	for (const disabled of [undefined, { ...lookup, resultHeading: undefined }]) {
		const off = {
			...adopted,
			modules: {
				...adopted.modules,
				[route]: {
					...mod,
					caseListConfig: { ...list, deviceLookup: disabled },
				},
			},
		};
		expect(snapshotTranslationUnits(off).get(id)?.generated?.dormant).toBe(
			true,
		);
		expect(expandDoc(off).translations?.en[key]).toBeUndefined();
		expect(localAppStringTable(off, []).languages.en[key]).toBeUndefined();
		expect(
			projectWorkerModule(off, "eng", route)?.caseListConfig?.deviceLookup
				?.resultHeading,
		).toBeUndefined();
	}
	const reordered = expandDoc({ ...adopted, moduleOrder: [source, route] });
	expect(reordered.translations?.en[key]).toBeUndefined();
	expect(reordered.translations?.en["case_lists.m1.callout.header"]).toBe(
		"Match score",
	);
});

it("keeps separate tab wording through adoption, a source change and publishing", async () => {
	const source = patients(
		[
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes"),
		],
		{
			search: {},
			list: {
				detailTabs: [
					{ uuid: uuid(41), title: "Patient", startColumnUuid: uuid(1) },
					{ uuid: uuid(42), title: "History", startColumnUuid: uuid(2) },
				],
			},
		},
	);
	source.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: { spa: {} },
	};
	const sourceBody = exportedBody(source);
	const modules = sourceBody.modules as ReturnType<typeof expandDoc>["modules"];
	if (!modules?.[0]) throw new Error("The source needs a menu.");
	const detail = modules[0].case_details.long;
	const firstTab = detail.tabs?.[0];
	if (!firstTab) throw new Error("The source needs a tab.");
	firstTab.header = { en: "Patient", es: "Paciente" };
	const caseKey = "m0.case_long.tab.1.title";
	const searchKey = "m0.search_long.tab.1.title";
	const sourceEntries = sourceBody.translations as Record<
		string,
		Record<string, string>
	>;
	sourceEntries.en[caseKey] = "Patient details";
	sourceEntries.es[searchKey] = "Resultado del paciente";
	const read = async (body: ReturnType<typeof exportedBody>) => {
		const result = readHqApp(
			await inputFor(body, {
				appStrings: (doc) => localAppStringTable(doc, []),
			}),
			{ claims: "full" },
		);
		if (result.kind !== "read")
			throw new Error(JSON.stringify(result.findings));
		return result.draft.doc;
	};
	const adopted = await read(sourceBody);
	const tab =
		adopted.modules[adopted.moduleOrder[0]].caseListConfig?.detailTabs?.[0];
	if (!tab) throw new Error("The reader lost the detail tab.");
	expect(tab.title).toBe("Patient");
	const caseTitle = detailTabWordingId(tab.uuid, false);
	const searchTitle = detailTabWordingId(tab.uuid, true);
	const checkOutputs = (doc: BlueprintDoc) => {
		const tab = doc.modules[doc.moduleOrder[0]].caseListConfig?.detailTabs?.[0];
		if (!tab) throw new Error("The document needs its first detail tab.");
		const wire = expandDoc(doc);
		const strings = localAppStringTable(doc, []).languages;
		expect(wire.modules[0].case_details.long.tabs?.[0]?.header).toEqual(
			firstTab.header,
		);
		expect(wire.translations?.en[caseKey]).toBe("Patient details");
		expect(wire.translations?.es[searchKey]).toBe("Resultado del paciente");
		expect(wire.translations?.en[searchKey]).toBeUndefined();
		expect(wire.translations?.es[caseKey]).toBeUndefined();
		expect(strings.en[caseKey]).toBe("Patient details");
		expect(strings.en[searchKey]).toBe("Patient");
		expect(strings.es[caseKey]).toBe("Paciente");
		expect(strings.es[searchKey]).toBe("Resultado del paciente");
		for (const [language, code] of [
			["eng", "en"],
			["spa", "es"],
		] as const) {
			const values = workerLocalizedValues(doc, language);
			const base = values.get(
				makeTranslationUnitId("detail-tab", tab.uuid, "title"),
			);
			if (typeof base !== "string")
				throw new Error("The locale lost the tab header.");
			expect(workerDetailTabTitle({ ...tab, title: base }, false, values)).toBe(
				strings[code][caseKey],
			);
			expect(workerDetailTabTitle({ ...tab, title: base }, true, values)).toBe(
				strings[code][searchKey],
			);
			for (const [search, key] of [
				[false, caseKey],
				[true, searchKey],
			] as const) {
				const moduleUuid = doc.moduleOrder[0];
				expect(
					bindAppTestAction(
						doc,
						{
							language,
							platform: "web-apps",
							androidDeviceId: "tab-wording-proof",
							personaUuid: null,
							screen: {
								kind: "details",
								moduleUuid,
								caseId: "patient-1",
								source: {
									kind: "records",
									moduleUuid,
									...(search && { searchAnswers: [] }),
								},
							},
							history: [],
							selections: {},
							deviceCases: { rows: [], indices: [] },
							afterSubmitStack: EMPTY_AFTER_SUBMIT_STACK,
						},
						{ kind: "detailTab", tabUuid: strings[code][key] },
					),
				).toMatchObject({ tabUuid: tab.uuid });
			}
		}
	};
	checkOutputs(adopted);
	const rebased = mutationCommitVerdict(
		adopted,
		[{ kind: "rebaseSourceLanguage", from: "eng", to: "spa" }],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!rebased.ok) throw new Error(JSON.stringify(rebased.findings));
	expect(rebased.nextDoc.localization?.sourceLanguage).toBe("spa");
	expect(
		rebased.nextDoc.localization?.generatedSourceWording?.[searchTitle]?.value,
	).toBe("Resultado del paciente");
	expect(
		rebased.nextDoc.localization?.translations.eng?.[caseTitle]?.value,
	).toBe("Patient details");
	checkOutputs(rebased.nextDoc);
	checkOutputs(await read(exportedBody(adopted)));
});

it("publishes the title on a listed-form menu with its own details", () => {
	const doc = twoMenus();
	const route = doc.modules[ROUTE];
	const config = route.caseListConfig;
	if (!config) throw new Error("The listed-form route needs a case list.");
	const tab = {
		uuid: uuid(43),
		title: "Clinic patient",
		startColumnUuid: config.columns[0].uuid,
	};
	config.detailTabs = [tab];
	const id = detailTabWordingId(tab.uuid, false);
	const unit = snapshotTranslationUnits(doc).get(id);
	if (!unit)
		throw new Error("The route needs its detail tab translation unit.");
	const changed = mutationCommitVerdict(
		doc,
		[
			{
				kind: "setTranslation",
				language: "eng",
				unitId: id,
				entry: {
					value: "Clinic details",
					origin: "human",
					review: "reviewed",
					sourceFingerprint: unit.sourceFingerprint,
					translatedFrom: "eng",
				},
			},
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!changed.ok) throw new Error(JSON.stringify(changed.findings));
	const key = "m0.case_long.tab.1.title";
	expect(localAppStringTable(changed.nextDoc, []).languages.en[key]).toBe(
		"Clinic details",
	);
	expect(expandDoc(changed.nextDoc).translations?.en[key]).toBe(
		"Clinic details",
	);
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
			altText: words,
			text: "a",
		});
		expect(
			projectColumnDisplay(column, patient, context(language, true)),
		).toMatchObject({
			kind: "image",
			altText: "\u00a0",
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

it("writes back the app name's two strings as CommCare HQ stores them, in the source language and in another", async () => {
	const base = localizationWireFixture("bilingual");
	const name = base.appName;
	const cases: readonly [string, Record<string, string>][] = [
		["neither", {}],
		[
			"both, alike",
			{ "app.display.name": "Clinique", "homescreen.title": "Clinique" },
		],
		["the display name alone", { "app.display.name": "Clinique" }],
		["the home screen title alone", { "homescreen.title": "Accueil" }],
		[
			"the two, different",
			{ "app.display.name": "Clinique", "homescreen.title": "Accueil" },
		],
		[
			"the display name alone, equal to the app's name",
			{ "app.display.name": name },
		],
		[
			"both, equal to the app's name",
			{ "app.display.name": name, "homescreen.title": name },
		],
	];
	const body = exportedBody(base);
	const codes = Object.keys(body.translations as Record<string, unknown>);
	expect(codes.length).toBe(2);
	for (const code of codes)
		for (const [label, stored] of cases) {
			const served = structuredClone(body);
			const translations = served.translations as Record<
				string,
				Record<string, string>
			>;
			const strings = { ...translations[code] };
			delete strings["app.display.name"];
			delete strings["homescreen.title"];
			translations[code] = { ...strings, ...stored };
			const result = readHqApp(
				await inputFor(served, {
					appStrings: (read) => localAppStringTable(read, []),
				}),
			);
			if (result.kind !== "read")
				throw new Error(`${code} ${label}: ${JSON.stringify(result.findings)}`);
			const again = exportedBody(result.draft.doc);
			const keys = (body: Record<string, unknown>) =>
				Object.fromEntries(
					Object.entries(
						(body.translations as Record<string, Record<string, string>>)[
							code
						] ?? {},
					).filter(
						([key]) => key === "app.display.name" || key === "homescreen.title",
					),
				);
			expect([code, label, again.name, keys(again)]).toEqual([
				code,
				label,
				served.name,
				keys(served),
			]);
		}
});
