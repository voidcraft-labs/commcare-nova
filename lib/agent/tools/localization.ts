import {
	presentedSearchWording,
	wordingSourceUnit,
} from "@/lib/doc/localizationWorkspace";
import { translationSourceFingerprintsEqual } from "@/lib/domain/localization";
import { installationAuthoringPage } from "./shared/installationAuthoringPage";
/** Shared Solutions Architect / MCP language and translation tools. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
	relabelSourceLanguageMutation,
} from "@/lib/doc/languageMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	appLanguageIdentitySchema,
	authoredTranslationValueMode,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	collectTranslationUnits,
	effectiveAppLocalization,
	hasGeneratedWording,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	languageEntries,
	languageTag,
	localizedValueSchema,
	localizeTranslationUnit,
	parseLanguageTag,
	projectLanguageIdentitySchema,
	reviewedTranslationValueMode,
	type TranslationStatus,
	type TranslationUnit,
	type TranslationUnitOwner,
	type TranslationUnitOwnerKind,
	translationEntryIntegrityIssue,
	translationUnitOwnerKinds,
	translationUnitProseSlot,
	translationUnitRoles,
	translationUnitsById,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import {
	identityIssues,
	languageDirection,
	languageQualifierLabels,
} from "@/lib/domain/languageRegistry";
import {
	languageDescriptor,
	resolvedLanguageDisplayLabel,
	resolvedLanguageEnglishName,
} from "@/lib/domain/languageRegistry/names";
import { automaticTranslationCapability } from "@/lib/translation/capabilityPolicy";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	type ReadToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

const translationStatuses = [
	"missing",
	"needs-review",
	"out-of-date",
	"ready",
] as const satisfies readonly TranslationStatus[];

/** The raw language-identity input before null-as-absence collapses. */
interface RegisteredLanguageInput {
	readonly language: string;
	readonly script?: string | null;
	readonly region?: string | null;
}

export function cleanLanguageIdentity(
	input:
		| RegisteredLanguageInput
		| z.infer<typeof projectLanguageIdentitySchema>,
): AppLanguageIdentity {
	if ("kind" in input) return input;
	return {
		language: input.language,
		...(input.script != null && { script: input.script }),
		...(input.region != null && { region: input.region }),
	};
}

/**
 * The one model-facing language shape: an exact three-part identity, with
 * registry membership enforced at parse so every rejection names what was
 * tried and the identifiers to use instead (a macrolanguage lists its
 * individual members, a two-letter code names its Set 3 code, a branching
 * language lists its required writing systems).
 */
export const registeredLanguageInputSchema = z
	.strictObject({
		language: z
			.string()
			.regex(
				/^[a-z]{2,3}$/,
				"Use a lower-case ISO 639:2023 Set 3 language code, such as cmn or spa.",
			)
			.describe(
				"ISO 639:2023 Set 3 individual living-language code — three lower-case letters (cmn, spa, hin). Macrolanguages, two-letter codes, and non-living codes are rejected with the identifiers to use instead.",
			),
		script: z
			.string()
			.regex(
				/^[A-Z][a-z]{3}$/,
				"Use a four-letter ISO 15924 script identifier in title case, such as Hans.",
			)
			.nullable()
			.optional()
			.describe(
				"ISO 15924 writing-system code (Hans, Cyrl). Required exactly when the language is customarily written in more than one script; omit it otherwise.",
			),
		region: z
			.string()
			.regex(
				/^[A-Z]{2}$/,
				"Use an upper-case two-letter ISO 3166-1 alpha-2 region identifier, such as MX.",
			)
			.nullable()
			.optional()
			.describe(
				"ISO 3166-1 alpha-2 region whose conventions the language follows (MX, SG). Always skippable — omit it for the language's general conventions.",
			),
	})
	.superRefine((value, ctx) => {
		for (const message of identityIssues(cleanLanguageIdentity(value))) {
			ctx.addIssue({ code: "custom", message });
		}
	});

export const languageIdentityInputSchema = z.union([
	registeredLanguageInputSchema,
	projectLanguageIdentitySchema.describe(
		"An exact project code, such as a language from CommCare HQ that has its own translations.",
	),
]);

