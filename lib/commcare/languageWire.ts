// lib/commcare/languageWire.ts
//
// The one projection from Nova's structured language identities to CommCare
// Classic's wire spellings. Classic's locale grammar accepts
// `^[a-z]{2,3}(-[a-z]*)?$`; its picker catalog presents three-letter codes
// except four grandfathered two-letter rows. Nothing outside lib/commcare
// speaks these spellings.

import {
	type AppLanguageIdentity,
	type LanguageTag,
	parseLanguageTag,
} from "@/lib/domain";
import { classicWideningTarget } from "@/lib/domain/languageRegistry";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { classicLanguageRow } from "./classicLanguages";

export interface LanguageWirePlan {
	/** Wire codes in `languageOrder` order. */
	readonly languages: readonly string[];
	readonly defaultLanguage: string;
	/** Total over the input order and injective — two tags never share a code. */
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
 * else the Set 3 code itself, which is always wire-valid.
 */
function preferredWireSpelling(identity: AppLanguageIdentity): string {
	const direct = classicLanguageRow(identity.language);
	if (direct !== undefined) return direct.code;
	const macro = classicWideningTarget(identity.language);
	const widened = macro === undefined ? undefined : classicLanguageRow(macro);
	return widened?.code ?? identity.language;
}

/**
 * Plan the wire spelling for every configured language in one pass. Distinct
 * identities that collapse to one preferred spelling (two Mandarin branches
 * both widening to Chinese) each take `language-<script><region>` lowered into
 * Classic's single allowed suffix segment; distinct identities sharing a
 * language differ in script or region, so the suffixes are distinct by
 * construction, and the closing assert makes any violation a loud compiler
 * bug rather than a silently merged locale.
 */
export function planLanguageWire(
	languageOrder: readonly LanguageTag[],
	defaultLanguage: LanguageTag,
): LanguageWirePlan {
	const identities = languageOrder.map((tag) => ({
		tag,
		identity: parseLanguageTag(tag),
	}));
	const byPreferred = new Map<string, typeof identities>();
	for (const entry of identities) {
		const preferred = preferredWireSpelling(entry.identity);
		const group = byPreferred.get(preferred);
		if (group === undefined) byPreferred.set(preferred, [entry]);
		else group.push(entry);
	}

	const wireCodeByTag = new Map<LanguageTag, string>();
	const nameByWireCode = new Map<string, string>();
	for (const [preferred, group] of byPreferred) {
		for (const { tag, identity } of group) {
			const wireCode =
				group.length === 1
					? preferred
					: `${identity.language}-${(identity.script ?? "").toLowerCase()}${(identity.region ?? "").toLowerCase()}`;
			wireCodeByTag.set(tag, wireCode);
			nameByWireCode.set(
				wireCode,
				resolvedLanguageDisplayLabel(identity) ?? tag,
			);
		}
	}

	if (new Set(wireCodeByTag.values()).size !== wireCodeByTag.size) {
		throw new Error(
			"The language wire plan assigned one Classic spelling to two app languages. This is a bug in planLanguageWire, not an authorable state.",
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
		languages: languageOrder.map(wireCode),
		defaultLanguage: wireCode(defaultLanguage),
		wireCodeByTag,
		nameByWireCode,
	};
}
