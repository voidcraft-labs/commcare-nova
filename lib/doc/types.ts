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
	caseTileLayoutSchema,
	caseTypeSchema,
	columnSchema,
	columnSortSchema,
	fieldKinds,
	formSchema,
	lookupOptionsSourceSchema,
	mediaSchema,
	moduleSchema,
	personaSchema,
	searchInputDefSchema,
	selectOptionSchema,
	tileCellSchema,
	userPropertySchema,
	userTypeSchema,
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
import { deepEqual } from "./deepEqual";

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
				/** The uuid this operation now follows, or `null` for first. */
				after: uuidSchema.nullable(),
			})
			.strict(),
	]);
}

/**
 * Current granular intent for an established `updateForm` event.
 *
 * `caseOperationChange` above is already deployed and therefore stays exact:
 * its full-operation `update` is the fallback a pre-granular reducer applies.
 * This separate top-level extension is stripped by that parser and interpreted
 * by current reducers against fresh peer state.
 */
function caseOperationPatchSchemaFor(
	operationValueSchema: typeof caseOperationSchema,
) {
	const operationPatchSchema = clearablePartialPatch(operationValueSchema)
		// `clearablePartialPatch` already drops `uuid`, so identity replacement
		// is unrepresentable here rather than checked after the fact: the arm's
		// own `uuid` is the addressing key, and `.strict()` rejects a second
		// one outright. Do not add a runtime guard for it.
		.omit({
			writes: true,
			links: true,
		})
		.strict()
		.refine((patch) => Object.keys(patch).length > 0, {
			message: "A case-operation update patch must change at least one slot.",
		});
	const writeSchema = operationValueSchema.shape.writes.unwrap().element;
	const writePatchSchema = z
		.object({
			value: writeSchema.shape.value.optional(),
			condition: writeSchema.shape.condition.unwrap().nullable().optional(),
		})
		.strict()
		.refine((patch) => Object.keys(patch).length > 0, {
			message: "A case-operation write patch must change at least one slot.",
		});
	const linkSchema = operationValueSchema.shape.links.unwrap().element;
	const linkPatchSchema = linkSchema
		.omit({ identifier: true })
		.partial()
		.strict()
		.refine((patch) => Object.keys(patch).length > 0, {
			message: "A case-operation link patch must change at least one slot.",
		});

	return z.discriminatedUnion("operation", [
		z
			.object({
				operation: z.literal("update"),
				uuid: uuidSchema,
				patch: operationPatchSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("add-write"),
				uuid: uuidSchema,
				value: writeSchema,
				index: z.number().int().nonnegative().optional(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("update-write"),
				uuid: uuidSchema,
				property: writeSchema.shape.property,
				patch: writePatchSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("remove-write"),
				uuid: uuidSchema,
				property: writeSchema.shape.property,
			})
			.strict(),
		z
			.object({
				operation: z.literal("add-link"),
				uuid: uuidSchema,
				value: linkSchema,
				index: z.number().int().nonnegative().optional(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("update-link"),
				uuid: uuidSchema,
				identifier: linkSchema.shape.identifier,
				patch: linkPatchSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("remove-link"),
				uuid: uuidSchema,
				identifier: linkSchema.shape.identifier,
			})
			.strict(),
		z
			.object({
				operation: z.literal("move"),
				uuid: uuidSchema,
				/**
				 * The uuid this operation now follows, or `null` for first.
				 *
				 * The separate `index` intent is gone with the fractional key it
				 * guarded: it existed so the authoritative writer could reject a
				 * placement a peer had shifted out from under the author. A placement
				 * named by the neighbouring uuid cannot be shifted — the anchor either
				 * still exists, or it does not and the move appends.
				 */
				after: uuidSchema.nullable(),
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
const carrierBlindCaseOperationPatchSchema = caseOperationPatchSchemaFor(
	carrierBlindCaseOperationSchema,
);
const carrierBlindCaseSearchConfigPatchSchema = caseSearchConfigPatchSchemaFor(
	carrierBlindCaseSearchConfigSchema,
);

// User properties, user types, and personas hold no Predicate or
// ValueExpression, so their patches are identical under both envelopes —
// there is no carrier-blind projection to build. Every clearable slot is
// null-as-delete-safe: an absent `order` sorts last by uuid, an absent
// `required` is not required, an absent `choices` is free text, an absent
// `description` is none, an absent `userTypeUuid` is no role, and an
// absent `values` bag is read as empty by `userTypesOf` / `personasOf`'s
// consumers. The required slots (`slug`, `label`, `name`) stay
// non-nullable, so a stray `null` for one is a parse error rather than a
// corrupting assign.
const userPropertyUpdatePatchSchema = clearablePartialPatch(userPropertySchema);
const userTypeUpdatePatchSchema = clearablePartialPatch(userTypeSchema);
const personaUpdatePatchSchema = clearablePartialPatch(personaSchema);
const userDataValuePatchSchema = z
	.object({
		userPropertyUuid: uuidSchema,
		/** `null` is the JSON-stable spelling of removing one authored value. */
		value: z.string().nullable(),
	})
	.strict();

const canonicalModuleUpdatePatchSchema = clearablePartialPatch(moduleSchema);
const canonicalFormUpdatePatchSchema = clearablePartialPatch(formSchema).omit({
	caseOperations: true,
});
const canonicalCaseOperationChangeSchema =
	caseOperationChangeSchemaFor(caseOperationSchema);
const canonicalCaseOperationPatchSchema =
	caseOperationPatchSchemaFor(caseOperationSchema);
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
	caseOperationPatch: canonicalCaseOperationPatchSchema,
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
	caseOperationPatch: carrierBlindCaseOperationPatchSchema,
	column: carrierBlindColumnSchema,
	searchInput: carrierBlindSearchInputDefSchema,
	predicate: rollingPredicateSchema,
} as const satisfies MutationSchemaFamily;

function reportMisplacedOptionsSource(
	value: unknown,
	ctx: z.RefinementCtx,
): void {
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
}

/**
 * Reports a case-operation update that also tries to set the operation's
 * `uuid`.
 *
 * `clearablePartialPatch` already omits `uuid`, so `.strict()` refuses this
 * shape on its own — the refusal is structural and this function does not
 * create it. What it creates is the SENTENCE. Strict parsing would otherwise
 * answer "Unrecognized key" for a caller (the SA, an MCP client) whose actual
 * mistake is believing an update can move an operation's identity, and that
 * caller has to be able to act on the message. Running as a preprocess means
 * this lands before the structural refusal rather than beside it.
 */
function reportImmutableCaseOperationIdentity(
	value: unknown,
	ctx: z.RefinementCtx,
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return;
	}
	if (!("kind" in value) || value.kind !== "updateForm") return;
	if (!("caseOperationPatch" in value)) return;
	const change = value.caseOperationPatch;
	if (
		typeof change !== "object" ||
		change === null ||
		!("operation" in change) ||
		change.operation !== "update" ||
		!("patch" in change) ||
		typeof change.patch !== "object" ||
		change.patch === null ||
		!Object.hasOwn(change.patch, "uuid")
	) {
		return;
	}
	ctx.addIssue({
		code: "custom",
		path: ["caseOperationPatch", "patch", "uuid"],
		message:
			"This update also sets the case operation's uuid. An operation's identity is fixed when it is created, so an update can change what the operation does but never which operation it is — address the operation by its existing uuid and leave that slot out of the patch.",
	});
}

/**
 * Run a raw-input check before `schema` without changing its public I/O types.
 *
 * Zod 4's `preprocess` declaration always exposes `unknown` as the wrapper's
 * input, even when the preprocess callback is an identity over the inner
 * schema's input. That is appropriate for ordinary coercion, but not for this
 * validation-only wrapper: callers compose mutation schemas into arrays and
 * event schemas, where widening the input would erase useful checking.
 *
 * The callback below returns its input unchanged and the direct schema remains
 * the sole parser/output producer, so explicitly restoring that schema's
 * `z.input` and `z.output` contract matches the runtime behavior. Compile-time
 * equality assertions in `mutationEnvelopeStrictness.test.ts` lock both
 * mutation families to their direct discriminated unions.
 */
function prevalidateRawMutationInput<Schema extends z.ZodType>(
	schema: Schema,
): z.ZodType<z.output<Schema>, z.input<Schema>> {
	const guarded = z.preprocess<z.input<Schema>, Schema, z.input<Schema>>(
		(value, ctx) => {
			reportMisplacedOptionsSource(value, ctx);
			reportImmutableCaseOperationIdentity(value, ctx);
			return value;
		},
		schema,
	);
	return guarded as z.ZodType<z.output<Schema>, z.input<Schema>>;
}

/**
 * Per-column tile placement carried on a wholesale module write.
 *
 * A tile cell is a current-only column slot, so it cannot ride inside
 * the nested module/config fallback that an origin/main strict schema
 * has to parse — exactly the constraint `columnSurfaceOrders` solves
 * for the two surface order keys. This array is the same shape of
 * answer: the fallback body carries cell-free columns an old reducer
 * applies unchanged, and a current reducer replays the cells on top.
 */
const columnTileCellsSchema = z
	.array(z.object({ uuid: uuidSchema, tile: tileCellSchema }).strict())
	.optional();

/**
 * Reports a nested fallback column that smuggled a current-only tile
 * cell. Shared by `addModule` and `updateModule`, whose fallback
 * bodies sit at different paths.
 */
function reportSmuggledTileCells(
	columns: readonly { readonly tile?: unknown }[],
	basePath: readonly (string | number)[],
	ctx: z.RefinementCtx,
): void {
	for (const [index, column] of columns.entries()) {
		if (column.tile === undefined) continue;
		ctx.addIssue({
			code: "custom",
			path: [...basePath, index, "tile"],
			message:
				"A tile cell must travel in the mutation's columnTileCells extension so the strict pre-deploy column schema can parse the fallback.",
		});
	}
}

/**
 * Reports tile-cell hydration entries that do not name exactly one
 * distinct column present in the mutation's own fallback body — the
 * same integrity rule `columnSurfaceOrders` carries, so a replayed
 * extension can never invent or double-write a column.
 */
function reportUnmatchedTileCellEntries(
	entries: readonly { readonly uuid: string }[],
	fallbackColumnUuids: ReadonlySet<string>,
	ctx: z.RefinementCtx,
): void {
	const seen = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (!fallbackColumnUuids.has(entry.uuid) || seen.has(entry.uuid)) {
			ctx.addIssue({
				code: "custom",
				path: ["columnTileCells", index, "uuid"],
				message:
					"Each tile-cell entry must name one unique column in the mutation's fallback columns.",
			});
		}
		seen.add(entry.uuid);
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function recordsIn(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value
				.map(asRecord)
				.filter(
					(entry): entry is Record<string, unknown> => entry !== undefined,
				)
		: [];
}

/**
 * Bind the current granular intent to the established full-operation fallback.
 *
 * A rolling parser from the immediate parent strips `caseOperationPatch` and
 * applies `caseOperationChange.value`; a current parser applies only the
 * granular extension. The two views must therefore name one identity and
 * agree on the slot the extension edits. This is schema-level integrity, not
 * reducer trust: malformed durable events cannot fork old and current replay.
 */
function reportCaseOperationPatchIntegrity(
	fallbackValue: unknown,
	semanticValue: unknown,
	ctx: z.RefinementCtx,
): void {
	if (semanticValue === undefined) return;
	const semantic = asRecord(semanticValue);
	const fallback = asRecord(fallbackValue);
	const issue = (path: readonly (string | number)[], message: string): void => {
		ctx.addIssue({ code: "custom", path: [...path], message });
	};
	if (
		semantic?.operation === "move" &&
		fallback?.operation === "move" &&
		typeof semantic.uuid === "string" &&
		fallback.uuid === semantic.uuid &&
		semantic.order !== null &&
		fallback.order === semantic.order
	) {
		return;
	}
	if (
		semantic === undefined ||
		fallback === undefined ||
		fallback.operation !== "update"
	) {
		issue(
			["caseOperationChange"],
			"A granular case-operation edit requires the established full-operation update fallback.",
		);
		return;
	}

	const desired = asRecord(fallback.value);
	const uuid = semantic.uuid;
	if (
		typeof uuid !== "string" ||
		fallback.uuid !== uuid ||
		desired?.uuid !== uuid
	) {
		issue(
			["caseOperationChange", "value", "uuid"],
			"The case-operation fallback and granular edit must preserve one UUID identity.",
		);
		return;
	}

	const mismatch = (
		path: readonly (string | number)[],
		message = "The case-operation fallback must agree with the granular edit.",
	): void => issue(path, message);
	// A patch `null` means one of two different things depending on the
	// slot it addresses, and the fallback spells each differently:
	//
	//   - a CLEARABLE OPTIONAL slot (a scalar facet, an order key) —
	//     `null` deletes it, so the fallback simply omits the key and
	//     reads back `undefined`;
	//   - a REQUIRED NULLABLE slot — a link's `target` is the one today
	//     — where `null` is the assigned value meaning "no target", so
	//     the fallback carries a literal `null`.
	//
	// Normalizing to `undefined` alone made the second case disagree
	// with itself: clearing a connection's target emitted a granular
	// `update-link` whose own fallback it then rejected, so
	// `mutationSchema` refused the mutation and the write 400'd rather
	// than persisting. Accepting either spelling keeps the clear case
	// exact while letting an assigned `null` match.
	const matchesPatch = (
		target: Record<string, unknown>,
		patch: Record<string, unknown>,
	): boolean =>
		Object.entries(patch).every(([key, value]) => {
			if (value === null) {
				return target[key] === undefined || target[key] === null;
			}
			return deepEqual(target[key], value);
		});

	switch (semantic.operation) {
		case "update": {
			const patch = asRecord(semantic.patch);
			if (
				desired === undefined ||
				patch === undefined ||
				!matchesPatch(desired, patch)
			) {
				mismatch(["caseOperationPatch", "patch"]);
			}
			return;
		}
		case "add-write": {
			const writes = recordsIn(desired?.writes);
			const expected = asRecord(semantic.value);
			const matches = writes
				.map((write, index) => ({ write, index }))
				.filter(({ write }) => write.property === expected?.property);
			if (
				expected === undefined ||
				matches.length !== 1 ||
				!deepEqual(matches[0]?.write, expected) ||
				(typeof semantic.index === "number" &&
					matches[0]?.index !== semantic.index)
			) {
				mismatch(["caseOperationPatch", "value"]);
			}
			return;
		}
		case "update-write": {
			const matches = recordsIn(desired?.writes).filter(
				(write) => write.property === semantic.property,
			);
			const patch = asRecord(semantic.patch);
			if (
				matches.length !== 1 ||
				patch === undefined ||
				!matchesPatch(matches[0] ?? {}, patch)
			) {
				mismatch(["caseOperationPatch", "patch"]);
			}
			return;
		}
		case "remove-write": {
			if (
				recordsIn(desired?.writes).some(
					(write) => write.property === semantic.property,
				)
			) {
				mismatch(["caseOperationPatch", "property"]);
			}
			return;
		}
		case "add-link": {
			const links = recordsIn(desired?.links);
			const expected = asRecord(semantic.value);
			const matches = links
				.map((link, index) => ({ link, index }))
				.filter(({ link }) => link.identifier === expected?.identifier);
			if (
				expected === undefined ||
				matches.length !== 1 ||
				!deepEqual(matches[0]?.link, expected) ||
				(typeof semantic.index === "number" &&
					matches[0]?.index !== semantic.index)
			) {
				mismatch(["caseOperationPatch", "value"]);
			}
			return;
		}
		case "update-link": {
			const matches = recordsIn(desired?.links).filter(
				(link) => link.identifier === semantic.identifier,
			);
			const patch = asRecord(semantic.patch);
			if (
				matches.length !== 1 ||
				patch === undefined ||
				!matchesPatch(matches[0] ?? {}, patch)
			) {
				mismatch(["caseOperationPatch", "patch"]);
			}
			return;
		}
		case "remove-link": {
			if (
				recordsIn(desired?.links).some(
					(link) => link.identifier === semantic.identifier,
				)
			) {
				mismatch(["caseOperationPatch", "identifier"]);
			}
			return;
		}
		case "move":
			if (
				!deepEqual(
					desired?.order,
					semantic.order === null ? undefined : semantic.order,
				)
			) {
				mismatch(["caseOperationPatch", "order"]);
			}
			return;
	}
}

function createMutationSchema({
	module: mutationModuleSchema,
	moduleUpdatePatch: mutationModuleUpdatePatchSchema,
	caseSearchConfig: mutationCaseSearchConfigSchema,
	caseSearchConfigPatch: mutationCaseSearchConfigPatchSchema,
	form: mutationFormSchema,
	formUpdatePatch: mutationFormUpdatePatchSchema,
	caseOperationChange: mutationCaseOperationChangeSchema,
	caseOperationPatch: mutationCaseOperationPatchSchema,
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
				// Per-column tile placement and the case list's tile layout are both
				// current-only slots on a strict nested schema, so they travel here and
				// the fallback module stays tile-free. An old reducer applies a
				// row-layout case list; the current reducer replays the tile on top.
				columnTileCells: columnTileCellsSchema,
				caseListTile: caseTileLayoutSchema.optional(),
				// Desired owner-only Search state contains Nova's private false bit.
				// The old-shape module carries a match-none projection instead.
				caseSearchConfigValue: mutationCaseSearchConfigSchema.optional(),
				// Belongs only to updateModule; reject accidental cross-arm placement.
				caseSearchConfigPatch: z.never().optional(),
			})
			.superRefine((mutation, ctx) => {
				const columns = mutation.module.caseListConfig?.columns ?? [];
				reportSmuggledTileCells(
					columns,
					["module", "caseListConfig", "columns"],
					ctx,
				);
				if (mutation.module.caseListConfig?.tile !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["module", "caseListConfig", "tile"],
						message:
							"A tile layout must travel in addModule.caseListTile so the strict pre-deploy module schema can parse the fallback.",
					});
				}
				reportUnmatchedTileCellEntries(
					mutation.columnTileCells ?? [],
					new Set(columns.map((column) => column.uuid)),
					ctx,
				);

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
			/** The uuid this module now follows, or `null` for first. */
			after: uuidSchema.nullable(),
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
				// Tile placement + layout on a wholesale case-list replacement. Same
				// contract as `columnSurfaceOrders`: the nested patch is the tile-free
				// old-reducer fallback and these rebuild the current-only slots.
				columnTileCells: columnTileCellsSchema,
				caseListTile: caseTileLayoutSchema.optional(),
			})
			.superRefine((mutation, ctx) => {
				const caseListFallback = mutation.patch.caseListConfig;
				const fallbackColumns =
					caseListFallback === null || caseListFallback === undefined
						? []
						: caseListFallback.columns;
				reportSmuggledTileCells(
					fallbackColumns,
					["patch", "caseListConfig", "columns"],
					ctx,
				);
				if (
					caseListFallback !== null &&
					caseListFallback !== undefined &&
					caseListFallback.tile !== undefined
				) {
					ctx.addIssue({
						code: "custom",
						path: ["patch", "caseListConfig", "tile"],
						message:
							"A tile layout must travel in updateModule.caseListTile so the strict pre-deploy nested schema can parse the fallback.",
					});
				}
				reportUnmatchedTileCellEntries(
					mutation.columnTileCells ?? [],
					new Set(fallbackColumns.map((column) => column.uuid)),
					ctx,
				);
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
			/** The uuid this form now follows within the target module, or `null`
			 *  for first. A cross-module move names a sibling in the DESTINATION. */
			after: uuidSchema.nullable(),
		}),
		z.object({
			kind: z.literal("renameForm"),
			uuid: uuidSchema,
			// See renameModule — reject empty ids at the schema boundary.
			newId: z.string().min(1),
		}),
		z
			.object({
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
				// Exact immediate-parent grammar. For a granular edit, `update.value`
				// is the full-operation fallback an older reducer safely applies.
				caseOperationChange: mutationCaseOperationChangeSchema.optional(),
				// Current-only granular intent. Immediate-parent strict object parsers
				// strip this top-level key and consume the fallback above.
				caseOperationPatch: mutationCaseOperationPatchSchema.optional(),
			})
			.superRefine((mutation, ctx) => {
				reportCaseOperationPatchIntegrity(
					mutation.caseOperationChange,
					mutation.caseOperationPatch,
					ctx,
				);
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
				/** The sibling this field follows under `parentUuid`, or `null` for
				 *  first. Absent appends — the common case, and distinct from `null`
				 *  so "add at the top" stays expressible. */
				after: uuidSchema.nullable().optional(),
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
			/** The uuid this field now follows under the target parent, or `null`
			 *  for first. A cross-parent move names a sibling in the DESTINATION. */
			after: uuidSchema.nullable(),
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
		// ─── User properties, user types, and personas ───────────────────────
		//
		// Three flat UUID-keyed collections (`lib/domain/users.ts`), each with
		// the same add / update / remove trio. There is no `move*` kind: these
		// collections carry no membership array, so a reorder is an `update`
		// whose patch names only `order` — which merges with a concurrent
		// content edit by construction, the same reason columns split their
		// move from their content update.
		//
		// Removal never cascades inside the reducer. A property removal
		// rewrites every value bag that referenced it, and a user-type removal
		// is refused while personas still reference it; both decisions are made
		// at the batch-building layer (`lib/doc/userMutations.ts`) and travel as
		// explicit granular mutations, so historical replay reduces an old
		// removal to the same doc it always did and a concurrent edit to a
		// different collection merges rather than being clobbered.
		z.object({
			kind: z.literal("addUserProperty"),
			property: userPropertySchema,
			after: uuidSchema.nullable().optional(),
		}),
		z.object({
			kind: z.literal("updateUserProperty"),
			uuid: uuidSchema,
			patch: userPropertyUpdatePatchSchema.default(() => ({})),
		}),
		z.object({ kind: z.literal("removeUserProperty"), uuid: uuidSchema }),
		z.object({
			kind: z.literal("addUserType"),
			userType: userTypeSchema,
			after: uuidSchema.nullable().optional(),
		}),
		z.object({
			kind: z.literal("updateUserType"),
			uuid: uuidSchema,
			patch: userTypeUpdatePatchSchema.default(() => ({})),
			/**
			 * Current receivers apply this one semantic key and ignore the
			 * whole-bag `patch.values` fallback. Older receivers strip this
			 * extension and apply that cumulative fallback instead.
			 */
			valuePatch: userDataValuePatchSchema.optional(),
		}),
		z.object({ kind: z.literal("removeUserType"), uuid: uuidSchema }),
		z.object({
			kind: z.literal("addPersona"),
			persona: personaSchema,
			after: uuidSchema.nullable().optional(),
		}),
		z.object({
			kind: z.literal("updatePersona"),
			uuid: uuidSchema,
			patch: personaUpdatePatchSchema.default(() => ({})),
			valuePatch: userDataValuePatchSchema.optional(),
		}),
		z.object({ kind: z.literal("removePersona"), uuid: uuidSchema }),
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
				column: mutationColumnSchema,
				/**
				 * Where the column lands in each surface — the uuid it follows, or
				 * `null` for first. A column belongs to BOTH sequences from birth
				 * regardless of visibility, so both placements are required: an
				 * absent one would mean "somewhere", which is the ambiguity this
				 * whole model removes.
				 */
				afterInList: uuidSchema.nullable(),
				afterInDetail: uuidSchema.nullable(),
				// Placement on the tile grid for a column added into a tile-laid-out
				// case list. Top-level because origin's nested column schema is strict
				// and predates the slot.
				tileCell: tileCellSchema.optional(),
			})
			.superRefine((mutation, ctx) => {
				if (mutation.column.tile !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["column", "tile"],
						message:
							"Tile placement must use addColumn.tileCell so the strict pre-deploy column schema can parse the fallback.",
					});
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
				// Tile placement is an independently mergeable slot, like sort: `null`
				// clears the cell, a value sets it. Unlike `sortPatch` there is no
				// agreeing fallback to check — origin's strict column schema has no
				// `tile` key at all, so the nested body stays cell-free and an old
				// receiver simply keeps rendering rows.
				tilePatch: tileCellSchema.nullable().optional(),
				visibilityPatch: z
					.object({
						surface: z.enum(["list", "detail"]),
						visible: z.boolean(),
					})
					.strict()
					.optional(),
			})
			.superRefine((mutation, ctx) => {
				if (mutation.column.tile !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["column", "tile"],
						message:
							"Tile placement must stay out of the strict pre-deploy updateColumn fallback.",
					});
				}
				if (
					mutation.tilePatch !== undefined &&
					(mutation.sortPatch !== undefined ||
						mutation.preserveSort ||
						mutation.preserveVisibility ||
						mutation.visibilityPatch !== undefined)
				) {
					ctx.addIssue({
						code: "custom",
						path: ["tilePatch"],
						message:
							"A tile patch cannot be combined with another updateColumn semantic mode.",
					});
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
		/**
		 * Move a column within ONE surface. Results and Details are independent
		 * sequences, so a move names which one it is reordering; the other is
		 * untouched, which is what lets two authors reorder the two surfaces at
		 * once without either losing the other's change.
		 */
		z.object({
			kind: z.literal("moveColumn"),
			moduleUuid: uuidSchema,
			uuid: uuidSchema,
			surface: z.enum(["list", "detail"]),
			/** The uuid this column now follows, or `null` for first. */
			after: uuidSchema.nullable(),
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
			/** The uuid this input now follows, or `null` for first. */
			after: uuidSchema.nullable(),
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
			// The tile layout is the same kind of non-array case-list metadata as
			// `filter` / `icon` / `audioLabel`, but `patch` is `.strict()` in the
			// pre-deploy schema, so a `patch.tile` key would fail an old parser
			// outright rather than degrade. It therefore rides top-level: an old
			// receiver strips it and applies the (typically empty) patch as a
			// harmless no-op, while the current reducer folds it into the same
			// key-by-key apply, where `null` clears exactly as it does for the
			// other three slots.
			tilePatch: caseTileLayoutSchema.nullable().optional(),
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
			/** The uuid this option now follows, or `null` for first. */
			after: uuidSchema.nullable(),
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
	// Placement is a rule about the untouched envelope, including subtrees that
	// an object arm would otherwise strip. Validate that raw value first, then
	// hand the SAME input to the discriminated union and return only the union's
	// output. Do not express this as an intersection: Zod 4 merges intersection
	// outputs and can accept a nested strict-object failure when the other branch
	// returns the raw or stripped object.
	const rawInputGuardedSchema = prevalidateRawMutationInput(schema);

	return Object.assign(rawInputGuardedSchema, {
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
