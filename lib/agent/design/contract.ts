/**
 * The lean, versioned Design Contract.
 *
 * The contract records only app semantics that a person or executor needs to
 * understand: the one-app boundary, actors, records and their properties,
 * task-complete workflows, work lists, access/navigation, external
 * prerequisites, decisions, assumptions, and unresolved questions. It is not
 * a traceability matrix and it is not a second Blueprint.
 *
 * Properties are declared once beneath their record. A workflow owns its
 * inputs, decisions, record effects, readback, exceptions, and acceptance
 * examples. Writers, readers, sources, and reverse references are derived from
 * those declarations by `graph.ts`; they are never mirrored in the artifact.
 */

import { z } from "zod";
import { sourceRefSchema } from "@/lib/agent/design/evidence";
import { validateDesignGraph } from "@/lib/agent/design/graph";
import { designIdSchema } from "@/lib/agent/design/ids";
import {
	type LookupChoiceProjectionRow,
	lookupChoiceProjectionAttestationSchema,
} from "@/lib/agent/design/lookupChoiceAttestation";
import { FORM_ICON_SLUGS, MODULE_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import type { FieldKind } from "@/lib/domain/fields";
import { identityIssues } from "@/lib/domain/languageRegistry";
import { languageDescriptor } from "@/lib/domain/languageRegistry/names";
import {
	appLanguageIdentitySchema,
	type LanguageTag,
	languageTag,
} from "@/lib/domain/localization";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { selectOptionValueSchema } from "@/lib/domain/selectOptionValue";
import { LOOKUP_MAX_COLUMNS, LOOKUP_MAX_ROWS } from "@/lib/lookup/constants";
import {
	lookupCellInputSchema,
	lookupColumnLabelSchema,
	lookupDataTypeSchema,
	lookupRevisionSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
} from "@/lib/lookup/schema";
import { automaticTranslationCapability } from "@/lib/translation/capabilityPolicy";

/**
 * Semantic fact shapes the accepted design can lower to at least one real
 * Blueprint field kind. `unknown` is the authoring-only escape hatch below;
 * construction refuses it until the model chooses a concrete shape.
 *
 * This vocabulary intentionally has no generic boolean. Nova has boolean
 * predicates, but no boolean field or case-property carrier. A durable yes/no
 * answer is an explicit single-choice fact with real values instead.
 */
export const constructibleFactDataShapes = [
	"text",
	"integer",
	"decimal",
	"date",
	"datetime",
	"single-choice",
	"multiple-choice",
	"location",
	"attachment",
] as const;

export type ConstructibleFactDataShape =
	(typeof constructibleFactDataShapes)[number];

interface FactDataShapeCarriers {
	readonly fieldKinds: readonly FieldKind[];
	readonly caseDataShapes: readonly CasePropertyDataType[];
}

/**
 * Executable carriers behind every concrete semantic shape. This explicit
 * relation is a drift tripwire between design vocabulary and the generated
 * capability catalog; tests prove every named carrier still exists in the
 * domain registries. Attachment capture is form-only until case attachment
 * emission ships, so it deliberately has no case-data carrier.
 */
export const factDataShapeCarriers = {
	text: { fieldKinds: ["text"], caseDataShapes: ["text"] },
	integer: { fieldKinds: ["int"], caseDataShapes: ["int"] },
	decimal: { fieldKinds: ["decimal"], caseDataShapes: ["decimal"] },
	date: { fieldKinds: ["date"], caseDataShapes: ["date"] },
	datetime: { fieldKinds: ["datetime"], caseDataShapes: ["datetime"] },
	"single-choice": {
		fieldKinds: ["single_select"],
		caseDataShapes: ["single_select"],
	},
	"multiple-choice": {
		fieldKinds: ["multi_select"],
		caseDataShapes: ["multi_select"],
	},
	location: { fieldKinds: ["geopoint"], caseDataShapes: ["geopoint"] },
	attachment: {
		fieldKinds: ["image", "audio", "video", "file", "signature"],
		caseDataShapes: [],
	},
} as const satisfies Record<ConstructibleFactDataShape, FactDataShapeCarriers>;

export const factDataShapeSchema = z.enum([
	...constructibleFactDataShapes,
	"unknown",
]);
export type FactDataShape = z.infer<typeof factDataShapeSchema>;

export const designLanguageSchema = appLanguageIdentitySchema.superRefine(
	(identity, ctx) => {
		for (const message of identityIssues(identity)) {
			ctx.addIssue({ code: "custom", message });
		}
	},
);
export type DesignLanguage = z.infer<typeof designLanguageSchema>;

export const designTargetLanguageSchema = z
	.object({
		language: designLanguageSchema,
		seedFrom: designLanguageSchema.describe(
			"Configured language whose effective strings initialize this target before any requested translation.",
		),
		strategy: z.enum(["copy-only", "translate-with-nova"]),
	})
	.strict();
export type DesignTargetLanguage = z.infer<typeof designTargetLanguageSchema>;

export const designLocalizationIntentSchema = z
	.object({
		sourceLanguage: designLanguageSchema,
		defaultLanguage: designLanguageSchema,
		targets: z.array(designTargetLanguageSchema).max(32),
	})
	.strict()
	.superRefine((intent, ctx) => {
		const sourceTag = languageTag(intent.sourceLanguage);
		const configured = new Set<LanguageTag>([sourceTag]);
		for (const [index, target] of intent.targets.entries()) {
			const tag = languageTag(target.language);
			if (configured.has(tag)) {
				ctx.addIssue({
					code: "custom",
					path: ["targets", index, "language"],
					message:
						"Every app language must be a distinct identity, and a target cannot repeat the source language.",
				});
			}
			configured.add(tag);
		}
		if (!configured.has(languageTag(intent.defaultLanguage))) {
			ctx.addIssue({
				code: "custom",
				path: ["defaultLanguage"],
				message:
					"The runtime default language must be the source or one of the configured targets.",
			});
		}
		const seedByTarget = new Map(
			intent.targets.map((target) => [
				languageTag(target.language),
				languageTag(target.seedFrom),
			]),
		);
		for (const [index, target] of intent.targets.entries()) {
			if (!configured.has(languageTag(target.seedFrom))) {
				ctx.addIssue({
					code: "custom",
					path: ["targets", index, "seedFrom"],
					message:
						"A target language must start from the source or another configured target.",
				});
				continue;
			}
			const seen = new Set<LanguageTag>();
			let cursor: LanguageTag = languageTag(target.language);
			while (cursor !== sourceTag) {
				if (seen.has(cursor)) {
					ctx.addIssue({
						code: "custom",
						path: ["targets", index, "seedFrom"],
						message:
							"Language copy dependencies must reach the source language without a cycle.",
					});
					break;
				}
				seen.add(cursor);
				const next = seedByTarget.get(cursor);
				if (next === undefined) break;
				cursor = next;
			}
		}
	});
export type DesignLocalizationIntent = z.infer<
	typeof designLocalizationIntentSchema
>;

/** One session builds one app in the current Project — a server law stated
 * by the capability catalog's session boundary, never a charter field the
 * model spends tokens re-affirming. */
export const appCharterSchema = z
	.object({
		appName: z.string().min(1),
		objective: z.string().min(1),
		includedWorkflowIds: z.array(designIdSchema).min(1),
		excludedWorkflows: z.array(z.string().min(1)),
		deliveryContext: z.enum([
			"offline-first",
			"online-first",
			"mixed",
			"not-decided",
		]),
		initialWorkflowId: designIdSchema,
		localization: designLocalizationIntentSchema.optional(),
	})
	.strict();
export type AppCharter = z.infer<typeof appCharterSchema>;

export const designActorSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		goals: z.array(z.string().min(1)).min(1),
		responsibilities: z.array(z.string().min(1)),
		workContext: z.array(z.string().min(1)),
		constraints: z.array(z.string().min(1)),
	})
	.strict();
