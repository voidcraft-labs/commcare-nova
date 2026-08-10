/**
 * The Design Contract — the typed, versioned, NON-EXECUTABLE representation
 * of what an app is for: actors, tasks, records, facts, rules, read models,
 * access, navigation, decisions, assumptions, and acceptance scenarios.
 *
 * This vocabulary is deliberately NOT Blueprint vocabulary. A task describes
 * a real-world transaction — a CommCare form is one possible lowering of it;
 * a read model describes a work queue — a case list is its primary lowering
 * target. Nothing here has a wire emitter, can be previewed, or can execute:
 * design artifacts influence a build brief and nothing else. Design identity
 * is the separate `DesignId` brand (`ids.ts`) — never a Blueprint UUID.
 *
 * The Zod schemas are the authority: the author/reviser structured calls
 * produce against them and every persisted artifact reads back through them,
 * unknown keys failing closed. The root contract proves its internal graph
 * (`graph.ts::validateDesignGraph`) inside the parse, so an incoherent
 * contract is an invalid structured output, never a persisted artifact.
 */

import { z } from "zod";
import { sourceClaimSchema } from "@/lib/agent/design/evidence";
import { validateDesignGraph } from "@/lib/agent/design/graph";
import { designIdSchema } from "@/lib/agent/design/ids";
import { uuidSchema } from "@/lib/domain/uuid";

const evidenceSchema = z.array(designIdSchema);

/**
 * A UX-level description of a person doing work — who they are, what they
 * are trying to achieve, and what constrains them. NOT a Blueprint user type
 * and NOT a Preview persona: a later implementation binding maps an actor to
 * those concepts (`actorRuntimeBindingSchema`), and the binding is
 * implementation provenance, never part of the actor's meaning.
 */
export const designActorSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		goals: z.array(z.string().min(1)).min(1),
		responsibilities: z.array(z.string().min(1)),
		workContext: z.array(z.string().min(1)),
		authority: z.array(z.string().min(1)),
		constraints: z.array(z.string().min(1)),
		failureRisks: z.array(z.string().min(1)),
		evidence: evidenceSchema,
	})
	.strict();
export type DesignActor = z.infer<typeof designActorSchema>;

/** Implementation provenance mapping an actor to Blueprint user types and
 *  Preview personas. Lives beside the actor schema because the two are read
 *  together, but it is never part of the contract payload. */
export const actorRuntimeBindingSchema = z
	.object({
		actorId: designIdSchema,
		userTypeUuid: uuidSchema.optional(),
		personaUuids: z.array(uuidSchema).default([]),
	})
	.strict();
export type ActorRuntimeBinding = z.infer<typeof actorRuntimeBindingSchema>;

/**
 * A real-world thing the workflow tracks over time. The primary lowering
 * target is a case type; `parentRecordId` names a real-world containment or
 * responsibility relationship (`relationshipMeaning` states what it means),
 * which lowers to a case parent relationship when implemented.
 */
export const recordConceptSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		purpose: z.string().min(1),
		parentRecordId: designIdSchema.optional(),
		relationshipMeaning: z.string().min(1).optional(),
		lifecycleStates: z.array(z.string().min(1)),
		evidence: evidenceSchema,
	})
	.strict();
export type RecordConcept = z.infer<typeof recordConceptSchema>;

/**
 * Where a fact's value comes from — load-bearing for lowering: an `answer`
 * fact lowers to a direct field-to-case write, a `derived` fact needs a
 * calculated writer, a `session` fact reads worker/session context, a
 * `lookup` fact reads Project reference data, `external` arrives outside the
 * app, and `constant` is fixed. The conformance analyzer compares this
 * declared source with the implementation to find unjustified hidden writers.
 *
 * The `lookup` arm's ids name the contract's own lookup vocabulary
 * (`lookupIntents`): the table intent the value is read from, and one of THAT
 * table's own column intents. The graph validator proves both, exactly like
 * every other reference.
 */
