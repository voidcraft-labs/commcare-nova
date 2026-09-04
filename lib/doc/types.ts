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
	appLanguageIdentitySchema,
	authoredCasePropertyNameSchema,
	automationAlertCriterionSchema,
	automationCaseUpdateCriterionSchema,
	automationCaseUpdateSchema,
	automationImmediateEventSchema,
	automationRecipientSchema,
	automationScheduleSchema,
	automationSchema,
	automationSetupOnlyCriterionSchema,
	automationTimedEventSchema,
	automationUserDataFilterSchema,
	CONNECT_TYPES,
	type Column,
	caseOperationSchema,
	casePropertySchema,
	caseSearchConfigSchema,
	caseSelectionSchema,
	caseTileLayoutSchema,
	columnSchema,
	columnSortSchema,
	fieldKinds,
	fieldPatchSchemaByKind,
	fieldSchema,
	formIconRefSchema,
	formLinkObjectSchema,
	formLinkSchema,
	formSchema,
	languageTagSchema,
	localizedValueSchema,
	locationPropertySchema,
	mediaAssetIdSchema,
	mediaSchema,
	moduleIconRefSchema,
	moduleSchema,
	ordinaryCaseSearchConfigSchema,
	organizationLevelSchema,
	ownerOnlyCaseSearchConfigSchema,
	personaSchema,
	type SearchInputDef,
	searchInputDefSchema,
	selectOptionSchema,
	selectOptionsSourceSchema,
	tileCellSchema,
	translationEntrySchema,
	translationUnitIdSchema,
	uniqueFormLinkDatumNames,
	userPropertySchema,
	userTypeSchema,
	uuidSchema,
} from "@/lib/domain";
import { predicateSchema } from "@/lib/domain/predicate";

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
// an exhaustive switch over a subset of these kinds. `mutationSchema` is the
// one canonical envelope used by every editor, durable log, stream, diff,
// undo, and replay boundary.
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
	return z.object(shape).partial().strict() as unknown as z.ZodObject<{
		[K in Exclude<keyof S, "uuid">]: z.ZodOptional<z.ZodNullable<S[K]>>;
	}>;
}

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
		z.object({ operation: z.literal("remove"), uuid: uuidSchema }).strict(),
	]);
}

/**
 * Final granular edit for an established case operation.
 *
 * Adds and removals use `caseOperationChange`; every edit to an existing
 * operation uses this identity-keyed union. There is no paired whole-operation
 * fallback; every reader consumes this one payload.
 */