export type DesignActor = z.infer<typeof designActorSchema>;

/** Stable reference to a lookup source that already exists in the Project. */
export const existingLookupChoiceSourceSchema = z
	.object({
		kind: z.literal("existing-project-lookup"),
		tableId: lookupTableIdSchema,
		valueColumnId: lookupColumnIdSchema,
		labelColumnId: lookupColumnIdSchema,
		inspection: lookupChoiceProjectionAttestationSchema.describe(
			"Constant-size, revision-bound attestation returned by inspectProjectData for the complete ordered saved-value and label projection. Copy every field exactly; never calculate or edit it.",
		),
	})
	.strict();
export type ExistingLookupChoiceSource = z.infer<
	typeof existingLookupChoiceSourceSchema
>;
/** Compiler-facing accepted reference after the server validates the design's
 * inspection evidence. The stable table and column identities do not change. */
export type ExistingLookupChoiceReference = Omit<
	ExistingLookupChoiceSource,
	"inspection"
>;

/** Reference to a table whose stable Project identities will be minted only
 * after this exact reviewed design is accepted. */
export const designedLookupChoiceSourceSchema = z
	.object({
		kind: z.literal("designed-project-lookup"),
		tableId: designIdSchema,
		valueColumnId: designIdSchema,
		labelColumnId: designIdSchema,
	})
	.strict();
export type DesignedLookupChoiceSource = z.infer<
	typeof designedLookupChoiceSourceSchema
>;

export const designLookupChoiceSourceSchema = z.discriminatedUnion("kind", [
	existingLookupChoiceSourceSchema,
	designedLookupChoiceSourceSchema,
]);
export type DesignLookupChoiceSource = z.infer<
	typeof designLookupChoiceSourceSchema
>;

function makeRecordPropertySchema<ChoiceSourceSchema extends z.ZodTypeAny>(
	choiceSourceSchema: ChoiceSourceSchema,
) {
	return z
		.object({
			id: designIdSchema,
			name: z.string().min(1),
			meaning: z.string().min(1),
			dataShape: factDataShapeSchema,
			sensitivity: z
				.enum(["ordinary", "sensitive", "highly-sensitive"])
				.default("ordinary"),
			requiredWhen: z.string().min(1).optional(),
			choiceValues: z
				.array(selectOptionValueSchema)
				.optional()
				.describe(
					"The stored values of this fact's choices, one slug each (in_progress, prefer_not_to_say); the executor derives the wording people read from them. Every later tool that writes these choices refuses a value outside that shape.",
				),
			choiceSource: choiceSourceSchema.optional(),
		})
		.strict()
		.superRefine((value, ctx) => {
			const choice =
				value.dataShape === "single-choice" ||
				value.dataShape === "multiple-choice";
			if (
				choice &&
				(value.choiceValues?.length ?? 0) === 0 &&
				value.choiceSource === undefined
			) {
				ctx.addIssue({
					code: "custom",
					path: ["choiceValues"],
					message:
						"A choice property must name its allowed values or a Project lookup source.",
				});
			}
			if (
				choice &&
				value.choiceValues !== undefined &&
				value.choiceSource !== undefined
			) {
				ctx.addIssue({
					code: "custom",
					path: ["choiceSource"],
					message:
						"A choice property must use either inline values or a Project lookup source, not both.",
				});
			}
			if (
				!choice &&
				(value.choiceValues !== undefined || value.choiceSource !== undefined)
			) {
				ctx.addIssue({
					code: "custom",
					path: ["choiceValues"],
					message:
						"Only a choice property may declare choice values or a lookup source.",
				});
			}
		});
}

export const recordPropertySchema = makeRecordPropertySchema(
	designLookupChoiceSourceSchema,
);
export type RecordProperty = z.infer<typeof recordPropertySchema>;

function makeRecordConceptSchema<PropertySchema extends z.ZodTypeAny>(
	propertySchema: PropertySchema,
) {
	return z
		.object({
			id: designIdSchema,
			name: z.string().min(1),
			purpose: z.string().min(1),
			parentRecordId: designIdSchema.optional(),
			relationshipMeaning: z.string().min(1).optional(),
			lifecycleStates: z.array(z.string().min(1)),
			properties: z.array(propertySchema),
		})
		.strict();
}

export const recordConceptSchema =
	makeRecordConceptSchema(recordPropertySchema);
export type RecordConcept = z.infer<typeof recordConceptSchema>;

function makeWorkflowInputSchema<ChoiceSourceSchema extends z.ZodTypeAny>(
	choiceSourceSchema: ChoiceSourceSchema,
) {
	return z
		.object({
			handle: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
			name: z.string().min(1),
			purpose: z.string().min(1),
			propertyId: designIdSchema.optional(),
			dataShape: factDataShapeSchema.optional(),
			requiredWhen: z.string().min(1).optional(),
			choiceValues: z
				.array(selectOptionValueSchema)
				.optional()
				.describe(
					"The stored values of this fact's choices, one slug each (in_progress, prefer_not_to_say); the executor derives the wording people read from them. Every later tool that writes these choices refuses a value outside that shape.",
				),
			choiceSource: choiceSourceSchema.optional(),
			validation: z
				.object({
					rule: z
						.string()
						.min(1)
						.describe(
							"Semantic condition that entered answers must satisfy; this is design intent, not an XPath expression.",
						),
					message: z
						.string()
						.min(1)
						.describe(
							"Worker-facing message shown when the answer is invalid.",
						),
				})
				.strict()
				.optional()
				.describe(
					"Optional data-quality intent for this input. Optional inputs must still accept an unanswered value.",
				),
		})
		.strict()
		.superRefine((value, ctx) => {
			if (value.propertyId !== undefined) return;
			const choice =
				value.dataShape === "single-choice" ||
				value.dataShape === "multiple-choice";
			if (
				choice &&
				(value.choiceValues?.length ?? 0) === 0 &&
				value.choiceSource === undefined
			) {
				ctx.addIssue({
					code: "custom",
					path: ["choiceValues"],
					message:
						"A form-only choice input must name its allowed values or a Project lookup source.",
				});
			}
			if (
				choice &&
				value.choiceValues !== undefined &&
				value.choiceSource !== undefined
			) {
				ctx.addIssue({
					code: "custom",
					path: ["choiceSource"],
					message:
						"A form-only choice input must use either inline values or a Project lookup source, not both.",
				});
			}
			if (
				!choice &&
				(value.choiceValues !== undefined || value.choiceSource !== undefined)
			) {
				ctx.addIssue({
					code: "custom",
					path: ["choiceValues"],
					message:
						"Only a form-only choice input may declare choice values or a lookup source.",
				});
			}
		});
}

export const workflowInputSchema = makeWorkflowInputSchema(
	designLookupChoiceSourceSchema,
);
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

