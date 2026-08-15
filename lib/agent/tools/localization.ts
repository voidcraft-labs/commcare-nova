/** Shared Solutions Architect / MCP language and translation tools. */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguage,
	appLanguageSchema,
	CLASSIC_LANGUAGE_OPTIONS,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	collectTranslationUnits,
	effectiveAppLocalization,
	type LanguageCode,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	languageCodeSchema,
	localizedValueSchema,
	localizeTranslationUnit,
	suggestedAppLanguage,
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

const languageSeedSchema = z
	.object({
		code: languageCodeSchema.describe(
			"Lower-case CommCare language code: two or three letters, optionally followed by a lower-case suffix.",
		),
		name: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe(
				"Worker-facing language name. Omit to use Nova's best endonym/catalog suggestion.",
			),
		direction: z
			.enum(["ltr", "rtl"])
			.optional()
			.describe(
				"Text direction. Omit to use the runtime locale suggestion, with ltr as the safe fallback.",
			),
	})
	.strict();

export const getLanguagesInputSchema = z.object({}).strict();

export const getTranslatableContentInputSchema = z
	.object({
		language: languageCodeSchema.describe(
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

export const addLanguageInputSchema = languageSeedSchema.extend({
	copyFrom: languageCodeSchema.describe(
		"Existing app language whose currently effective values seed every new target entry.",
	),
});

const languageMetadataPatchSchema = z
	.object({
		name: appLanguageSchema.shape.name.optional(),
		direction: appLanguageSchema.shape.direction.optional(),
	})
	.strict()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "Change the language name or text direction.",
	});

export const updateLanguageInputSchema = z
	.object({
		action: z.enum(["metadata", "set-default", "relabel-source"]),
		code: languageCodeSchema,
		patch: languageMetadataPatchSchema.optional(),
		replacement: languageSeedSchema
			.optional()
			.describe(
				"Complete replacement metadata for relabel-source. Omit for other actions.",
			),
	})
	.strict()
	.superRefine((input, ctx) => {
		const patchExpected = input.action === "metadata";
		const replacementExpected = input.action === "relabel-source";
		if ((input.patch !== undefined) !== patchExpected) {
			ctx.addIssue({
				code: "custom",
				path: ["patch"],
				message: patchExpected
					? "The metadata action requires patch."
					: `The ${input.action} action does not accept patch.`,
			});
		}
		if ((input.replacement !== undefined) !== replacementExpected) {
			ctx.addIssue({
				code: "custom",
				path: ["replacement"],
				message: replacementExpected
					? "The relabel-source action requires replacement."
					: `The ${input.action} action does not accept replacement.`,
			});
		}
	});

export const removeLanguageInputSchema = z
	.object({ code: languageCodeSchema })
	.strict();

const translationUpdateSchema = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("set"),
			unitId: z.string().min(1).startsWith("tu1:"),
			value: localizedValueSchema,
			translatedFrom: languageCodeSchema
				.optional()
				.describe(
					"Existing language used as the translation source. Defaults to the app's canonical source language.",
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
			expectedValue: localizedValueSchema,
		})
		.strict(),
]);