function caseOperationPatchSchemaFor(
	operationValueSchema: typeof caseOperationSchema,
) {
	// Identity and destination action are represented once on the outer update
	// arm. Writes and links have their own keyed merge units.
	const createOperationPatchSchema = clearablePartialPatch(
		operationValueSchema.options[0],
	)
		.omit({ action: true, writes: true, links: true })
		.strict();
	const updateOperationPatchSchema = clearablePartialPatch(
		operationValueSchema.options[1],
	)
		.omit({ action: true, writes: true, links: true })
		.strict();
	const closeOperationPatchSchema = clearablePartialPatch(
		operationValueSchema.options[2],
	)
		.omit({ action: true, writes: true, links: true })
		.strict();
	const operationUpdateSchema = z.discriminatedUnion("targetAction", [
		z
			.object({
				operation: z.literal("update"),
				uuid: uuidSchema,
				targetAction: operationValueSchema.options[0].shape.action,
				patch: createOperationPatchSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("update"),
				uuid: uuidSchema,
				targetAction: operationValueSchema.options[1].shape.action,
				patch: updateOperationPatchSchema,
			})
			.strict(),
		z
			.object({
				operation: z.literal("update"),
				uuid: uuidSchema,
				targetAction: operationValueSchema.options[2].shape.action,
				patch: closeOperationPatchSchema,
			})
			.strict(),
	]);
	const writeSchema =
		operationValueSchema.options[0].shape.writes.unwrap().element;
	const writePatchSchema = z
		.object({
			value: writeSchema.shape.value.optional(),
			condition: writeSchema.shape.condition.unwrap().nullable().optional(),
		})
		.strict()
		.refine((patch) => Object.keys(patch).length > 0, {
			message: "A case-operation write patch must change at least one slot.",
		});
	const linkSchema =
		operationValueSchema.options[0].shape.links.unwrap().element;
	const linkPatchSchema = linkSchema
		.omit({ identifier: true })
		.partial()
		.strict()
		.refine((patch) => Object.keys(patch).length > 0, {
			message: "A case-operation link patch must change at least one slot.",
		});
	return z.discriminatedUnion("operation", [
		operationUpdateSchema,
		z
			.object({
				operation: z.literal("add-write"),
				uuid: uuidSchema,
				value: writeSchema,
				/** Logical predecessor in this operation's write collection.
				 * `null` means first; omission means intentional append. */
				after: writeSchema.shape.property.nullable().optional(),
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
				operation: z.literal("move-write"),
				uuid: uuidSchema,
				property: writeSchema.shape.property,
				after: writeSchema.shape.property.nullable(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("add-link"),
				uuid: uuidSchema,
				value: linkSchema,
				/** Logical predecessor in this operation's link collection.
				 * `null` means first; omission means intentional append. */
				after: linkSchema.shape.identifier.nullable().optional(),
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
				operation: z.literal("move-link"),
				uuid: uuidSchema,
				identifier: linkSchema.shape.identifier,
				after: linkSchema.shape.identifier.nullable(),
			})
			.strict(),
		z
			.object({
				operation: z.literal("move"),
				uuid: uuidSchema,
				/**
				 * The uuid this operation now follows, or `null` for first.
				 *
				 * The anchor is the whole placement — there is no separate rank for
				 * the authoritative writer to fence. A placement named by a
				 * neighbouring uuid cannot be shifted by a peer: the anchor either
				 * still exists, or it does not and the move appends.
				 */
				after: uuidSchema.nullable(),
			})
			.strict(),
	]);
}

function caseSearchConfigPatchSchemaFor(
	configSchema: typeof ordinaryCaseSearchConfigSchema,
) {
	return z
		.object({
			excludedOwnerIds: configSchema.shape.excludedOwnerIds.nullable(),
			searchScreenTitle: configSchema.shape.searchScreenTitle.nullable(),
			searchScreenSubtitle: configSchema.shape.searchScreenSubtitle.nullable(),
			searchButtonLabel: configSchema.shape.searchButtonLabel.nullable(),
			searchButtonDisplayCondition:
				configSchema.shape.searchButtonDisplayCondition.nullable(),
			searchFirst: configSchema.shape.searchFirst.nullable(),
		})
		.partial()
		.strict();
}

// Every clearable slot is null-as-delete-safe: an absent `required` is not
// required, an absent `choices` is free text, an absent `description` is none,
// an absent `userTypeUuid` is no role, and an
// absent `values` bag is read as empty by `userTypesOf` / `personasOf`'s
// consumers. The required slots (`slug`, `label`, `name`) stay
// non-nullable, so a stray `null` for one is a parse error rather than a
// corrupting assign.
const userPropertyUpdatePatchSchema = clearablePartialPatch(userPropertySchema);
const userTypeUpdatePatchSchema = clearablePartialPatch(userTypeSchema);
const personaUpdatePatchSchema = clearablePartialPatch(personaSchema);
const userTypeEntityUpdatePatchSchema = userTypeUpdatePatchSchema.omit({
	values: true,
});
const personaEntityUpdatePatchSchema = personaUpdatePatchSchema.omit({
	values: true,
});
const organizationLevelUpdatePatchSchema = clearablePartialPatch(
	organizationLevelSchema,
)
	.omit({
		code: true,
	})
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "Change at least one organization-level field.",
	});
const locationPropertyUpdatePatchSchema = clearablePartialPatch(
	locationPropertySchema,
).refine((patch) => Object.keys(patch).length > 0, {
	message: "Change at least one location-property field.",
});

const automationCaseUpdatePatchSchema = z
	.object({
		name: automationSchema.options[0].shape.name.optional(),
		caseType: automationSchema.options[0].shape.caseType.optional(),
		criteriaOperator:
			automationSchema.options[0].shape.criteriaOperator.optional(),
		serverModifiedBoundaryDays:
			automationSchema.options[0].shape.serverModifiedBoundaryDays.nullable(),
		closeCase: automationSchema.options[0].shape.closeCase.optional(),
	})
	.partial()
	.strict()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "Change at least one automation field.",
	});

const alertShape = automationSchema.options[1].shape;
const automationAlertUpdatePatchSchema = z
	.object({
		name: alertShape.name.optional(),
		caseType: alertShape.caseType.optional(),
		criteriaOperator: alertShape.criteriaOperator.optional(),
		includeDescendantLocations:
			alertShape.includeDescendantLocations.optional(),
		locationLevelUuids: alertShape.locationLevelUuids.optional(),
		defaultLanguageCode: alertShape.defaultLanguageCode.nullable(),
		useUserCaseForFilter: alertShape.useUserCaseForFilter.optional(),
		resetCaseProperty: alertShape.resetCaseProperty.nullable(),
		stopDateCaseProperty: alertShape.stopDateCaseProperty.nullable(),
	})
	.partial()
	.strict()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "Change at least one automation field.",
	});

function automationItemEditSchemas<
	C extends string,
	S extends z.ZodType<{ uuid: z.infer<typeof uuidSchema> }>,