export const workflowDecisionSchema = z
	.object({
		handle: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
		name: z.string().min(1),
		statement: z.string().min(1),
		inputPropertyIds: z.array(designIdSchema),
		outcomes: z.array(z.string().min(1)).min(1),
	})
	.strict();
export type WorkflowDecision = z.infer<typeof workflowDecisionSchema>;

export const workflowPropertyWriteSchema = z
	.object({
		propertyId: designIdSchema,
		value: z.string().min(1),
		when: z.string().min(1).optional(),
		unanswered: z.enum(["preserve", "clear"]).default("preserve"),
	})
	.strict();
export type WorkflowPropertyWrite = z.infer<typeof workflowPropertyWriteSchema>;

export const workflowRecordEffectSchema = z
	.object({
		handle: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
		recordId: designIdSchema,
		kind: z.enum(["create", "update", "close", "link", "reassign"]),
		sourceRecordId: designIdSchema.optional(),
		condition: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Semantic condition under which this effect is skipped while submission may otherwise succeed. Never condition a registration form's hosted primary create: use a standalone form for a conditional create, or input validation when the whole ineligible submission must be blocked.",
			),
		writes: z.array(workflowPropertyWriteSchema),
		outcome: z.string().min(1),
	})
	.strict();
export type WorkflowRecordEffect = z.infer<typeof workflowRecordEffectSchema>;

/** Supported Blueprint features whose authored state is workflow-local but is
 * not otherwise represented by a record effect. This is semantic intent, not
 * a tool list: the deterministic plan compiler lowers it to Blueprint areas. */
export const workflowAuthoredFeatureSchema = z.enum([
	"existing-media",
	"automation",
]);
export type WorkflowAuthoredFeature = z.infer<
	typeof workflowAuthoredFeatureSchema
>;

export const workflowReadbackSchema = z
	.object({
		recordId: designIdSchema,
		purpose: z.string().min(1),
		propertyIds: z.array(designIdSchema),
	})
	.strict();
export type WorkflowReadback = z.infer<typeof workflowReadbackSchema>;

export const workflowAcceptanceExampleSchema = z
	.object({
		name: z.string().min(1),
		given: z.array(z.string().min(1)),
		when: z.array(z.string().min(1)).min(1),
		expectedResults: z.array(z.string().min(1)).min(1),
	})
	.strict();
export type WorkflowAcceptanceExample = z.infer<
	typeof workflowAcceptanceExampleSchema
>;

function makeWorkflowSchema<InputSchema extends z.ZodTypeAny>(
	inputSchema: InputSchema,
) {
	return z
		.object({
			id: designIdSchema,
			name: z.string().min(1),
			actorIds: z.array(designIdSchema).min(1),
			goal: z.string().min(1),
			trigger: z.string().min(1),
			contextRecordId: designIdSchema.optional(),
			prerequisiteWorkflowIds: z.array(designIdSchema),
			prerequisites: z.array(z.string().min(1)),
			inputs: z.array(inputSchema),
			decisions: z.array(workflowDecisionSchema),
			recordEffects: z.array(workflowRecordEffectSchema),
			authoredFeatures: z.array(workflowAuthoredFeatureSchema),
			readback: z.array(workflowReadbackSchema),
			exceptions: z.array(z.string().min(1)),
			externalRequirementIds: z.array(designIdSchema),
			acceptanceExamples: z.array(workflowAcceptanceExampleSchema).min(1),
		})
		.strict();
}

export const workflowSchema = makeWorkflowSchema(workflowInputSchema);
export type Workflow = z.infer<typeof workflowSchema>;

const compositionMarkdownSchema = z
	.string()
	.min(1)
	.max(4_000)
	.describe(
		"Concise user-facing Markdown. Use structure only when it helps a worker scan or act; do not add decorative filler.",
	);

const moduleIconDecisionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("builtin"),
			slug: z.enum(MODULE_ICON_SLUGS),
			rationale: z.string().min(1).max(500).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("none"),
			rationale: z.string().min(1).max(500),
		})
		.strict(),
]);

const formIconDecisionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("builtin"),
			slug: z.enum(FORM_ICON_SLUGS),
			rationale: z.string().min(1).max(500).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("none"),
			rationale: z.string().min(1).max(500),
		})
		.strict(),
]);

/** Case-selection cardinality belongs to the module Results screen, including
 * modules whose default Results screen is not described by a WorkList. */
export const moduleSelectionSchema = z.discriminatedUnion("cases", [
	z
		.object({
			workflowIds: z
				.array(designIdSchema)
				.min(1)
				.max(32)
				.describe(
					"Every workflow with a selected-record or close form affected by this module's one-case setting, listed once. Include same-record child consumers when this is a queue-only parent.",
				),
			cases: z.literal("one"),
		})
		.strict(),
	z
		.object({
			workflowIds: z
				.array(designIdSchema)
				.min(1)
				.max(32)
				.describe(
					"Every workflow whose selected-record or close form will receive the same shared answers for the complete selection, listed once. Include same-record child consumers when this is a queue-only parent.",
				),
			cases: z.literal("several"),
			maximum: z.number().int().min(1).max(100),
		})
		.strict(),
]);
export type ModuleSelection = z.infer<typeof moduleSelectionSchema>;

/** One deliberate home-screen/menu container. These are product-composition
 * decisions, not Blueprint modules: every reference stays in Design IDs and
 * the deterministic compiler later chooses construction ownership. */
export const moduleCompositionSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1).max(160),
		purpose: z.string().min(1).max(1_000),
		parentModuleCompositionId: designIdSchema.optional(),
		role: z.enum(["form-host", "queue-only", "form-and-queue"]),
		selection: moduleSelectionSchema.optional(),
		workflowIds: z.array(designIdSchema).min(1).max(32),
		hostRecordId: designIdSchema.optional(),
		actorIds: z.array(designIdSchema).min(1).max(32),
		navigationIds: z.array(designIdSchema).max(16),
		listIds: z.array(designIdSchema).max(16),
		orderRationale: z.string().min(1).max(1_000),
		icon: moduleIconDecisionSchema,
		roleSeparationRationale: z.string().min(1).max(1_000),
	})
	.strict();
export type ModuleComposition = z.infer<typeof moduleCompositionSchema>;

export const formCompositionItemSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("input"),
			id: designIdSchema,
			inputHandle: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
			labelMarkdown: compositionMarkdownSchema,
			hintMarkdown: compositionMarkdownSchema.optional(),
			helpMarkdown: compositionMarkdownSchema.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("guidance"),
			id: designIdSchema,
			markdown: compositionMarkdownSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("record-summary"),
			id: designIdSchema,
			recordId: designIdSchema,
			propertyIds: z.array(designIdSchema).min(1).max(16),
			purpose: z.string().min(1).max(1_000),
		})
		.strict(),
]);
export type FormCompositionItem = z.infer<typeof formCompositionItemSchema>;

export const formCompositionSectionSchema = z
	.object({
		id: designIdSchema,
		headingMarkdown: compositionMarkdownSchema,
		purpose: z.string().min(1).max(1_000),
		items: z.array(formCompositionItemSchema).min(1).max(64),
	})
	.strict();
export type FormCompositionSection = z.infer<
	typeof formCompositionSectionSchema
>;

