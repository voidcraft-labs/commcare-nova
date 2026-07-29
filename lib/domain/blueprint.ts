// lib/domain/blueprint.ts
//
// The normalized blueprint document — single source of truth for the
// builder's domain state. This is the persisted shape (decomposed into
// per-entity rows and recomposed on load — no nested-tree conversion).
// In-memory representation matches the persisted one, minus the
// `fieldParent` reverse index which is rebuilt from `fieldOrder` on
// load.

import { z } from "zod";
import {
	type CasePropertyDataType,
	casePropertyDataTypeSchema,
	casePropertyDataTypes,
} from "./casePropertyTypes";
import { fieldSchema } from "./fields";
import { formSchema } from "./forms";
import { moduleSchema } from "./modules";
import { mediaAssetIdSchema } from "./multimedia";
import { proseTemplateSchema } from "./prose";
import { ownRecordSchema } from "./records";
import type { ReferenceIndex } from "./referenceIndex";
import { personaSchema, userPropertySchema, userTypeSchema } from "./users";
import { type Uuid, uuidSchema } from "./uuid";
import { xpathExpressionSchema } from "./xpath";

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

export const casePropertySchema = z
	.object({
		name: z.string(),
		label: proseTemplateSchema,
		data_type: casePropertyDataTypeSchema.optional(),
		hint: proseTemplateSchema.optional(),
		required: xpathExpressionSchema.optional(),
		validation: xpathExpressionSchema.optional(),
		validation_msg: proseTemplateSchema.optional(),
		options: z
			.array(
				z.object({ value: z.string(), label: proseTemplateSchema }).strict(),
			)
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
// `uuidSchema` is a transform-free structural string with a compile-time Zod
// brand. Record keys deliberately remain plain strings because JavaScript
// object keys lose value-level brands; ordered UUID values use `uuidSchema`
// below and retain the `Uuid` type.
export const blueprintDocSchema = z
	.object({
		appId: z.string(),
		appName: z.string(),
		connectType: z.enum(CONNECT_TYPES).nullable(),
		caseTypes: z.array(caseTypeSchema).nullable(),

		modules: ownRecordSchema(z.string(), moduleSchema),
		forms: ownRecordSchema(z.string(), formSchema),
		fields: ownRecordSchema(z.string(), fieldSchema),

		moduleOrder: z.array(uuidSchema),
		formOrder: ownRecordSchema(z.string(), z.array(uuidSchema)),
		fieldOrder: ownRecordSchema(z.string(), z.array(uuidSchema)),

		/**
		 * App-level logo for the web-apps surface. A single image —
		 * no audio, no per-language variants — shown on the login
		 * and home screens. Android-only logo slots are out of scope
		 * for Nova's web-apps target.
		 */
		logo: mediaAssetIdSchema.optional(),

		/**
		 * Who runs the app (`./users.ts`): the user-data property catalog,
		 * the user types built on it, and the named preview personas that
		 * act as those types.
		 *
		 * Each is a UUID-keyed record paired with a membership array that IS
		 * its sequence, the same shape `moduleOrder` / `formOrder` use. Both
		 * slots are OPTIONAL and omitted when empty, so an app that declares
		 * none serializes byte-identically to one authored before they
		 * existed. Read them through `userPropertiesOf` / `userTypesOf` /
		 * `personasOf` rather than defaulting at the call site.
		 *
		 * The record and its array cannot silently disagree: `assembleBlueprint`
		 * throws on exactly that mismatch, which is the guard the hierarchical
		 * collections have always relied on.
		 */
		userProperties: ownRecordSchema(z.string(), userPropertySchema).optional(),
		userPropertyOrder: z.array(uuidSchema).optional(),
		userTypes: ownRecordSchema(z.string(), userTypeSchema).optional(),
		userTypeOrder: z.array(uuidSchema).optional(),
		personas: ownRecordSchema(z.string(), personaSchema).optional(),
		personaOrder: z.array(uuidSchema).optional(),

		// fieldParent is NOT persisted — derived from fieldOrder on load.
	})
	.strict();

/**
 * The persisted shape of the blueprint doc.
 *
 * This is the direct Zod-inferred type from `blueprintDocSchema`. It does NOT
 * include `fieldParent` — that field is derived from `fieldOrder` on load and
 * is never stored.
 *
 * Use `BlueprintDoc` for in-memory / store state (includes `fieldParent`);
 * use `PersistableDoc` at persistence read/write boundaries.
 */
export type PersistableDoc = z.infer<typeof blueprintDocSchema>;

/**
 * The blueprint as it crosses the persistence boundary — a
 * `PersistableDoc` PROVABLY free of the in-memory derived state.
 *
 * `BlueprintDoc` is structurally assignable to `PersistableDoc` (extra
 * properties don't break TS assignability), so a writer parameter typed
 * `PersistableDoc` would happily accept an unstripped in-memory doc and
 * serialize `fieldParent` + the reference index into the stored rows. The
 * `never`-typed slots are the compile-time wall: a value whose TYPE
 * declares either property is rejected at the call site, while the
 * output of `toPersistableDoc` (and any Zod-parsed wire payload)
 * passes untouched. Every direct blueprint writer takes this shape, so
 * the strip chokepoint is type-enforced rather than discipline.
 */
export type PersistedBlueprint = PersistableDoc & {
	fieldParent?: never;
	refIndex?: never;
};

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
