// scripts/generate-language-registry.ts
//
// Regenerates the language registry catalogs under lib/domain/languageRegistry/
// from the current ISO 639:2023 Set 3 code tables (SIL) and CLDR supplemental +
// display-name data. Run it when SIL or CLDR publish a release:
//
//   npx tsx scripts/generate-language-registry.ts
//
// It fetches the pinned sources over HTTPS, derives the catalogs through
// scripts/lib/languageRegistryGeneration.ts, asserts the structural facts the
// registry API depends on, and rewrites the generated files in place.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { serializeLocaleFileValue } from "@/lib/commcare/localeFile";
import {
	deriveLanguageRegistry,
	type GeneratedLanguageRegistry,
	type LanguageRegistrySource,
	type LocaleNamesFile,
} from "./lib/languageRegistryGeneration";
import { runMain } from "./lib/main";

const CLDR_JSON_VERSION = "48.2.0";
const CLDR_REPO_TAG = "release-48-2";

const SOURCES = {
	iso6393Tab:
		"https://iso639-3.sil.org/sites/iso639-3/files/downloads/iso-639-3.tab",
	macrolanguagesTab:
		"https://iso639-3.sil.org/sites/iso639-3/files/downloads/iso-639-3-macrolanguages.tab",
	cldrCore: `https://registry.npmjs.org/cldr-core/-/cldr-core-${CLDR_JSON_VERSION}.tgz`,
	cldrLocalenames: `https://registry.npmjs.org/cldr-localenames-full/-/cldr-localenames-full-${CLDR_JSON_VERSION}.tgz`,
	scriptMetadata: `https://raw.githubusercontent.com/unicode-org/cldr/${CLDR_REPO_TAG}/common/properties/scriptMetadata.txt`,
} as const;