export const updateTranslationsInputSchema = z
	.object({
		language: languageCodeSchema,
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

function appLanguageFromSeed(
	seed: z.infer<typeof languageSeedSchema>,
): AppLanguage {
	const suggested = suggestedAppLanguage(seed.code);
	return {
		...suggested,
		...(seed.name === undefined ? {} : { name: seed.name }),
		...(seed.direction === undefined ? {} : { direction: seed.direction }),
	};
}

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
	readonly language: LanguageCode;
	readonly query: string | null;
	readonly status: TranslationStatus | null;
	readonly role: TranslationUnit["role"] | null;
	readonly ownerKind: TranslationUnitOwnerKind | null;
	readonly moduleUuid: Uuid | null;
	readonly formUuid: Uuid | null;
}

const translationCursorSchema = z
	.object({
		version: z.literal(1),
		digest: z.string().length(64),
		offset: z.number().int().nonnegative(),
		filters: z
			.object({
				language: languageCodeSchema,
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
		"Read the app's ordered source, runtime default, and target languages with complete per-language translation coverage counts. Manual authoring and copy are available for every CommCare Classic language code; automatic-translation availability is a separate direction-specific policy.",
	inputSchema: getLanguagesInputSchema,
	async execute(
		_input: z.infer<typeof getLanguagesInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const doc = ctx.snapshot.doc;
		const localization = effectiveAppLocalization(doc.localization);
		const units = collectTranslationUnits(doc);
		return {
			kind: "read",
			data: {
				sourceLanguage: localization.sourceLanguage,
				defaultLanguage: localization.defaultLanguage,
				unitCount: units.length,
				languages: localization.languageOrder.map((code) => ({
					...localization.languages[code],
					isSource: code === localization.sourceLanguage,
					isDefault: code === localization.defaultLanguage,
					coverage: coverage(
						units.map((unit) => localizeTranslationUnit(doc, code, unit)),
					),
				})),
				classicCatalogSize: CLASSIC_LANGUAGE_OPTIONS.length,
				coverageDiagnostics: collectTranslationCoverageDiagnostics(doc),
				codePolicy:
					"Every Classic picker code and every Classic wire-valid lower-case regional code can be added manually or by copying an existing language.",
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
			if (!localization.languageOrder.includes(input.language)) {
				throw new Error(
					`Language ${input.language} does not belong to this app. Run getLanguages first.`,
				);
			}
			const filters: TranslationContentFilters = {
				language: input.language,
				query: input.query?.trim().toLowerCase() || null,
				status: input.status ?? null,
				role: input.role ?? null,
				ownerKind: input.ownerKind ?? null,
				moduleUuid: input.moduleUuid ?? null,
				formUuid: input.formUuid ?? null,
			};
			const units = filteredTranslationUnits(
				collectLocalizedTranslationUnits(doc, input.language),
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
					language: input.language,
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
										version: 1,
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
		"Add one CommCare language atomically by copying every currently effective worker-facing value from an existing app language. The copied entries begin Needs review; the new language is never born blank. Automatic translation is a separate explicit action and is not implied by this tool.",
	inputSchema: addLanguageInputSchema,
	async execute(
		input: z.infer<typeof addLanguageInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
		try {
			const doc = ctx.snapshot.doc;
			const localization = effectiveAppLocalization(doc.localization);
			if (localization.languages[input.code] !== undefined) {
				return mutationError(
					`Language ${input.code} already belongs to this app.`,
				);
			}
			if (localization.languages[input.copyFrom] === undefined) {
				return mutationError(
					`Copy source ${input.copyFrom} does not belong to this app. Run getLanguages first.`,
				);
			}
			const language = appLanguageFromSeed(input);
			const mutations: Mutation[] = [{ kind: "addLanguage", language }];
			for (const unit of collectLocalizedTranslationUnits(
				doc,
				input.copyFrom,
			)) {
				mutations.push({
					kind: "setTranslation",
					language: language.code,
					unitId: unit.id,
					entry: {
						value: structuredClone(unit.effective),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "copied",
						review: "needs-review",
						translatedFrom: input.copyFrom,
					},
				});
			}
			return await commitLanguageMutations(
				ctx,
				mutations,
				`localization:${language.code}:add`,
				`Added ${language.name} (${language.code}) and copied ${mutations.length - 1} worker-facing strings from ${localization.languages[input.copyFrom]?.name ?? input.copyFrom}. Every copied value needs review.`,
				{ subject: language.name, count: mutations.length - 1 },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updateLanguageTool = {
	description:
		"Update one language's editable name/direction, make an existing language the runtime default, or relabel the sole source language. A code is locale identity: only a one-language app can relabel its source; multilingual code changes are remove-and-add operations.",
	inputSchema: updateLanguageInputSchema,
	async execute(
		input: z.infer<typeof updateLanguageInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
		try {
			const doc = ctx.snapshot.doc;
			const localization = effectiveAppLocalization(doc.localization);
			const current = localization.languages[input.code];
			if (current === undefined) {
				return mutationError(
					`Language ${input.code} does not belong to this app. Run getLanguages first.`,
				);
			}
			switch (input.action) {
				case "metadata": {
					if (input.patch === undefined) {
						return mutationError("The metadata action requires patch.");
					}
					if (
						(input.patch.name === undefined ||
							input.patch.name === current.name) &&
						(input.patch.direction === undefined ||
							input.patch.direction === current.direction)
					) {
						return mutationError("Nothing to change.");
					}
					const nextName = input.patch.name ?? current.name;
					return await commitLanguageMutations(
						ctx,
						[
							{
								kind: "updateLanguage",
								code: input.code,
								patch: input.patch,
							},
						],
						`localization:${input.code}:metadata`,
						`Updated ${nextName} (${input.code}).`,
						{ subject: nextName },
					);
				}
				case "set-default":
					if (localization.defaultLanguage === input.code) {
						return mutationError(
							`${current.name} is already the default language.`,
						);
					}
					return await commitLanguageMutations(
						ctx,
						[{ kind: "setDefaultLanguage", code: input.code }],
						`localization:${input.code}:default`,
						`Set ${current.name} (${input.code}) as the runtime default language.`,
						{ subject: current.name },
					);
				case "relabel-source": {
					if (input.replacement === undefined) {
						return mutationError(
							"The relabel-source action requires replacement metadata.",
						);
					}
					if (
						localization.languageOrder.length !== 1 ||
						localization.sourceLanguage !== input.code
					) {
						return mutationError(
							"The source language can be relabeled only while it is the app's sole language. In a multilingual app, add the intended code and move content explicitly.",
						);
					}
					const replacement = appLanguageFromSeed(input.replacement);
					if (exactJsonEqual(current, replacement)) {
						return mutationError("Nothing to change.");
					}
					return await commitLanguageMutations(
						ctx,
						[{ kind: "relabelSourceLanguage", language: replacement }],
						`localization:${replacement.code}:source`,
						`Relabeled the sole source and default language as ${replacement.name} (${replacement.code}).`,
						{ subject: replacement.name },
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
			const language = localization.languages[input.code];
			if (language === undefined) {
				return mutationError(
					`Language ${input.code} does not belong to this app.`,
				);
			}
			if (input.code === localization.sourceLanguage) {
				return mutationError(
					"The canonical source language cannot be removed.",
				);
			}
			if (input.code === localization.defaultLanguage) {
				return mutationError(
					"Change the runtime default language before removing its current language.",
				);
			}
			return await commitLanguageMutations(
				ctx,
				[{ kind: "removeLanguage", code: input.code }],
				`localization:${input.code}:remove`,
				`Removed ${language.name} (${input.code}) and its explicit translations.`,
				{ subject: language.name },
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
		"Set, clear, or explicitly review up to 50 target-language entries atomically. Set operations are machine-authored and begin Needs review. Review operations must echo the exact explicit value and source fingerprint previously read, so they can keep a stale translation only when no peer changed it. Protected reference parts must remain exact.",
	inputSchema: updateTranslationsInputSchema,
	async execute(
		input: z.infer<typeof updateTranslationsInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
		try {
			const doc = ctx.snapshot.doc;
			const localization = effectiveAppLocalization(doc.localization);
			const language = localization.languages[input.language];
			if (language === undefined) {
				return mutationError(
					`Language ${input.language} does not belong to this app. Add it first.`,
				);
			}
			if (input.language === localization.sourceLanguage) {
				return mutationError(
					"Canonical source content is edited through its ordinary app, module, form, field, and case-list tools, not through a target overlay.",
				);
			}
			const units = translationUnitsById(doc);
			const entries = localization.translations[input.language] ?? {};
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
						const issue = integrityMessage(unit, update.value);
						if (issue !== undefined) return mutationError(issue);
						const translatedFrom =
							update.translatedFrom ?? localization.sourceLanguage;
						if (localization.languages[translatedFrom] === undefined) {
							return mutationError(
								`Translation source ${translatedFrom} does not belong to this app.`,
							);
						}
						if (translatedFrom === input.language) {
							return mutationError(
								"A target entry cannot name its own language as the translation source.",
							);
						}
						mutations.push({
							kind: "setTranslation",
							language: input.language,
							unitId: unit.id,
							entry: {
								value: structuredClone(update.value),
								sourceFingerprint: unit.sourceFingerprint,
								origin: "ai",
								review: "needs-review",
								translatedFrom,
							},
						});
						break;
					}
					case "clear":
						if (entries[unit.id] === undefined) {
							return mutationError(
								`Translation unit ${unit.id} has no explicit ${input.language} value to clear.`,
							);
						}
						mutations.push({
							kind: "setTranslation",
							language: input.language,
							unitId: unit.id,
							entry: null,
						});
						break;
					case "review": {
						const entry = entries[unit.id];
						if (
							entry === undefined ||
							entry.sourceFingerprint !== update.expectedSourceFingerprint ||
							!exactJsonEqual(entry.value, update.expectedValue)
						) {
							return mutationError(
								`Translation unit ${unit.id} changed after it was read. Re-read getTranslatableContent before reviewing it.`,
							);
						}
						const issue = integrityMessage(unit, update.expectedValue);
						if (issue !== undefined) return mutationError(issue);
						mutations.push({
							kind: "reviewTranslation",
							language: input.language,
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
				`localization:${input.language}:translations`,
				`Updated ${input.updates.length} ${language.name} translation ${input.updates.length === 1 ? "entry" : "entries"}. Machine-authored values remain Needs review until an explicit review action.`,
				{ subject: language.name, count: input.updates.length },
			);
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
