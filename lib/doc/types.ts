// lib/doc/types.ts
//
// Defines the doc-layer `Mutation` union and re-exports the handful of
// doc-adjacent types that the mutation reducers + hooks need. Components
// and application code import entity types (`Field`, `Form`, `Module`,
// `BlueprintDoc`) directly from `@/lib/domain`; this file exists only
// because `Mutation` cites domain types in the mutation payload shapes,
// and it's conventional for reducers to live in the same directory as
// the types they consume.

export type { BlueprintDoc, Uuid } from "@/lib/domain";
export { asUuid } from "@/lib/domain";

import { z } from "zod";
import {
	assetIdSchema,
	CONNECT_TYPES,
	carrierBlindFieldPatchSchemaByKind,
	carrierBlindFieldSchema,
	caseListConfigSchema,
	caseOperationSchema,
	casePropertySchema,
	caseSearchConfigSchema,
	caseTargetSchema,
	caseTypeSchema,
	columnSchema,
	columnSortSchema,
	fieldKinds,
	formSchema,
	lookupOptionsSourceSchema,
	mediaSchema,
	moduleSchema,
	searchInputDefSchema,
	selectOptionSchema,
	uuidSchema,
} from "@/lib/domain";
import {
	carrierBlindPredicateSchema,
	carrierBlindValueExpressionSchema,
	type Predicate,
	predicateSchema,
	searchInputRefSchema,
	type ValueExpression,
} from "@/lib/domain/predicate";

// Runtime-narrow, statically canonical projections. Mutation call sites keep
// their long-standing Predicate / ValueExpression types; the wire parser and
// generated grammar use the carrier-blind schema instances underneath.
const rollingPredicateSchema =
	carrierBlindPredicateSchema as unknown as z.ZodType<Predicate>;
const rollingValueExpressionSchema =
	carrierBlindValueExpressionSchema as unknown as z.ZodType<ValueExpression>;

/**
 * The four field message slots a `Media` bundle attaches to. The
 * `setFieldMedia` mutation carries the slot name (`label` / `hint` /
 * `help` / `validate_msg`); the reducer maps it to the `<slot>_media`
 * field key. Kept as a literal tuple in the doc layer so it owns its own
 * wire vocabulary without depending on `lib/agent`.
 */
export const FIELD_MEDIA_SLOTS = [
	"label",
	"hint",
	"help",
	"validate_msg",
] as const;

// ─── Mutation union ────────────────────────────────────────────────────
//
// Every way the doc store can change. Each reducer in `./mutations/*` is
// an exhaustive switch over a subset of these kinds. One shared schema
// factory produces the carrier-blind rolling/external `mutationSchema` and
// the full-vocabulary `canonicalMutationSchema` used for durable replay.
// The TypeScript `Mutation` type derives from the canonical projection, and
// the rolling output is compile-time asserted assignable to it.
//
// The update-*/patch variants for modules and forms use
// `.omit({ uuid: true }).partial()` on the underlying entity schema to
// express "any subset of mutable properties." The `updateField` variant
// is per-kind: a discriminated union of one arm per `targetKind`, each
// arm typing its `patch` slot against that kind's schema-declared
// properties. This is the type-level guard that makes a patch with a
// stray key (e.g. `{ label }` against a hidden field) a compile error
// at every call site rather than a silently-dropped key at runtime.

/**
 * Build the `updateModule` / `updateForm` patch schema: every mutable slot
 * optional, and every CLEARABLE slot additionally `null`-accepting.
 *
 * A clear must survive the persistence wire. The browser diffs its working
 * doc into a `Mutation[]` and ships it as JSON to `PUT /api/apps/[id]`;
 * `JSON.stringify` DROPS `undefined`-valued keys, so a cleared optional
 * slot (e.g. switching a form's conditional close back to "always close" by
 * blanking `closeCondition`) can only cross the wire as an explicit `null`.
 * For that `null`-clear to parse, the patch schema must admit `null` on the
 * clearable slots — a plain `.partial()` makes them optional, not nullable.
 *
 * Nullability is scoped to slots the SOURCE schema already declares
 * `.optional()`: those are the clearable ones (a slot's absence is a legal
 * doc state). A genuinely-required slot (`id` / `name` / `type`) stays
 * non-nullable, so a stray `null` for it is still a parse error — the
 * `updateModule` / `updateForm` reducers delete-on-`null` without a final
 * whole-entity re-parse, so a required slot must never reach them as `null`.
 * Optionality is detected by whether the slot accepts `undefined`.
 */
function clearablePartialPatch<
	S extends { uuid: z.ZodTypeAny } & z.ZodRawShape,
>(
	schema: z.ZodObject<S>,
): z.ZodObject<{
	[K in Exclude<keyof S, "uuid">]: z.ZodOptional<z.ZodNullable<S[K]>>;
}> {
	// `S extends { uuid }` guarantees the slot exists; Zod's `omit()`
	// parameter type demands every key of `S` in the mask, which the generic
	// can't satisfy structurally — the runtime call is sound, so cast the
	// mask through `unknown` (mirrors `partialOf` in `lib/domain/fields`).
	const omitted = schema.omit({
		uuid: true,
	} as unknown as Parameters<typeof schema.omit>[0]);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, value] of Object.entries(omitted.shape)) {
		const slot = value as z.ZodTypeAny;
		shape[key] = slot.safeParse(undefined).success ? slot.nullable() : slot;
	}
	// Required slots stay non-nullable at RUNTIME (a `null` for them is a
	// parse error), but the inferred type marks every key nullable-optional —
	// a uniform partial-patch shape consumers build typed patches against.
	return z.object(shape).partial() as unknown as z.ZodObject<{
		[K in Exclude<keyof S, "uuid">]: z.ZodOptional<z.ZodNullable<S[K]>>;
	}>;
}

/**
 * Origin-compatible projections for every canonical domain subtree embedded
 * in an established mutation discriminator.
 *
 * Canonical BlueprintDoc schemas intentionally accept dormant lookup ASTs so
 * a current receiver can hydrate and replay them. Mutation fallbacks have a
 * different compatibility obligation: an open pre-S05 receiver must parse
 * them. Rebuild the affected recursive slots with the carrier-blind AST
 * family rather than applying a shallow refinement at `mutationSchema`.
 *
 * The `as typeof canonicalSchema` casts preserve the existing public
 * `Mutation` TypeScript API. Runtime schemas are strictly narrower, and their
 * generated JSON grammars expose only the narrower recursive family. This
 * mirrors the established rolling-field projection: compatibility is a wire
 * boundary without redefining the canonical persisted domain type.
 */