async function fetchBytes(url: string): Promise<Buffer> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Fetching ${url} failed with HTTP ${response.status} — the registry sources are unreachable, so nothing was regenerated.`,
		);
	}
	return Buffer.from(await response.arrayBuffer());
}

function readTarString(block: Buffer, start: number, length: number): string {
	const slice = block.subarray(start, start + length);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul === -1 ? length : nul).toString("utf8");
}

function* tarEntries(
	tgz: Buffer,
): Generator<{ readonly name: string; readonly body: Buffer }> {
	const raw = gunzipSync(tgz, { maxOutputLength: 512 * 1024 * 1024 });
	let offset = 0;
	while (offset + 512 <= raw.length) {
		const header = raw.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const size = Number.parseInt(
			readTarString(header, 124, 12).trim() || "0",
			8,
		);
		const typeFlag = header[156];
		const body = raw.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (typeFlag === 0x30 || typeFlag === 0) {
			yield { name: prefix === "" ? name : `${prefix}/${name}`, body };
		}
	}
}

function supplemental<T>(body: Buffer, key: string): T {
	const parsed = JSON.parse(body.toString("utf8")) as {
		supplemental?: Record<string, unknown> & {
			metadata?: { alias?: Record<string, unknown> };
		};
	};
	const direct = parsed.supplemental?.[key];
	if (direct !== undefined) return direct as T;
	const aliased = parsed.supplemental?.metadata?.alias?.[key];
	if (aliased !== undefined) return aliased as T;
	throw new Error(
		`The cldr-core supplemental file is missing its ${key} section — the CLDR JSON layout may have changed.`,
	);
}

async function loadSource(): Promise<LanguageRegistrySource> {
	const [iso6393Tab, macrolanguagesTab, coreTgz, localenamesTgz, scriptMeta] =
		await Promise.all([
			fetchBytes(SOURCES.iso6393Tab),
			fetchBytes(SOURCES.macrolanguagesTab),
			fetchBytes(SOURCES.cldrCore),
			fetchBytes(SOURCES.cldrLocalenames),
			fetchBytes(SOURCES.scriptMetadata),
		]);

	const coreFiles = new Map<string, Buffer>();
	for (const entry of tarEntries(coreTgz)) {
		if (entry.name.startsWith("package/supplemental/")) {
			coreFiles.set(
				entry.name.slice("package/supplemental/".length),
				entry.body,
			);
		}
	}
	const coreFile = (name: string): Buffer => {
		const body = coreFiles.get(name);
		if (body === undefined) {
			throw new Error(
				`The cldr-core package has no supplemental/${name} — the CLDR JSON layout may have changed.`,
			);
		}
		return body;
	};

	const localeFiles = new Map<
		string,
		{ languages?: Buffer; territories?: Buffer; scripts?: Buffer }
	>();
	for (const entry of tarEntries(localenamesTgz)) {
		const match = entry.name.match(
			/^package\/main\/([^/]+)\/(languages|territories|scripts)\.json$/,
		);
		if (match === null) continue;
		const [, locale = "", kind = ""] = match;
		const bucket = localeFiles.get(locale) ?? {};
		bucket[kind as "languages" | "territories" | "scripts"] = entry.body;
		localeFiles.set(locale, bucket);
	}

	const parsedLocales = new Map<string, LocaleNamesFile>();
	const localeNames = (locale: string): LocaleNamesFile | undefined => {
		const cached = parsedLocales.get(locale);
		if (cached !== undefined) return cached;
		const bucket = localeFiles.get(locale);
		if (bucket === undefined) return undefined;
		const read = (
			body: Buffer | undefined,
			kind: "languages" | "territories" | "scripts",
		): Record<string, string> | undefined => {
			if (body === undefined) return undefined;
			const parsed = JSON.parse(body.toString("utf8")) as {
				main?: Record<
					string,
					{ localeDisplayNames?: Record<string, Record<string, string>> }
				>;
			};
			return parsed.main?.[locale]?.localeDisplayNames?.[kind];
		};
		const file: LocaleNamesFile = {
			languages: read(bucket.languages, "languages"),
			territories: read(bucket.territories, "territories"),
			scripts: read(bucket.scripts, "scripts"),
		};
		parsedLocales.set(locale, file);
		return file;
	};

	return {
		iso6393Tab: iso6393Tab.toString("utf8"),
		macrolanguagesTab: macrolanguagesTab.toString("utf8"),
		languageAliases: supplemental(coreFile("aliases.json"), "languageAlias"),
		languageData: supplemental(coreFile("languageData.json"), "languageData"),
		territoryInfo: supplemental(
			coreFile("territoryInfo.json"),
			"territoryInfo",
		),
		likelySubtags: supplemental(
			coreFile("likelySubtags.json"),
			"likelySubtags",
		),
		scriptMetadataTxt: scriptMeta.toString("utf8"),
		availableLocaleDirs: [...localeFiles.keys()],
		localeNames,
	};
}

function assertRegistry(registry: GeneratedLanguageRegistry): void {
	const fail = (message: string): never => {
		throw new Error(`Registry derivation check failed: ${message}`);
	};

	const livingCount = registry.livingIndividualCodesPacked.length / 3;
	if (!Number.isInteger(livingCount)) {
		fail("the packed living-individual codes are not a multiple of 3 bytes");
	}
	if (livingCount < 7000 || livingCount > 7300) {
		fail(
			`expected 7,000–7,300 living individual languages, derived ${livingCount}`,
		);
	}
	if (registry.macrolanguages.length !== 63) {
		fail(
			`expected exactly 63 macrolanguages, derived ${registry.macrolanguages.length}`,
		);
	}

	const cmnScripts =
		registry.multiScriptLanguages.find((entry) => entry.language === "cmn")
			?.scripts ?? [];
	if (cmnScripts[0]?.script !== "Hans") {
		fail("Mandarin must branch with Hans as its leading writing system");
	}
	if (!cmnScripts.some((choice) => choice.script === "Hant")) {
		fail("Mandarin must offer the Hant writing system");
	}
	const regionSet = (script: string): string => {
		const entry = registry.regionChoices.find(
			(candidate) =>
				candidate.language === "cmn" && candidate.script === script,
		);
		return (entry?.regions ?? [])
			.map((choice) => choice.region)
			.sort()
			.join(",");
	};
	if (regionSet("Hans") !== "CN,SG") {
		fail(`Mandarin+Hans regions must be CN,SG — derived ${regionSet("Hans")}`);
	}
	if (regionSet("Hant") !== "HK,MO,TW") {
		fail(
			`Mandarin+Hant regions must be HK,MO,TW — derived ${regionSet("Hant")}`,
		);
	}

	const spanish = registry.regionChoices.find(
		(entry) => entry.language === "spa",
	);
	if (spanish === undefined || spanish.script !== undefined) {
		fail("Spanish must offer regions on its bare (non-branching) identity");
	}
	const spanishRegions = spanish?.regions ?? [];
	if (spanishRegions.length < 15) {
		fail(
			`Spanish should offer at least 15 regions, derived ${spanishRegions.length}`,
		);
	}
	if (spanishRegions.some((choice) => choice.region === "US")) {
		fail("Spanish must not offer US, where it holds no official status");
	}
	if (
		registry.multiScriptLanguages.some((entry) =>
			["eng", "spa", "fra"].includes(entry.language),
		)
	) {
		fail("English, Spanish, and French must not branch by writing system");
	}

	if (registry.endonymByKey.cmn !== "中文") {
		fail(
			`the Mandarin endonym must be 中文 — derived ${registry.endonymByKey.cmn}`,
		);
	}
	if (registry.endonymByKey["cmn-Hant"]?.includes("體") !== true) {
		fail("the Mandarin+Hant endonym must render in traditional characters");
	}
	if (registry.endonymByKey.spa !== "Español") {
		fail(
			`the Spanish endonym must be Español — derived ${registry.endonymByKey.spa}`,
		);
	}

	if (
		!registry.rtlScripts.includes("Arab") ||
		!registry.rtlScripts.includes("Hebr")
	) {
		fail("the RTL script set must include Arab and Hebr");
	}
	if (registry.rtlScripts.includes("Latn")) {
		fail("the RTL script set must not include Latn");
	}
	const rtlLanguages = new Set(
		registry.rtlDefaultLanguageCodesPacked.match(/.{3}/g) ?? [],
	);
	if (!rtlLanguages.has("arb") || !rtlLanguages.has("heb")) {
		fail("Standard Arabic and Hebrew must default to right-to-left");
	}
	if (rtlLanguages.has("eng") || rtlLanguages.has("cmn")) {
		fail("English and Mandarin must not default to right-to-left");
	}

	// Every derived label can become a CommCare locale-file value (device
	// language-menu name rows), so a label the wire grammar cannot round-trip
	// is a generation failure, never a runtime one.
	const wireCheck = (label: string, origin: string): void => {
		try {
			serializeLocaleFileValue("registry-label", label);
		} catch (error) {
			fail(
				`${origin} ${JSON.stringify(label)} cannot serialize as a locale-file value: ${String(error)}`,
			);
		}
	};
	for (const [key, endonym] of Object.entries(registry.endonymByKey)) {
		wireCheck(endonym, `endonym ${key}`);
	}
	for (const line of registry.englishNamesPacked.split("\n")) {
		wireCheck(line.slice(3), `english name ${line.slice(0, 3)}`);
	}
	for (const line of registry.altEnglishNamesPacked.split("\n")) {
		wireCheck(line.slice(3), `alt english name ${line.slice(0, 3)}`);
	}
	for (const macro of registry.macrolanguages) {
		wireCheck(macro.name, `macrolanguage ${macro.code}`);
		for (const member of macro.members) {
			wireCheck(member.name, `macrolanguage member ${member.code}`);
		}
	}
	for (const entry of registry.multiScriptLanguages) {
		for (const choice of entry.scripts) {
			wireCheck(
				choice.label,
				`script label ${entry.language}-${choice.script}`,
			);
			wireCheck(
				choice.qualifier,
				`script qualifier ${entry.language}-${choice.script}`,
			);
		}
	}
	for (const entry of registry.regionChoices) {
		for (const choice of entry.regions) {
			wireCheck(
				choice.label,
				`region label ${entry.language}-${choice.region}`,
			);
		}
	}
}

function header(fileName: string): string {
	return [
		`// lib/domain/languageRegistry/${fileName}`,
		"//",
		"// AUTO-GENERATED by scripts/generate-language-registry.ts — DO NOT EDIT BY HAND.",
		"// Regenerate: npx tsx scripts/generate-language-registry.ts",
		"//",
		"// Sources:",
		`//   ${SOURCES.iso6393Tab}`,
		`//   ${SOURCES.macrolanguagesTab}`,
		`//   cldr-core + cldr-localenames-full ${CLDR_JSON_VERSION} (npm), scriptMetadata.txt at ${CLDR_REPO_TAG}`,
		"",
	].join("\n");
}