export const formCompositionLayoutSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z
				.literal("sectioned")
				.describe(
					"A grouped visual layout on one continuous form, lowered through ordinary group fields. This is not form sections (pages) or page navigation.",
				),
			rationale: z.string().min(1).max(1_000),
			sections: z.array(formCompositionSectionSchema).min(1).max(12),
		})
		.strict(),
	z
		.object({
			kind: z.literal("flat"),
			rationale: z.string().min(1).max(1_000),
			items: z.array(formCompositionItemSchema).min(1).max(64),
		})
		.strict(),
]);
export type FormCompositionLayout = z.infer<typeof formCompositionLayoutSchema>;

/** Exact worker-facing form composition for one complete workflow variant. */
export const formCompositionSchema = z
	.object({
		id: designIdSchema,
		workflowId: designIdSchema,
		moduleCompositionId: designIdSchema,
		name: z.string().min(1).max(160),
		purpose: z.string().min(1).max(1_000),
		mode: z.enum(["registration", "selected-record", "close", "standalone"]),
		icon: formIconDecisionSchema,
		variant: z.enum(["shared", "actor-specific"]),
		actorIds: z.array(designIdSchema).min(1).max(32),
		duplicateRationale: z.string().min(1).max(1_000).optional(),
		layout: formCompositionLayoutSchema,
	})
	.strict();
export type FormComposition = z.infer<typeof formCompositionSchema>;

/** Source pointers that ground a model-authored set of lookup rows without
 * copying source bodies into the Design Contract. */
export const lookupRowEvidenceSchema = z
	.object({
		sourceRefs: z.array(sourceRefSchema).min(1).max(16),
		summary: z
			.string()
			.min(1)
			.max(1_000)
			.describe(
				"What these sources establish about the exact row values; never copy a source body here.",
			),
	})
	.strict();
export type LookupRowEvidence = z.infer<typeof lookupRowEvidenceSchema>;

export const designedLookupCellSchema = z
	.object({
		columnId: designIdSchema,
		value: lookupCellInputSchema,
	})
	.strict();
export type DesignedLookupCell = z.infer<typeof designedLookupCellSchema>;

export const designedLookupColumnSchema = z
	.object({
		id: designIdSchema,
		wireName: lookupWireNameSchema,
		label: lookupColumnLabelSchema,
		dataType: lookupDataTypeSchema,
	})
	.strict();
export type DesignedLookupColumn = z.infer<typeof designedLookupColumnSchema>;

export const designedLookupRowSchema = z
	.object({
		id: designIdSchema,
		cells: z.array(designedLookupCellSchema).max(LOOKUP_MAX_COLUMNS),
	})
	.strict();
export type DesignedLookupRow = z.infer<typeof designedLookupRowSchema>;

export const createLookupTableDesignSchema = z
	.object({
		kind: z.literal("create"),
		id: designIdSchema,
		name: lookupTableNameSchema,
		tag: lookupTagSchema,
		purpose: z.string().min(1).max(1_000),
		columns: z.array(designedLookupColumnSchema).min(1).max(LOOKUP_MAX_COLUMNS),
		rows: z.array(designedLookupRowSchema).max(LOOKUP_MAX_ROWS),
		rowEvidence: lookupRowEvidenceSchema,
	})
	.strict();
export type CreateLookupTableDesign = z.infer<
	typeof createLookupTableDesignSchema
>;

/** A shared existing table may change only when the durable source package
 * contains the direct request or the explicit approval for that Project-wide
 * effect. Review still proves that the cited source says what this record
 * claims; this is not a self-asserted permission bit. */
export const existingLookupChangeAuthorizationSchema = z
	.object({
		kind: z.enum(["direct-user-request", "explicit-user-approval"]),
		sourceRefs: z.array(sourceRefSchema).min(1).max(8),
		impactSummary: z.string().min(1).max(1_000),
	})
	.strict();
export type ExistingLookupChangeAuthorization = z.infer<
	typeof existingLookupChangeAuthorizationSchema
>;

const existingLookupColumnRefSchema = z
	.object({
		kind: z.literal("existing-column"),
		columnId: lookupColumnIdSchema,
	})
	.strict();
const addedLookupColumnRefSchema = z
	.object({
		kind: z.literal("added-column"),
		columnId: designIdSchema,
	})
	.strict();
export const changedLookupColumnRefSchema = z.discriminatedUnion("kind", [
	existingLookupColumnRefSchema,
	addedLookupColumnRefSchema,
]);
export type ChangedLookupColumnRef = z.infer<
	typeof changedLookupColumnRefSchema
>;

const existingLookupRowRefSchema = z
	.object({ kind: z.literal("existing-row"), rowId: lookupRowIdSchema })
	.strict();
const addedLookupRowRefSchema = z
	.object({ kind: z.literal("added-row"), rowId: designIdSchema })
	.strict();
export const changedLookupRowRefSchema = z.discriminatedUnion("kind", [
	existingLookupRowRefSchema,
	addedLookupRowRefSchema,
]);
export type ChangedLookupRowRef = z.infer<typeof changedLookupRowRefSchema>;

export const changedLookupCellSchema = z
	.object({
		column: changedLookupColumnRefSchema,
		value: lookupCellInputSchema,
	})
	.strict();
export type ChangedLookupCell = z.infer<typeof changedLookupCellSchema>;

const addLookupColumnDesignOperationSchema = z
	.object({
		kind: z.literal("add-column"),
		column: designedLookupColumnSchema,
		after: changedLookupColumnRefSchema.optional(),
	})
	.strict();
const updateLookupColumnDesignOperationSchema = z
	.object({
		kind: z.literal("update-column"),
		columnId: lookupColumnIdSchema,
		label: lookupColumnLabelSchema.optional(),
		wireName: lookupWireNameSchema.optional(),
		dataType: lookupDataTypeSchema.optional(),
	})
	.strict();
const moveLookupColumnDesignOperationSchema = z
	.object({
		kind: z.literal("move-column"),
		column: changedLookupColumnRefSchema,
		after: changedLookupColumnRefSchema.optional(),
	})
	.strict();
const removeLookupColumnDesignOperationSchema = z
	.object({
		kind: z.literal("remove-column"),
		columnId: lookupColumnIdSchema,
	})
	.strict();
const addLookupRowDesignOperationSchema = z
	.object({
		kind: z.literal("add-row"),
		rowId: designIdSchema,
		cells: z.array(changedLookupCellSchema).max(LOOKUP_MAX_COLUMNS),
		after: changedLookupRowRefSchema.optional(),
		rowEvidence: lookupRowEvidenceSchema,
	})
	.strict();
const updateLookupRowDesignOperationSchema = z
	.object({
		kind: z.literal("update-row"),
		rowId: lookupRowIdSchema,
		cells: z.array(changedLookupCellSchema).max(LOOKUP_MAX_COLUMNS),
		rowEvidence: lookupRowEvidenceSchema,
	})
	.strict();
const moveLookupRowDesignOperationSchema = z
	.object({
		kind: z.literal("move-row"),
		row: changedLookupRowRefSchema,
		after: changedLookupRowRefSchema.optional(),
	})
	.strict();
const removeLookupRowDesignOperationSchema = z
	.object({
		kind: z.literal("remove-row"),
		rowId: lookupRowIdSchema,
	})
	.strict();