const carrierBlindColumnSchema = z.discriminatedUnion(
	"kind",
	columnSchema.options.map((arm) => {
		const kind = (arm.shape.kind as z.ZodLiteral).value;
		return kind === "calculated"
			? arm.extend({ expression: rollingValueExpressionSchema })
			: arm;
	}) as unknown as typeof columnSchema.options,
) as unknown as typeof columnSchema;

const carrierBlindSearchInputDefSchema = z.discriminatedUnion(
	"kind",
	searchInputDefSchema.options.map((arm) => {
		const common = {
			default: rollingValueExpressionSchema.optional(),
		};
		const kind = (arm.shape.kind as z.ZodLiteral).value;
		return kind === "advanced"
			? arm.extend({
					...common,
					predicate: rollingPredicateSchema,
				})
			: arm.extend(common);
	}) as unknown as typeof searchInputDefSchema.options,
) as unknown as typeof searchInputDefSchema;

const carrierBlindCaseListConfigSchema = caseListConfigSchema.extend({
	columns: z.array(carrierBlindColumnSchema),
	filter: rollingPredicateSchema.optional(),
	searchInputs: z.array(carrierBlindSearchInputDefSchema),
});

const carrierBlindCaseSearchConfigSchema = caseSearchConfigSchema.extend({
	excludedOwnerIds: rollingValueExpressionSchema.optional(),
	searchButtonDisplayCondition: rollingPredicateSchema.optional(),
});

const carrierBlindCaseTargetSchema = z.discriminatedUnion(
	"kind",
	caseTargetSchema.options.map((arm) => {
		const kind = (arm.shape.kind as z.ZodLiteral).value;
		return kind === "expression"
			? arm.extend({ expr: rollingValueExpressionSchema })
			: arm;
	}) as unknown as typeof caseTargetSchema.options,
) as unknown as typeof caseTargetSchema;

const carrierBlindCaseOperationWriteSchema = caseOperationSchema.shape.writes
	.unwrap()
	.element.extend({
		value: rollingValueExpressionSchema,
		condition: rollingPredicateSchema.optional(),
	});
const carrierBlindCaseOperationLinkSchema = caseOperationSchema.shape.links
	.unwrap()
	.element.extend({
		target: carrierBlindCaseTargetSchema.nullable(),
	});
const carrierBlindCaseOperationSchema = caseOperationSchema.extend({
	target: carrierBlindCaseTargetSchema,
	condition: rollingPredicateSchema.optional(),
	name: rollingValueExpressionSchema.optional(),
	owner: rollingValueExpressionSchema.optional(),
	rename: rollingValueExpressionSchema.optional(),
	writes: z.array(carrierBlindCaseOperationWriteSchema).optional(),
	links: z.array(carrierBlindCaseOperationLinkSchema).optional(),
}) as unknown as typeof caseOperationSchema;

const carrierBlindModuleSchema = moduleSchema.extend({
	displayCondition: rollingPredicateSchema.optional(),
	caseListConfig: carrierBlindCaseListConfigSchema.optional(),
	caseSearchConfig: carrierBlindCaseSearchConfigSchema.optional(),
}) as unknown as typeof moduleSchema;

const carrierBlindFormSchema = formSchema.extend({
	displayCondition: rollingPredicateSchema.optional(),
	caseOperations: z.array(carrierBlindCaseOperationSchema).optional(),
}) as unknown as typeof formSchema;

function caseOperationChangeSchemaFor(
	operationValueSchema: typeof caseOperationSchema,
) {
	return z.discriminatedUnion("operation", [
		z
			.object({
				operation: z.literal("add"),
				value: operationValueSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("update"),
				uuid: uuidSchema,
				value: operationValueSchema,
			})
			.strict()
			.superRefine((change, ctx) => {
				if (change.uuid === change.value.uuid) return;
				ctx.addIssue({
					code: "custom",
					path: ["value", "uuid"],
					message: "A case-operation replacement must preserve UUID identity.",
				});
			}),
		z.object({ operation: z.literal("remove"), uuid: uuidSchema }).strict(),
		z
			.object({
				operation: z.literal("move"),
				uuid: uuidSchema,
				order: z.string(),
			})
			.strict(),
	]);
}

function caseSearchConfigPatchSchemaFor(
	configSchema: typeof caseSearchConfigSchema,
) {
	return z
		.object({
			excludedOwnerIds: configSchema.shape.excludedOwnerIds.nullable(),
			searchScreenTitle: configSchema.shape.searchScreenTitle.nullable(),
			searchScreenSubtitle: configSchema.shape.searchScreenSubtitle.nullable(),
			searchButtonLabel: configSchema.shape.searchButtonLabel.nullable(),
			searchButtonDisplayCondition:
				configSchema.shape.searchButtonDisplayCondition.nullable(),
		})
		.partial()
		.strict();
}

const carrierBlindModuleUpdatePatchSchema = clearablePartialPatch(
	carrierBlindModuleSchema,
);
const carrierBlindFormUpdatePatchSchema = clearablePartialPatch(
	carrierBlindFormSchema,
).omit({
	caseOperations: true,
});
const carrierBlindCaseOperationChangeSchema = caseOperationChangeSchemaFor(
	carrierBlindCaseOperationSchema,
);
const carrierBlindCaseSearchConfigPatchSchema = caseSearchConfigPatchSchemaFor(
	carrierBlindCaseSearchConfigSchema,
);

const canonicalModuleUpdatePatchSchema = clearablePartialPatch(moduleSchema);
const canonicalFormUpdatePatchSchema = clearablePartialPatch(formSchema).omit({
	caseOperations: true,
});
const canonicalCaseOperationChangeSchema =
	caseOperationChangeSchemaFor(caseOperationSchema);
const canonicalCaseSearchConfigPatchSchema = caseSearchConfigPatchSchemaFor(
	caseSearchConfigSchema,
);

/**
 * Per-`targetKind` arms for the `updateField` mutation. Each arm
 * carries the `targetKind` literal as a sub-discriminator and types its
 * `patch` slot against that kind's partial schema. These arms compose
 * into a `z.discriminatedUnion("kind", ...)` arm whose `kind` literal is
 * `"updateField"` — the outer `mutationSchema` selects the
 * `updateField` arm by `kind`, and TypeScript / Zod further discriminate
 * on `targetKind` to pick the correct patch shape.
 *
 * Built from `fieldKinds.map(...)` so adding a new field kind extends
 * both the `Field` union (via `fieldKinds` + `fieldRegistry`) and the
 * `updateField` arm set in lockstep — no per-kind list to maintain
 * separately. The `as const` cast pins the literal `kind` to
 * `"updateField"` (Zod literals erase to `string` in the array's
 * element type without it).
 */