export const getLanguagesInputSchema = z.strictObject({
	installations: z
		.strictObject({ cursor: z.string().max(160).nullable().optional() })
		.nullable()
		.optional()
		.describe(
			"Read named installation profiles instead of the language overview. Pass {} for the first page, then its nextCursor. Large entries use consecutive JSON text parts for the same profile UUID.",
		),
});

export const getTranslatableContentInputSchema = z.strictObject({
	language: languageIdentityInputSchema.describe(
		"Existing app language whose effective worker-facing values and status should be read.",
	),
	query: z
		.string()
		.trim()
		.max(255)
		.nullable()
		.optional()
		.describe(
			"Optional case-insensitive search across source text, role, breadcrumb, and context.",
		),
	status: z.enum(translationStatuses).nullable().optional(),
	role: z.enum(translationUnitRoles).nullable().optional(),
	ownerKind: z.enum(translationUnitOwnerKinds).nullable().optional(),
	moduleUuid: uuidSchema.nullable().optional(),
	formUuid: uuidSchema.nullable().optional(),
	cursor: z
		.string()
		.max(2048)
		.nullable()
		.optional()
		.describe(
			"Opaque snapshot-bound cursor from the preceding page. Omit for the first page.",
		),
	limit: z.number().int().min(1).max(50).default(25),
});

export const addLanguageInputSchema = z.strictObject({
	language: languageIdentityInputSchema.describe(
		"The exact identity of the language to add.",
	),
	copyFrom: languageIdentityInputSchema
		.nullable()
		.optional()
		.describe(
			"Existing app language whose currently effective values seed every new target entry. Defaults to the app's canonical source language.",
		),
});

export const updateLanguageInputSchema = z
	.strictObject({
		action: z.enum(["set-default", "change-identity", "move", "set-direction"]),
		direction: z
			.enum(["ltr", "rtl"])
			.nullable()
			.optional()
			.describe(
				"Writing direction for the project language, for set-direction.",
			),
		after: languageIdentityInputSchema
			.nullable()
			.optional()
			.describe(
				"For move, the app language this one will follow. Use null to move it first and make it the default.",
			),
		language: languageIdentityInputSchema.describe(
			"Existing app language the action applies to.",
		),
		replacement: languageIdentityInputSchema
			.nullable()
			.optional()
			.describe(
				"The identity that replaces this language for change-identity. Omit for set-default.",
			),
	})
	.superRefine((input, ctx) => {
		if ((input.action === "set-direction") !== (input.direction != null))
			ctx.addIssue({
				code: "custom",
				path: ["direction"],
				message:
					"A writing direction applies only to set-direction and is required for that choice.",
			});
		if (input.action !== "move" && input.after != null) {
			ctx.addIssue({
				code: "custom",
				path: ["after"],
				message: "Only a move can name a preceding language.",
			});
		}
		const replacementExpected = input.action === "change-identity";
		if ((input.replacement != null) !== replacementExpected) {
			ctx.addIssue({
				code: "custom",
				path: ["replacement"],
				message: replacementExpected
					? "The change-identity action requires replacement."
					: `The ${input.action} action does not accept replacement.`,
			});
		}
	});

export const removeLanguageInputSchema = z.strictObject({
	language: languageIdentityInputSchema.describe(
		"Existing target language to remove.",
	),
});

const translationUpdateSchema = z.discriminatedUnion("operation", [
	z.strictObject({
		operation: z.literal("set"),
		unitId: z.string().min(1).startsWith("tu1:"),
		expectedSourceFingerprint: z
			.string()
			.min(1)
			.describe(
				"Current sourceFingerprint returned by getTranslatableContent for the source text that was translated.",
			),
		value: localizedValueSchema,
		changeShownValues: z
			.boolean()
			.nullable()
			.optional()
			.describe(
				"Set to true only when the author wants this language to show different answers or calculations. An ordinary translation keeps its source values. Where the current entry shows values of its own (showsOwnValues in getTranslatableContent), say true to keep or change them, or false to show the source's values again.",
			),
		translatedFrom: languageIdentityInputSchema
			.nullable()
			.optional()
			.describe(
				"Existing app language used as the translation source. Defaults to the app's canonical source language.",
			),
	}),
	z.strictObject({
		operation: z.literal("clear"),
		unitId: z.string().min(1).startsWith("tu1:"),
	}),
	z.strictObject({
		operation: z.literal("review"),
		unitId: z.string().min(1).startsWith("tu1:"),
		expectedSourceFingerprint: z.string().min(1),
		expectedCurrentSourceFingerprint: z
			.string()
			.min(1)
			.describe(
				"Current sourceFingerprint returned by getTranslatableContent for the source text reviewed.",
			),
		expectedValue: localizedValueSchema,
	}),
]);

