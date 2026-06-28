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
	caseTypeSchema,
	fieldKinds,
	fieldPatchSchemaByKind,
	fieldSchema,
	formSchema,
	mediaSchema,
	moduleSchema,
	uuidSchema,
} from "@/lib/domain";

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
// an exhaustive switch over a subset of these kinds. Zod-validated via
// `mutationSchema` — the TypeScript `Mutation` type is derived from it
// (single source of truth), which lets the event log validate persisted
// mutations at read time without a parallel TS/Zod pair drifting.
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

const moduleUpdatePatchSchema = clearablePartialPatch(moduleSchema);
const formUpdatePatchSchema = clearablePartialPatch(formSchema);

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
		patch: z.ZodDefault<(typeof fieldPatchSchemaByKind)[K]>;
	}>;
}[(typeof fieldKinds)[number]];

const updateFieldArms = fieldKinds.map(
	(targetKind) =>
		z.object({
			kind: z.literal("updateField"),
			uuid: uuidSchema,
			targetKind: z.literal(targetKind),
			// `patch` defaults to `{}` when it is absent on read. A field
			// clear travels as an explicit `null` value (which survives
			// Firestore), so a normal clear-only edit produces a NON-empty
			// patch and never needs this default. The default exists for a
			// patch that is genuinely empty on the wire: a degenerate
			// no-property update, or a legacy event written before clears
			// carried `null` — back then a clear lowered to an all-`undefined`
			// patch that `ignoreUndefinedProperties` stripped to an empty map,
			// which Firestore omits from the document entirely. Defaulting to
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
			patch: (fieldPatchSchemaByKind[targetKind] as z.ZodTypeAny).default(
				() => ({}),
			),
		}) as UpdateFieldArm,
) as [UpdateFieldArm, ...UpdateFieldArm[]];

export const mutationSchema = z.discriminatedUnion("kind", [
	// Module
	z.object({
		kind: z.literal("addModule"),
		module: moduleSchema,
		index: z.number().int().nonnegative().optional(),
	}),
	z.object({ kind: z.literal("removeModule"), uuid: uuidSchema }),
	z.object({
		kind: z.literal("moveModule"),
		uuid: uuidSchema,
		toIndex: z.number().int().nonnegative(),
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
	z.object({
		kind: z.literal("updateModule"),
		uuid: uuidSchema,
		// A clear carries an explicit `null` (the clearable slots are
		// nullable — see `clearablePartialPatch`), so a clear-only edit is a
		// NON-empty patch that round-trips intact. The `{}` default exists for
		// a genuinely-empty patch: a degenerate no-property update, or a legacy
		// event written before clears carried `null` (then a clear lowered to
		// an all-`undefined` patch that `ignoreUndefinedProperties` stripped to
		// an empty, document-omitted map). See `updateFieldArms`.
		patch: moduleUpdatePatchSchema.default(() => ({})),
	}),
	// Form
	z.object({
		kind: z.literal("addForm"),
		moduleUuid: uuidSchema,
		form: formSchema,
		index: z.number().int().nonnegative().optional(),
	}),
	z.object({ kind: z.literal("removeForm"), uuid: uuidSchema }),
	z.object({
		kind: z.literal("moveForm"),
		uuid: uuidSchema,
		toModuleUuid: uuidSchema,
		toIndex: z.number().int().nonnegative(),
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
		patch: formUpdatePatchSchema.default(() => ({})),
	}),
	// Field
	z.object({
		kind: z.literal("addField"),
		parentUuid: uuidSchema,
		field: fieldSchema,
		index: z.number().int().nonnegative().optional(),
	}),
	z.object({ kind: z.literal("removeField"), uuid: uuidSchema }),
	z.object({
		kind: z.literal("moveField"),
		uuid: uuidSchema,
		toParentUuid: uuidSchema,
		toIndex: z.number().int().nonnegative(),
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

export type Mutation = z.infer<typeof mutationSchema>;

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