const replaceLookupRowsDesignOperationSchema = z
	.object({
		kind: z.literal("replace-rows"),
		rows: z
			.array(
				z
					.object({
						id: designIdSchema,
						cells: z.array(changedLookupCellSchema).max(LOOKUP_MAX_COLUMNS),
					})
					.strict(),
			)
			.max(LOOKUP_MAX_ROWS),
		rowEvidence: lookupRowEvidenceSchema,
	})
	.strict();

export const existingLookupTableDesignOperationSchema = z.discriminatedUnion(
	"kind",
	[
		z
			.object({
				kind: z.literal("update-table"),
				name: lookupTableNameSchema.optional(),
				tag: lookupTagSchema.optional(),
			})
			.strict(),
		addLookupColumnDesignOperationSchema,
		updateLookupColumnDesignOperationSchema,
		moveLookupColumnDesignOperationSchema,
		removeLookupColumnDesignOperationSchema,
		addLookupRowDesignOperationSchema,
		updateLookupRowDesignOperationSchema,
		moveLookupRowDesignOperationSchema,
		removeLookupRowDesignOperationSchema,
		replaceLookupRowsDesignOperationSchema,
	],
);
export type ExistingLookupTableDesignOperation = z.infer<
	typeof existingLookupTableDesignOperationSchema
>;

export const changeExistingLookupTableDesignSchema = z
	.object({
		kind: z.literal("modify-existing"),
		id: designIdSchema,
		tableId: lookupTableIdSchema,
		expectedTableRevision: lookupRevisionSchema,
		purpose: z.string().min(1).max(1_000),
		authorization: existingLookupChangeAuthorizationSchema,
		operations: z
			.array(existingLookupTableDesignOperationSchema)
			.min(1)
			.max(128),
	})
	.strict();
export type ChangeExistingLookupTableDesign = z.infer<
	typeof changeExistingLookupTableDesignSchema
>;

export const designLookupTableSchema = z.discriminatedUnion("kind", [
	createLookupTableDesignSchema,
	changeExistingLookupTableDesignSchema,
]);
export type DesignLookupTable = z.infer<typeof designLookupTableSchema>;

export const workListSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		actorIds: z.array(designIdSchema).min(1),
		recordId: designIdSchema,
		purpose: z.string().min(1),
		filters: z.array(z.string().min(1)),
		sort: z.array(z.string().min(1)),
		scanPropertyIds: z.array(designIdSchema),
		detailPropertyIds: z.array(designIdSchema),
		searchPropertyIds: z.array(designIdSchema),
		emptyStateMeaning: z.string().min(1),
	})
	.strict();
export type WorkList = z.infer<typeof workListSchema>;

export const accessPolicySchema = z
	.object({
		id: designIdSchema,
		actorId: designIdSchema,
		targets: z
			.array(
				z
					.object({
						kind: z.enum(["record", "workflow", "list", "navigation"]),
						id: designIdSchema,
					})
					.strict(),
			)
			.min(1),
		capabilities: z
			.array(
				z.enum(["discover", "view", "create", "update", "close", "administer"]),
			)
			.min(1),
		condition: z.string().min(1).optional(),
		locationScope: z.string().min(1).optional(),
	})
	.strict();
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

export const navigationIntentSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		purpose: z.string().min(1),
		actorIds: z.array(designIdSchema).min(1),
		workflowIds: z.array(designIdSchema),
		listIds: z.array(designIdSchema),
		parentNavigationId: designIdSchema.optional(),
		orderRationale: z.string().min(1).optional(),
	})
	.strict();
export type NavigationIntent = z.infer<typeof navigationIntentSchema>;

export const externalRequirementSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		kind: z.enum([
			"existing-reference",
			"user-prerequisite",
			"runtime-readiness",
			"deployment-readiness",
			"unsupported",
		]),
		description: z.string().min(1),
		relatedWorkflowIds: z.array(designIdSchema),
		/** Missing runtime/deployment assets do not block app construction. */
		blocksConstruction: z.boolean(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.blocksConstruction &&
			(value.kind === "runtime-readiness" ||
				value.kind === "deployment-readiness")
		) {
			ctx.addIssue({
				code: "custom",
				path: ["blocksConstruction"],
				message: "Runtime and deployment readiness may not block construction.",
			});
		}
	});
export type ExternalRequirement = z.infer<typeof externalRequirementSchema>;

export const architectureDecisionSchema = z
	.object({
		id: designIdSchema,
		question: z.string().min(1),
		decision: z.string().min(1),
		rationale: z.string().min(1),
	})
	.strict();
export type ArchitectureDecision = z.infer<typeof architectureDecisionSchema>;

export const assumptionSchema = z
	.object({
		id: designIdSchema,
		statement: z.string().min(1),
		consequenceIfWrong: z.string().min(1),
	})
	.strict();
export type Assumption = z.infer<typeof assumptionSchema>;

export const openQuestionSchema = z
	.object({
		id: designIdSchema,
		question: z.string().min(1),
		blocking: z.boolean(),
		relatedElementIds: z.array(designIdSchema),
	})
	.strict();
export type OpenQuestion = z.infer<typeof openQuestionSchema>;

/** The one current Design Contract vocabulary. Project lookup intent belongs
 * directly to this model rather than to a parallel compatibility shape. */
export const appDesignContractBaseSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: designIdSchema,
		charter: appCharterSchema,
		actors: z.array(designActorSchema).min(1),
		records: z.array(recordConceptSchema),
		workflows: z.array(workflowSchema).min(1),
		lists: z.array(workListSchema),
		access: z.array(accessPolicySchema),
		navigation: z.array(navigationIntentSchema),
		moduleCompositions: z.array(moduleCompositionSchema),
		formCompositions: z.array(formCompositionSchema),
		lookupTables: z.array(designLookupTableSchema),
		externalRequirements: z.array(externalRequirementSchema),
		decisions: z.array(architectureDecisionSchema),
		assumptions: z.array(assumptionSchema),
		openQuestions: z.array(openQuestionSchema),
	})
	.strict();

export type AppDesignContract = z.infer<typeof appDesignContractBaseSchema>;

export const appDesignContractSchema =
	appDesignContractBaseSchema.superRefine(validateDesignGraph);

/** Remove the former WorkList-only selection carrier after its workflow has
 * been projected onto the owning module by the whole-contract normalizer. */
function normalizeStoredWorkList(stored: unknown): unknown {
	if (stored === null || typeof stored !== "object" || Array.isArray(stored))
		return stored;
	const value = stored as Record<string, unknown>;
	if (!Object.hasOwn(value, "selectionWorkflowId")) return stored;
	const { selectionWorkflowId: _selectionWorkflowId, ...current } = value;
	return current;
}

/** The sole persisted-contract normalization seam. Stored contracts can
 * predate additive collections or the module-owned selection shape, but every
 * caller receives the one complete current domain model. Digest verification
 * happens against the sealed bytes before this function is called. */
