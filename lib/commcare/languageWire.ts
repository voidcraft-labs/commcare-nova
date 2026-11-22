// lib/commcare/languageWire.ts
//
// The one projection from Nova's structured language identities to CommCare
// Classic's wire spellings. Classic's locale grammar accepts
// `^[a-z]{2,3}(-[a-z]*)?$`; its picker catalog presents three-letter codes
// except four grandfathered two-letter rows. A code is minted here once, when
// its language joins the app, and the document stores it
// (`localization.wireCodes`); emission reads the stored code.

import {
	type AppLanguageIdentity,
	type EffectiveAppLocalization,
	type LanguageTag,
	languageTag,
	parseLanguageTag,
} from "@/lib/domain";
import {
	classicWideningTarget,
	identityIssues,
	languageCodeVerdict,
	regionChoices,
	scriptChoices,
} from "@/lib/domain/languageRegistry";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { classicLanguageRow } from "./classicLanguages";

export interface LanguageWirePlan {
	/** Wire codes in `languageOrder` order. */
	readonly languages: readonly string[];
	readonly defaultLanguage: string;
	/** Total over `languageOrder` and injective, as the schema guarantees. */
	readonly wireCodeByTag: ReadonlyMap<LanguageTag, string>;
	/**
	 * Device-picker label rows: the baked endonym at the identity's most
	 * specific key, else the baked English name — never runtime `Intl`, whose
	 * ICU data varies across Node builds and would reach wire bytes.
	 */
	readonly nameByWireCode: ReadonlyMap<string, string>;
}

/**
 * Each identity's preferred Classic spelling: its own catalog row, or its
 * macrolanguage's row (`cmn` widens through `zho` to Classic's Chinese row),
 * else the Set 3 code itself, which is always wire-valid. No preferred
 * spelling holds a hyphen.
 */
function preferredWireSpelling(identity: AppLanguageIdentity): string {
	const direct = classicLanguageRow(identity.language);
	if (direct !== undefined) return direct.code;
	const macro = classicWideningTarget(identity.language);
	const widened = macro === undefined ? undefined : classicLanguageRow(macro);
	return widened?.code ?? identity.language;
}

/**
 * The languages a code with no hyphen names, the one it reads as first: an
 * individual living language, a Set 1 alias's language, or a
 * macrolanguage's members, the predominant member first as the registry
 * lists them. Empty where it names no living language.
 */
export function languagesOfWireBase(base: string): readonly string[] {
	const verdict = languageCodeVerdict(base);
	switch (verdict.kind) {
		case "individual-living":
			return [base];
		case "set1-alias":
			return verdict.resolved === undefined ? [] : [verdict.resolved];
		case "macrolanguage":
			return (verdict.members ?? []).map((member) => member.code);
		case "non-living":
		case "unknown":
			return [];
	}
}

/** Every lawful identity of a language: bare, then by each script it is written in, each with its regions. */
export function lawfulLanguageIdentities(
	language: string,
): readonly AppLanguageIdentity[] {
	const scripts = [
		undefined,
		...scriptChoices(language).map((choice) => choice.script),
	];
	const identities: AppLanguageIdentity[] = [];
	for (const script of scripts) {
		const regions = [
			undefined,
			...regionChoices(language, script).map((choice) => choice.region),
		];
		for (const region of regions) {
			const identity: AppLanguageIdentity = {
				language,
				...(script === undefined ? {} : { script }),
				...(region === undefined ? {} : { region }),
			};
			if (identityIssues(identity).length === 0) identities.push(identity);
		}
	}
	return identities;
}

/** The name an app's strings hold for a language: the registry's label for its identity. */
function wireLanguageName(identity: AppLanguageIdentity): string {
	return resolvedLanguageDisplayLabel(identity) ?? languageTag(identity);
}

const spellingHoldersMemo = new Map<string, ReadonlyMap<string, LanguageTag>>();

/**
 * For a preferred spelling, each name to the one identity that holds the
 * spelling alone under that name: of the identities the spelling's languages
 * name whose preferred spelling it is, the first to give the name, the
 * languages in the order `languagesOfWireBase` gives them and each
 * language's identities in `lawfulLanguageIdentities`' order.
 */
