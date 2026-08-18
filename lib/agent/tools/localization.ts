/** Shared Solutions Architect / MCP language and translation tools. */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	appLanguageIdentitySchema,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	collectTranslationUnits,
	effectiveAppLocalization,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	languageTag,
	localizedValueSchema,
	localizeTranslationUnit,
	parseLanguageTag,
	type TranslationStatus,
	type TranslationUnit,
	type TranslationUnitOwner,
	type TranslationUnitOwnerKind,
	translationUnitOwnerKinds,
	translationUnitRoles,
	translationUnitsById,
	translationValueIntegrityIssue,
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
interface LanguageIdentityInput {
	readonly language: string;
	readonly script?: string | null;
	readonly region?: string | null;
}

function cleanLanguageIdentity(
	input: LanguageIdentityInput,
): AppLanguageIdentity {
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
const languageIdentityInputSchema = z
	.object({
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
	.strict()
	.superRefine((value, ctx) => {
		for (const message of identityIssues(cleanLanguageIdentity(value))) {
			ctx.addIssue({ code: "custom", message });
		}
	});

export const getLanguagesInputSchema = z.object({}).strict();

export const getTranslatableContentInputSchema = z
	.object({
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
	})
	.strict();

export const addLanguageInputSchema = z
	.object({
		language: languageIdentityInputSchema.describe(
			"The exact identity of the language to add.",
		),
		copyFrom: languageIdentityInputSchema
			.nullable()
			.optional()
			.describe(
				"Existing app language whose currently effective values seed every new target entry. Defaults to the app's canonical source language.",
			),
	})
	.strict();

export const updateLanguageInputSchema = z
	.object({
		action: z.enum(["set-default", "change-identity"]),
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
	.strict()
	.superRefine((input, ctx) => {
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

export const removeLanguageInputSchema = z
	.object({
		language: languageIdentityInputSchema.describe(
			"Existing target language to remove.",
		),
	})
	.strict();

const translationUpdateSchema = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("set"),
			unitId: z.string().min(1).startsWith("tu1:"),
			expectedSourceFingerprint: z
				.string()
				.min(1)
				.describe(
					"Current sourceFingerprint returned by getTranslatableContent for the source text that was translated.",
				),
			value: localizedValueSchema,
			translatedFrom: languageIdentityInputSchema
				.nullable()
				.optional()
				.describe(
					"Existing app language used as the translation source. Defaults to the app's canonical source language.",
				),
		})
		.strict(),
	z
		.object({
			operation: z.literal("clear"),
			unitId: z.string().min(1).startsWith("tu1:"),
		})
		.strict(),
	z
		.object({
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
		})
		.strict(),
]);

export const updateTranslationsInputSchema = z
	.object({
		language: languageIdentityInputSchema.describe(
			"Existing target language whose entries change.",
		),
		updates: z.array(translationUpdateSchema).min(1).max(50),
	})
	.strict()
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

const translationCursorSchema = z
	.object({
		version: z.literal(2),
		digest: z.string().length(64),
		offset: z.number().int().nonnegative(),
		filters: z
			.object({
				language: appLanguageIdentitySchema,
				query: z.string().max(255).nullable(),
				status: z.enum(translationStatuses).nullable(),
				role: z.enum(translationUnitRoles).nullable(),
				ownerKind: z.enum(translationUnitOwnerKinds).nullable(),
				moduleUuid: uuidSchema.nullable(),
				formUuid: uuidSchema.nullable(),
			})
			.strict(),
	})
	.strict();

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

async function commitLanguageMutations(
	ctx: ToolInvocationContext,
	mutations: readonly Mutation[],
	stage: string,
	message: string,
	summary: ToolCallSummary,
): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
	const outcome = await guardedMutate(ctx, mutations, stage);
	if (!outcome.ok) return mutationError(outcome.error);
	return {
		kind: "mutate",
		mutations: outcome.mutations,
		result: { message, summary },
	};
}

export const getLanguagesTool = {
	description:
		"Read the app's source, runtime default, and target languages as exact identities with derived display names, text direction, automatic-translation status, and complete per-language translation coverage counts. Manual authoring and copy work for every individual living language; automatic-translation availability is a separate direction-specific policy.",
	inputSchema: getLanguagesInputSchema,
	async execute(
		_input: z.infer<typeof getLanguagesInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const doc = ctx.snapshot.doc;
		const localization = effectiveAppLocalization(doc.localization);
		const sourceIdentity = parseLanguageTag(localization.sourceLanguage);
		const units = collectTranslationUnits(doc);
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
						endonym:
							resolvedLanguageDisplayLabel(identity) ??
							languageDescriptor(identity),
						englishName:
							resolvedLanguageEnglishName(identity) ??
							languageDescriptor(identity),
						qualifiers: languageQualifierLabels(identity),
						direction: languageDirection(identity),
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
					"A language is an exact identity: an ISO 639:2023 Set 3 individual living-language code, an ISO 15924 script where the language is written in more than one, and an ISO 3166-1 alpha-2 region where regional conventions differ. Macrolanguages, two-letter codes, and non-living codes are rejected with the identifiers to use instead. Names and text direction derive from the identity and are never authored.",
			},
		};
	},
};