function renderCatalogs(
	registry: GeneratedLanguageRegistry,
): Record<string, string> {
	const json = (value: unknown): string => JSON.stringify(value, null, "\t");
	return {
		"codes.catalog.ts": [
			header("codes.catalog.ts"),
			"/** Sorted ISO 639:2023 Set 3 individual living codes, 3 characters each. */",
			`export const LIVING_INDIVIDUAL_LANGUAGE_CODES_PACKED =\n\t${JSON.stringify(registry.livingIndividualCodesPacked)};`,
			"",
			"/** Current Set 3 codes that are not individual living languages, packed as",
			" *  code + Language_Type letter (E extinct, A ancient, H historical,",
			" *  C constructed, S special). Macrolanguages live in their own catalog. */",
			`export const NON_LIVING_LANGUAGE_CODES_PACKED =\n\t${JSON.stringify(registry.nonLivingCodesPacked)};`,
			"",
			"/** ISO 639-1 two-letter identifier → its ISO 639:2023 Set 3 identifier. */",
			`export const ISO_639_1_TO_SET3: Readonly<Record<string, string>> = ${json(registry.iso6391ToSet3)};`,
			"",
		].join("\n"),
		"macrolanguages.catalog.ts": [
			header("macrolanguages.catalog.ts"),
			"/** Every ISO 639:2023 macrolanguage with its individual living members,",
			" *  CLDR's predominant member first. */",
			"export const MACROLANGUAGE_CATALOG: readonly {",
			"\treadonly code: string;",
			"\treadonly name: string;",
			"\treadonly members: readonly { readonly code: string; readonly name: string }[];",
			`}[] = ${json(registry.macrolanguages)};`,
			"",
			"/** Individual member code → its macrolanguage code. */",
			`export const MACROLANGUAGE_OF_MEMBER: Readonly<Record<string, string>> = ${json(registry.macrolanguageOfMember)};`,
			"",
		].join("\n"),
		"scripts.catalog.ts": [
			header("scripts.catalog.ts"),
			"/** Languages customarily written in more than one script, with their",
			" *  choices — the likely (default) script first. An absent language does",
			" *  not branch and its identities never carry a script. */",
			"export const MULTI_SCRIPT_LANGUAGE_CATALOG: readonly {",
			"\treadonly language: string;",
			"\treadonly scripts: readonly {",
			"\t\treadonly script: string;",
			"\t\treadonly label: string;",
			"\t\treadonly qualifier: string;",
			'\t\treadonly direction: "ltr" | "rtl";',
			"\t}[];",
			`}[] = ${json(registry.multiScriptLanguages)};`,
			"",
		].join("\n"),
		"regions.catalog.ts": [
			header("regions.catalog.ts"),
			"/** Regional-convention choices per language (per script where the",
			" *  language branches): territories where the language holds official or",
			" *  de-facto-official status, listed only when at least two exist. The",
			" *  likely territory leads; region always stays skippable. */",
			"export const LANGUAGE_REGION_CATALOG: readonly {",
			"\treadonly language: string;",
			"\treadonly script?: string;",
			"\treadonly regions: readonly { readonly region: string; readonly label: string }[];",
			`}[] = ${json(registry.regionChoices)};`,
			"",
		].join("\n"),
		"displayLabels.catalog.ts": [
			header("displayLabels.catalog.ts"),
			"/** Canonical identity tag → capitalized endonym at that exact key, for",
			" *  every CLDR-known language, script, and regional-convention shape. */",
			`export const ENDONYM_BY_KEY: Readonly<Record<string, string>> = ${json(registry.endonymByKey)};`,
			"",
			"/** Bare code → display English name for CLDR-known languages, so common",
			" *  labels render without the full name catalog. */",
			`export const COMMON_ENGLISH_NAME_BY_CODE: Readonly<Record<string, string>> = ${json(registry.commonEnglishNameByCode)};`,
			"",
			"/** ISO 15924 scripts written right-to-left. */",
			`export const RTL_SCRIPTS: readonly string[] = ${json(registry.rtlScripts)};`,
			"",
			"/** Living-individual codes whose likely (default) script is RTL, packed. */",
			`export const RTL_DEFAULT_LANGUAGE_CODES_PACKED =\n\t${JSON.stringify(registry.rtlDefaultLanguageCodesPacked)};`,
			"",
		].join("\n"),
		"names.catalog.ts": [
			header("names.catalog.ts"),
			"/** English name per living-individual code, one `code<name>` line each. */",
			`export const LANGUAGE_ENGLISH_NAMES_PACKED =\n\t${JSON.stringify(registry.englishNamesPacked)};`,
			"",
			"/** SIL reference names where they differ from the display name above,",
			" *  kept as additional search aliases. Same line shape. */",
			`export const LANGUAGE_ALT_ENGLISH_NAMES_PACKED =\n\t${JSON.stringify(registry.altEnglishNamesPacked)};`,
			"",
		].join("\n"),
	};
}

