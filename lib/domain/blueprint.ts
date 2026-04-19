// lib/domain/blueprint.ts
//
// The normalized blueprint document — single source of truth for the
// builder's domain state. Firestore stores this shape directly (no
// nested-tree conversion). In-memory representation matches on-disk,
// minus the `fieldParent` reverse index which is rebuilt from
// `fieldOrder` on load.

import { z } from "zod";
import { fieldSchema } from "./fields";
import { formSchema } from "./forms";
import { moduleSchema } from "./modules";
import { type Uuid, uuidSchema } from "./uuid";

// Case type schemas — moved verbatim from lib/schemas/blueprint.ts.
const casePropertyMappingSchema = z.object({
	case_property: z.string(),
	question_id: z.string(), // stays "question_id" — CommCare terminology at the boundary
});
export type CasePropertyMapping = z.infer<typeof casePropertyMappingSchema>;

const casePropertySchema = z.object({
	name: z.string(),
	label: z.string(),
	data_type: z
		.enum([
			"text",
			"int",
			"decimal",
			"date",
			"time",
			"datetime",
			"single_select",
			"multi_select",
			"geopoint",
		])
		.optional(),
	hint: z.string().optional(),
	required: z.string().optional(),
	validation: z.string().optional(),
	validation_msg: z.string().optional(),
	options: z
		.array(z.object({ value: z.string(), label: z.string() }))
		.optional(),
});
export type CaseProperty = z.infer<typeof casePropertySchema>;

export const caseTypeSchema = z.object({
	name: z.string(),
	properties: z.array(casePropertySchema),
	parent_type: z.string().optional(),
	relationship: z.enum(["child", "extension"]).optional(),
});
export type CaseType = z.infer<typeof caseTypeSchema>;

export const CONNECT_TYPES = ["learn", "deliver"] as const;
export type ConnectType = (typeof CONNECT_TYPES)[number];

// z.record() in Zod 4 requires an explicit key schema as the first argument.
// We use z.string() rather than uuidSchema here because uuidSchema is a
// ZodEffects (transform), which is not a valid record-key schema. At runtime
// all keys are UUIDs; the branded Uuid type is enforced via the TypeScript
// overlay on BlueprintDoc below.
export const blueprintDocSchema = z.object({
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

	// fieldParent is NOT persisted — derived from fieldOrder on load.
});

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
};
