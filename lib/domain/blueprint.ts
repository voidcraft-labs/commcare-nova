// lib/domain/blueprint.ts
//
// The normalized blueprint document — single source of truth for the
// builder's domain state. Firestore stores this shape directly (no
// nested-tree conversion). In-memory representation matches on-disk,
// minus the `fieldParent` reverse index which is rebuilt from
// `fieldOrder` on load.

import { z } from "zod";
import {
	type CasePropertyDataType,
	casePropertyDataTypeSchema,
	casePropertyDataTypes,
} from "./casePropertyTypes";
import { fieldSchema } from "./fields";
import { formSchema } from "./forms";
import { moduleSchema } from "./modules";
import { assetIdSchema } from "./multimedia";
import type { ReferenceIndex } from "./referenceIndex";
import { type Uuid, uuidSchema } from "./uuid";

// Re-exports — `casePropertyDataTypes` / `CasePropertyDataType` /
// `casePropertyDataTypeSchema` live at the leaf
// `./casePropertyTypes` so the predicate AST + the structured
// `Module` schema can pull them without a cycle through the rest
// of the case-type definitions in this file. Surfaced from the
// blueprint barrel so existing `@/lib/domain` consumers see the
// same names without an import-path migration.
export {
	type CasePropertyDataType,
	casePropertyDataTypeSchema,
	casePropertyDataTypes,
};

// Case type schemas — moved verbatim from lib/schemas/blueprint.ts.
//
// NOTE: this struct's `case_property` slot holds a case PROPERTY NAME (the
// derived form-action mapping's case-side key — e.g. "name", "dob"). It
// is NOT the field-level `case_property_on` pointer (case TYPE this field
// writes to) on `inputFieldBaseSchema`. The two share the word "case
// property" but model different things; keep the name `case_property`
// here because the value IS a case property name. The matching field-side
// pointer carries the `_on` suffix to force the prepositional reading.
const casePropertyMappingSchema = z
	.object({
		case_property: z.string(),
		question_id: z.string(), // stays "question_id" — CommCare terminology at the boundary
	})
	.strict();
export type CasePropertyMapping = z.infer<typeof casePropertyMappingSchema>;

const casePropertySchema = z
	.object({
		name: z.string(),
		label: z.string(),
		data_type: casePropertyDataTypeSchema.optional(),
		hint: z.string().optional(),
		required: z.string().optional(),
		validation: z.string().optional(),
		validation_msg: z.string().optional(),
		options: z
			.array(z.object({ value: z.string(), label: z.string() }).strict())
			.optional(),
	})
	.strict();
export type CaseProperty = z.infer<typeof casePropertySchema>;

export const caseTypeSchema = z
	.object({
		name: z.string(),
		properties: z.array(casePropertySchema),
		parent_type: z.string().optional(),
		relationship: z.enum(["child", "extension"]).optional(),
	})
	.strict();
export type CaseType = z.infer<typeof caseTypeSchema>;

export const CONNECT_TYPES = ["learn", "deliver"] as const;
export type ConnectType = (typeof CONNECT_TYPES)[number];

// z.record() in Zod 4 requires an explicit key schema as the first argument.
// We use z.string() rather than uuidSchema here because uuidSchema is a
// ZodEffects (transform), which is not a valid record-key schema. At runtime
// all keys are UUIDs; the branded Uuid type is enforced via the TypeScript
// overlay on BlueprintDoc below.
export const blueprintDocSchema = z
	.object({
		appId: z.string(),
		appName: z.string(),
		connectType: z.enum(CONNECT_TYPES).nullable(),
		caseTypes: z.array(caseTypeSchema).nullable(),

		modules: z.record(z.string(), moduleSchema),
		forms: z.record(z.string(), formSchema),
		fields: z.record(z.string(), fieldSchema),

		moduleOrder: z.array(uuidSchema),
		formOrder: z.record(z.string(), z.array(uuidSchema)),
		fieldOrder: z.record(z.string(), z.array(uuidSchema)),

		/**
		 * App-level logo for the web-apps surface. A single image —
		 * no audio, no per-language variants — shown on the login
		 * and home screens. Android-only logo slots are out of scope
		 * for Nova's web-apps target.
		 */
		logo: assetIdSchema.optional(),

		// fieldParent is NOT persisted — derived from fieldOrder on load.
	})
	.strict();

/**
 * The on-disk (Firestore-persisted) shape of the blueprint doc.
 *
 * This is the direct Zod-inferred type from `blueprintDocSchema`. It does NOT
 * include `fieldParent` — that field is derived from `fieldOrder` on load and
 * is never stored.
 *
 * Use `BlueprintDoc` for in-memory / store state (includes `fieldParent`);
 * use `PersistableDoc` at Firestore read/write boundaries.
 */
export type PersistableDoc = z.infer<typeof blueprintDocSchema>;

export type BlueprintDoc = PersistableDoc & {
	/** Reverse index: field uuid → parent uuid (form or container). Maintained
	 *  atomically by every mutation that touches fieldOrder. Rebuilt by
	 *  rebuildFieldParent() on load. Not persisted. */
	fieldParent: Record<Uuid, Uuid | null>;
	/**
	 * The reference + declarations index (`lib/domain/referenceIndex.ts`)
	 * — derived state, never persisted. Seeded by every apply entry
	 * point (`lib/doc/mutations`' `applyMutation(s)` build it on first
	 * contact) and by the hydration boundaries (`store.load`, the MCP
	 * blueprint load, the chat route's working doc), then maintained
	 * incrementally per mutation. Optional so the many read-only
	 * `PersistableDoc → BlueprintDoc` widenings (compile, upload,
	 * preview) stay valid without paying a build they never read;
	 * reference operations go through `lib/doc/referenceIndex.ts`'s
	 * accessor, which falls back to a fresh build when the slot is
	 * absent.
	 */
	refIndex?: ReferenceIndex;
};
