import type { AppLanguageIdentity, LanguageTag } from "@/lib/domain";
import {
	languageDirection,
	languageDisplayLabel,
	languageEnglishName,
	languageQualifierLabels,
} from "@/lib/domain/languageRegistry";
import type { LanguageRegistrySearch } from "@/lib/domain/languageRegistry/load";

interface SelectorRow {
	readonly tag: LanguageTag;
	readonly identity: AppLanguageIdentity;
	/** Endonym-first label; undefined while the full registry chunk loads. */
	readonly label: string | undefined;
	/** Full English qualified name, for the tooltip and accessible name. */
	readonly englishName: string | undefined;
	readonly direction: "ltr" | "rtl";
	/**
	 * The muted disambiguator, present only when the identity carries
	 * qualifiers or shares its language axis with another app language.
	 */
	readonly qualifier: string | undefined;
}

/** Human labels for the current app's language identities. The optional full
 * registry resolves the long tail after its lazy chunk is available. */
export function languageSelectorRows(
	languages: readonly { tag: LanguageTag; identity: AppLanguageIdentity }[],
	resolver?: Pick<
		LanguageRegistrySearch,
		"resolvedLanguageDisplayLabel" | "resolvedLanguageEnglishName"
	>,
): SelectorRow[] {
	const axisCounts = new Map<string, number>();
	for (const { identity } of languages) {
		axisCounts.set(
			identity.language,
			(axisCounts.get(identity.language) ?? 0) + 1,
		);
	}
	const rows: SelectorRow[] = languages.map(({ tag, identity }) => {
		const qualifiers = languageQualifierLabels(identity);
		const sharesAxis = (axisCounts.get(identity.language) ?? 0) > 1;
		return {
			tag,
			identity,
			label:
				languageDisplayLabel(identity) ??
				resolver?.resolvedLanguageDisplayLabel(identity),
			englishName:
				languageEnglishName(identity) ??
				resolver?.resolvedLanguageEnglishName(identity),
			direction: languageDirection(identity),
			qualifier:
				qualifiers.length > 0
					? qualifiers.join(", ")
					: sharesAxis
						? "General"
						: undefined,
		};
	});
	return rows;
}