export const factSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("answer"), taskInputId: designIdSchema }).strict(),
	z.object({ kind: z.literal("derived"), ruleId: designIdSchema }).strict(),
	z.object({ kind: z.literal("session"), value: z.string().min(1) }).strict(),
	z
		.object({
			kind: z.literal("lookup"),
			lookupIntentId: designIdSchema,
			columnIntentId: designIdSchema,
		})
		.strict(),
	z.object({ kind: z.literal("external") }).strict(),
	z
		.object({
			kind: z.literal("constant"),
			/** A fixed scalar — the only shape a constant fact can lower to (a
			 *  fixed form value or case write). */
			value: z.union([z.string(), z.number(), z.boolean()]),
		})
		.strict(),
]);
export type FactSource = z.infer<typeof factSourceSchema>;

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

/**
 * One durable piece of information about a record — the design-level
 * counterpart of a case property. `writerTaskIds` and `readerIds` are the
 * read/write coherence graph the validator proves and the conformance
 * analyzer replays against the implementation.
 */
export const factDefinitionSchema = z
	.object({
		id: designIdSchema,
		recordId: designIdSchema,
		name: z.string().min(1),
		meaning: z.string().min(1),
		dataShape: factDataShapeSchema,
		source: factSourceSchema,
		sensitivity: z
			.enum(["ordinary", "sensitive", "highly-sensitive"])
			.default("ordinary"),
		requiredIntent: z.string().min(1).optional(),
		writerTaskIds: z.array(designIdSchema),
		readerIds: z.array(designIdSchema),
		evidence: evidenceSchema,
	})
	.strict();
export type FactDefinition = z.infer<typeof factDefinitionSchema>;

/** One thing a worker is asked during a task. `factId` names the fact this
 *  answer persists to (absent for ephemeral inputs used only in decisions). */
export const taskInputSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		purpose: z.string().min(1),
		factId: designIdSchema.optional(),
		requiredIntent: z.string().min(1).optional(),
		choiceSetIntent: z.array(z.string().min(1)).optional(),
		/** Omit when the input inherits the containing task's evidence. */
		evidence: evidenceSchema.optional(),
	})
	.strict();
export type TaskInput = z.infer<typeof taskInputSchema>;

/** One intended durable write: which fact changes, from what, under which
 *  rule. */
export const writeIntentSchema = z
	.object({
		id: designIdSchema,
		targetFactId: designIdSchema,
		sourceDescription: z.string().min(1),
		ruleId: designIdSchema.optional(),
	})
	.strict();
export type WriteIntent = z.infer<typeof writeIntentSchema>;

/**
 * A record lifecycle change a task can cause — create, update, close, link,
 * or reassign. Its writes must target facts of its target record (the graph
 * validator proves it).
 */
export const lifecycleTransitionSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		sourceRecordId: designIdSchema.optional(),
		targetRecordId: designIdSchema,
		transitionKind: z.enum(["create", "update", "close", "link", "reassign"]),
		conditionRuleId: designIdSchema.optional(),
		writes: z.array(writeIntentSchema),
		outcomeDescription: z.string().min(1),
		evidence: evidenceSchema,
	})
	.strict();
export type LifecycleTransition = z.infer<typeof lifecycleTransitionSchema>;

/**
 * A real-world transaction one actor performs: its trigger, context record,
 * inputs, decisions, writes, lifecycle transitions, and what the actor reads
 * back afterwards. A CommCare form is one possible lowering of a task; it is
 * not the task itself.
 */
export const taskSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		actorId: designIdSchema,
		goal: z.string().min(1),
		trigger: z.string().min(1),
		contextRecordId: designIdSchema.optional(),
		preconditions: z.array(z.string().min(1)),
		inputs: z.array(taskInputSchema),
		decisionRuleIds: z.array(designIdSchema),
		writes: z.array(writeIntentSchema),
		transitionIds: z.array(designIdSchema),
		readBackIds: z.array(designIdSchema),
		exceptionPaths: z.array(z.string().min(1)),
		evidence: evidenceSchema,
	})
	.strict();
export type Task = z.infer<typeof taskSchema>;