runMain(async () => {
	const repoRoot = process.cwd();
	const outDir = path.join(repoRoot, "lib", "domain", "languageRegistry");

	console.log("Fetching ISO 639-3 and CLDR sources…");
	const source = await loadSource();
	console.log("Deriving catalogs…");
	const registry = deriveLanguageRegistry(source);
	assertRegistry(registry);

	await mkdir(outDir, { recursive: true });
	const files = renderCatalogs(registry);
	for (const [fileName, content] of Object.entries(files)) {
		await writeFile(path.join(outDir, fileName), content, "utf8");
	}
	execFileSync(
		path.join(repoRoot, "node_modules", ".bin", "biome"),
		[
			"check",
			"--write",
			...Object.keys(files).map((f) => path.join(outDir, f)),
		],
		{ stdio: "inherit" },
	);

	const livingCount = registry.livingIndividualCodesPacked.length / 3;
	console.log(
		`Wrote ${Object.keys(files).length} catalogs → ${outDir}\n` +
			`  ${livingCount} individual living languages, ${registry.macrolanguages.length} macrolanguages,\n` +
			`  ${registry.multiScriptLanguages.length} multi-script languages, ${registry.regionChoices.length} region-choice shapes,\n` +
			`  ${Object.keys(registry.endonymByKey).length} baked endonym keys.`,
	);
});
