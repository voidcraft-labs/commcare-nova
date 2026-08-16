// lib/domain/localization.ts
//
// Persisted app-language vocabulary. Worker-facing strings remain canonical
// on their owning Blueprint entities; this app-level overlay stores only
// target-language values and their review provenance. The effective legacy
// state is derived by `effectiveAppLocalization` and is never backfilled.

import { z } from "zod";
import { type ProseTemplate, proseTemplateSchema } from "./prose";
import { ownRecordSchema } from "./records";

/**
 * CommCare HQ's persisted language-code grammar, tightened so a regional
 * suffix cannot be empty. Identity is lower-case and is never locale-cased on
 * storage (`es-mx`, not `es-MX`).
 */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z]+)?$/;

export const languageCodeSchema = z
	.string()
	.regex(
		LANGUAGE_CODE_PATTERN,
		"Use a lower-case two- or three-letter language code, optionally followed by a lower-case suffix.",
	);
export type LanguageCode = z.infer<typeof languageCodeSchema>;

export function normalizeLanguageCode(value: string): LanguageCode {
	return languageCodeSchema.parse(value.trim().toLowerCase());
}

export const languageDirections = ["ltr", "rtl"] as const;
export type LanguageDirection = (typeof languageDirections)[number];

export const appLanguageSchema = z
	.object({
		code: languageCodeSchema,
		name: z.string().trim().min(1),
		direction: z.enum(languageDirections),
	})
	.strict();
export type AppLanguage = z.infer<typeof appLanguageSchema>;

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
		translatedFrom: languageCodeSchema,
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
 */
export const appLocalizationSchema = z
	.object({
		sourceLanguage: languageCodeSchema,
		defaultLanguage: languageCodeSchema,
		languageOrder: z.array(languageCodeSchema).min(1),
		languages: ownRecordSchema(languageCodeSchema, appLanguageSchema),
		translations: ownRecordSchema(languageCodeSchema, translationMapSchema),
	})
	.strict()
	.superRefine((localization, ctx) => {
		const ordered = new Set<LanguageCode>();
		for (const [index, code] of localization.languageOrder.entries()) {
			if (ordered.has(code)) {
				ctx.addIssue({
					code: "custom",
					path: ["languageOrder", index],
					message: `Language ${code} appears more than once.`,
				});
			}
			ordered.add(code);
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

		for (const [code, language] of Object.entries(localization.languages)) {
			if (language.code !== code) {
				ctx.addIssue({
					code: "custom",
					path: ["languages", code, "code"],
					message: `Language record key ${code} must equal its embedded code ${language.code}.`,
				});
			}
			if (!ordered.has(code)) {
				ctx.addIssue({
					code: "custom",
					path: ["languages", code],
					message: `Language ${code} is absent from languageOrder.`,
				});
			}
		}
		for (const [index, code] of localization.languageOrder.entries()) {
			if (!Object.hasOwn(localization.languages, code)) {
				ctx.addIssue({
					code: "custom",
					path: ["languageOrder", index],
					message: `Language ${code} has no metadata record.`,
				});
			}
		}

		const expectedTargets = localization.languageOrder.filter(
			(code) => code !== localization.sourceLanguage,
		);
		const expectedTargetSet = new Set(expectedTargets);
		for (const code of Object.keys(localization.translations)) {
			if (!expectedTargetSet.has(code)) {
				ctx.addIssue({
					code: "custom",
					path: ["translations", code],
					message:
						code === localization.sourceLanguage
							? "The source language uses canonical Blueprint content and cannot have a translation overlay."
							: `Translation target ${code} is not an app language.`,
				});
			}
		}
		for (const code of expectedTargets) {
			if (!Object.hasOwn(localization.translations, code)) {
				ctx.addIssue({
					code: "custom",
					path: ["translations", code],
					message: `Target language ${code} has no translation map.`,
				});
			}
		}
	});
export type AppLocalization = z.infer<typeof appLocalizationSchema>;

const LEGACY_ENGLISH: AppLanguage = {
	code: "en",
	name: "English",
	direction: "ltr",
};

export interface EffectiveAppLocalization {
	readonly sourceLanguage: LanguageCode;
	readonly defaultLanguage: LanguageCode;
	readonly languageOrder: readonly LanguageCode[];
	readonly languages: Readonly<Record<LanguageCode, AppLanguage>>;
	readonly translations: Readonly<
		Record<LanguageCode, Readonly<Record<TranslationUnitId, TranslationEntry>>>
	>;
}

const LEGACY_LOCALIZATION: EffectiveAppLocalization = {
	sourceLanguage: "en",
	defaultLanguage: "en",
	languageOrder: ["en"],
	languages: { en: LEGACY_ENGLISH },
	translations: {},
};

export function effectiveAppLocalization(
	localization: AppLocalization | undefined,
): EffectiveAppLocalization {
	return localization ?? LEGACY_LOCALIZATION;
}

/**
 * Resolve an ambient Builder or Preview language against the exact document
 * snapshot being projected. Multiplayer and local catalog edits can remove a
 * selected target before React updates its provider lens; every snapshot read
 * therefore falls back atomically to that snapshot's runtime default.
 */
export function resolveAppLanguage(
	localization: AppLocalization | undefined,
	requested: LanguageCode | null | undefined,
): LanguageCode {
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

/** Length-prefixed segments preserve arbitrary semantic keys without escaping. */
export function makeTranslationUnitId(
	...segments: readonly string[]
): TranslationUnitId {
	return translationUnitIdSchema.parse(
		`tu1:${segments.map((segment) => `${segment.length}:${segment}`).join("")}`,
	);
}