/**
 * A business rule as typed references plus an exact semantic statement —
 * deliberately NOT a second executable expression language. The build
 * executor lowers a rule into the canonical Predicate/ValueExpression/XPath
 * representation; conformance compares that implementation with the
 * statement. No design rule executes directly.
 */
export const ruleIntentSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		statement: z.string().min(1),
		inputIds: z.array(designIdSchema),
		outputFactIds: z.array(designIdSchema),
		evidence: evidenceSchema,
	})
	.strict();
export type RuleIntent = z.infer<typeof ruleIntentSchema>;

/**
 * A task-oriented work queue: who opens it, what decision it supports, what
 * they scan, how urgency is ordered, and what happens after selection. A
 * CommCare case list is the primary lowering target.
 */
export const readModelSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		actorIds: z.array(designIdSchema).min(1),
		recordId: designIdSchema,
		decisionSupported: z.string().min(1),
		filters: z.array(z.string().min(1)),
		sortIntent: z.array(z.string().min(1)),
		scanFactIds: z.array(designIdSchema),
		detailFactIds: z.array(designIdSchema),
		searchFactIds: z.array(designIdSchema),
		selectionTaskId: designIdSchema.optional(),
		emptyStateMeaning: z.string().min(1),
		evidence: evidenceSchema,
	})
	.strict();
export type ReadModel = z.infer<typeof readModelSchema>;

/** One column of a lookup table intent — the design-level counterpart of a
 *  data-table column. Column ids live in the contract's ONE id namespace, so
 *  a fact can name the exact column its value is read from. */
export const lookupColumnIntentSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		meaning: z.string().min(1),
		/** Omit when the column inherits its containing table's evidence. */
		evidence: evidenceSchema.optional(),
	})
	.strict();
export type LookupColumnIntent = z.infer<typeof lookupColumnIntentSchema>;

/** Effective evidence without repeating parent citations in the artifact. */
export function effectiveTaskInputEvidence(
	task: Pick<Task, "evidence">,
	input: Pick<TaskInput, "evidence">,
) {
	return input.evidence ?? task.evidence;
}

export function effectiveLookupColumnEvidence(
	table: Pick<LookupTableIntent, "evidence">,
	column: Pick<LookupColumnIntent, "evidence">,
) {
	return column.evidence ?? table.evidence;
}

/**
 * Reference data the workflow reads but does not collect — the design-level
 * counterpart of a Project lookup table. A `lookup`-sourced fact names one of
 * these tables and one of that table's columns.
 *
 * A lookup intent is deliberately NOT an implementable intent
 * (`buildPlan.ts::implementableIntentIds`): it describes data that lives in
 * the Project beside the app, loaded by an external action, not Blueprint
 * structure a slice constructs. No slice owns one.
 */
export const lookupTableIntentSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		purpose: z.string().min(1),
		columns: z.array(lookupColumnIntentSchema).min(1),
		evidence: evidenceSchema,
	})
	.strict();
export type LookupTableIntent = z.infer<typeof lookupTableIntentSchema>;

/** Who may do what to which intents, and under what condition. */
export const accessPolicySchema = z
	.object({
		id: designIdSchema,
		actorId: designIdSchema,
		targetIntentIds: z.array(designIdSchema).min(1),
		capability: z.enum([
			"discover",
			"view",
			"create",
			"update",
			"close",
			"administer",
		]),
		condition: z.string().min(1).optional(),
		locationScopeIntent: z.string().min(1).optional(),
		evidence: evidenceSchema,
	})
	.strict();
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

/**
 * A navigation destination decided from worker tasks and read models —
 * module/menu hierarchy is the lowering target. The parent graph is acyclic
 * (proved by the graph validator).
 */
export const navigationIntentSchema = z
	.object({
		id: designIdSchema,
		actorIds: z.array(designIdSchema).min(1),
		name: z.string().min(1),
		purpose: z.string().min(1),
		entryTaskIds: z.array(designIdSchema),
		readModelIds: z.array(designIdSchema),
		parentNavigationId: designIdSchema.optional(),
		orderRationale: z.string().min(1),
	})
	.strict();
