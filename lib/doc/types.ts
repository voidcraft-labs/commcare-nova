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

const moduleUpdatePatchSchema = moduleSchema.omit({ uuid: true }).partial();
const formUpdatePatchSchema = formSchema.omit({ uuid: true }).partial();

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
		patch: (typeof fieldPatchSchemaByKind)[K];
	}>;
}[(typeof fieldKinds)[number]];

const updateFieldArms = fieldKinds.map(
	(targetKind) =>
		z.object({
			kind: z.literal("updateField"),
			uuid: uuidSchema,
			targetKind: z.literal(targetKind),
			patch: fieldPatchSchemaByKind[targetKind],
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
		patch: moduleUpdatePatchSchema,
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
		patch: formUpdatePatchSchema,
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
	// Media slots can't ride the generic `updateField` / `updateModule` /
	// `updateForm` patch reducers for a CLEAR. A clear is `{ key: undefined }`,
	// and the SA streams mutations to the client as JSON — `JSON.stringify`
	// DROPS keys whose value is `undefined`, so a clear patch arrives at
	// `applyMany` as `{}` and the reducer's `Object.assign` no-ops, leaving
	// the stale asset ref in the client doc (which then auto-saves back over
	// the SA's correct clear). These kinds carry an explicit on-wire `null`
	// (which survives JSON) and map it to `undefined` INSIDE the reducer, so
	// both set and clear cross the wire intact. Mirrors `setAppLogo`.
	//
	// They are NOT folded into the generic reducers with a "null-means-clear"
	// rule: `setConnectType`'s slot is genuinely `.nullable()` and stores
	// `null` as a real value, so a generic null-as-clear rule would corrupt
	// it. The clear-safe behavior stays scoped to these media-only kinds.
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