export function normalizeStoredAppDesignContract(
	stored: unknown,
): AppDesignContract {
	if (stored === null || typeof stored !== "object" || Array.isArray(stored))
		return appDesignContractSchema.parse(stored);
	const value = stored as Record<string, unknown>;
	const storedLists = Array.isArray(value.lists) ? value.lists : [];
	const legacySelections = storedLists.flatMap((list) => {
		if (list === null || typeof list !== "object" || Array.isArray(list))
			return [];
		const candidate = list as Record<string, unknown>;
		return Object.hasOwn(candidate, "selectionWorkflowId") &&
			candidate.selection === undefined &&
			typeof candidate.id === "string"
			? [
					{
						listId: candidate.id,
						workflowId: candidate.selectionWorkflowId,
					},
				]
			: [];
	});
	const storedModules = Array.isArray(value.moduleCompositions)
		? value.moduleCompositions
		: [];
	const storedForms = Array.isArray(value.formCompositions)
		? value.formCompositions
		: [];
	const storedWorkflows = Array.isArray(value.workflows) ? value.workflows : [];
	const storedWorkflowIds = new Set(
		storedWorkflows.flatMap((workflow) =>
			workflow !== null &&
			typeof workflow === "object" &&
			!Array.isArray(workflow)
				? [(workflow as Record<string, unknown>).id]
				: [],
		),
	);
	const invalidLegacyListIds = new Set(
		legacySelections
			.filter((selection) => !storedWorkflowIds.has(selection.workflowId))
			.map((selection) => selection.listId),
	);
	const storedSelectionWorkflowIds = (
		candidate: Record<string, unknown>,
	): unknown[] => {
		const consumerModuleIds = new Set<unknown>([candidate.id]);
		if (candidate.role === "queue-only") {
			for (const child of storedModules) {
				if (child === null || typeof child !== "object" || Array.isArray(child))
					continue;
				const childCandidate = child as Record<string, unknown>;
				if (
					childCandidate.parentModuleCompositionId === candidate.id &&
					childCandidate.hostRecordId === candidate.hostRecordId
				) {
					consumerModuleIds.add(childCandidate.id);
				}
			}
		}
		const consumerWorkflowIds = new Set(
			storedForms.flatMap((form) => {
				if (form === null || typeof form !== "object" || Array.isArray(form))
					return [];
				const formCandidate = form as Record<string, unknown>;
				return consumerModuleIds.has(formCandidate.moduleCompositionId) &&
					(formCandidate.mode === "selected-record" ||
						formCandidate.mode === "close")
					? [formCandidate.workflowId]
					: [];
			}),
		);
		return storedWorkflows.flatMap((workflow) => {
			if (
				workflow === null ||
				typeof workflow !== "object" ||
				Array.isArray(workflow)
			)
				return [];
			const workflowId = (workflow as Record<string, unknown>).id;
			return consumerWorkflowIds.has(workflowId) ? [workflowId] : [];
		});
	};
	const normalizedModules = storedModules.map((module) => {
		if (module === null || typeof module !== "object" || Array.isArray(module))
			return module;
		const candidate = module as Record<string, unknown>;
		if (candidate.selection !== undefined) return module;
		const workflowIds = storedSelectionWorkflowIds(candidate);
		/* A legacy module with no case-loading consumer had no observable
		 * selection cardinality. Keep the current carrier absent. */
		if (workflowIds.length === 0) return module;
		const inheritsQueueParent = storedModules.some((parent) => {
			if (
				parent === null ||
				typeof parent !== "object" ||
				Array.isArray(parent)
			)
				return false;
			const parentCandidate = parent as Record<string, unknown>;
			return (
				parentCandidate.id === candidate.parentModuleCompositionId &&
				parentCandidate.role === "queue-only" &&
				parentCandidate.hostRecordId === candidate.hostRecordId &&
				storedSelectionWorkflowIds(parentCandidate).length > 0
			);
		});
		if (inheritsQueueParent) return module;
		return {
			...candidate,
			selection: {
				workflowIds,
				cases: "one",
			},
		};
	});
	const normalized = {
		...value,
		moduleCompositions:
			value.moduleCompositions === undefined ? [] : normalizedModules,
		formCompositions:
			value.formCompositions === undefined ? [] : value.formCompositions,
		lookupTables: value.lookupTables === undefined ? [] : value.lookupTables,
		lists: Array.isArray(value.lists)
			? value.lists.map((list) => {
					if (
						list !== null &&
						typeof list === "object" &&
						!Array.isArray(list) &&
						invalidLegacyListIds.has(
							(list as Record<string, unknown>).id as string,
						)
					)
						return list;
					return normalizeStoredWorkList(list);
				})
			: value.lists,
	};
	return appDesignContractSchema.parse(normalized);
}

export interface DesignConstructionIssue {
	readonly path: readonly (string | number)[];
	readonly message: string;
}

function distinctRealChoices(values: readonly string[] | undefined): number {
	return new Set(
		(values ?? []).map((value) => value.trim()).filter((value) => value !== ""),
	).size;
}

export function existingLookupChoiceRowsAfterChanges(
	contract: AppDesignContract,
	source: ExistingLookupChoiceSource,
	initialRows: readonly LookupChoiceProjectionRow[],
): LookupChoiceProjectionRow[] {
	const rows = new Map(
		initialRows.map((row) => [row.rowId, { ...row }] as const),
	);

	const changed = contract.lookupTables.find(
		(table) =>
			table.kind === "modify-existing" && table.tableId === source.tableId,
	);
	if (changed === undefined || changed.kind !== "modify-existing")
		return [...rows.values()];

	const projectedCells = (
		cells: readonly ChangedLookupCell[],
	): Pick<LookupChoiceProjectionRow, "value" | "label"> => {
		const projected: { value?: string | number; label?: string | number } = {};
		for (const cell of cells) {
			if (cell.column.kind !== "existing-column") continue;
			if (cell.column.columnId === source.valueColumnId)
				projected.value = cell.value;
			if (cell.column.columnId === source.labelColumnId)
				projected.label = cell.value;
		}
		return projected;
	};
	for (const operation of changed.operations) {
		switch (operation.kind) {
			case "add-row":
				rows.set(operation.rowId, {
					rowId: operation.rowId,
					...projectedCells(operation.cells),
				});
				break;
			case "update-row": {
				const current = rows.get(operation.rowId);
				if (current !== undefined)
					rows.set(operation.rowId, {
						rowId: operation.rowId,
						...projectedCells(operation.cells),
					});
				break;
			}
			case "remove-row":
				rows.delete(operation.rowId);
				break;
			case "replace-rows":
				rows.clear();
				for (const row of operation.rows)
					rows.set(row.id, {
						rowId: row.id,
						...projectedCells(row.cells),
					});
				break;
		}
	}
	return [...rows.values()];
}

function appendChoiceProjectionIssues(
	rows: readonly LookupChoiceProjectionRow[],
	path: readonly (string | number)[],
	issues: DesignConstructionIssue[],
	spelling: "designed" | "existing",
): void {
	const article = spelling === "existing" ? "An" : "A";
	const values: string[] = [];
	let missingValue = false;
	let missingLabel = false;
	for (const row of rows) {
		const valueText = row.value === undefined ? "" : String(row.value);
		const labelText = row.label === undefined ? "" : String(row.label);
		if (valueText === "" || /[\t\n\r ]/.test(valueText)) missingValue = true;
		else values.push(valueText);
		if (labelText.trim() === "") missingLabel = true;
	}
	if (missingValue)
		issues.push({
			path: [...path, "valueColumnId"],
			message: `Every ${spelling} lookup row needs a nonblank, whitespace-free saved value before this controlled choice can be built.`,
		});
	if (missingLabel)
		issues.push({
			path: [...path, "labelColumnId"],
			message: `Every ${spelling} lookup row needs a nonblank label before this controlled choice can be built.`,
		});
	if (new Set(values).size < 2)
		issues.push({
			path: [...path, "valueColumnId"],
			message: `${article} ${spelling} lookup-backed controlled choice needs at least two distinct real saved values before it can be built.`,
		});
	else if (new Set(values).size !== values.length)
		issues.push({
			path: [...path, "valueColumnId"],
			message: `${article} ${spelling} lookup-backed controlled choice cannot repeat a saved value across rows.`,
		});
}