export const updateTranslationsInputSchema = z
	.strictObject({
		language: languageIdentityInputSchema.describe(
			"Existing target language whose entries change.",
		),
		updates: z.array(translationUpdateSchema).min(1).max(50),
	})
	.superRefine((input, ctx) => {
		const seen = new Set<string>();
		for (const [index, update] of input.updates.entries()) {
			if (seen.has(update.unitId)) {
				ctx.addIssue({
					code: "custom",
					path: ["updates", index, "unitId"],
					message:
						"Each translation unit may be changed at most once in one atomic call.",
				});
			}
			seen.add(update.unitId);
		}
	});

function coverage(units: readonly LocalizedTranslationUnit[]) {
	const counts: Record<TranslationStatus, number> = {
		missing: 0,
		"needs-review": 0,
		"out-of-date": 0,
		ready: 0,
	};
	for (const unit of units) counts[unit.status] += 1;
	return counts;
}

function ownerModuleUuid(owner: TranslationUnitOwner): string | undefined {
	switch (owner.kind) {
		case "module":
		case "form":
		case "field":
		case "select-option":
		case "case-list-column":
		case "search-input":
			return owner.moduleUuid;
		case "app":
		case "case-property-option":
			return undefined;
	}
}

function ownerFormUuid(owner: TranslationUnitOwner): string | undefined {
	switch (owner.kind) {
		case "form":
		case "field":
		case "select-option":
			return owner.formUuid;
		case "app":
		case "module":
		case "case-list-column":
		case "search-input":
		case "case-property-option":
			return undefined;
	}
}

function searchableSource(unit: TranslationUnit): string {
	return typeof unit.source === "string"
		? unit.source
		: unit.source.parts
				.filter((part) => part.kind === "text")
				.map((part) => part.text)
				.join(" ");
}

interface TranslationContentFilters {
	readonly language: AppLanguageIdentity;
	readonly query: string | null;
	readonly status: TranslationStatus | null;
	readonly role: TranslationUnit["role"] | null;
	readonly ownerKind: TranslationUnitOwnerKind | null;
	readonly moduleUuid: Uuid | null;
	readonly formUuid: Uuid | null;
}

const translationCursorSchema = z.strictObject({
	version: z.literal(2),
	digest: z.string().length(64),
	offset: z.number().int().nonnegative(),
	filters: z.strictObject({
		language: appLanguageIdentitySchema,
		query: z.string().max(255).nullable(),
		status: z.enum(translationStatuses).nullable(),
		role: z.enum(translationUnitRoles).nullable(),
		ownerKind: z.enum(translationUnitOwnerKinds).nullable(),
		moduleUuid: uuidSchema.nullable(),
		formUuid: uuidSchema.nullable(),
	}),
});

function encodeTranslationCursor(
	payload: z.infer<typeof translationCursorSchema>,
): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeTranslationCursor(
	cursor: string,
): z.infer<typeof translationCursorSchema> {
	try {
		return translationCursorSchema.parse(
			JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
		);
	} catch {
		throw new Error(
			"That translation cursor is invalid. Restart the read without a cursor.",
		);
	}
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function filteredTranslationUnits(
	units: readonly LocalizedTranslationUnit[],
	filters: TranslationContentFilters,
): readonly LocalizedTranslationUnit[] {
	const query = filters.query?.toLowerCase() ?? null;
	return units.filter((unit) => {
		if (filters.status !== null && unit.status !== filters.status) return false;
		if (filters.role !== null && unit.role !== filters.role) return false;
		if (filters.ownerKind !== null && unit.owner.kind !== filters.ownerKind) {
			return false;
		}
		if (
			filters.moduleUuid !== null &&
			ownerModuleUuid(unit.owner) !== filters.moduleUuid
		) {
			return false;
		}
		if (
			filters.formUuid !== null &&
			ownerFormUuid(unit.owner) !== filters.formUuid
		) {
			return false;
		}
		if (query !== null && query.length > 0) {
			const haystack = JSON.stringify([
				unit.role,
				unit.breadcrumb,
				unit.context,
				searchableSource(unit),
			]).toLowerCase();
			if (!haystack.includes(query)) return false;
		}
		return true;
	});
}

function translationPageDigest(
	units: readonly LocalizedTranslationUnit[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				units.map((unit) => ({
					id: unit.id,
					role: unit.role,
					valueKind: unit.valueKind,
					contentPolicy: unit.contentPolicy,
					source: unit.source,
					sourceFingerprint: unit.sourceFingerprint,
					effective: unit.effective,
					explicit: unit.explicit ?? null,
					status: unit.status,
					filledFrom: unit.filledFrom ?? null,
					owner: unit.owner,
					breadcrumb: unit.breadcrumb,
					context: unit.context,
					protectedParts: protectedParts(unit),
				})),
			),
		)
		.digest("hex");
}