>(collection: C, valueSchema: S) {
	return [
		z
			.object({
				collection: z.literal(collection),
				operation: z.literal("add"),
				value: valueSchema,
				after: uuidSchema.nullable().optional(),
			})
			.strict(),
		z
			.object({
				collection: z.literal(collection),
				operation: z.literal("update"),
				value: valueSchema,
			})
			.strict(),
		z
			.object({
				collection: z.literal(collection),
				operation: z.literal("remove"),
				uuid: uuidSchema,
			})
			.strict(),
		z
			.object({
				collection: z.literal(collection),
				operation: z.literal("move"),
				uuid: uuidSchema,
				after: uuidSchema.nullable(),
			})
			.strict(),
	] as const;
}

const caseUpdateAutomationItemEditSchema = z.union([
	...automationItemEditSchemas(
		"criterion",
		automationCaseUpdateCriterionSchema,
	),
	...automationItemEditSchemas(
		"setup-only-criterion",
		automationSetupOnlyCriterionSchema,
	),
	...automationItemEditSchemas("update", automationCaseUpdateSchema),
]);

const alertAutomationItemEditSchema = z.union([
	...automationItemEditSchemas("criterion", automationAlertCriterionSchema),
	...automationItemEditSchemas(
		"setup-only-criterion",
		automationSetupOnlyCriterionSchema,
	),
	...automationItemEditSchemas("recipient", automationRecipientSchema),
	...automationItemEditSchemas(
		"immediate-event",
		automationImmediateEventSchema,
	),
	...automationItemEditSchemas("timed-event", automationTimedEventSchema),
	...automationItemEditSchemas(
		"user-data-filter",
		automationUserDataFilterSchema,
	),
]);
const userDataValuePatchSchema = z
	.object({
		userPropertyUuid: uuidSchema,
		/** `null` is the JSON-stable spelling of removing one authored value. */
		value: z.string().nullable(),
	})
	.strict();

const canonicalModuleUpdatePatchSchema = clearablePartialPatch(moduleSchema)
	.omit({
		id: true,
		name: true,
		parentModuleUuid: true,
		caseListConfig: true,
		caseSearchConfig: true,
		icon: true,
		audioLabel: true,
	})
	.extend({
		/** Whole config snapshots have granular owners. These null-only slots are
		 * the direct structural teardown payloads. */
		caseListConfig: z.null().optional(),
		caseSearchConfig: z.null().optional(),
	});
const canonicalFormUpdatePatchSchema = clearablePartialPatch(formSchema).omit({
	id: true,
	name: true,
	caseOperations: true,
	// Links are entities with their own four kinds below; a whole-array
	// replacement would erase identity and never survives the wire.
	formLinks: true,
	icon: true,
	audioLabel: true,
});
/**
 * Granular edit of one established after-submit link, addressed by uuid.
 * `target` is required on a link so it replaces rather than clears;
 * `condition` and `datums` clear with `null`. The datum-uniqueness rule is
 * the same one the link schema applies.
 */
const canonicalFormLinkPatchSchema = clearablePartialPatch(formLinkObjectSchema)
	.strict()
	.superRefine((patch, ctx) => {
		if (Object.keys(patch).length === 0) {
			ctx.addIssue({
				code: "custom",
				message:
					"A form link update changes at least one of condition, target, or datums.",
			});
		}
		uniqueFormLinkDatumNames(patch.datums, ctx);
	});
const canonicalCaseOperationChangeSchema =
	caseOperationChangeSchemaFor(caseOperationSchema);
const canonicalCaseOperationPatchSchema =
	caseOperationPatchSchemaFor(caseOperationSchema);
const canonicalCaseSearchConfigPatchSchema = caseSearchConfigPatchSchemaFor(
	ordinaryCaseSearchConfigSchema,
);

type WithoutColumnFacets<T> = T extends Column
	? Omit<T, "uuid" | "sort" | "tile" | "visibleInList" | "visibleInDetail">
	: never;
type ColumnContent = WithoutColumnFacets<Column>;

const columnContentSchema = z.discriminatedUnion(
	"kind",
	columnSchema.options.map((arm) =>
		(arm as z.ZodObject<z.ZodRawShape>).omit({
			uuid: true,
			sort: true,
			tile: true,
			visibleInList: true,
			visibleInDetail: true,
		}),
	) as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]],
) as unknown as z.ZodType<ColumnContent>;

type SearchInputContent = SearchInputDef extends infer T
	? T extends SearchInputDef
		? Omit<T, "uuid">
		: never
	: never;

/**
 * The UUID-omitted projection of the domain's exact seven-arm Search-input
 * union.
 *
 * `kind` alone is deliberately not a discriminator here: both `simple` and
 * `advanced` each have a scalar-widget arm, a date-range arm, and a choice arm
 * (the hidden arm stands alone). The widget
 * split is structural (date-range owns range mode and cannot own a scalar
 * default), so collapsing those pairs to make `kind` unique would weaken the
 * final stored shape. Keep the mutation projection as the same strict union
 * the domain owns.
 */