function appendChoiceAttestationIssues(
	inspection: ExistingLookupChoiceSource["inspection"],
	path: readonly (string | number)[],
	issues: DesignConstructionIssue[],
): void {
	if (inspection.invalidValueCount > 0)
		issues.push({
			path: [...path, "valueColumnId"],
			message:
				"Every existing lookup row needs a nonblank, whitespace-free saved value before this controlled choice can be built.",
		});
	if (inspection.blankLabelCount > 0)
		issues.push({
			path: [...path, "labelColumnId"],
			message:
				"Every existing lookup row needs a nonblank label before this controlled choice can be built.",
		});
	if (inspection.distinctValueCount < 2)
		issues.push({
			path: [...path, "valueColumnId"],
			message:
				"An existing lookup-backed controlled choice needs at least two distinct real saved values before it can be built.",
		});
	else if (inspection.duplicateValueCount > 0)
		issues.push({
			path: [...path, "valueColumnId"],
			message:
				"An existing lookup-backed controlled choice cannot repeat a saved value across rows.",
		});
}

export function existingLookupChoicePostChangeIssues(
	contract: AppDesignContract,
	source: ExistingLookupChoiceSource,
	initialRows: readonly LookupChoiceProjectionRow[],
	path: readonly (string | number)[],
): DesignConstructionIssue[] {
	const issues: DesignConstructionIssue[] = [];
	appendChoiceProjectionIssues(
		existingLookupChoiceRowsAfterChanges(contract, source, initialRows),
		path,
		issues,
		"existing",
	);
	return issues;
}

/** Admission for semantics that the Blueprint field grammar must be able to
 * construct. Finalization and deterministic plan derivation apply this
 * buildability proof to every newly accepted design. */
export function designConstructionIssues(
	contract: AppDesignContract,
): DesignConstructionIssue[] {
	const issues: DesignConstructionIssue[] = [];
	const designedTables = new Map(
		contract.lookupTables.flatMap((table) =>
			table.kind === "create" ? [[table.id, table] as const] : [],
		),
	);
	const checkLookupChoiceRows = (
		source: RecordProperty["choiceSource"],
		path: readonly (string | number)[],
	): void => {
		if (source?.kind === "existing-project-lookup" && "tableId" in source) {
			const changed = contract.lookupTables.find(
				(table) =>
					table.kind === "modify-existing" && table.tableId === source.tableId,
			);
			if (
				changed !== undefined &&
				changed.kind === "modify-existing" &&
				changed.expectedTableRevision !== source.inspection.tableRevision
			)
				issues.push({
					path: [...path, "inspection", "tableRevision"],
					message:
						"The choice inspection and approved existing-table change must bind the same inspected table revision.",
				});
			const rowOperations =
				changed?.kind === "modify-existing"
					? changed.operations.filter((operation) =>
							["add-row", "update-row", "remove-row", "replace-rows"].includes(
								operation.kind,
							),
						)
					: [];
			const replacesRows = rowOperations.some(
				(operation) => operation.kind === "replace-rows",
			);
			if (replacesRows)
				issues.push(
					...existingLookupChoicePostChangeIssues(contract, source, [], path),
				);
			else if (rowOperations.length === 0)
				appendChoiceAttestationIssues(source.inspection, path, issues);
			return;
		}
		if (source?.kind !== "designed-project-lookup") return;
		const table = designedTables.get(source.tableId);
		if (table === undefined) return;
		appendChoiceProjectionIssues(
			table.rows.map((row) => ({
				rowId: row.id,
				value: row.cells.find((cell) => cell.columnId === source.valueColumnId)
					?.value,
				label: row.cells.find((cell) => cell.columnId === source.labelColumnId)
					?.value,
			})),
			path,
			issues,
			"designed",
		);
	};
	const localization = contract.charter.localization;
	if (localization !== undefined) {
		for (const [targetIndex, target] of localization.targets.entries()) {
			if (target.strategy !== "translate-with-nova") continue;
			const capability = automaticTranslationCapability(
				localization.sourceLanguage,
				target.language,
			);
			if (capability.status === "available") continue;
			issues.push({
				path: ["charter", "localization", "targets", targetIndex, "strategy"],
				message: `Automatic translation from ${languageDescriptor(localization.sourceLanguage)} to ${languageDescriptor(target.language)} is not available. ${capability.explanation} Use copy-only and plan human translation, or choose two distinct languages from Nova's automatic-translation launch set.`,
			});
		}
	}
	contract.records.forEach((record, recordIndex) => {
		record.properties.forEach((property, propertyIndex) => {
			if (property.dataShape === "unknown") {
				issues.push({
					path: [
						"records",
						recordIndex,
						"properties",
						propertyIndex,
						"dataShape",
					],
					message:
						"A record property needs a concrete data shape before its field and storage can be authored.",
				});
			}
			if (
				(property.dataShape === "single-choice" ||
					property.dataShape === "multiple-choice") &&
				property.choiceSource === undefined &&
				distinctRealChoices(property.choiceValues) < 2
			) {
				issues.push({
					path: [
						"records",
						recordIndex,
						"properties",
						propertyIndex,
						"choiceValues",
					],
					message:
						"A controlled-choice property needs at least two distinct real values before it can be built.",
				});
			}
			checkLookupChoiceRows(property.choiceSource, [
				"records",
				recordIndex,
				"properties",
				propertyIndex,
				"choiceSource",
			]);
		});
	});
	contract.workflows.forEach((workflow, workflowIndex) => {
		if (
			workflow.inputs.length === 0 &&
			workflow.decisions.length === 0 &&
			workflow.recordEffects.length === 0 &&
			workflow.authoredFeatures.length === 0 &&
			workflow.readback.length === 0
		) {
			issues.push({
				path: ["workflows", workflowIndex],
				message:
					"An included workflow needs executable inputs, decisions, record effects, readback, or an explicitly authored feature; an empty workflow shell cannot be constructed.",
			});
		}
		workflow.inputs.forEach((input, inputIndex) => {
			if (input.propertyId === undefined && input.dataShape === "unknown") {
				issues.push({
					path: ["workflows", workflowIndex, "inputs", inputIndex, "dataShape"],
					message:
						"A form-only input needs a concrete data shape before it can be authored.",
				});
			}
			if (
				input.propertyId === undefined &&
				(input.dataShape === "single-choice" ||
					input.dataShape === "multiple-choice") &&
				input.choiceSource === undefined &&
				distinctRealChoices(input.choiceValues) < 2
			) {
				issues.push({
					path: [
						"workflows",
						workflowIndex,
						"inputs",
						inputIndex,
						"choiceValues",
					],
					message:
						"A controlled-choice form input needs at least two distinct real values before it can be built.",
				});
			}
			checkLookupChoiceRows(input.choiceSource, [
				"workflows",
				workflowIndex,
				"inputs",
				inputIndex,
				"choiceSource",
			]);
		});
		workflow.decisions.forEach((decision, decisionIndex) => {
			if (decision.inputPropertyIds.length === 0) {
				issues.push({
					path: [
						"workflows",
						workflowIndex,
						"decisions",
						decisionIndex,
						"inputPropertyIds",
					],
					message:
						"A workflow decision must name the accepted property inputs that determine it.",
				});
			}
			if (distinctRealChoices(decision.outcomes) < 2) {
				issues.push({
					path: [
						"workflows",
						workflowIndex,
						"decisions",
						decisionIndex,
						"outcomes",
					],
					message:
						"A workflow decision needs at least two distinct concrete outcomes before construction.",
				});
			}
		});
	});
	const includedWorkflowIds = new Set(contract.charter.includedWorkflowIds);
	for (const [workflowIndex, workflow] of contract.workflows.entries()) {
		if (!includedWorkflowIds.has(workflow.id)) continue;
		if (
			!contract.formCompositions.some(
				(composition) => composition.workflowId === workflow.id,
			)
		) {
			issues.push({
				path: ["workflows", workflowIndex],
				message:
					"Every included workflow needs at least one complete form composition before construction.",
			});
		}
	}
	if (contract.moduleCompositions.length === 0) {
		issues.push({
			path: ["moduleCompositions"],
			message:
				"The accepted design needs deliberate menu/module composition before construction.",
		});
	}
	for (const [listIndex, list] of contract.lists.entries()) {
		const placements = contract.moduleCompositions.filter((composition) =>
			composition.listIds.includes(list.id),
		);
		if (placements.length !== 1) {
			issues.push({
				path: ["lists", listIndex],
				message:
					placements.length === 0
						? "Every accepted list needs exactly one module composition before construction. Add this list to a queue-owning module whose host record is the list's record."
						: "Every accepted list needs exactly one module composition before construction. Give repeated placements distinct list identities instead of reusing one list across modules.",
			});
		}
	}
	for (const [navigationIndex, navigation] of contract.navigation.entries()) {
		const placements = contract.moduleCompositions.filter((composition) =>
			composition.navigationIds.includes(navigation.id),
		);
		if (placements.length !== 1) {
			issues.push({
				path: ["navigation", navigationIndex],
				message:
					placements.length === 0
						? "Every accepted navigation entry needs exactly one module composition before construction. Place it with the workflows or lists it exposes."
						: "Every accepted navigation entry needs exactly one module composition before construction. Give repeated destinations distinct navigation identities instead of reusing one entry across modules.",
			});
		}
	}
	const includedIds = new Set<string>([
		...contract.charter.includedWorkflowIds,
		...contract.actors.map((actor) => actor.id),
		...contract.records.map((record) => record.id),
		...contract.records.flatMap((record) =>
			record.properties.map((property) => property.id),
		),
		...contract.lists.map((list) => list.id),
		...contract.access.map((policy) => policy.id),
		...contract.navigation.map((navigation) => navigation.id),
		...contract.moduleCompositions.map((composition) => composition.id),
		...contract.formCompositions.flatMap((composition) => [
			composition.id,
			...(composition.layout.kind === "sectioned"
				? composition.layout.sections.flatMap((section) => [
						section.id,
						...section.items.map((item) => item.id),
					])
				: composition.layout.items.map((item) => item.id)),
		]),
		...contract.lookupTables.flatMap((table) => [
			table.id,
			...(table.kind === "create"
				? [
						...table.columns.map((column) => column.id),
						...table.rows.map((row) => row.id),
					]
				: table.operations.flatMap((operation) => {
						switch (operation.kind) {
							case "add-column":
								return [operation.column.id];
							case "add-row":
								return [operation.rowId];
							case "replace-rows":
								return operation.rows.map((row) => row.id);
							default:
								return [];
						}
					})),
		]),
	]);
	/* The authored `blocking` flag is the construction gate, honoring a user
	 * who delegated the decision: a non-blocking question is a recorded caveat
	 * beside concrete design, and the concreteness checks above catch design
	 * that is not actually buildable regardless of what any question claims. */
	contract.openQuestions.forEach((question, questionIndex) => {
		if (
			question.blocking &&
			question.relatedElementIds.some((id) => includedIds.has(id))
		) {
			issues.push({
				path: ["openQuestions", questionIndex],
				message:
					"A blocking question must be answered or its workflow explicitly excluded before a plan can exist.",
			});
		}
	});
	return issues;
}

