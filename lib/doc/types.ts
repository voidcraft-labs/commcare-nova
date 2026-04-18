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
	CONNECT_TYPES,
	caseTypeSchema,
	fieldKinds,
	fieldSchema,
	formSchema,
	moduleSchema,
	uuidSchema,
} from "@/lib/domain";

// ─── Mutation union ────────────────────────────────────────────────────
//
// Every way the doc store can change. Each reducer in `./mutations/*` is
// an exhaustive switch over a subset of these kinds. Zod-validated via
// `mutationSchema` — the TypeScript `Mutation` type is derived from it
// (single source of truth), which lets the event log validate persisted
// mutations at read time without a parallel TS/Zod pair drifting.
//
// The update-*/patch variants use `.omit({ uuid: true }).partial()` on
// the underlying entity schema to express "any subset of mutable
// properties." For `updateField`, the patch validates against any ONE
// of the per-kind field variants (a union of partials, not a discriminated
// union — the patch does NOT carry a `kind` discriminator since the
// reducer merges into an already-existing field whose kind is fixed).

const moduleUpdatePatchSchema = moduleSchema.omit({ uuid: true }).partial();
const formUpdatePatchSchema = formSchema.omit({ uuid: true }).partial();
// Field patch: an arbitrary subset of mutable field properties. The
// `updateField` reducer narrowly validates the merged result against
// `fieldSchema` (the per-kind discriminated union), which is where
// shape enforcement actually lives — so this schema only guarantees
// "it's a plain JSON object with string keys" at the event-log layer.
// Building a Zod union of per-kind partials here would couple the log
// schema to the kind set and push a wider-than-intended object type
// to `Mutation["patch"]` callers; a record of unknown is both simpler
// and honest about the fact that kind-specific validation happens
// later in the pipeline.
const fieldPatchSchema = z.record(z.string(), z.unknown());

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
		newId: z.string(),
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
		newId: z.string(),
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
		newId: z.string(),
	}),
	z.object({ kind: z.literal("duplicateField"), uuid: uuidSchema }),
	z.object({
		kind: z.literal("updateField"),
		uuid: uuidSchema,
		patch: fieldPatchSchema,
	}),
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
	z.object({
		kind: z.literal("setCaseTypes"),
		caseTypes: z.array(caseTypeSchema).nullable(),
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
