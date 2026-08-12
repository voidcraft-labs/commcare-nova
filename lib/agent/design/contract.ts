/**
 * The lean Design Contract v1.
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
import { validateDesignGraph } from "@/lib/agent/design/graph";
import { designIdSchema } from "@/lib/agent/design/ids";
import { uuidSchema } from "@/lib/domain/uuid";

export const factDataShapeSchema = z.enum([
	"text",
	"integer",
	"decimal",
	"boolean",
	"date",
	"datetime",
	"single-choice",
	"multiple-choice",
	"location",
	"attachment",
	"unknown",
]);
export type FactDataShape = z.infer<typeof factDataShapeSchema>;

export const appCharterSchema = z
	.object({
		appName: z.string().min(1),
		objective: z.string().min(1),
		/** A design session produces exactly one app in the current Project. */
		appCount: z.literal(1),
		projectScope: z.literal("current-project"),
		includedWorkflowIds: z.array(designIdSchema).min(1),
		excludedWorkflows: z.array(z.string().min(1)),
		deliveryContext: z.enum([
			"offline-first",
			"online-first",
			"mixed",
			"not-decided",
		]),
		initialWorkflowId: designIdSchema,
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

/** Semantic intent to use a lookup table that already exists in the current
 * Project. Names stay human-readable in the Design Contract; the executor
 * resolves the current stable table/column identities before authoring. */
export const existingLookupChoiceSourceSchema = z
	.object({
		kind: z.literal("existing-project-lookup"),
		table: z.string().min(1),
		valueColumn: z.string().min(1),
		labelColumn: z.string().min(1),
	})
	.strict();
export type ExistingLookupChoiceSource = z.infer<
	typeof existingLookupChoiceSourceSchema
>;

/** Implementation provenance, never part of the Design Contract payload. */
export const actorRuntimeBindingSchema = z
	.object({
		actorId: designIdSchema,
		userTypeUuid: uuidSchema.optional(),
		personaUuids: z.array(uuidSchema).default([]),
	})
	.strict();
export type ActorRuntimeBinding = z.infer<typeof actorRuntimeBindingSchema>;

export const recordPropertySchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		meaning: z.string().min(1),
		dataShape: factDataShapeSchema,
		sensitivity: z
			.enum(["ordinary", "sensitive", "highly-sensitive"])
			.default("ordinary"),
		requiredWhen: z.string().min(1).optional(),
		choiceValues: z.array(z.string().min(1)).optional(),
		choiceSource: existingLookupChoiceSourceSchema.optional(),
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
					"A choice property must name its allowed values or an existing Project lookup source.",
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
					"A choice property must use either inline values or an existing Project lookup source, not both.",
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
export type RecordProperty = z.infer<typeof recordPropertySchema>;

export const recordConceptSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		purpose: z.string().min(1),
		parentRecordId: designIdSchema.optional(),
		relationshipMeaning: z.string().min(1).optional(),
		lifecycleStates: z.array(z.string().min(1)),
		properties: z.array(recordPropertySchema),
	})
	.strict();
export type RecordConcept = z.infer<typeof recordConceptSchema>;

export const workflowInputSchema = z
	.object({
		handle: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
		name: z.string().min(1),
		purpose: z.string().min(1),
		propertyId: designIdSchema.optional(),
		dataShape: factDataShapeSchema.optional(),
		requiredWhen: z.string().min(1).optional(),
		choiceValues: z.array(z.string().min(1)).optional(),
		choiceSource: existingLookupChoiceSourceSchema.optional(),
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
					"A form-only choice input must name its allowed values or an existing Project lookup source.",
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
					"A form-only choice input must use either inline values or an existing Project lookup source, not both.",
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
		condition: z.string().min(1).optional(),
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

export const workflowSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		actorIds: z.array(designIdSchema).min(1),
		goal: z.string().min(1),
		trigger: z.string().min(1),
		contextRecordId: designIdSchema.optional(),
		prerequisiteWorkflowIds: z.array(designIdSchema),
		prerequisites: z.array(z.string().min(1)),
		inputs: z.array(workflowInputSchema),
		decisions: z.array(workflowDecisionSchema),
		recordEffects: z.array(workflowRecordEffectSchema),
		/** Optional on input for persisted Design Contract v1 compatibility. */
		authoredFeatures: z.array(workflowAuthoredFeatureSchema).optional(),
		readback: z.array(workflowReadbackSchema),
		exceptions: z.array(z.string().min(1)),
		externalRequirementIds: z.array(designIdSchema),
		acceptanceExamples: z.array(workflowAcceptanceExampleSchema).min(1),
	})
	.strict();
export type Workflow = z.infer<typeof workflowSchema>;

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
		selectionWorkflowId: designIdSchema.optional(),
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
		orderRationale: z.string().min(1),
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
		timing: z.enum([
			"before-construction",
			"before-workflow",
			"before-runtime",
			"before-deployment",
		]),
		/** Missing runtime/deployment assets do not block app construction. */
		blocksConstruction: z.boolean(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.blocksConstruction &&
			value.timing !== "before-construction" &&
			value.timing !== "before-workflow"
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
		structuralImpact: z.enum(["none", "local", "architecture"]),
		blocking: z.boolean(),
		relatedElementIds: z.array(designIdSchema),
	})
	.strict();
export type OpenQuestion = z.infer<typeof openQuestionSchema>;

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
		externalRequirements: z.array(externalRequirementSchema),
		decisions: z.array(architectureDecisionSchema),
		assumptions: z.array(assumptionSchema),
		openQuestions: z.array(openQuestionSchema),
	})
	.strict();

export type AppDesignContract = z.infer<typeof appDesignContractBaseSchema>;

export const appDesignContractSchema =
	appDesignContractBaseSchema.superRefine(validateDesignGraph);

export interface DesignConstructionIssue {
	readonly path: readonly (string | number)[];
	readonly message: string;
}

function distinctRealChoices(values: readonly string[] | undefined): number {
	return new Set(
		(values ?? []).map((value) => value.trim()).filter((value) => value !== ""),
	).size;
}

/** New-artifact admission for semantics that the Blueprint field grammar must
 * be able to construct. The base v1 parser remains compatible with already-
 * persisted artifacts; finalization and deterministic plan derivation apply
 * this stricter buildability proof to every newly accepted design. */
export function designConstructionIssues(
	contract: AppDesignContract,
): DesignConstructionIssue[] {
	const issues: DesignConstructionIssue[] = [];
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
		});
	});
	contract.workflows.forEach((workflow, workflowIndex) => {
		if (
			workflow.inputs.length === 0 &&
			workflow.decisions.length === 0 &&
			workflow.recordEffects.length === 0 &&
			(workflow.authoredFeatures?.length ?? 0) === 0 &&
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
	for (const requirement of contract.externalRequirements)
		ids.add(requirement.id);
	for (const decision of contract.decisions) ids.add(decision.id);
	for (const assumption of contract.assumptions) ids.add(assumption.id);
	for (const question of contract.openQuestions) ids.add(question.id);
	return ids;
}