function preferredSpellingHolders(
	preferred: string,
): ReadonlyMap<string, LanguageTag> {
	const memo = spellingHoldersMemo.get(preferred);
	if (memo !== undefined) return memo;
	const holders = new Map<string, LanguageTag>();
	for (const language of languagesOfWireBase(preferred)) {
		for (const candidate of lawfulLanguageIdentities(language)) {
			if (preferredWireSpelling(candidate) !== preferred) continue;
			const name = wireLanguageName(candidate);
			if (!holders.has(name)) holders.set(name, languageTag(candidate));
		}
	}
	spellingHoldersMemo.set(preferred, holders);
	return holders;
}

/**
 * The code a language takes when it joins an app whose languages hold `held`:
 * its preferred spelling while no language holds that and no other identity
 * holds the spelling alone under the same name, else `language-<script><region>`
 * lowered into Classic's single allowed suffix segment. The suffix always
 * carries a hyphen, which no preferred spelling does, and two identities
 * sharing a language differ in script or region, so the code never collides
 * with one `held` names.
 *
 * A code with no hyphen and the name the app holds for it are all an HQ app
 * says of a language. Two identities of one preferred spelling and one name
 * (Congo Swahili and Swahili are both `sw` and Kiswahili; Dari and Iranian
 * Persian both `fas` and فارسی; Aruban Papiamentu and Papiamentu both `pap`
 * and Papiamentu) would be one language to a reader, so the spelling stays
 * the first one's (`preferredSpellingHolders`) and the others take the
 * suffixed form, which names their language, script and region.
 *
 * Producers mint through `lib/doc/languageMutations.ts`, which carries the
 * code on the mutation that adds the language; the reducer stores it and the
 * emitter reads it, so a later change to the language catalog never renames
 * a code an app already holds.
 */
export function mintLanguageWireCode(
	held: ReadonlySet<string>,
	identity: AppLanguageIdentity,
): string {
	if (identity.kind === "project") {
		if (held.has(identity.language))
			throw new Error(
				`The app already has a language with the code “${identity.language}”. Choose another project code or edit that language.`,
			);
		return identity.language;
	}
	const preferred = preferredWireSpelling(identity);
	const holder = preferredSpellingHolders(preferred).get(
		wireLanguageName(identity),
	);
	const holdsAlone = holder === undefined || holder === languageTag(identity);
	if (!held.has(preferred) && holdsAlone) return preferred;
	const suffixed = `${identity.language}-${(identity.script ?? "").toLowerCase()}${(identity.region ?? "").toLowerCase()}`;
	if (!held.has(suffixed)) return suffixed;
	// Each imported code has its own identity. Allocate a fresh, grammatically
	// valid suffix without renaming any of those existing language resources.
	let code = `${suffixed}a`;
	while (held.has(code)) code += "a";
	return code;
}

/**
 * Plan the wire spelling for every configured language from the codes the
 * localization stores. The schema guarantees a code for every tag of
 * `languageOrder` and no two tags sharing one.
 */
export function planLanguageWire(
	localization: EffectiveAppLocalization,
): LanguageWirePlan {
	const wireCodeByTag = new Map<LanguageTag, string>();
	const nameByWireCode = new Map<string, string>();
	for (const tag of localization.languageOrder) {
		const wireCode = localization.wireCodes[tag];
		if (wireCode === undefined) {
			throw new Error(
				`Language ${tag} has no stored CommCare code. Every app language holds one from the mutation that added it.`,
			);
		}
		wireCodeByTag.set(tag, wireCode);
		nameByWireCode.set(
			wireCode,
			resolvedLanguageDisplayLabel(parseLanguageTag(tag)) ?? tag,
		);
	}

	const wireCode = (tag: LanguageTag): string => {
		const code = wireCodeByTag.get(tag);
		if (code === undefined) {
			throw new Error(
				`The language wire plan has no spelling for ${tag}. Every emitted language must be in the planned languageOrder.`,
			);
		}
		return code;
	};

	return {
		languages: localization.languageOrder.map(wireCode),
		defaultLanguage: wireCode(localization.defaultLanguage),
		wireCodeByTag,
		nameByWireCode,
	};
}
