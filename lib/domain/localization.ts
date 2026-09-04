// lib/domain/localization.ts
//
// Persisted app-language vocabulary. Worker-facing strings remain canonical
// on their owning Blueprint entities; this app-level overlay stores only
// target-language values and their review provenance. The effective
// English-only state is derived by `effectiveAppLocalization` and is never
// backfilled.

import { z } from "zod";
import { type ProseTemplate, proseTemplateSchema } from "./prose";
import { ownRecordSchema } from "./records";

/**
 * An app language is a three-part identity: which language (ISO 639:2023
 * Set 3, individual living languages only), which writing system when the
 * language is customarily written in more than one (ISO 15924), and which
 * regional conventions when meaningful alternatives exist (ISO 3166-1
 * alpha-2). Names and text direction are derived from the identity through
 * `lib/domain/languageRegistry` and are never stored or authored.
 *
 * These schemas admit shape only; membership in the registry (individual
 * living language, valid script branch, valid region) is enforced at the
 * authoring boundaries — tool schemas, the design contract, and the picker.
 */
export const appLanguageIdentitySchema = z
	.object({
		language: z
			.string()
			.regex(
				/^[a-z]{3}$/,
				"Use a lower-case three-letter ISO 639:2023 Set 3 identifier, such as cmn or spa.",
			),
		script: z
			.string()
			.regex(
				/^[A-Z][a-z]{3}$/,
				"Use a four-letter ISO 15924 script identifier in title case, such as Hans.",
			)
			.optional(),
		region: z
			.string()
			.regex(
				/^[A-Z]{2}$/,
				"Use an upper-case two-letter ISO 3166-1 alpha-2 region identifier, such as MX.",
			)
			.optional(),
	})
	.strict();
export type AppLanguageIdentity = z.infer<typeof appLanguageIdentitySchema>;

/**
 * The canonical serialized spelling of an `AppLanguageIdentity` — the record
 * key in `AppLocalization`, the reference parameter in mutations, the
 * `?lang=` URL value, and an internal map key. It is never rendered on any
 * UI surface and agents never pass it; tools and the design contract speak
 * the identity object.
 */
