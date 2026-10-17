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
import { classicWideningTarget } from "@/lib/domain/languageRegistry";
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
 * The code a language takes when it joins an app whose languages hold `held`:
 * its preferred spelling while no language holds that, else
 * `language-<script><region>` lowered into Classic's single allowed suffix
 * segment. The suffix always carries a hyphen, which no preferred spelling
 * does, and two identities sharing a language differ in script or region, so
 * the code never collides with one `held` names.
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
	const preferred = preferredWireSpelling(identity);
	if (!held.has(preferred)) return preferred;
	const suffixed = `${identity.language}-${(identity.script ?? "").toLowerCase()}${(identity.region ?? "").toLowerCase()}`;
	if (held.has(suffixed)) {
		throw new Error(
			`The CommCare code ${suffixed} for ${languageTag(identity)} is already held by another language of this app. This is a bug in mintLanguageWireCode, not an authorable state.`,
		);
	}
	return suffixed;
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
