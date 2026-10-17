/**
 * The pre-step language wire-code grouping, frozen.
 *
 * Before step 2 every export recomputed each language's CommCare HQ code from
 * the whole language set (`lib/commcare/languageWire.ts::planLanguageWire` as
 * it read at the stack's base): each language took its preferred Classic
 * spelling, and the languages that preferred one spelling each took
 * `language-<script><region>` in its place. That file now reads the codes the
 * document stores and groups nothing, so this copy is the one place the
 * grouping still exists. Step `language-wire-codes` reads it to store the
 * codes every deployed app already carries, so no deployed code moves.
 */

import { classicLanguageRow } from "@/lib/commcare/classicLanguages";
import { type AppLanguageIdentity, parseLanguageTag } from "@/lib/domain";
import { classicWideningTarget } from "@/lib/domain/languageRegistry";

/**
 * Each identity's preferred Classic spelling: its own catalog row, or its
 * macrolanguage's row, else the Set 3 code itself.
 */
function preferredWireSpelling(identity: AppLanguageIdentity): string {
	const direct = classicLanguageRow(identity.language);
	if (direct !== undefined) return direct.code;
	const macro = classicWideningTarget(identity.language);
	const widened = macro === undefined ? undefined : classicLanguageRow(macro);
	return widened?.code ?? identity.language;
}

/**
 * The code each language of a stored localization root took on every
 * pre-step export, keyed by language tag. Distinct identities that share a
 * preferred spelling each take the suffixed form; distinct identities sharing
 * a language differ in script or region, so the codes are distinct, and the
 * closing check makes any violation a loud stop rather than a merged locale.
 */
export function legacyWireCodes(localization: {
	readonly languageOrder: readonly string[];
}): Record<string, string> {
	const identities = localization.languageOrder.map((tag) => ({
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
	const wireCodes: Record<string, string> = {};
	for (const [preferred, group] of byPreferred) {
		for (const { tag, identity } of group) {
			wireCodes[tag] =
				group.length === 1
					? preferred
					: `${identity.language}-${(identity.script ?? "").toLowerCase()}${(identity.region ?? "").toLowerCase()}`;
		}
	}
	if (new Set(Object.values(wireCodes)).size !== identities.length) {
		throw new Error(
			`The pre-step grouping gave two languages of [${localization.languageOrder.join(", ")}] one CommCare code, which no pre-step export could have sent.`,
		);
	}
	return wireCodes;
}
