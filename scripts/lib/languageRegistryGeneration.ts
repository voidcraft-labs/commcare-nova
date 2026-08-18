// scripts/lib/languageRegistryGeneration.ts
//
// Pure derivation from the ISO 639-3 / CLDR source files to the language
// registry catalogs under lib/domain/languageRegistry/. The generator script
// fetches the sources and renders the catalog files; this module holds every
// derivation rule so tests can drive it with checked-in fixture slices.

/** The subset of each source file the derivation reads. */
export interface LanguageRegistrySource {
	/** SIL iso-639-3.tab — Id, Part2b, Part2t, Part1, Scope, Language_Type, Ref_Name, Comment. */
	readonly iso6393Tab: string;
	/** SIL iso-639-3-macrolanguages.tab — M_Id, I_Id, I_Status. */
	readonly macrolanguagesTab: string;
	/** CLDR supplemental/aliases.json → languageAlias. */
	readonly languageAliases: Readonly<
		Record<
			string,
			{ readonly _reason?: string; readonly _replacement?: string }
		>
	>;
	/** CLDR supplemental/languageData.json → languageData. */
	readonly languageData: Readonly<
		Record<string, { readonly _scripts?: readonly string[] }>
	>;
	/** CLDR supplemental/territoryInfo.json → territoryInfo. */
	readonly territoryInfo: Readonly<
		Record<
			string,
			{
				readonly languagePopulation?: Readonly<
					Record<string, { readonly _officialStatus?: string }>
				>;
			}
		>
	>;
	/** CLDR supplemental/likelySubtags.json → likelySubtags. */
	readonly likelySubtags: Readonly<Record<string, string>>;
	/** CLDR common/properties/scriptMetadata.txt — field 6 is RTL. */
	readonly scriptMetadataTxt: string;
	/** Locale directory names available in cldr-localenames-full/main. */
	readonly availableLocaleDirs: readonly string[];
	/** Resolved per-locale display-name maps, keyed as the raw files key them. */
	readonly localeNames: (locale: string) => LocaleNamesFile | undefined;
}

export interface LocaleNamesFile {
	readonly languages?: Readonly<Record<string, string>>;
	readonly territories?: Readonly<Record<string, string>>;
	readonly scripts?: Readonly<Record<string, string>>;
}

export interface MacrolanguageEntry {
	readonly code: string;
	readonly name: string;
	readonly members: readonly { readonly code: string; readonly name: string }[];
}

export interface ScriptChoiceEntry {
	readonly script: string;
	readonly label: string;
	readonly qualifier: string;
	readonly direction: "ltr" | "rtl";
}

export interface MultiScriptLanguageEntry {
	readonly language: string;
	readonly scripts: readonly ScriptChoiceEntry[];
}

export interface RegionChoicesEntry {
	readonly language: string;
	readonly script?: string;
	readonly regions: readonly {
		readonly region: string;
		readonly label: string;
	}[];
}

export interface GeneratedLanguageRegistry {
	/** Sorted living-individual codes, three characters each, no separator. */
	readonly livingIndividualCodesPacked: string;
	/** Non-living or special SIL codes as code+type letter (E/A/H/C/S), packed. */
	readonly nonLivingCodesPacked: string;
	/** ISO 639-1 two-letter code → its ISO 639:2023 Set 3 code. */
	readonly iso6391ToSet3: Readonly<Record<string, string>>;
	readonly macrolanguages: readonly MacrolanguageEntry[];
	/** Member code → its macrolanguage code. */
	readonly macrolanguageOfMember: Readonly<Record<string, string>>;
	readonly multiScriptLanguages: readonly MultiScriptLanguageEntry[];
	readonly regionChoices: readonly RegionChoicesEntry[];
	/** Canonical identity tag → capitalized endonym, for CLDR-known keys. */
	readonly endonymByKey: Readonly<Record<string, string>>;
	/** Bare code → display English name, for CLDR-known languages only. */
	readonly commonEnglishNameByCode: Readonly<Record<string, string>>;
	readonly rtlScripts: readonly string[];
	/** Living-individual codes whose likely (default) script is RTL, packed. */
	readonly rtlDefaultLanguageCodesPacked: string;
	/** `code<name>\n` lines for every living-individual code. */
	readonly englishNamesPacked: string;
	/** Same shape, SIL Ref_Name rows where it differs from the display name. */
	readonly altEnglishNamesPacked: string;
}