type UpdateFieldArm = {
	[K in (typeof fieldKinds)[number]]: z.ZodObject<{
		kind: z.ZodLiteral<"updateField">;
		uuid: typeof uuidSchema;
		targetKind: z.ZodLiteral<K>;
		patch: z.ZodDefault<(typeof carrierBlindFieldPatchSchemaByKind)[K]>;
		optionsSource: z.ZodOptional<
			z.ZodNullable<typeof lookupOptionsSourceSchema>
		>;
	}>;
}[(typeof fieldKinds)[number]];

const updateFieldArms = fieldKinds.map(
	(targetKind) =>
		z
			.object({
				kind: z.literal("updateField"),
				uuid: uuidSchema,
				targetKind: z.literal(targetKind),
				// `patch` defaults to `{}` when it is absent on read. A field
				// clear travels as an explicit `null` value (which survives JSON
				// serialization), so a normal clear-only edit produces a NON-empty
				// patch and never needs this default. The default exists for a
				// patch that is genuinely empty on the wire: a degenerate
				// no-property update, or a legacy event written before clears
				// carried `null` — back then a clear lowered to an all-`undefined`
				// patch, and JSON serialization drops `undefined`-valued keys, so
				// the persisted patch was an empty map. Defaulting to
				// `{}` lets such an event parse and replay as a no-op (the reducer
				// applies no keys) instead of the strict arm throwing and taking
				// down the whole event scan — the log is supplemental, so one
				// degenerate event must never block reading the rest. The blueprint
				// snapshot stays authoritative for the field's actual state.
				//
				// Cast needed because under the generic `targetKind` the schema is a
				// union of every kind's patch schema, which isn't directly
				// `.default()`-callable; the outer `as UpdateFieldArm` restores the
				// precise per-kind type.
				patch: (
					carrierBlindFieldPatchSchemaByKind[targetKind] as z.ZodTypeAny
				).default(() => ({})),
				optionsSource: lookupOptionsSourceSchema.nullable().optional(),
			})
			.superRefine((mutation, ctx) => {
				if (
					mutation.optionsSource !== undefined &&
					targetKind !== "single_select" &&
					targetKind !== "multi_select"
				) {
					ctx.addIssue({
						code: "custom",
						path: ["optionsSource"],
						message:
							"Only single-select and multi-select fields can use lookup-backed options.",
					});
				}
			}) as unknown as UpdateFieldArm,
) as [UpdateFieldArm, ...UpdateFieldArm[]];

const canonicalMutationFamily = {
	module: moduleSchema,
	moduleUpdatePatch: canonicalModuleUpdatePatchSchema,
	caseSearchConfig: caseSearchConfigSchema,
	caseSearchConfigPatch: canonicalCaseSearchConfigPatchSchema,
	form: formSchema,
	formUpdatePatch: canonicalFormUpdatePatchSchema,
	caseOperationChange: canonicalCaseOperationChangeSchema,
	column: columnSchema,
	searchInput: searchInputDefSchema,
	predicate: predicateSchema,
} as const;

type MutationSchemaFamily = typeof canonicalMutationFamily;

const carrierBlindMutationFamily = {
	module: carrierBlindModuleSchema,
	moduleUpdatePatch: carrierBlindModuleUpdatePatchSchema,
	caseSearchConfig: carrierBlindCaseSearchConfigSchema,
	caseSearchConfigPatch: carrierBlindCaseSearchConfigPatchSchema,
	form: carrierBlindFormSchema,
	formUpdatePatch: carrierBlindFormUpdatePatchSchema,
	caseOperationChange: carrierBlindCaseOperationChangeSchema,
	column: carrierBlindColumnSchema,
	searchInput: carrierBlindSearchInputDefSchema,
	predicate: rollingPredicateSchema,
} as const satisfies MutationSchemaFamily;

const optionsSourcePlacementSchema = z
	.unknown()
	.superRefine((value, ctx) => {
		const rootKind =
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			"kind" in value
				? value.kind
				: undefined;
		const rootAllowsOptionsSource =
			rootKind === "addField" || rootKind === "updateField";
		const visited = new WeakSet<object>();

		function visit(node: unknown, path: PropertyKey[]): void {
			if (typeof node !== "object" || node === null) return;
			if (visited.has(node)) return;
			visited.add(node);

			for (const [key, child] of Object.entries(node)) {
				const childPath = [...path, key];
				if (
					key === "optionsSource" &&
					!(path.length === 0 && rootAllowsOptionsSource)
				) {
					ctx.addIssue({
						code: "custom",
						path: childPath,
						message:
							"Lookup optionsSource is reserved for the top level of addField and updateField mutations.",
					});
				}
				visit(child, childPath);
			}
		}

		visit(value, []);
	})
	// The intersection below evaluates this branch against the untouched input,
	// before the normal object schemas strip unknown future extensions. Emit an
	// empty object so the intersection's merged output remains the parsed union.
	.transform(() => ({}));