function protectedParts(unit: TranslationUnit) {
	return typeof unit.source === "string"
		? []
		: unit.source.parts.filter((part) => part.kind !== "text");
}

function readError(error: unknown): ReadToolResult<{ error: string }> {
	return {
		kind: "read",
		data: { error: error instanceof Error ? error.message : String(error) },
	};
}

function mutationError(error: string): MutatingToolResult<{ error: string }> {
	return { kind: "mutate", mutations: [], result: { error } };
}

interface LanguageResultFacts {
	language: AppLanguageIdentity;
	copy?: { from: AppLanguageIdentity; strings: number; review: "needs-review" };
	previousLanguage?: AppLanguageIdentity;
	direction?: "ltr" | "rtl";
	source?: true;
	default?: boolean;
	translationsMoved?: number;
	translationsRemoved?: "all-explicit";
	updated?: number;
}
type LanguageMutationResult =
	| (MutationSuccess & LanguageResultFacts)
	| { error: string };

async function commitLanguageMutations(
	ctx: ToolInvocationContext,
	mutations: readonly Mutation[],
	stage: string,
	facts: LanguageResultFacts,
	summary: ToolCallSummary,
): Promise<MutatingToolResult<LanguageMutationResult>> {
	const outcome = await guardedMutate(ctx, mutations, stage);
	if (!outcome.ok) return mutationError(outcome.error);
	return {
		kind: "mutate",
		mutations: outcome.mutations,
		result: { ok: true, ...facts, summary },
	};
}

export const getLanguagesTool = {
	description:
		"Read the source, default and target languages, translation coverage and automatic-translation availability, or page through named installation profiles and their ordered language identities.",
	inputSchema: getLanguagesInputSchema,
	async execute(
		input: z.infer<typeof getLanguagesInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const doc = ctx.snapshot.doc;
		if (input.installations) {
			try {
				return {
					kind: "read",
					data: installationAuthoringPage(
						doc,
						input.installations.cursor ?? undefined,
					),
				};
			} catch (error) {
				return readError(error);
			}
		}
		const localization = effectiveAppLocalization(doc.localization);
		const sourceIdentity = parseLanguageTag(localization.sourceLanguage);
		const units = collectTranslationUnits(doc)
			.filter((unit) => !unit.generated?.dormant)
			.map((unit) => wordingSourceUnit(doc, unit));
		return {
			kind: "read",
			data: {
				sourceLanguage: sourceIdentity,
				defaultLanguage: parseLanguageTag(localization.defaultLanguage),
				unitCount: units.length,
				languages: localization.languageOrder.map((tag) => {
					const identity = parseLanguageTag(tag);
					const isSource = tag === localization.sourceLanguage;
					const capability = isSource
						? null
						: automaticTranslationCapability(sourceIdentity, identity);
					return {
						language: identity,
						// The CommCare code the language took when it joined the app.
						// An identity Nova keeps, never an input.
						commcareCode: localization.wireCodes[tag],
						endonym:
							resolvedLanguageDisplayLabel(identity) ??
							languageDescriptor(identity),
						englishName:
							resolvedLanguageEnglishName(identity) ??
							languageDescriptor(identity),
						qualifiers: languageQualifierLabels(identity),
						direction: languageDirection(identity, localization),
						isSource,
						isDefault: tag === localization.defaultLanguage,
						automaticTranslation:
							capability === null
								? null
								: {
										status: capability.status,
										explanation: capability.explanation,
									},
						coverage: coverage(
							units.map((unit) => localizeTranslationUnit(doc, tag, unit)),
						),
					};
				}),
				coverageDiagnostics: collectTranslationCoverageDiagnostics(doc),
				codePolicy:
					"A registered language uses an ISO 639:2023 Set 3 individual living-language code, with its script or region when needed. A project language keeps its exact code and can set its writing direction. Both support manual wording.",
			},
		};
	},
};