export const getTranslatableContentTool = {
	description:
		"Read one bounded, snapshot-bound page from the app's complete static worker-facing translation inventory. Each row includes source, effective target, explicit provenance/review state, context, and protected reference parts. Continue with nextCursor until complete; restart without a cursor if the inventory or filtered translation state changed.",
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
				collectLocalizedTranslationUnits(doc, tag),
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
						status: unit.status,
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
		"Add one app language atomically by copying every currently effective worker-facing value from an existing app language — the canonical source language unless copyFrom names another. The copied entries begin Needs review; the new language is never born blank. Automatic translation is a separate explicit action and is not implied by this tool.",
	inputSchema: addLanguageInputSchema,
	async execute(
		input: z.infer<typeof addLanguageInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
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
				{ kind: "addLanguage", language: identity },
			];
			for (const unit of collectLocalizedTranslationUnits(doc, copyFromTag)) {
				mutations.push({
					kind: "setTranslation",
					language: tag,
					unitId: unit.id,
					entry: {
						value: structuredClone(unit.effective),
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
				`Added ${descriptor} and copied ${mutations.length - 1} worker-facing strings from ${languageDescriptor(copyFromIdentity)}. Every copied value needs review.`,
				{ subject: descriptor, count: mutations.length - 1 },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updateLanguageTool = {
	description:
		"Make an existing language the runtime default, or change a language's identity. Changing the sole language of a one-language app relabels the canonical source in place; changing a target language carries its explicit translations to the new identity in one atomic batch. A multilingual app's source identity cannot be changed. Worker-facing names and text direction derive from the identity and are never authored.",
	inputSchema: updateLanguageInputSchema,
	async execute(
		input: z.infer<typeof updateLanguageInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
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
						`Set ${descriptor} as the runtime default language.`,
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
							[{ kind: "relabelSourceLanguage", language: replacement }],
							`localization:${replacementTag}:source`,
							`Relabeled the sole source and default language as ${replacementDescriptor}.`,
							{ subject: replacementDescriptor },
						);
					}
					const entries = localization.translations[tag] ?? {};
					const mutations: Mutation[] = [
						{ kind: "addLanguage", language: replacement },
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
						`Changed ${descriptor} to ${replacementDescriptor}, carrying its ${Object.keys(entries).length} explicit translations to the new identity.`,
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
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
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
				`Removed ${descriptor} and its explicit translations.`,
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
): string | undefined {
	switch (translationValueIntegrityIssue(unit, value)) {
		case undefined:
			return undefined;
		case "value-kind":
			return `Translation unit ${unit.id} requires a ${unit.valueKind} value.`;
		case "blank-content":
			return `Translation unit ${unit.id} (${unit.breadcrumb.join(" → ")}) cannot be blank.`;
		case "protected-content":
			return `Translation unit ${unit.id} must preserve every protected reference part exactly once. Re-read it with getTranslatableContent.`;
	}
}

export const updateTranslationsTool = {
	description:
		"Set, clear, or explicitly review up to 50 target-language entries atomically. Set operations must echo the current source fingerprint they translated and begin Needs review. Review operations must echo both the exact explicit entry and the current source fingerprint reviewed, so no peer can change either side unseen. Protected reference parts must remain exact.",
	inputSchema: updateTranslationsInputSchema,
	async execute(
		input: z.infer<typeof updateTranslationsInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
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
			if (tag === localization.sourceLanguage) {
				return mutationError(
					"Canonical source content is edited through its ordinary app, module, form, field, and case-list tools, not through a target overlay.",
				);
			}
			const units = translationUnitsById(doc);
			const entries = localization.translations[tag] ?? {};
			const mutations: Mutation[] = [];
			for (const update of input.updates) {
				const unit = units.get(update.unitId);
				if (unit === undefined) {
					return mutationError(
						`Translation unit ${update.unitId} no longer exists. Re-read getTranslatableContent.`,
					);
				}
				switch (update.operation) {
					case "set": {
						if (unit.sourceFingerprint !== update.expectedSourceFingerprint) {
							return mutationError(
								`Translation unit ${unit.id} source content changed after it was read. Re-read getTranslatableContent before translating it.`,
							);
						}
						const issue = integrityMessage(unit, update.value);
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
						if (translatedFromTag === tag) {
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
							unit.sourceFingerprint !==
								update.expectedCurrentSourceFingerprint ||
							entry === undefined ||
							entry.sourceFingerprint !== update.expectedSourceFingerprint ||
							!exactJsonEqual(entry.value, update.expectedValue)
						) {
							return mutationError(
								`Translation unit ${unit.id} or its source content changed after it was read. Re-read getTranslatableContent before reviewing it.`,
							);
						}
						const issue = integrityMessage(unit, update.expectedValue);
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
				`Updated ${input.updates.length} ${descriptor} translation ${input.updates.length === 1 ? "entry" : "entries"}. Machine-authored values remain Needs review until an explicit review action.`,
				{ subject: descriptor, count: input.updates.length },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