const OFFICIAL_STATUSES = new Set(["official", "de_facto_official"]);

interface Iso6393Row {
	readonly id: string;
	readonly part1: string | undefined;
	readonly scope: string;
	readonly type: string;
	readonly refName: string;
}

function parseIso6393Tab(tab: string): Iso6393Row[] {
	const [header, ...lines] = tab.split("\n");
	if (header === undefined || !header.startsWith("Id\t")) {
		throw new Error(
			"The iso-639-3.tab download does not start with the expected Id column header — SIL may have changed the file layout.",
		);
	}
	return lines
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const cells = line.split("\t");
			const [id, , , part1, scope, type, refName] = cells;
			if (
				id === undefined ||
				scope === undefined ||
				type === undefined ||
				refName === undefined ||
				!/^[a-z]{3}$/.test(id)
			) {
				throw new Error(
					`An iso-639-3.tab row is missing its Id/Scope/Language_Type/Ref_Name cells: ${JSON.stringify(line)}`,
				);
			}
			return {
				id,
				part1: part1 === "" || part1 === undefined ? undefined : part1,
				scope,
				type,
				refName,
			};
		});
}

interface CldrTagParts {
	readonly lang: string;
	readonly script?: string;
	readonly region?: string;
}

function parseCldrTag(tag: string): CldrTagParts {
	const [lang = "", ...rest] = tag.replaceAll("_", "-").split("-");
	let script: string | undefined;
	let region: string | undefined;
	for (const part of rest) {
		if (/^[A-Z][a-z]{3}$/.test(part)) script = part;
		else if (/^[A-Z]{2}$/.test(part)) region = part;
	}
	return { lang, script, region };
}

function capitalizeForLocale(value: string, localeTag: string): string {
	const [first = "", ...rest] = [...value];
	return `${first.toLocaleUpperCase(localeTag)}${rest.join("")}`;
}