export const getTranslatableContentTool = {
	description:
		"Read a page of translatable app content with its source, target text, context and review state. An entry with showsOwnValues shows answers or calculations of its own, as the author chose. Continue with nextCursor; restart if the source changed.",
	inputSchema: getTranslatableContentInputSchema,
	async execute(
		input: z.infer<typeof getTranslatableContentInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		try {
			const doc = ctx.snapshot.doc;
			const localization = effectiveAppLocalization(doc.localization);
			const identity = cleanLanguageIdentity(input.language);
			const tag = languageTag(identity);
			if (!localization.languageOrder.includes(tag)) {
				throw new Error(
					`${languageDescriptor(identity)} does not belong to this app. Run getLanguages first.`,
				);
			}
			const filters: TranslationContentFilters = {
				language: identity,
				query: input.query?.trim().toLowerCase() || null,
				status: input.status ?? null,
				role: input.role ?? null,
				ownerKind: input.ownerKind ?? null,
				moduleUuid: input.moduleUuid ?? null,
				formUuid: input.formUuid ?? null,
			};
			const units = filteredTranslationUnits(
				collectLocalizedTranslationUnits(doc, tag).map((unit) =>
					presentedSearchWording(doc, unit),
				),
				filters,
			);
			const digest = translationPageDigest(units);
			let offset = 0;
			if (input.cursor !== undefined && input.cursor !== null) {
				const cursor = decodeTranslationCursor(input.cursor);
				if (
					cursor.digest !== digest ||
					!exactJsonEqual(cursor.filters, filters) ||
					cursor.offset > units.length
				) {
					throw new Error(
						"The translation inventory or filters changed after the previous page. Restart the read without a cursor.",
					);
				}
				offset = cursor.offset;
			}
			const page = units.slice(offset, offset + input.limit);
			const nextOffset = offset + page.length;
			return {
				kind: "read",
				data: {
					language: identity,
					filters,
					total: units.length,
					items: page.map((unit) => ({
						id: unit.id,
						role: unit.role,
						valueKind: unit.valueKind,
						contentPolicy: unit.contentPolicy,
						source: unit.source,
						sourceFingerprint: unit.sourceFingerprint,
						effective: unit.effective,
						explicit: unit.explicit,
						...(unit.generated && {
							output: unit.generated,
							defaultText: unit.defaultText,
						}),
						status: unit.status,
						...(unit.filledFrom === undefined
							? {}
							: { filledFrom: unit.filledFrom }),
						owner: unit.owner,
						breadcrumb: unit.breadcrumb,
						context: unit.context,
						protectedParts: protectedParts(unit),
					})),
					page: {
						returned: page.length,
						complete: nextOffset >= units.length,
						nextCursor:
							nextOffset >= units.length
								? null
								: encodeTranslationCursor({
										version: 2,
										digest,
										offset: nextOffset,
										filters,
									}),
					},
				},
			};
		} catch (error) {
			return readError(error);
		}
	},
};