function createMutationSchema({
	module: mutationModuleSchema,
	moduleUpdatePatch: mutationModuleUpdatePatchSchema,
	caseSearchConfig: mutationCaseSearchConfigSchema,
	caseSearchConfigPatch: mutationCaseSearchConfigPatchSchema,
	form: mutationFormSchema,
	formUpdatePatch: mutationFormUpdatePatchSchema,
	caseOperationChange: mutationCaseOperationChangeSchema,
	column: mutationColumnSchema,
	searchInput: mutationSearchInputSchema,
	predicate: mutationPredicateSchema,
}: MutationSchemaFamily) {
	const schema = z.discriminatedUnion("kind", [
		// Module
		z
			.object({
				kind: z.literal("addModule"),
				// The nested module is the origin/main reducer fallback. New strict
				// nested slots travel in top-level extensions so old PUT handlers can
				// parse this established discriminator and safely degrade.
				module: mutationModuleSchema,
				index: z.number().int().nonnegative().optional(),
				columnSurfaceOrders: z
					.array(
						z
							.object({
								uuid: uuidSchema,
								listOrder: z.string().optional(),
								detailOrder: z.string().optional(),
							})
							.strict()
							.refine(
								(value) =>
									value.listOrder !== undefined ||
									value.detailOrder !== undefined,
								{ message: "A column surface-order entry cannot be empty." },
							),
					)
					.optional(),
				// Desired owner-only Search state contains Nova's private false bit.
				// The old-shape module carries a match-none projection instead.
				caseSearchConfigValue: mutationCaseSearchConfigSchema.optional(),
				// Belongs only to updateModule; reject accidental cross-arm placement.
				caseSearchConfigPatch: z.never().optional(),
			})
			.superRefine((mutation, ctx) => {
				const columns = mutation.module.caseListConfig?.columns ?? [];
				for (const [index, column] of columns.entries()) {
					for (const key of ["listOrder", "detailOrder"] as const) {
						if (column[key] !== undefined) {
							ctx.addIssue({
								code: "custom",
								path: ["module", "caseListConfig", "columns", index, key],
								message:
									"Column surface order must use addModule.columnSurfaceOrders so the strict pre-deploy module schema can parse the fallback.",
							});
						}
					}
				}
				const columnUuids = new Set(columns.map((column) => column.uuid));
				const seenSurfaceOrders = new Set<string>();
				for (const [index, entry] of (
					mutation.columnSurfaceOrders ?? []
				).entries()) {
					if (
						!columnUuids.has(entry.uuid) ||
						seenSurfaceOrders.has(entry.uuid)
					) {
						ctx.addIssue({
							code: "custom",
							path: ["columnSurfaceOrders", index, "uuid"],
							message:
								"Each column surface-order entry must name one unique column in the fallback module.",
						});
					}
					seenSurfaceOrders.add(entry.uuid);
				}

				const desiredSearch = mutation.caseSearchConfigValue;
				const fallbackSearch = mutation.module.caseSearchConfig;
				if (desiredSearch !== undefined) {
					if (
						desiredSearch.searchActionEnabled !== false ||
						desiredSearch.excludedOwnerIds === undefined
					) {
						ctx.addIssue({
							code: "custom",
							path: ["caseSearchConfigValue"],
							message:
								"Only disabled assigned-case availability needs the addModule compatibility extension.",
						});
					}
					if (
						fallbackSearch?.searchActionEnabled === false ||
						fallbackSearch?.searchButtonDisplayCondition?.kind !== "match-none"
					) {
						ctx.addIssue({
							code: "custom",
							path: ["module", "caseSearchConfig"],
							message:
								"Owner-only addModule must carry an origin-compatible match-none Search fallback.",
						});
					}
					const { searchActionEnabled: _intent, ...originSearch } =
						desiredSearch;
					const expectedFallback = {
						...originSearch,
						searchButtonDisplayCondition: { kind: "match-none" as const },
					};
					if (
						JSON.stringify(fallbackSearch) !== JSON.stringify(expectedFallback)
					) {
						ctx.addIssue({
							code: "custom",
							path: ["module", "caseSearchConfig"],
							message:
								"The owner-only module fallback must agree with every retained Search setting.",
						});
					}
				} else if (fallbackSearch?.searchActionEnabled === false) {
					ctx.addIssue({
						code: "custom",
						path: ["module", "caseSearchConfig", "searchActionEnabled"],
						message:
							"Nova's private Search intent must use addModule.caseSearchConfigValue outside the strict pre-deploy module fallback.",
					});
				}
			}),
		z.object({ kind: z.literal("removeModule"), uuid: uuidSchema }),
		// A move carries the absolute fractional `order` key the gesture computed;
		// the reducer writes it verbatim (a same-parent reorder leaves the
		// membership array untouched). `toIndex` is kept OPTIONAL so the reducer can
		// still replay legacy pre-`order` events (array-position moves); new
		// emissions always carry `order` and the reducer prefers it.
		z.object({
			kind: z.literal("moveModule"),
			uuid: uuidSchema,
			order: z.string().optional(),
			toIndex: z.number().int().nonnegative().optional(),
		}),
		z.object({
			kind: z.literal("renameModule"),
			uuid: uuidSchema,
			// `.min(1)` guards against empty-string renames: the reducer would
			// happily install an empty id (producing a nameless entity) and the
			// event log would round-trip the corruption forever. Rejecting at the
			// schema boundary is the only layer that catches this before write.
			newId: z.string().min(1),
		}),
		z
			.object({
				kind: z.literal("updateModule"),
				uuid: uuidSchema,
				// A clear carries an explicit `null` (the clearable slots are
				// nullable — see `clearablePartialPatch`), so a clear-only edit is a
				// NON-empty patch that round-trips intact. The `{}` default exists for
				// a genuinely-empty patch: a degenerate no-property update, or a legacy
				// event written before clears carried `null` (then a clear lowered to
				// an all-`undefined` patch that `ignoreUndefinedProperties` stripped to
				// an empty, document-omitted map). See `updateFieldArms`.
				patch: mutationModuleUpdatePatchSchema.default(() => ({})),
				// Semantic absent -> present transition. This deliberately extends the
				// pre-deploy `updateModule` arm instead of adding a discriminator: an old
				// parser strips this flag and applies the empty fallback snapshot, while
				// the new reducer ensures the container without replacing peer contents.
				ensureCaseListConfig: z.literal(true).optional(),
				// A full case-list replacement carries old-shape nested columns in the
				// patch and reconstructs current-only surface keys from this top-level
				// extension. Origin/main strips the extension and accepts the fallback.
				columnSurfaceOrders: z
					.array(
						z
							.object({
								uuid: uuidSchema,
								listOrder: z.string().optional(),
								detailOrder: z.string().optional(),
							})
							.strict()
							.refine(
								(value) =>
									value.listOrder !== undefined ||
									value.detailOrder !== undefined,
								{ message: "A column surface-order entry cannot be empty." },
							),
					)
					.optional(),
				// Search presence and final-input cleanup are likewise semantic edits on
				// the origin/main-known `updateModule` discriminator. The patch retains
				// the locally projected `caseSearchConfig` as an old-reducer fallback;
				// new reducers interpret this operation against fresh peer state instead.
				caseSearchConfigOperation: z
					.enum([
						"enable",
						"disable-if-unused",
						"remove-if-no-authored-settings",
						"cleanup-after-final-input",
						"set-owner-only",
					])
					.optional(),
				// Desired owner-only state contains Nova's private false bit, which an
				// origin/main strict nested schema cannot parse. Keeping it in a new
				// top-level slot means an old parser strips it whole and consumes only
				// the old-compatible match-none fallback in `patch`.
				caseSearchConfigValue: mutationCaseSearchConfigSchema.optional(),
				// Per-setting enabled-Search edits merge into the fresh bag. The nested
				// patch remains a full origin-compatible snapshot for old reducers.
				caseSearchConfigPatch: mutationCaseSearchConfigPatchSchema.optional(),
			})
			.superRefine((mutation, ctx) => {
				const caseListFallback = mutation.patch.caseListConfig;
				const fallbackColumns =
					caseListFallback === null || caseListFallback === undefined
						? []
						: caseListFallback.columns;
				for (const [index, column] of fallbackColumns.entries()) {
					for (const key of ["listOrder", "detailOrder"] as const) {
						if (column[key] !== undefined) {
							ctx.addIssue({
								code: "custom",
								path: ["patch", "caseListConfig", "columns", index, key],
								message:
									"Surface order must use updateModule.columnSurfaceOrders so the strict pre-deploy nested schema can parse the fallback.",
							});
						}
					}
				}
				const fallbackColumnUuids = new Set(
					fallbackColumns.map((column) => column.uuid),
				);
				const seenSurfaceOrders = new Set<string>();
				for (const [index, entry] of (
					mutation.columnSurfaceOrders ?? []
				).entries()) {
					if (
						!fallbackColumnUuids.has(entry.uuid) ||
						seenSurfaceOrders.has(entry.uuid)
					) {
						ctx.addIssue({
							code: "custom",
							path: ["columnSurfaceOrders", index, "uuid"],
							message:
								"Each column surface-order entry must name one unique column in the fallback case-list config.",
						});
					}
					seenSurfaceOrders.add(entry.uuid);
				}

				if (mutation.ensureCaseListConfig) {
					const fallback = mutation.patch.caseListConfig;
					const hasOnlyRequiredEmptySlots =
						fallback !== null &&
						fallback !== undefined &&
						fallback.columns.length === 0 &&
						fallback.searchInputs.length === 0 &&
						Object.keys(fallback).every(
							(key) => key === "columns" || key === "searchInputs",
						);
					if (!hasOnlyRequiredEmptySlots) {
						ctx.addIssue({
							code: "custom",
							path: ["patch", "caseListConfig"],
							message:
								"A semantic case-list ensure must carry the required empty config as its pre-deploy fallback.",
						});
					}
				}

				const operation = mutation.caseSearchConfigOperation;
				const patchSearch = mutation.patch.caseSearchConfig;
				const semanticPatch = mutation.caseSearchConfigPatch;
				if (semanticPatch !== undefined) {
					if (Object.keys(semanticPatch).length === 0) {
						ctx.addIssue({
							code: "custom",
							path: ["caseSearchConfigPatch"],
							message: "A semantic Search settings patch cannot be empty.",
						});
					}
					if (!Object.hasOwn(mutation.patch, "caseSearchConfig")) {
						ctx.addIssue({
							code: "custom",
							path: ["patch", "caseSearchConfig"],
							message:
								"A semantic Search settings patch needs an origin-compatible fallback.",
						});
					}
					if (
						operation !== undefined ||
						mutation.caseSearchConfigValue !== undefined
					) {
						ctx.addIssue({
							code: "custom",
							path: ["caseSearchConfigPatch"],
							message:
								"A per-setting Search patch cannot be combined with another Search semantic operation.",
						});
					}
					for (const [slot, semanticValue] of Object.entries(semanticPatch)) {
						const fallbackValue =
							patchSearch === null || patchSearch === undefined
								? undefined
								: (patchSearch as unknown as Record<string, unknown>)[slot];
						const desiredValue = semanticValue ?? undefined;
						if (
							JSON.stringify(fallbackValue) !== JSON.stringify(desiredValue)
						) {
							ctx.addIssue({
								code: "custom",
								path: ["caseSearchConfigPatch", slot],
								message:
									"Each Search settings patch slot must agree with its origin-compatible fallback.",
							});
						}
					}
				}
				if (patchSearch?.searchActionEnabled === false) {
					ctx.addIssue({
						code: "custom",
						path: ["patch", "caseSearchConfig", "searchActionEnabled"],
						message:
							"The pre-deploy Search fallback cannot contain Nova's private searchActionEnabled slot.",
					});
				}
				if (operation === undefined) {
					if (mutation.caseSearchConfigValue !== undefined) {
						ctx.addIssue({
							code: "custom",
							path: ["caseSearchConfigValue"],
							message:
								"A semantic Search value requires a caseSearchConfigOperation.",
						});
					}
					return;
				}
				if (!Object.hasOwn(mutation.patch, "caseSearchConfig")) {
					ctx.addIssue({
						code: "custom",
						path: ["patch", "caseSearchConfig"],
						message:
							"A semantic Search operation must carry a caseSearchConfig fallback for pre-deploy receivers.",
					});
					return;
				}
				const fallback = mutation.patch.caseSearchConfig;
				if (
					operation === "enable" &&
					(fallback == null || fallback.searchActionEnabled === false)
				) {
					ctx.addIssue({
						code: "custom",
						path: ["patch", "caseSearchConfig"],
						message:
							"A semantic Search enable must carry an enabled config snapshot as its pre-deploy fallback.",
					});
				}
				if (
					(operation === "disable-if-unused" ||
						operation === "remove-if-no-authored-settings") &&
					fallback !== null
				) {
					ctx.addIssue({
						code: "custom",
						path: ["patch", "caseSearchConfig"],
						message:
							"A conditional Search removal must carry null as its pre-deploy fallback.",
					});
				}
				if (operation === "set-owner-only") {
					if (
						mutation.caseSearchConfigValue?.searchActionEnabled !== false ||
						mutation.caseSearchConfigValue.excludedOwnerIds === undefined
					) {
						ctx.addIssue({
							code: "custom",
							path: ["caseSearchConfigValue"],
							message:
								"An owner-only Search operation must carry the desired disabled assigned-case config outside the legacy patch.",
						});
					}
					if (mutation.caseSearchConfigValue !== undefined) {
						const { searchActionEnabled: _intent, ...originSearch } =
							mutation.caseSearchConfigValue;
						const expectedFallback = {
							...originSearch,
							searchButtonDisplayCondition: { kind: "match-none" as const },
						};
						if (JSON.stringify(fallback) !== JSON.stringify(expectedFallback)) {
							ctx.addIssue({
								code: "custom",
								path: ["patch", "caseSearchConfig"],
								message:
									"The owner-only fallback must agree with every retained Search setting.",
							});
						}
					}
					if (
						fallback == null ||
						fallback.searchButtonDisplayCondition?.kind !== "match-none"
					) {
						ctx.addIssue({
							code: "custom",
							path: ["patch", "caseSearchConfig"],
							message:
								"An owner-only Search operation must carry an origin-compatible match-none fallback.",
						});
					}
				} else if (mutation.caseSearchConfigValue !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["caseSearchConfigValue"],
						message:
							"Only an owner-only Search operation may carry a semantic config value.",
					});
				}
			}),
		// Form
		z.object({
			kind: z.literal("addForm"),
			moduleUuid: uuidSchema,
			form: mutationFormSchema,
			index: z.number().int().nonnegative().optional(),
		}),
		z.object({ kind: z.literal("removeForm"), uuid: uuidSchema }),
		// `order` is the gesture-computed fractional key (written verbatim);
		// `toIndex` is kept optional for legacy replay only. A same-module reorder
		// sets only `order`; a cross-module move also updates membership.
		z.object({
			kind: z.literal("moveForm"),
			uuid: uuidSchema,
			toModuleUuid: uuidSchema,
			order: z.string().optional(),
			toIndex: z.number().int().nonnegative().optional(),
		}),
		z.object({
			kind: z.literal("renameForm"),
			uuid: uuidSchema,
			// See renameModule — reject empty ids at the schema boundary.
			newId: z.string().min(1),
		}),
		z.object({
			kind: z.literal("updateForm"),
			uuid: uuidSchema,
			// A clear carries an explicit `null` (the clearable slots are
			// nullable — see `clearablePartialPatch`), so a clear-only edit is a
			// NON-empty patch that round-trips intact. The `{}` default exists for
			// a genuinely-empty patch: a degenerate no-property update, or a legacy
			// event written before clears carried `null` (then a clear lowered to
			// an all-`undefined` patch that `ignoreUndefinedProperties` stripped to
			// an empty, document-omitted map). See `updateFieldArms`.
			patch: mutationFormUpdatePatchSchema.default(() => ({})),
			// Semantic extension on the long-lived updateForm discriminator. Old
			// receivers strip this unknown key and safely replay the empty patch;
			// new receivers apply one identity-keyed operation edit.
			caseOperationChange: mutationCaseOperationChangeSchema.optional(),
		}),
		// Field
		z
			.object({
				kind: z.literal("addField"),
				parentUuid: uuidSchema,
				// The nested field is the pre-S05 receiver fallback and therefore
				// remains strict and carrier-blind. Current source intent travels in
				// the optional top-level extension below.
				field: carrierBlindFieldSchema,
				index: z.number().int().nonnegative().optional(),
				optionsSource: lookupOptionsSourceSchema.optional(),
			})
			.superRefine((mutation, ctx) => {
				if (
					mutation.optionsSource !== undefined &&
					mutation.field.kind !== "single_select" &&
					mutation.field.kind !== "multi_select"
				) {
					ctx.addIssue({
						code: "custom",
						path: ["optionsSource"],
						message:
							"Only single-select and multi-select fields can use lookup-backed options.",
					});
				}
			}),
		z.object({ kind: z.literal("removeField"), uuid: uuidSchema }),
		// `order` is the gesture-computed fractional key (written verbatim);
		// `toIndex` is kept optional for legacy replay only. A same-parent reorder
		// sets only `order` (membership untouched); a cross-parent move also updates
		// membership and re-anchors references.
		z.object({
			kind: z.literal("moveField"),
			uuid: uuidSchema,
			toParentUuid: uuidSchema,
			order: z.string().optional(),
			toIndex: z.number().int().nonnegative().optional(),
		}),
		z.object({
			kind: z.literal("renameField"),
			uuid: uuidSchema,
			// See renameModule — reject empty ids at the schema boundary.
			newId: z.string().min(1),
		}),
		z.object({ kind: z.literal("duplicateField"), uuid: uuidSchema }),
		// `updateField` is itself a per-`targetKind` discriminated union — see
		// `updateFieldArms` above. Zod v4 supports nesting one
		// `discriminatedUnion` inside another, which keeps both layers as
		// O(1) literal-keyed dispatch (kind → updateField → targetKind)
		// rather than falling back to a generic union scan.
		z.discriminatedUnion("targetKind", updateFieldArms),
		z.object({
			kind: z.literal("convertField"),
			uuid: uuidSchema,
			toKind: z.enum(fieldKinds),
			// Born options for a conversion INTO a select kind from a kind with
			// no options slot (text → single_select) — the select schemas
			// require `.min(2)` options the source can't carry, so the
			// reducer's reconcile would otherwise always fail. Minted (uuid +
			// order) at the batch-building layer so the reducer stays
			// deterministic for replay and peers. Ignored when the target kind
			// has no options slot.
			options: z.array(selectOptionSchema).optional(),
		}),
		// App-level
		z.object({ kind: z.literal("setAppName"), name: z.string() }),
		z.object({
			kind: z.literal("setConnectType"),
			connectType: z.enum(CONNECT_TYPES).nullable(),
		}),
		// `logo` is `assetIdSchema.optional()` on the doc — there is no
		// stored `null`. The payload is `.nullable()` (not optional) so the
		// mutation always carries an explicit intent: an asset id sets the
		// logo, `null` clears it. The reducer maps `null → undefined` so the
		// cleared key drops off the doc rather than persisting as a literal
		// `null` the schema would reject. Distinct from `setConnectType`,
		// whose `connectType` slot is genuinely `.nullable()` and stores the
		// `null` verbatim.
		z.object({
			kind: z.literal("setAppLogo"),
			logo: assetIdSchema.nullable(),
		}),
		z.object({
			kind: z.literal("setCaseTypes"),
			caseTypes: z.array(caseTypeSchema).nullable(),
		}),
		// ─── Granular case-type catalog ──────────────────────────────────────
		//
		// The catalog is keyed by `(case-type name, property name)`. Replacing the
		// wholesale `setCaseTypes` on the live diff path, these fine-grained kinds
		// let two members concurrently declare a type / add a property / edit a
		// property and merge by construction. `setCaseTypes` stays in the union for
		// event-log replay and whole-catalog seeding. Each `setCaseTypeMeta` slot is
		// nullable so a clear (`parent_type` / `relationship`) crosses the JSON wire
		// as an explicit `null`; the reducer maps `null → delete`.
		z.object({ kind: z.literal("declareCaseType"), caseType: z.string() }),
		z.object({ kind: z.literal("retireCaseType"), caseType: z.string() }),
		z.object({
			kind: z.literal("addCaseProperty"),
			caseType: z.string(),
			property: casePropertySchema,
		}),
		z.object({
			kind: z.literal("setCaseProperty"),
			caseType: z.string(),
			property: casePropertySchema,
		}),
		z.object({
			kind: z.literal("removeCaseProperty"),
			caseType: z.string(),
			property: z.string(),
		}),
		z.object({
			kind: z.literal("setCaseTypeMeta"),
			caseType: z.string(),
			parent_type: z.string().nullable().optional(),
			relationship: z.enum(["child", "extension"]).nullable().optional(),
		}),
		// ─── Granular case-list collections ──────────────────────────────────
		//
		// `caseListConfig.columns` / `.searchInputs` are membership arrays whose
		// position is NOT authoritative. Search inputs use `sort-by-(order, uuid)`;
		// columns additionally carry independent `listOrder` / `detailOrder` keys
		// (each falling back to `order`). Every kind is keyed by the owning module
		// uuid + item uuid, so concurrent edits merge. New column content updates
		// preserve all three current order keys plus both current visibility slots;
		// each move or visibility mutation changes only its named surface.
		// A config's absent -> present transition is the semantic extension on
		// `updateModule` above. Its old-client fallback is an empty config snapshot;
		// new reducers treat it as an idempotent ensure before the granular edits.
		z
			.object({
				kind: z.literal("addColumn"),
				moduleUuid: uuidSchema,
				// Origin/main's nested column schema is strict and predates the two
				// surface keys, so the fallback column must remain in the old shape.
				column: mutationColumnSchema,
				surfaceOrders: z
					.object({
						listOrder: z.string().optional(),
						detailOrder: z.string().optional(),
					})
					.strict()
					.optional(),
			})
			.superRefine((mutation, ctx) => {
				for (const key of ["listOrder", "detailOrder"] as const) {
					if (mutation.column[key] !== undefined) {
						ctx.addIssue({
							code: "custom",
							path: ["column", key],
							message:
								"Surface order must use addColumn.surfaceOrders so the strict pre-deploy column schema can parse the fallback.",
						});
					}
				}
			}),
		z
			.object({
				kind: z.literal("updateColumn"),
				moduleUuid: uuidSchema,
				uuid: uuidSchema,
				column: mutationColumnSchema,
				// New content emitters opt into preserving the fresh slots;
				// visibility-only emitters carry a single-surface patch. Both are
				// optional extensions of the existing kind so pre-deploy clients keep
				// recognizing streamed events. Absence retains legacy full-body behavior.
				preserveVisibility: z.literal(true).optional(),
				// Content-only replacements preserve a peer's fresh sort directive.
				preserveSort: z.literal(true).optional(),
				// Sort is an independently mergeable slot. `null` clears it; the
				// nested column remains an old-reducer full-body fallback.
				sortPatch: columnSortSchema.nullable().optional(),
				visibilityPatch: z
					.object({
						surface: z.enum(["list", "detail"]),
						visible: z.boolean(),
					})
					.strict()
					.optional(),
			})
			.superRefine((mutation, ctx) => {
				for (const key of ["listOrder", "detailOrder"] as const) {
					if (mutation.column[key] !== undefined) {
						ctx.addIssue({
							code: "custom",
							path: ["column", key],
							message:
								"Surface order keys must stay out of the strict pre-deploy updateColumn fallback.",
						});
					}
				}
				if (mutation.sortPatch !== undefined) {
					if (
						mutation.preserveSort ||
						mutation.preserveVisibility ||
						mutation.visibilityPatch !== undefined
					) {
						ctx.addIssue({
							code: "custom",
							path: ["sortPatch"],
							message:
								"A sort patch cannot be combined with another updateColumn semantic mode.",
						});
					}
					const fallbackSort = mutation.column.sort ?? null;
					if (
						JSON.stringify(fallbackSort) !== JSON.stringify(mutation.sortPatch)
					) {
						ctx.addIssue({
							code: "custom",
							path: ["column", "sort"],
							message:
								"The old-reducer column fallback must carry the requested sort value.",
						});
					}
				}
				if (mutation.visibilityPatch === undefined) return;
				if (mutation.preserveVisibility) {
					ctx.addIssue({
						code: "custom",
						path: ["preserveVisibility"],
						message:
							"A visibility-only update cannot also be a content update that preserves visibility.",
					});
				}
				if (mutation.preserveSort) {
					ctx.addIssue({
						code: "custom",
						path: ["preserveSort"],
						message:
							"A visibility-only patch cannot also request content sort preservation.",
					});
				}
				const slot =
					mutation.visibilityPatch.surface === "list"
						? "visibleInList"
						: "visibleInDetail";
				if (
					(mutation.column[slot] !== false) !==
					mutation.visibilityPatch.visible
				) {
					ctx.addIssue({
						code: "custom",
						path: ["column", slot],
						message:
							"The fallback column visibility must agree with the visibility patch for pre-deploy receivers.",
					});
				}
			}),
		z.object({
			kind: z.literal("removeColumn"),
			moduleUuid: uuidSchema,
			uuid: uuidSchema,
		}),
		z
			.object({
				kind: z.literal("moveColumn"),
				moduleUuid: uuidSchema,
				uuid: uuidSchema,
				// Pre-deploy fallback: old reducers move the legacy shared order key.
				order: z.string(),
				// New reducers use the named surface key instead. Keeping this optional
				// on the existing discriminator lets both old open tabs and old servers
				// accept the payload; a string value must agree with the legacy fallback.
				surfaceOrderPatch: z
					.object({
						surface: z.enum(["list", "detail"]),
						// `null` clears the override and restores the generic fallback.
						order: z.string().nullable(),
					})
					.strict()
					.optional(),
			})
			.superRefine((mutation, ctx) => {
				const semanticOrder = mutation.surfaceOrderPatch?.order;
				if (semanticOrder === undefined || semanticOrder === null) return;
				if (semanticOrder !== mutation.order) {
					ctx.addIssue({
						code: "custom",
						path: ["order"],
						message:
							"The legacy column-order fallback must agree with the surface order patch.",
					});
				}
			}),
		z.object({
			kind: z.literal("addSearchInput"),
			moduleUuid: uuidSchema,
			searchInput: mutationSearchInputSchema,
		}),
		z
			.object({
				kind: z.literal("updateSearchInput"),
				moduleUuid: uuidSchema,
				uuid: uuidSchema,
				// Origin-compatible full-row fallback. A rename retains the previous
				// declaration name here; current receivers apply the desired name below
				// and structurally rewrite module-wide input refs against fresh state.
				searchInput: mutationSearchInputSchema,
				renamedTo: searchInputRefSchema.shape.name.optional(),
			})
			.superRefine((mutation, ctx) => {
				if (
					mutation.renamedTo !== undefined &&
					mutation.renamedTo === mutation.searchInput.name
				) {
					ctx.addIssue({
						code: "custom",
						path: ["renamedTo"],
						message:
							"A Search-input rename extension must differ from its origin-compatible fallback name.",
					});
				}
			}),
		z.object({
			kind: z.literal("removeSearchInput"),
			moduleUuid: uuidSchema,
			uuid: uuidSchema,
		}),
		z.object({
			kind: z.literal("moveSearchInput"),
			moduleUuid: uuidSchema,
			uuid: uuidSchema,
			order: z.string(),
		}),
		// Presence-only Search transitions and final-input cleanup are the semantic
		// `updateModule` extension above. Keeping their fallback on the established
		// discriminator lets an open pre-deploy client parse and safely replay them.
		// The module's case-list metadata that is NOT a membership array — the
		// always-on `filter` predicate and the case-list-link `icon` / `audioLabel`.
		// Each slot is nullable so a clear crosses the JSON wire as `null`.
		z.object({
			kind: z.literal("setCaseListMeta"),
			uuid: uuidSchema,
			patch: z
				.object({
					filter: mutationPredicateSchema.nullable().optional(),
					icon: assetIdSchema.nullable().optional(),
					audioLabel: assetIdSchema.nullable().optional(),
				})
				.strict(),
		}),
		// ─── Granular select options ─────────────────────────────────────────
		//
		// A select field's `options` array is a membership set keyed by per-option
		// `uuid`; sequence is `sort-by-(order, uuid)`. The reducers mutate `options`
		// IN PLACE and never re-parse the field through `fieldSchema`, so a
		// `removeOption` dropping below two options reaches the commit gate as a
		// sub-2 candidate (`SELECT_TOO_FEW_OPTIONS`).
		z.object({
			kind: z.literal("addOption"),
			fieldUuid: uuidSchema,
			option: selectOptionSchema,
		}),
		z.object({
			kind: z.literal("updateOption"),
			fieldUuid: uuidSchema,
			uuid: uuidSchema,
			option: selectOptionSchema,
		}),
		z.object({
			kind: z.literal("removeOption"),
			fieldUuid: uuidSchema,
			uuid: uuidSchema,
		}),
		z.object({
			kind: z.literal("moveOption"),
			fieldUuid: uuidSchema,
			uuid: uuidSchema,
			order: z.string(),
		}),
		// ─── Media slots — dedicated clear-safe kinds ────────────────────────
		//
		// Media slots are deliberately OFF the generic field-edit surface
		// (`toolSchemaGenerator.ts` drops `media`), so they ride their own kinds
		// rather than an `updateField` / `updateModule` / `updateForm` patch.
		// Each carries an explicit on-wire `null` and maps it to `undefined`
		// INSIDE the reducer, so both set and clear cross the wire intact (a
		// generic patch's clear travels as `null` too — `JSON.stringify` DROPS
		// `undefined`-valued keys, so a clear can only ever be `null` on the
		// wire). Mirrors `setAppLogo`.
		//
		// The generic `update*` reducers DO treat `null` as delete on their
		// clearable slots — `setConnectType` is the lone exception: its slot is
		// genuinely `.nullable()` and stores `null` as a real value, so it is NOT
		// a patch reducer and never gets the null-as-delete treatment.
		z.object({
			kind: z.literal("setFieldMedia"),
			fieldUuid: uuidSchema,
			slot: z.enum(FIELD_MEDIA_SLOTS),
			media: mediaSchema.nullable(),
		}),
		z.object({
			kind: z.literal("setModuleMedia"),
			uuid: uuidSchema,
			icon: assetIdSchema.nullable(),
			audioLabel: assetIdSchema.nullable(),
		}),
		z.object({
			kind: z.literal("setFormMedia"),
			uuid: uuidSchema,
			icon: assetIdSchema.nullable(),
			audioLabel: assetIdSchema.nullable(),
		}),
	]);
	return Object.assign(schema.and(optionsSourcePlacementSchema), {
		// Preserve the useful arm-level inspection surface for grammar tests.
		options: schema.options,
	});
}