export const LANGUAGE_TAG_PATTERN =
	/^[a-z]{3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?$/;

export const languageTagSchema = z
	.string()
	.regex(
		LANGUAGE_TAG_PATTERN,
		"Use a canonical language tag: a three-letter ISO 639:2023 Set 3 code, optionally followed by a title-case ISO 15924 script and an upper-case ISO 3166-1 region, joined with hyphens (cmn-Hans-CN).",
	);
export type LanguageTag = z.infer<typeof languageTagSchema>;

export function languageTag(identity: AppLanguageIdentity): LanguageTag {
	let tag = identity.language;
	if (identity.script !== undefined) tag += `-${identity.script}`;
	if (identity.region !== undefined) tag += `-${identity.region}`;
	return tag;
}

/**
 * Inverts `languageTag`. The three segment shapes are disjoint (lower-case
 * triple, title-case quad, upper-case pair), so the parse is unambiguous.
 */
export function parseLanguageTag(tag: LanguageTag): AppLanguageIdentity {
	const parsed = languageTagSchema.parse(tag);
	const [language = "", ...qualifiers] = parsed.split("-");
	const identity: AppLanguageIdentity = { language };
	for (const qualifier of qualifiers) {
		if (/^[A-Z][a-z]{3}$/.test(qualifier)) identity.script = qualifier;
		else identity.region = qualifier;
	}
	return identity;
}

export const languageDirections = ["ltr", "rtl"] as const;
export type LanguageDirection = (typeof languageDirections)[number];

export const translationUnitIdSchema = z.string().min(1).startsWith("tu1:");
export type TranslationUnitId = z.infer<typeof translationUnitIdSchema>;

export const localizedValueSchema = z.union([z.string(), proseTemplateSchema]);
export type LocalizedValue = string | ProseTemplate;

export const translationOrigins = ["copied", "ai", "human"] as const;
export type TranslationOrigin = (typeof translationOrigins)[number];

export const translationReviews = ["needs-review", "reviewed"] as const;
export type TranslationReview = (typeof translationReviews)[number];

export const translationEntrySchema = z
	.object({
		value: localizedValueSchema,
		sourceFingerprint: z.string().min(1),
		origin: z.enum(translationOrigins),
		review: z.enum(translationReviews),
		/** Historical provenance may name a language later removed from the app. */
		translatedFrom: languageTagSchema,
	})
	.strict();
export type TranslationEntry = z.infer<typeof translationEntrySchema>;

const translationMapSchema = ownRecordSchema(
	translationUnitIdSchema,
	translationEntrySchema,
);

/**
 * Materialized multilingual state. The source language owns the ordinary
 * Blueprint strings and therefore never has a duplicate translation map.
 * Language records carry nothing beyond identity — names and direction are
 * derived — so the tags themselves are the complete language catalog.
 */
export const appLocalizationSchema = z
	.object({
		sourceLanguage: languageTagSchema,
		defaultLanguage: languageTagSchema,
		languageOrder: z.array(languageTagSchema).min(1),
		translations: ownRecordSchema(languageTagSchema, translationMapSchema),
	})
	.strict()
	.superRefine((localization, ctx) => {
		const ordered = new Set<LanguageTag>();
		for (const [index, tag] of localization.languageOrder.entries()) {
			if (ordered.has(tag)) {
				ctx.addIssue({
					code: "custom",
					path: ["languageOrder", index],
					message: `Language ${tag} appears more than once.`,
				});
			}
			ordered.add(tag);
		}

		if (localization.languageOrder[0] !== localization.defaultLanguage) {
			ctx.addIssue({
				code: "custom",
				path: ["languageOrder", 0],
				message: "The runtime default language must be first.",
			});
		}
		if (!ordered.has(localization.sourceLanguage)) {
			ctx.addIssue({
				code: "custom",
				path: ["sourceLanguage"],
				message: "The source language must belong to the app.",
			});
		}
		if (!ordered.has(localization.defaultLanguage)) {
			ctx.addIssue({
				code: "custom",
				path: ["defaultLanguage"],
				message: "The default language must belong to the app.",
			});
		}

		const expectedTargets = localization.languageOrder.filter(
			(tag) => tag !== localization.sourceLanguage,
		);
		const expectedTargetSet = new Set(expectedTargets);
		for (const tag of Object.keys(localization.translations)) {
			if (!expectedTargetSet.has(tag)) {
				ctx.addIssue({
					code: "custom",
					path: ["translations", tag],
					message:
						tag === localization.sourceLanguage
							? "The source language uses canonical Blueprint content and cannot have a translation overlay."
							: `Translation target ${tag} is not an app language.`,
				});
			}
		}
		for (const tag of expectedTargets) {
			if (!Object.hasOwn(localization.translations, tag)) {
				ctx.addIssue({
					code: "custom",
					path: ["translations", tag],
					message: `Target language ${tag} has no translation map.`,
				});
			}
		}
	});
export type AppLocalization = z.infer<typeof appLocalizationSchema>;

export interface EffectiveAppLocalization {
	readonly sourceLanguage: LanguageTag;
	readonly defaultLanguage: LanguageTag;
	readonly languageOrder: readonly LanguageTag[];
	readonly translations: Readonly<
		Record<LanguageTag, Readonly<Record<TranslationUnitId, TranslationEntry>>>
	>;
}

/**
 * An absent localization root means exactly this English-only state.
 * `apps.localization = NULL` remains its canonical persisted spelling and is
 * never materialized into a stored root.
 */
const ENGLISH_ONLY_LOCALIZATION: EffectiveAppLocalization = {
	sourceLanguage: "eng",
	defaultLanguage: "eng",
	languageOrder: ["eng"],
	translations: {},
};

export function effectiveAppLocalization(
	localization: AppLocalization | undefined,
): EffectiveAppLocalization {
	return localization ?? ENGLISH_ONLY_LOCALIZATION;
}

/**
 * Resolve an ambient Builder or Preview language against the exact document
 * snapshot being projected. Multiplayer and local catalog edits can remove a
 * selected target before React updates its provider lens; every snapshot read
 * therefore falls back atomically to that snapshot's runtime default.
 */
export function resolveAppLanguage(
	localization: AppLocalization | undefined,
	requested: LanguageTag | null | undefined,
): LanguageTag {
	const effective = effectiveAppLocalization(localization);
	return requested !== null &&
		requested !== undefined &&
		effective.languageOrder.includes(requested)
		? requested
		: effective.defaultLanguage;
}

/**
 * One injective, synchronous proof of the exact canonical source value. It is
 * intentionally the canonical JSON itself rather than a lossy non-crypto hash:
 * equality cannot collide and every runtime (browser, Node, replay) agrees.
 */
export function translationSourceFingerprint(
	kind: "text" | "prose",
	value: LocalizedValue,
): string {
	return `source-v1:${kind}:${JSON.stringify(value)}`;
}

/**
 * What one wire string resolves to in each language: a single translation
 * unit, or several units whose localized texts are joined by one space. The
 * joined form exists for the one wire slot CommCare cannot split, a search
 * prompt's single validation message, when an authored rule and a compiler
 * guard share it.
 */
export type WireStringSource = TranslationUnitId | readonly TranslationUnitId[];

/** Length-prefixed segments preserve arbitrary semantic keys without escaping. */
export function makeTranslationUnitId(
	...segments: readonly string[]
): TranslationUnitId {
	return translationUnitIdSchema.parse(
		`tu1:${segments.map((segment) => `${segment.length}:${segment}`).join("")}`,
	);
}