const searchInputContentSchema = z.union(
	searchInputDefSchema.options.map((arm) =>
		(arm as z.ZodObject<z.ZodRawShape>).omit({ uuid: true }),
	) as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]],
) as unknown as z.ZodType<SearchInputContent>;

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
		patch: (typeof updateFieldPatchSchemaByKind)[K];
	}>;
}[(typeof fieldKinds)[number]];

/**
 * A field id is mutable through `updateField`, but it is never clearable.
 * Override the domain partial's generic nullable slot here so the canonical
 * mutation envelope rejects both `null` and the empty string.
 */
function fieldPatchWithValidId<S extends z.ZodRawShape>(
	schema: z.ZodObject<S>,
) {
	return schema.extend({ id: z.string().min(1).optional() });
}

const updateFieldPatchSchemaByKind = {
	text: fieldPatchWithValidId(fieldPatchSchemaByKind.text),
	int: fieldPatchWithValidId(fieldPatchSchemaByKind.int),
	decimal: fieldPatchWithValidId(fieldPatchSchemaByKind.decimal),
	date: fieldPatchWithValidId(fieldPatchSchemaByKind.date),
	time: fieldPatchWithValidId(fieldPatchSchemaByKind.time),
	datetime: fieldPatchWithValidId(fieldPatchSchemaByKind.datetime),
	single_select: fieldPatchWithValidId(fieldPatchSchemaByKind.single_select),
	multi_select: fieldPatchWithValidId(fieldPatchSchemaByKind.multi_select),
	geopoint: fieldPatchWithValidId(fieldPatchSchemaByKind.geopoint),
	image: fieldPatchWithValidId(fieldPatchSchemaByKind.image),
	audio: fieldPatchWithValidId(fieldPatchSchemaByKind.audio),
	video: fieldPatchWithValidId(fieldPatchSchemaByKind.video),
	file: fieldPatchWithValidId(fieldPatchSchemaByKind.file),
	barcode: fieldPatchWithValidId(fieldPatchSchemaByKind.barcode),
	signature: fieldPatchWithValidId(fieldPatchSchemaByKind.signature),
	label: fieldPatchWithValidId(fieldPatchSchemaByKind.label),
	hidden: fieldPatchWithValidId(fieldPatchSchemaByKind.hidden),
	secret: fieldPatchWithValidId(fieldPatchSchemaByKind.secret),
	group: fieldPatchWithValidId(fieldPatchSchemaByKind.group),
	section: fieldPatchWithValidId(fieldPatchSchemaByKind.section),
	repeat: z.union([
		fieldPatchWithValidId(fieldPatchSchemaByKind.repeat.options[0]),
		fieldPatchWithValidId(fieldPatchSchemaByKind.repeat.options[1]),
		fieldPatchWithValidId(fieldPatchSchemaByKind.repeat.options[2]),
	]),
} as const;

const updateFieldArms = fieldKinds.map(
	(targetKind) =>
		z
			.object({
				kind: z.literal("updateField"),
				uuid: uuidSchema,
				targetKind: z.literal(targetKind),
				// A final update always carries its patch.
				patch: updateFieldPatchSchemaByKind[targetKind],
			})
			.strict() as unknown as UpdateFieldArm,
) as [UpdateFieldArm, ...UpdateFieldArm[]];

const finalMutationFamily = {
	module: moduleSchema,
	moduleUpdatePatch: canonicalModuleUpdatePatchSchema,
	caseSearchConfig: caseSearchConfigSchema,
	caseSearchConfigPatch: canonicalCaseSearchConfigPatchSchema,
	form: formSchema,
	formUpdatePatch: canonicalFormUpdatePatchSchema,
	caseOperationChange: canonicalCaseOperationChangeSchema,
	caseOperationPatch: canonicalCaseOperationPatchSchema,
	formLink: formLinkSchema,
	formLinkPatch: canonicalFormLinkPatchSchema,
	column: columnSchema,
	searchInput: searchInputDefSchema,
	predicate: predicateSchema,
} as const;

type MutationSchemaFamily = typeof finalMutationFamily;

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
			"This update also sets the case operation's uuid. An operation's identity is fixed when it is created, so an update can change what the operation does but never which operation it is. Address the operation by its existing uuid and leave that slot out of the patch.",
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
 * equality assertions in `mutationEnvelopeStrictness.test.ts` lock the final
 * mutation schema to its direct discriminated union.
 */
function prevalidateRawMutationInput<Schema extends z.ZodType>(
	schema: Schema,
): z.ZodType<z.output<Schema>, z.input<Schema>> {
	const guarded = z.preprocess<z.input<Schema>, Schema, z.input<Schema>>(
		(value, ctx) => {
			reportImmutableCaseOperationIdentity(value, ctx);
			return value;
		},
		schema,
	);
	return guarded as z.ZodType<z.output<Schema>, z.input<Schema>>;
}