export function deriveLanguageRegistry(
	source: LanguageRegistrySource,
): GeneratedLanguageRegistry {
	const rows = parseIso6393Tab(source.iso6393Tab);
	const rowById = new Map(rows.map((row) => [row.id, row]));

	const livingIndividual = rows
		.filter((row) => row.scope === "I" && row.type === "L")
		.map((row) => row.id)
		.sort();
	const livingSet = new Set(livingIndividual);

	const iso6391ToSet3: Record<string, string> = {};
	for (const row of rows) {
		if (row.part1 !== undefined) iso6391ToSet3[row.part1] = row.id;
	}

	// --- CLDR locale projection -------------------------------------------
	// CLDR keys its records by BCP-47 canonical tags, which spell some Set 3
	// identities differently (cmn → zh, fra → fr, prs → fa-AF). The alias
	// table is consulted for lookups only; canonical identity never rewrites.
	const cldrTagFor = (language: string): CldrTagParts => {
		const replacement = source.languageAliases[language]?._replacement;
		if (replacement === undefined) return { lang: language };
		return parseCldrTag(replacement);
	};

	// A region-bearing alias (prs → fa-AF) claims that region for its source
	// language, so region-free siblings sharing the CLDR language (pes → fa)
	// do not also offer it.
	const claimedRegions = new Map<string, Map<string, string>>();
	for (const code of livingSet) {
		const parts = cldrTagFor(code);
		if (parts.region === undefined) continue;
		const byRegion = claimedRegions.get(parts.lang) ?? new Map();
		byRegion.set(parts.region, code);
		claimedRegions.set(parts.lang, byRegion);
	}

	// --- Scripts -----------------------------------------------------------
	const rtlScripts = source.scriptMetadataTxt
		.split("\n")
		.filter((line) => !line.startsWith("#") && line.includes(";"))
		.map((line) => line.split(";").map((cell) => cell.trim()))
		.filter((cells) => cells[6] === "YES")
		.map((cells) => cells[0] ?? "")
		.filter((script) => /^[A-Z][a-z]{3}$/.test(script))
		.sort();
	const rtlScriptSet = new Set(rtlScripts);

	const likelyScriptFor = (
		cldrLang: string,
		territory?: string,
	): string | undefined => {
		const keys =
			territory === undefined
				? [cldrLang]
				: [`${cldrLang}-${territory}`, cldrLang];
		for (const key of keys) {
			const likely = source.likelySubtags[key];
			if (likely !== undefined) return parseCldrTag(likely).script;
		}
		return undefined;
	};

	// The territories where an identity's language holds official or de-facto
	// official status, script-matched when the identity carries one: an
	// explicitly script-qualified population row states its script, and an
	// unqualified row means the territory's likely script for that language.
	const officialTerritories = (
		language: string,
		script: string | undefined,
	): string[] => {
		const parts = cldrTagFor(language);
		const claims = claimedRegions.get(parts.lang);
		const territories: string[] = [];
		for (const [territory, info] of Object.entries(source.territoryInfo)) {
			if (parts.region !== undefined && territory !== parts.region) continue;
			const claimant = claims?.get(territory);
			if (claimant !== undefined && claimant !== language) continue;
			for (const [rawKey, population] of Object.entries(
				info.languagePopulation ?? {},
			)) {
				const status = population._officialStatus;
				if (status === undefined || !OFFICIAL_STATUSES.has(status)) continue;
				const key = parseCldrTag(rawKey);
				if (key.lang !== parts.lang || key.region !== undefined) continue;
				if (script !== undefined) {
					const keyScript =
						key.script ?? likelyScriptFor(parts.lang, territory);
					if (keyScript !== script) continue;
				}
				territories.push(territory);
				break;
			}
		}
		return territories.sort();
	};

	// A language's customary writing systems: CLDR's primary scripts plus any
	// script an official-status population row qualifies explicitly. Fewer
	// than two means the language does not branch and identities stay bare.
	const customaryScripts = (language: string): string[] => {
		const parts = cldrTagFor(language);
		if (parts.script !== undefined) return [];
		const scripts = new Set(source.languageData[parts.lang]?._scripts ?? []);
		for (const info of Object.values(source.territoryInfo)) {
			for (const [rawKey, population] of Object.entries(
				info.languagePopulation ?? {},
			)) {
				const status = population._officialStatus;
				if (status === undefined || !OFFICIAL_STATUSES.has(status)) continue;
				const key = parseCldrTag(rawKey);
				if (key.lang === parts.lang && key.script !== undefined) {
					scripts.add(key.script);
				}
			}
		}
		if (scripts.size < 2) return [];
		const likely = likelyScriptFor(parts.lang);
		return [...scripts].sort((a, b) => {
			if (a === likely) return -1;
			if (b === likely) return 1;
			return a.localeCompare(b);
		});
	};

	// --- English display names ----------------------------------------------
	const en = source.localeNames("en");
	const enLanguages = en?.languages ?? {};
	const enScripts = en?.scripts ?? {};
	const enTerritories = en?.territories ?? {};

	const englishNameFor = (code: string): string => {
		const silName = rowById.get(code)?.refName ?? code;
		const alias = source.languageAliases[code];
		if (alias?._replacement === undefined) return enLanguages[code] ?? silName;
		// A macrolanguage alias points at the group headword (cmn → zh names
		// "Chinese"), which would collapse the member into the group.
		if (alias._reason === "macrolanguage") return silName;
		return (
			enLanguages[alias._replacement] ??
			enLanguages[parseCldrTag(alias._replacement).lang] ??
			silName
		);
	};

	// --- Macrolanguages ------------------------------------------------------
	const memberRows = source.macrolanguagesTab
		.split("\n")
		.slice(1)
		.filter((line) => line.trim() !== "")
		.map((line) => line.split("\t"))
		.filter((cells) => cells[2]?.trim() === "A");
	const macroCodes = rows
		.filter((row) => row.scope === "M")
		.map((row) => row.id)
		.sort();
	const macrolanguageOfMember: Record<string, string> = {};
	const membersByMacro = new Map<string, string[]>();
	for (const [macro, member] of memberRows) {
		if (macro === undefined || member === undefined) continue;
		if (!livingSet.has(member)) continue;
		macrolanguageOfMember[member] = macro;
		membersByMacro.set(macro, [...(membersByMacro.get(macro) ?? []), member]);
	}
	const macrolanguages: MacrolanguageEntry[] = macroCodes.map((macro) => {
		const macroCldrLang = cldrTagFor(macro).lang;
		const members = (membersByMacro.get(macro) ?? []).sort((a, b) => {
			// CLDR's predominant member (the one it canonicalizes onto the
			// macro's own locale) leads the suggestion list.
			const aPredominant = cldrTagFor(a).lang === macroCldrLang && a !== macro;
			const bPredominant = cldrTagFor(b).lang === macroCldrLang && b !== macro;
			if (aPredominant !== bPredominant) return aPredominant ? -1 : 1;
			return a.localeCompare(b);
		});
		return {
			code: macro,
			name: rowById.get(macro)?.refName ?? macro,
			members: members.map((code) => ({ code, name: englishNameFor(code) })),
		};
	});

	// --- Script and region catalogs -----------------------------------------
	const multiScriptLanguages: MultiScriptLanguageEntry[] = [];
	const regionChoices: RegionChoicesEntry[] = [];
	for (const language of livingIndividual) {
		const parts = cldrTagFor(language);
		const scripts = customaryScripts(language);
		if (scripts.length >= 2) {
			multiScriptLanguages.push({
				language,
				scripts: scripts.map((script) => {
					const composed = enLanguages[`${parts.lang}-${script}`];
					const qualifier = enScripts[script] ?? script;
					return {
						script,
						label:
							composed ?? `${englishNameFor(language)} (${qualifier} script)`,
						qualifier,
						direction: rtlScriptSet.has(script) ? "rtl" : "ltr",
					};
				}),
			});
			for (const script of scripts) {
				const regions = officialTerritories(language, script);
				if (regions.length < 2) continue;
				regionChoices.push({
					language,
					script,
					regions: orderRegions(regions, parts.lang, script),
				});
			}
		} else {
			const regions = officialTerritories(language, undefined);
			if (regions.length < 2) continue;
			regionChoices.push({
				language,
				regions: orderRegions(regions, parts.lang, undefined),
			});
		}
	}

	function orderRegions(
		regions: readonly string[],
		cldrLang: string,
		script: string | undefined,
	): { region: string; label: string }[] {
		const likelyTag =
			source.likelySubtags[
				script === undefined ? cldrLang : `${cldrLang}-${script}`
			] ?? source.likelySubtags[cldrLang];
		const likelyRegion =
			likelyTag === undefined ? undefined : parseCldrTag(likelyTag).region;
		return [...regions]
			.map((region) => ({ region, label: enTerritories[region] ?? region }))
			.sort((a, b) => {
				if (a.region === likelyRegion) return -1;
				if (b.region === likelyRegion) return 1;
				return a.label.localeCompare(b.label);
			});
	}

	// --- Endonyms ------------------------------------------------------------
	const availableDirs = new Set(source.availableLocaleDirs);

	const endonymFor = (
		language: string,
		script: string | undefined,
		region: string | undefined,
	): string | undefined => {
		const parts = cldrTagFor(language);
		const cldrScript = script ?? parts.script;
		const cldrRegion = region ?? parts.region;
		const tagChain: string[] = [];
		const push = (tag: string | undefined): void => {
			if (tag !== undefined && !tagChain.includes(tag)) tagChain.push(tag);
		};
		if (cldrScript !== undefined && cldrRegion !== undefined) {
			push(`${parts.lang}-${cldrScript}-${cldrRegion}`);
		}
		if (cldrScript !== undefined) push(`${parts.lang}-${cldrScript}`);
		if (cldrRegion !== undefined) push(`${parts.lang}-${cldrRegion}`);
		push(parts.lang);
		const dir = tagChain.find((tag) => availableDirs.has(tag));
		if (dir === undefined) return undefined;
		const names = source.localeNames(dir);
		const languages = names?.languages ?? {};

		// The identity's own qualifiers must survive into the label: a
		// region-bearing identity composes its territory name rather than
		// falling back to the bare language endonym another identity uses.
		if (region !== undefined) {
			const exact =
				(script !== undefined
					? languages[`${parts.lang}-${script}-${region}`]
					: undefined) ?? languages[`${parts.lang}-${region}`];
			if (exact !== undefined) return capitalizeForLocale(exact, dir);
			const base =
				(script !== undefined
					? languages[`${parts.lang}-${script}`]
					: undefined) ?? languages[parts.lang];
			const territory = names?.territories?.[region];
			if (base === undefined) return undefined;
			return capitalizeForLocale(
				territory === undefined ? base : `${base} (${territory})`,
				dir,
			);
		}
		if (script !== undefined) {
			const exact = languages[`${parts.lang}-${script}`];
			if (exact !== undefined) return capitalizeForLocale(exact, dir);
			const base = languages[parts.lang];
			if (base === undefined) return undefined;
			const scriptName = names?.scripts?.[script] ?? enScripts[script];
			return capitalizeForLocale(
				scriptName === undefined ? base : `${base} (${scriptName})`,
				dir,
			);
		}
		const base = languages[parts.lang];
		return base === undefined ? undefined : capitalizeForLocale(base, dir);
	};

	const endonymByKey: Record<string, string> = {};
	const commonEnglishNameByCode: Record<string, string> = {};
	const scriptsByLanguage = new Map(
		multiScriptLanguages.map((entry) => [
			entry.language,
			entry.scripts.map((choice) => choice.script),
		]),
	);
	const regionsByShape = new Map(
		regionChoices.map((entry) => [
			entry.script === undefined
				? entry.language
				: `${entry.language}-${entry.script}`,
			entry.regions.map((choice) => choice.region),
		]),
	);
	for (const language of livingIndividual) {
		const bare = endonymFor(language, undefined, undefined);
		if (bare === undefined) continue;
		endonymByKey[language] = bare;
		commonEnglishNameByCode[language] = englishNameFor(language);
		const scripts = scriptsByLanguage.get(language);
		const shapes: { script?: string }[] =
			scripts === undefined ? [{}] : scripts.map((script) => ({ script }));
		for (const { script } of shapes) {
			if (script !== undefined) {
				const scripted = endonymFor(language, script, undefined);
				if (scripted !== undefined) {
					endonymByKey[`${language}-${script}`] = scripted;
				}
			}
			const shapeKey =
				script === undefined ? language : `${language}-${script}`;
			for (const region of regionsByShape.get(shapeKey) ?? []) {
				const regional = endonymFor(language, script, region);
				if (regional !== undefined) {
					endonymByKey[`${shapeKey}-${region}`] = regional;
				}
			}
		}
	}

	// --- Direction defaults ---------------------------------------------------
	const rtlDefaultLanguages = livingIndividual.filter((language) => {
		const parts = cldrTagFor(language);
		const script =
			parts.script ??
			likelyScriptFor(parts.lang) ??
			(parts.lang === language ? undefined : likelyScriptFor(language));
		return script !== undefined && rtlScriptSet.has(script);
	});

	// --- Names ---------------------------------------------------------------
	const englishNameLines: string[] = [];
	const altEnglishNameLines: string[] = [];
	for (const language of livingIndividual) {
		const silName = rowById.get(language)?.refName ?? language;
		const name = englishNameFor(language);
		englishNameLines.push(`${language}${name}`);
		if (name !== silName) altEnglishNameLines.push(`${language}${silName}`);
	}

	const nonLivingCodesPacked = rows
		.filter(
			(row) => row.scope !== "M" && !(row.scope === "I" && row.type === "L"),
		)
		.map((row) => `${row.id}${row.type}`)
		.sort()
		.join("");

	return {
		livingIndividualCodesPacked: livingIndividual.join(""),
		nonLivingCodesPacked,
		iso6391ToSet3,
		macrolanguages,
		macrolanguageOfMember,
		multiScriptLanguages,
		regionChoices,
		endonymByKey,
		commonEnglishNameByCode,
		rtlScripts,
		rtlDefaultLanguageCodesPacked: rtlDefaultLanguages.join(""),
		englishNamesPacked: englishNameLines.join("\n"),
		altEnglishNamesPacked: altEnglishNameLines.join("\n"),
	};
}