/**
 * Rolling/external mutation envelope.
 *
 * Established fallback subtrees intentionally omit dormant S05 lookup
 * carriers so a payload remains parseable by a pre-S05 receiver. New lookup
 * option intent travels only in the top-level addField/updateField extension.
 */
export const mutationSchema = createMutationSchema(carrierBlindMutationFamily);

/**
 * Canonical replay envelope.
 *
 * Durable events may already contain canonical lookup carriers in established
 * Predicate / ValueExpression slots. Replays and log reads must preserve
 * those values even though new rolling writes keep their fallback projection
 * carrier-blind.
 */
export const canonicalMutationSchema = createMutationSchema(
	canonicalMutationFamily,
);

export type Mutation = z.infer<typeof canonicalMutationSchema>;
export type RollingMutation = z.infer<typeof mutationSchema>;

type Assert<T extends true> = T;
export type RollingMutationIsCanonical = Assert<
	RollingMutation extends Mutation ? true : false
>;

// ─── MutationResult ────────────────────────────────────────────────────
//
// Per-mutation result returned by the reducer.
//
// `applyMany(mutations)` returns `MutationResult[]` — one entry per input
// mutation, same order. Most mutation kinds produce `undefined`; the two
// that surface actionable metadata are:
//   - `renameField`: `FieldRenameMeta` with the XPath-rewrite count
//   - `moveField`: `MoveFieldResult` with cross-level auto-rename info
//
// A flat union (rather than a positionally-typed tuple or a
// generic-per-mutation result) keeps the public API uniform and easy to
// type at call sites. Callers that need metadata destructure by known
// position and narrow via `typeof` / kind check. This shape is final —
// it will not expand to a mapped type when new mutation kinds are added,
// because those kinds return `undefined` and `undefined` already belongs
// to this union.

import type {
	FieldRenameMeta,
	MoveFieldResult,
} from "@/lib/doc/mutations/fields";

export type MutationResult = FieldRenameMeta | MoveFieldResult | undefined;

export type { FieldRenameMeta, MoveFieldResult };