function createMutationSchema({
	module: mutationModuleSchema,
	moduleUpdatePatch: mutationModuleUpdatePatchSchema,
	caseSearchConfigPatch: mutationCaseSearchConfigPatchSchema,
	form: mutationFormSchema,
	formUpdatePatch: mutationFormUpdatePatchSchema,
	caseOperationChange: mutationCaseOperationChangeSchema,
	caseOperationPatch: mutationCaseOperationPatchSchema,
	formLink: mutationFormLinkSchema,
	formLinkPatch: mutationFormLinkPatchSchema,
	column: mutationColumnSchema,
	searchInput: mutationSearchInputSchema,
	predicate: mutationPredicateSchema,
}: MutationSchemaFamily) {
	const mutationArms = [
		// Module
		z.object({
			kind: z.literal("addModule"),
			module: mutationModuleSchema,
			/** The module this one now follows, or `null` for first. Absent
			 *  appends — the common case, and distinct from `null` so "add at
			 *  the top" stays expressible across the JSON wire. */
			after: uuidSchema.nullable().optional(),
		}),
		z.object({ kind: z.literal("removeModule"), uuid: uuidSchema }),
		// A move carries an ANCHOR — the module it now follows — not a position.
		// A position is computed against the sequence its author could see, so
		// two people moving from one document compute the same one; an anchor
		// cannot be shifted by a peer's insert. A peer-removed anchor rejects at
		// live admission; replay leaves the sequence unchanged.
		z.object({
			kind: z.literal("moveModule"),
			uuid: uuidSchema,
			/** Omission preserves the current sibling group, null makes this a
			 * root, and a UUID reparents it under that root module. */
			parentModuleUuid: uuidSchema.nullable().optional(),
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
				patch: mutationModuleUpdatePatchSchema,
				ensureCaseListConfig: z.literal(true).optional(),
				caseSearchConfigOperation: z
					.enum([
						"enable",
						"disable-if-unused",
						"remove-if-no-authored-settings",
						"cleanup-after-final-input",
						"set-owner-only",
					])
					.optional(),
				caseSearchConfigValue: ownerOnlyCaseSearchConfigSchema.optional(),
				caseSearchConfigPatch: mutationCaseSearchConfigPatchSchema.optional(),
			})
			.superRefine((mutation, ctx) => {
				if (
					mutation.ensureCaseListConfig &&
					Object.hasOwn(mutation.patch, "caseListConfig")
				) {
					ctx.addIssue({
						code: "custom",
						path: ["patch", "caseListConfig"],
						message:
							"A case-list ensure is its complete payload and cannot carry a duplicate config snapshot.",
					});
				}
				const operation = mutation.caseSearchConfigOperation;
				const semanticPatch = mutation.caseSearchConfigPatch;
				const ownsCaseSearchPayload =
					operation !== undefined || semanticPatch !== undefined;
				if (
					ownsCaseSearchPayload &&
					Object.hasOwn(mutation.patch, "caseSearchConfig")
				) {
					ctx.addIssue({
						code: "custom",
						path: ["patch", "caseSearchConfig"],
						message:
							"A Search semantic edit is its complete payload and cannot carry a duplicate whole-config patch.",
					});
				}
				if (semanticPatch !== undefined) {
					if (Object.keys(semanticPatch).length === 0) {
						ctx.addIssue({
							code: "custom",
							path: ["caseSearchConfigPatch"],
							message: "A semantic Search settings patch cannot be empty.",
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
				if (operation === "set-owner-only") {
					if (mutation.caseSearchConfigValue === undefined) {
						ctx.addIssue({
							code: "custom",
							path: ["caseSearchConfigValue"],
							message:
								"An owner-only Search operation must carry the desired disabled assigned-case config.",
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
			/** The form this one now follows within the module, or `null` for
			 *  first. Absent appends. */
			after: uuidSchema.nullable().optional(),
		}),
		z.object({ kind: z.literal("removeForm"), uuid: uuidSchema }),
		// A same-module reorder splices within the module's membership array; a
		// cross-module move splices into the destination's.
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
				patch: mutationFormUpdatePatchSchema,
				caseOperationChange: mutationCaseOperationChangeSchema.optional(),
				caseOperationPatch: mutationCaseOperationPatchSchema.optional(),
			})
			.superRefine((mutation, ctx) => {
				if (
					mutation.caseOperationChange !== undefined &&
					mutation.caseOperationPatch !== undefined
				) {
					ctx.addIssue({
						code: "custom",
						path: ["caseOperationPatch"],
						message: "A case-operation event carries one final change payload.",
					});
				}
			}),
		// After-submit links: form-owned entities whose array position is the
		// sequence, so add and move both say "after this link" (`null` first,
		// absent appends), exactly like Search inputs.
		z
			.object({
				kind: z.literal("addFormLink"),
				formUuid: uuidSchema,
				link: mutationFormLinkSchema,
				/** The link this one now follows; `null` first, absent appends. */
				after: uuidSchema.nullable().optional(),
			})
			.strict(),
		z
			.object({
				kind: z.literal("updateFormLink"),
				formUuid: uuidSchema,
				uuid: uuidSchema,
				patch: mutationFormLinkPatchSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal("removeFormLink"),
				formUuid: uuidSchema,
				uuid: uuidSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal("moveFormLink"),
				formUuid: uuidSchema,
				uuid: uuidSchema,
				/** The link this one now follows, or `null` for first. */
				after: uuidSchema.nullable(),
			})
			.strict(),
		// Field
		z
			.object({
				kind: z.literal("addField"),
				parentUuid: uuidSchema,
				field: fieldSchema,
				/** The sibling this field follows under `parentUuid`, or `null` for
				 *  first. Absent appends — the common case, and distinct from `null`
				 *  so "add at the top" stays expressible. */
				after: uuidSchema.nullable().optional(),
			})
			.strict(),
		z.object({ kind: z.literal("removeField"), uuid: uuidSchema }),
		// A same-parent reorder splices the field to a new position in its
		// parent's membership array; a cross-parent move splices it into the
		// destination's array and re-anchors references.
		z.object({
			kind: z.literal("moveField"),
			uuid: uuidSchema,
			toParentUuid: uuidSchema,
			/** The uuid this field now follows under the target parent, or `null`
			 *  for first. A cross-parent move names a sibling in the DESTINATION. */
			after: uuidSchema.nullable(),
		}),
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
			// reducer's reconcile would otherwise always fail. UUIDs are minted
			// at the batch-building layer so the reducer stays deterministic for
			// replay and peers. Ignored when the target kind has no options slot.
			optionsSource: selectOptionsSourceSchema.optional(),
		}),
		// App-level
		z.object({ kind: z.literal("setAppName"), name: z.string() }),
		z.object({
			kind: z.literal("setConnectType"),
			connectType: z.enum(CONNECT_TYPES).nullable(),
		}),
		// `logo` is `mediaAssetIdSchema.optional()` on the doc — there is no
		// stored `null`. The payload is `.nullable()` (not optional) so the
		// mutation always carries an explicit intent: an asset id sets the
		// logo, `null` clears it. The reducer maps `null → undefined` so the
		// cleared key drops off the doc rather than persisting as a literal
		// `null` the schema would reject. Distinct from `setConnectType`,
		// whose `connectType` slot is genuinely `.nullable()` and stores the
		// `null` verbatim.
		z.object({
			kind: z.literal("setAppLogo"),
			logo: mediaAssetIdSchema.nullable(),
		}),
		// App language identity and translation overlays. The canonical source
		// strings remain on their owning Blueprint entities; these commands edit
		// only the language catalog and target-language values. Identity-adding
		// kinds carry the structured identity object; reference kinds carry the
		// canonical tag it serializes to (`languageTag(identity)`).
		z.object({
			kind: z.literal("relabelSourceLanguage"),
			language: appLanguageIdentitySchema,
		}),
		z.object({
			kind: z.literal("addLanguage"),
			language: appLanguageIdentitySchema,
		}),
		z.object({ kind: z.literal("removeLanguage"), code: languageTagSchema }),
		z.object({
			kind: z.literal("setDefaultLanguage"),
			code: languageTagSchema,
		}),
		z.object({
			kind: z.literal("setTranslation"),
			language: languageTagSchema,
			unitId: translationUnitIdSchema,
			entry: translationEntrySchema.nullable(),
		}),
		z.object({
			kind: z.literal("reviewTranslation"),
			language: languageTagSchema,
			unitId: translationUnitIdSchema,
			expectedSourceFingerprint: z.string().min(1),
			sourceFingerprint: z.string().min(1),
			value: localizedValueSchema,
		}),
		// A case-property rename is an app-wide semantic operation, not a
		// field-id patch. Its batch is required to be exclusive at the admitted
		// batch boundary so the complete simultaneous relation is one durable,
		// invertible command.
		z.object({
			kind: z.literal("renameCaseProperties"),
			renames: z
				.array(
					z
						.object({
							caseType: z.string().min(1),
							from: authoredCasePropertyNameSchema,
							to: authoredCasePropertyNameSchema,
						})
						.strict(),
				)
				.min(1),
		}),
		// ─── Granular case-type catalog ──────────────────────────────────────
		//
		// The catalog is keyed by `(case-type name, property name)`. These
		// fine-grained kinds let two members concurrently declare a type / add a
		// property / edit a property and merge by construction. There is no
		// whole-catalog mutation in the post-horizon dialect. Each
		// `setCaseTypeMeta` slot is nullable so a clear (`parent_type` /
		// `relationship`) crosses the JSON wire as an explicit `null`; the reducer
		// maps `null → delete`.
		z.object({ kind: z.literal("declareCaseType"), caseType: z.string() }),
		z.object({ kind: z.literal("retireCaseType"), caseType: z.string() }),
		z.object({
			kind: z.literal("addCaseProperty"),
			caseType: z.string(),
			property: casePropertySchema,
			after: authoredCasePropertyNameSchema.nullable().optional(),
		}),
		z.object({
			kind: z.literal("setCaseProperty"),
			caseType: z.string(),
			property: casePropertySchema,
		}),
		z.object({
			kind: z.literal("removeCaseProperty"),
			caseType: z.string(),
			property: authoredCasePropertyNameSchema,
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
		// the same add / update / remove trio and a membership array. Adds state
		// their predecessor. No reorder gesture is exposed yet, so there is no
		// `move*` mutation; updates carry content only.
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
			patch: userPropertyUpdatePatchSchema,
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
			patch: userTypeEntityUpdatePatchSchema,
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
			patch: personaEntityUpdatePatchSchema,
			valuePatch: userDataValuePatchSchema.optional(),
		}),
		z.object({ kind: z.literal("removePersona"), uuid: uuidSchema }),
		// ─── Organization levels and place-information fields ────────────────
		// The organization shape uses the same record + membership-array model
		// as worker information. A level's external code is create-once, so its
		// update schema deliberately has no `code` slot.
		z.object({
			kind: z.literal("addOrganizationLevel"),
			level: organizationLevelSchema,
			after: uuidSchema.nullable().optional(),
		}),
		z.object({
			kind: z.literal("updateOrganizationLevel"),
			uuid: uuidSchema,
			patch: organizationLevelUpdatePatchSchema,
		}),
		z.object({
			kind: z.literal("removeOrganizationLevel"),
			uuid: uuidSchema,
		}),
		z.object({
			kind: z.literal("addLocationProperty"),
			property: locationPropertySchema,
			after: uuidSchema.nullable().optional(),
		}),
		z.object({
			kind: z.literal("updateLocationProperty"),
			uuid: uuidSchema,
			patch: locationPropertyUpdatePatchSchema,
		}),
		z.object({
			kind: z.literal("removeLocationProperty"),
			uuid: uuidSchema,
		}),
		// ─── Human-applied automations ────────────────────────────────────────
		// Automation children are identity-keyed merge units. A peer editing one
		// criterion, recipient, event, update, or filter never replaces a sibling.
		z.object({
			kind: z.literal("addAutomation"),
			automation: automationSchema,
			after: uuidSchema.nullable().optional(),
		}),
		z.discriminatedUnion("targetKind", [
			z
				.object({
					kind: z.literal("updateAutomation"),
					uuid: uuidSchema,
					targetKind: z.literal("case-update"),
					patch: automationCaseUpdatePatchSchema,
				})
				.strict(),
			z
				.object({
					kind: z.literal("updateAutomation"),
					uuid: uuidSchema,
					targetKind: z.literal("conditional-alert"),
					patch: automationAlertUpdatePatchSchema,
				})
				.strict(),
		]),
		z
			.object({
				kind: z.literal("removeAutomation"),
				uuid: uuidSchema,
				targetKind: z.enum(["case-update", "conditional-alert"]),
			})
			.strict(),
		z
			.object({
				kind: z.literal("moveAutomation"),
				uuid: uuidSchema,
				targetKind: z.enum(["case-update", "conditional-alert"]),
				after: uuidSchema.nullable(),
			})
			.strict(),
		z.discriminatedUnion("targetKind", [
			z
				.object({
					kind: z.literal("editAutomationItem"),
					automationUuid: uuidSchema,
					targetKind: z.literal("case-update"),
					edit: caseUpdateAutomationItemEditSchema,
				})
				.strict(),
			z
				.object({
					kind: z.literal("editAutomationItem"),
					automationUuid: uuidSchema,
					targetKind: z.literal("conditional-alert"),
					edit: alertAutomationItemEditSchema,
				})
				.strict(),
		]),
		z.object({
			kind: z.literal("setAutomationSchedule"),
			uuid: uuidSchema,
			schedule: automationScheduleSchema,
		}),
		z.object({
			kind: z.literal("updateAutomationSchedule"),
			uuid: uuidSchema,
			patch: z
				.object({
					repeatEvery:
						automationScheduleSchema.options[1].shape.repeatEvery.optional(),
					totalIterations:
						automationScheduleSchema.options[1].shape.totalIterations.optional(),
					startOffsetDays:
						automationScheduleSchema.options[1].shape.startOffsetDays.optional(),
					startDayOfWeek:
						automationScheduleSchema.options[1].shape.startDayOfWeek.optional(),
					start: automationScheduleSchema.options[1].shape.start.optional(),
				})
				.strict()
				.refine((value) => Object.keys(value).length > 0, {
					message: "Change at least one schedule field.",
				}),
		}),
		// ─── Granular case-list collections ──────────────────────────────────
		//
		// `caseListConfig.columns` / `.searchInputs` are membership arrays whose
		// position is NOT authoritative. Search inputs use their collection
		// sequence; columns use the case-list config's exact Results and Details
		// UUID permutations. Every kind is keyed by the owning module uuid + item
		// uuid, so concurrent edits merge. Column content updates preserve both
		// sequences and current visibility slots; each move or visibility mutation
		// changes only its named surface.
		// A config's absent -> present transition is the semantic ensure on
		// `updateModule` above.
		z.object({
			kind: z.literal("addColumn"),
			moduleUuid: uuidSchema,
			column: mutationColumnSchema,
			/**
			 * Where the column lands in each surface — the uuid it follows, or
			 * `null` for first. A column belongs to BOTH sequences from birth.
			 */
			afterInList: uuidSchema.nullable(),
			afterInDetail: uuidSchema.nullable(),
		}),
		z
			.object({
				kind: z.literal("updateColumn"),
				moduleUuid: uuidSchema,
				uuid: uuidSchema,
				column: columnContentSchema.optional(),
				sortPatch: columnSortSchema.nullable().optional(),
				tilePatch: tileCellSchema.nullable().optional(),
				visibilityPatch: z
					.object({
						surface: z.enum(["list", "detail"]),
						visible: z.boolean(),
					})
					.strict()
					.optional(),
			})
			.strict()
			.superRefine((mutation, ctx) => {
				const payloadCount = [
					mutation.column,
					mutation.sortPatch,
					mutation.tilePatch,
					mutation.visibilityPatch,
				].filter((value) => value !== undefined).length;
				if (payloadCount !== 1) {
					ctx.addIssue({
						code: "custom",
						message:
							"A column update carries exactly one content, sort, tile, or visibility payload.",
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
			/** The uuid this input now follows; `null` first, absent appends. */
			after: uuidSchema.nullable().optional(),
		}),
		z
			.object({
				kind: z.literal("updateSearchInput"),
				moduleUuid: uuidSchema,
				uuid: uuidSchema,
				searchInput: searchInputContentSchema,
			})
			.strict(),
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
		// `updateModule` operations above.
		// The module's case-list metadata that is NOT a membership array — the
		// always-on `filter` predicate, selection behavior, and the case-list-link
		// `icon` / `audioLabel`.
		// Each slot is nullable so a clear crosses the JSON wire as `null`.
		z.object({
			kind: z.literal("setCaseListMeta"),
			uuid: uuidSchema,
			patch: z
				.object({
					filter: mutationPredicateSchema.nullable().optional(),
					selection: caseSelectionSchema.nullable().optional(),
					icon: moduleIconRefSchema.nullable().optional(),
					audioLabel: mediaAssetIdSchema.nullable().optional(),
					tile: caseTileLayoutSchema.nullable().optional(),
				})
				.strict(),
		}),
		// ─── Granular select options ─────────────────────────────────────────
		//
		// A select field's `options` array IS the sequence, keyed by per-option
		// `uuid` for identity. The reducers rewrite `options` on the draft and
		// never re-parse the field through `fieldSchema`, so a `removeOption`
		// dropping below two options reaches the commit gate as a sub-2 candidate
		// (`SELECT_TOO_FEW_OPTIONS`).
		z.object({
			kind: z.literal("addOption"),
			fieldUuid: uuidSchema,
			option: selectOptionSchema,
			/** The uuid this option now follows; `null` first, absent appends. */
			after: uuidSchema.nullable().optional(),
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
			icon: moduleIconRefSchema.nullable(),
			audioLabel: mediaAssetIdSchema.nullable(),
		}),
		z.object({
			kind: z.literal("setFormMedia"),
			uuid: uuidSchema,
			icon: formIconRefSchema.nullable(),
			audioLabel: mediaAssetIdSchema.nullable(),
		}),
	] as const;
	const strictMutationArms = mutationArms.map((arm) =>
		arm instanceof z.ZodObject ? arm.strict() : arm,
	) as unknown as typeof mutationArms;
	const schema = z.discriminatedUnion("kind", strictMutationArms);
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

/** The single canonical mutation envelope. */
export const mutationSchema = createMutationSchema(finalMutationFamily);

export type Mutation = z.infer<typeof mutationSchema>;

// ─── MutationResult ────────────────────────────────────────────────────
//
// Reducers are deterministic state transitions and return no side-channel
// metadata. `applyMany(mutations)` retains one `undefined` entry per input so
// existing batched call sites can preserve positional accounting without
// inventing a second result protocol.
export type MutationResult = undefined;