export const addLanguageTool = {
	description:
		"Add a target language by copying the current text from copyFrom, or the source language. Copied text starts as Needs review; this does not translate it.",
	inputSchema: addLanguageInputSchema,
	async execute(
		input: z.infer<typeof addLanguageInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<LanguageMutationResult>> {
		try {
			const doc = ctx.snapshot.doc;
			const localization = effectiveAppLocalization(doc.localization);
			const identity = cleanLanguageIdentity(input.language);
			const tag = languageTag(identity);
			const descriptor = languageDescriptor(identity);
			if (localization.languageOrder.includes(tag)) {
				return mutationError(`${descriptor} already belongs to this app.`);
			}
			const copyFromIdentity =
				input.copyFrom == null
					? parseLanguageTag(localization.sourceLanguage)
					: cleanLanguageIdentity(input.copyFrom);
			const copyFromTag = languageTag(copyFromIdentity);
			if (!localization.languageOrder.includes(copyFromTag)) {
				return mutationError(
					`Copy source ${languageDescriptor(copyFromIdentity)} does not belong to this app. Run getLanguages first.`,
				);
			}
			const mutations: Mutation[] = [
				addLanguageMutation(heldLanguageWireCodes(doc), identity),
			];
			for (const raw of collectLocalizedTranslationUnits(doc, copyFromTag)) {
				const unit = presentedSearchWording(doc, raw);
				if (unit.generated && unit.explicit === undefined) continue;
				mutations.push({
					kind: "setTranslation",
					language: tag,
					unitId: unit.id,
					entry: {
						value: structuredClone(unit.effective),
						...authoredTranslationValueMode(unit, unit.effective),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "copied",
						review: "needs-review",
						translatedFrom: copyFromTag,
					},
				});
			}
			return await commitLanguageMutations(
				ctx,
				mutations,
				`localization:${tag}:add`,
				{
					language: identity,
					copy: {
						from: copyFromIdentity,
						strings: mutations.length - 1,
						review: "needs-review",
					},
				},
				{ subject: descriptor, count: mutations.length - 1 },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updateLanguageTool = {
	description:
		"Move a language in the app's order, set the default language, change a language identity or choose a project's language text direction. Workers start in the first language. Moving a language preserves each language’s text. A multilingual source identity is fixed.",
	inputSchema: updateLanguageInputSchema,
	async execute(
		input: z.infer<typeof updateLanguageInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<LanguageMutationResult>> {
		try {
			const doc = ctx.snapshot.doc;
			const localization = effectiveAppLocalization(doc.localization);
			const identity = cleanLanguageIdentity(input.language);
			const tag = languageTag(identity);
			const descriptor = languageDescriptor(identity);
			if (!localization.languageOrder.includes(tag)) {
				return mutationError(
					`${descriptor} does not belong to this app. Run getLanguages first.`,
				);
			}
			switch (input.action) {
				case "set-direction":
					if (identity.kind !== "project" || input.direction == null)
						return mutationError(
							"Choose a project language to set its writing direction. Other languages use the direction of their writing system.",
						);
					return await commitLanguageMutations(
						ctx,
						[
							{
								kind: "setProjectLanguageDirection",
								code: tag,
								direction: input.direction,
							},
						],
						`localization:${tag}:direction`,
						{ language: identity, direction: input.direction },
						{ subject: descriptor },
					);
				case "move": {
					const after =
						input.after == null
							? null
							: languageTag(cleanLanguageIdentity(input.after));
					if (tag === after)
						return mutationError("A language can't follow itself.");
					if (after !== null && !localization.languageOrder.includes(after))
						return mutationError(
							"The preceding language isn't in this app. You can choose one from getLanguages.",
						);
					return await commitLanguageMutations(
						ctx,
						[{ kind: "moveLanguage", code: tag, after }],
						`localization:${tag}:order`,
						{ language: identity, default: after === null },
						{ subject: descriptor },
					);
				}
				case "set-default":
					if (localization.defaultLanguage === tag) {
						return mutationError(
							`${descriptor} is already the default language.`,
						);
					}
					return await commitLanguageMutations(
						ctx,
						[{ kind: "setDefaultLanguage", code: tag }],
						`localization:${tag}:default`,
						{ language: identity, default: true },
						{ subject: descriptor },
					);
				case "change-identity": {
					if (input.replacement == null) {
						return mutationError(
							"The change-identity action requires replacement.",
						);
					}
					const replacement = cleanLanguageIdentity(input.replacement);
					const replacementTag = languageTag(replacement);
					const replacementDescriptor = languageDescriptor(replacement);
					if (replacementTag === tag) {
						return mutationError("Nothing to change.");
					}
					if (localization.languageOrder.includes(replacementTag)) {
						return mutationError(
							`${replacementDescriptor} already belongs to this app.`,
						);
					}
					if (tag === localization.sourceLanguage) {
						if (localization.languageOrder.length !== 1) {
							return mutationError(
								"The source language's identity can be changed only while it is the app's sole language. In a multilingual app, add the intended language and move content explicitly.",
							);
						}
						return await commitLanguageMutations(
							ctx,
							[relabelSourceLanguageMutation(replacement)],
							`localization:${replacementTag}:source`,
							{
								language: replacement,
								previousLanguage: identity,
								source: true,
								default: true,
							},
							{ subject: replacementDescriptor },
						);
					}
					const entries = languageEntries(localization, tag) ?? {};
					// The replacement is added before the old language is removed, so
					// it mints against codes that still hold the old one: the state
					// the reducer applies the add on.
					const mutations: Mutation[] = [
						addLanguageMutation(heldLanguageWireCodes(doc), replacement),
					];
					for (const [unitId, entry] of Object.entries(entries)) {
						mutations.push({
							kind: "setTranslation",
							language: replacementTag,
							unitId,
							entry: structuredClone(entry),
						});
					}
					if (localization.defaultLanguage === tag) {
						mutations.push({
							kind: "setDefaultLanguage",
							code: replacementTag,
						});
					}
					mutations.push({ kind: "removeLanguage", code: tag });
					return await commitLanguageMutations(
						ctx,
						mutations,
						`localization:${replacementTag}:identity`,
						{
							language: replacement,
							previousLanguage: identity,
							default: localization.defaultLanguage === tag,
							translationsMoved: Object.keys(entries).length,
						},
						{ subject: replacementDescriptor },
					);
				}
			}
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const removeLanguageTool = {
	description:
		"Remove one target language and all of its explicit translations. The source cannot be removed, and the current runtime default must be changed first.",
	inputSchema: removeLanguageInputSchema,
	async execute(
		input: z.infer<typeof removeLanguageInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<LanguageMutationResult>> {
		try {
			const localization = effectiveAppLocalization(
				ctx.snapshot.doc.localization,
			);
			const identity = cleanLanguageIdentity(input.language);
			const tag = languageTag(identity);
			const descriptor = languageDescriptor(identity);
			if (!localization.languageOrder.includes(tag)) {
				return mutationError(`${descriptor} does not belong to this app.`);
			}
			if (tag === localization.sourceLanguage) {
				return mutationError(
					"The canonical source language cannot be removed.",
				);
			}
			if (tag === localization.defaultLanguage) {
				return mutationError(
					"Change the runtime default language before removing its current language.",
				);
			}
			return await commitLanguageMutations(
				ctx,
				[{ kind: "removeLanguage", code: tag }],
				`localization:${tag}:remove`,
				{
					language: identity,
					translationsRemoved: "all-explicit",
				},
				{ subject: descriptor },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

function integrityMessage(
	unit: TranslationUnit,
	value: LocalizedValue,
	valueMode?: "independent-values",
): string | undefined {
	switch (translationEntryIntegrityIssue(unit, { value, valueMode })) {
		case undefined:
			return undefined;
		case "value-kind":
			return `Translation unit ${unit.id} requires a ${unit.valueKind} value.`;
		case "blank-content":
			return `Translation unit ${unit.id} (${unit.breadcrumb.join(" → ")}) cannot be blank.`;
		case "protected-content":
			return `Translation unit ${unit.id} must preserve every answer and record insertion and every {{= formula}} exactly once. Read the current entry and keep its references and calculated values${translationUnitProseSlot(unit) === undefined ? "." : ", or set changeShownValues to true if the author asked for this language to show different answers or calculations."}`;
	}
}

export const updateTranslationsTool = {
	description:
		"Set, clear or review translations and generated worker wording, including generated wording in the source language. Clear an override to use the default wording. Use fingerprints from the current read so edits cannot overwrite a changed source or translation. Keep answer and record insertions and every {{= formula}} intact, unless the author wants one language to show different answers or calculations: then set changeShownValues on that edit.",
	inputSchema: updateTranslationsInputSchema,
	async execute(
		input: z.infer<typeof updateTranslationsInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<LanguageMutationResult>> {
		try {
			const doc = ctx.snapshot.doc;
			const localization = effectiveAppLocalization(doc.localization);
			const identity = cleanLanguageIdentity(input.language);
			const tag = languageTag(identity);
			const descriptor = languageDescriptor(identity);
			if (!localization.languageOrder.includes(tag)) {
				return mutationError(
					`${descriptor} does not belong to this app. Add it first.`,
				);
			}
			const units = translationUnitsById(doc);
			const entries = languageEntries(localization, tag) ?? {};
			const mutations: Mutation[] = [];
			for (const update of input.updates) {
				const raw = units.get(update.unitId);
				const unit = raw && wordingSourceUnit(doc, raw);
				if (unit === undefined) {
					return mutationError(
						`Translation unit ${update.unitId} no longer exists. Re-read getTranslatableContent.`,
					);
				}
				if (tag === localization.sourceLanguage && !hasGeneratedWording(unit))
					return mutationError(
						"This wording belongs to the app, menu, form or field. You can edit it there.",
					);
				switch (update.operation) {
					case "set": {
						if (
							!translationSourceFingerprintsEqual(
								unit.sourceFingerprint,
								update.expectedSourceFingerprint,
							)
						) {
							return mutationError(
								`Translation unit ${unit.id} source content changed after it was read. Re-read getTranslatableContent before translating it.`,
							);
						}
						/* A translation the author gave values of its own changes
						 * them only when the edit says what to do with them. */
						if (
							entries[unit.id]?.valueMode === "independent-values" &&
							update.changeShownValues == null
						)
							return mutationError(
								`Translation unit ${unit.id} shows answers or calculations of its own in ${descriptor}, as the author chose. Set changeShownValues to true to keep or change them, or to false to show the source's values again.`,
							);
						const mode =
							update.changeShownValues === true
								? authoredTranslationValueMode(unit, update.value)
								: {};
						const issue = integrityMessage(unit, update.value, mode.valueMode);
						if (issue !== undefined) return mutationError(issue);
						const translatedFromTag =
							update.translatedFrom == null
								? localization.sourceLanguage
								: languageTag(cleanLanguageIdentity(update.translatedFrom));
						if (!localization.languageOrder.includes(translatedFromTag)) {
							return mutationError(
								`Translation source ${languageDescriptor(parseLanguageTag(translatedFromTag))} does not belong to this app.`,
							);
						}
						if (
							translatedFromTag === tag &&
							tag !== localization.sourceLanguage
						) {
							return mutationError(
								"A target entry cannot name its own language as the translation source.",
							);
						}
						mutations.push({
							kind: "setTranslation",
							language: tag,
							unitId: unit.id,
							entry: {
								value: structuredClone(update.value),
								...mode,
								sourceFingerprint: unit.sourceFingerprint,
								origin: "ai",
								review: "needs-review",
								translatedFrom: translatedFromTag,
							},
						});
						break;
					}
					case "clear":
						if (entries[unit.id] === undefined) {
							return mutationError(
								`Translation unit ${unit.id} has no explicit ${descriptor} value to clear.`,
							);
						}
						mutations.push({
							kind: "setTranslation",
							language: tag,
							unitId: unit.id,
							entry: null,
						});
						break;
					case "review": {
						const entry = entries[unit.id];
						if (
							!translationSourceFingerprintsEqual(
								unit.sourceFingerprint,
								update.expectedCurrentSourceFingerprint,
							) ||
							entry === undefined ||
							!translationSourceFingerprintsEqual(
								entry.sourceFingerprint,
								update.expectedSourceFingerprint,
							) ||
							!deepEqual(entry.value, update.expectedValue)
						) {
							return mutationError(
								`Translation unit ${unit.id} or its source content changed after it was read. Re-read getTranslatableContent before reviewing it.`,
							);
						}
						const issue = integrityMessage(
							unit,
							update.expectedValue,
							reviewedTranslationValueMode(unit, entry).valueMode,
						);
						if (issue !== undefined) return mutationError(issue);
						mutations.push({
							kind: "reviewTranslation",
							language: tag,
							unitId: unit.id,
							expectedSourceFingerprint: update.expectedSourceFingerprint,
							sourceFingerprint: unit.sourceFingerprint,
							value: structuredClone(update.expectedValue),
						});
						break;
					}
				}
			}
			return await commitLanguageMutations(
				ctx,
				mutations,
				`localization:${tag}:translations`,
				{ language: identity, updated: input.updates.length },
				{ subject: descriptor, count: input.updates.length },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