/** Exact user questions when every remaining construction issue is already
 * represented by one authored open question. A mixed set still belongs to
 * model repair, so it deliberately returns null rather than hiding the
 * non-question defects behind a user pause. */
export function designConstructionQuestionRequirements(
	contract: AppDesignContract,
	issues: readonly DesignConstructionIssue[] = designConstructionIssues(
		contract,
	),
): OpenQuestion[] | null {
	const questions = issues.flatMap((issue) => {
		const [collection, index] = issue.path;
		if (collection !== "openQuestions" || typeof index !== "number") return [];
		const question = contract.openQuestions[index];
		return question?.question.trim() ? [{ ...question }] : [];
	});
	return questions.length === issues.length && questions.length > 0
		? questions
		: null;
}

/** Customer-facing text projection of construction question requirements.
 * Server protocol code must retain the identity-bearing requirements above so
 * two questions with identical prose cannot inherit one another's answers. */
export function designConstructionQuestions(
	contract: AppDesignContract,
	issues: readonly DesignConstructionIssue[] = designConstructionIssues(
		contract,
	),
): string[] | null {
	return (
		designConstructionQuestionRequirements(contract, issues)?.map((question) =>
			question.question.trim(),
		) ?? null
	);
}

/** Every stable semantic identity carried by a contract. */
export function collectContractIds(
	contract: AppDesignContract,
): ReadonlySet<string> {
	const ids = new Set<string>([contract.id]);
	for (const actor of contract.actors) ids.add(actor.id);
	for (const record of contract.records) {
		ids.add(record.id);
		for (const property of record.properties) ids.add(property.id);
	}
	for (const workflow of contract.workflows) ids.add(workflow.id);
	for (const list of contract.lists) ids.add(list.id);
	for (const policy of contract.access) ids.add(policy.id);
	for (const nav of contract.navigation) ids.add(nav.id);
	for (const composition of contract.moduleCompositions)
		ids.add(composition.id);
	for (const composition of contract.formCompositions) {
		ids.add(composition.id);
		if (composition.layout.kind === "sectioned") {
			for (const section of composition.layout.sections) {
				ids.add(section.id);
				for (const item of section.items) ids.add(item.id);
			}
		} else {
			for (const item of composition.layout.items) ids.add(item.id);
		}
	}
	for (const table of contract.lookupTables) {
		ids.add(table.id);
		if (table.kind === "create") {
			for (const column of table.columns) ids.add(column.id);
			for (const row of table.rows) ids.add(row.id);
			continue;
		}
		for (const operation of table.operations) {
			switch (operation.kind) {
				case "add-column":
					ids.add(operation.column.id);
					break;
				case "add-row":
					ids.add(operation.rowId);
					break;
				case "replace-rows":
					for (const row of operation.rows) ids.add(row.id);
					break;
			}
		}
	}
	for (const requirement of contract.externalRequirements)
		ids.add(requirement.id);
	for (const decision of contract.decisions) ids.add(decision.id);
	for (const assumption of contract.assumptions) ids.add(assumption.id);
	for (const question of contract.openQuestions) ids.add(question.id);
	return ids;
}