export type NavigationIntent = z.infer<typeof navigationIntentSchema>;

/** A recorded architecture decision: the question, the options considered
 *  (ids local to this decision), the selected option, and why. */
export const architectureDecisionSchema = z
	.object({
		id: designIdSchema,
		question: z.string().min(1),
		options: z
			.array(
				z
					.object({
						id: designIdSchema,
						description: z.string().min(1),
						consequences: z.array(z.string().min(1)),
					})
					.strict(),
			)
			.min(1)
			.max(3),
		selectedOptionId: designIdSchema,
		rationale: z.string().min(1),
		evidence: evidenceSchema,
	})
	.strict();
export type ArchitectureDecision = z.infer<typeof architectureDecisionSchema>;

export const assumptionSchema = z
	.object({
		id: designIdSchema,
		statement: z.string().min(1),
		consequenceIfWrong: z.string().min(1),
		evidence: evidenceSchema,
	})
	.strict();
export type Assumption = z.infer<typeof assumptionSchema>;

export const openQuestionSchema = z
	.object({
		id: designIdSchema,
		question: z.string().min(1),
		structuralImpact: z.enum(["none", "local", "architecture"]),
		blocking: z.boolean(),
		relatedIntentIds: z.array(designIdSchema),
	})
	.strict();
export type OpenQuestion = z.infer<typeof openQuestionSchema>;

/** Given/when/then acceptance evidence tied to the intents it exercises. A
 *  structural-path check over these is design-level evidence only — never a
 *  runtime proof. */
export const acceptanceScenarioSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		actorId: designIdSchema,
		given: z.array(z.string().min(1)),
		when: z.array(z.string().min(1)).min(1),
		/* Given/when/THEN is the scenario vocabulary; the value is an array,
		 * never a function, so a scenario object is not thenable. */
		// biome-ignore lint/suspicious/noThenProperty: given/when/then vocabulary; array value, not a thenable
		then: z.array(z.string().min(1)).min(1),
		relatedIntentIds: z.array(designIdSchema),
		evidence: evidenceSchema,
	})
	.strict();
export type AcceptanceScenario = z.infer<typeof acceptanceScenarioSchema>;

export const deferredRequirementSchema = z
	.object({
		claimId: designIdSchema,
		reason: z.string().min(1),
	})
	.strict();
export type DeferredRequirement = z.infer<typeof deferredRequirementSchema>;

/**
 * The root Design Contract. `schemaVersion` is the artifact dialect —
 * a prompt/schema change that alters meaning bumps it and re-produces
 * artifacts; it never silently reinterprets an old persisted body.
 */
export const appDesignContractBaseSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: designIdSchema,
		title: z.string().min(1),
		objective: z.string().min(1),
		inScope: z.array(z.string().min(1)),
		outOfScope: z.array(z.string().min(1)),
		sourceClaims: z.array(sourceClaimSchema),
		actors: z.array(designActorSchema).min(1),
		records: z.array(recordConceptSchema),
		facts: z.array(factDefinitionSchema),
		rules: z.array(ruleIntentSchema),
		tasks: z.array(taskSchema).min(1),
		transitions: z.array(lifecycleTransitionSchema),
		readModels: z.array(readModelSchema),
		lookupIntents: z.array(lookupTableIntentSchema),
		accessPolicies: z.array(accessPolicySchema),
		navigation: z.array(navigationIntentSchema),
		decisions: z.array(architectureDecisionSchema),
		assumptions: z.array(assumptionSchema),
		openQuestions: z.array(openQuestionSchema),
		acceptanceScenarios: z.array(acceptanceScenarioSchema).min(1),
		deferredRequirements: z.array(deferredRequirementSchema),
	})
	.strict();

export type AppDesignContract = z.infer<typeof appDesignContractBaseSchema>;

/** The parse-time authority: structural shape plus the full deterministic
 *  graph proof. Every producer and every persisted read uses THIS schema. */
export const appDesignContractSchema =
	appDesignContractBaseSchema.superRefine(validateDesignGraph);
