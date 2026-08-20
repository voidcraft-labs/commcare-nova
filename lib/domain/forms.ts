// lib/domain/forms.ts
import { z } from "zod";
import { formIconRefSchema } from "./builtinIcons";
import { authoredCasePropertyNameSchema } from "./casePropertyName";
import { persistableJsonPositiveIntegerSchema } from "./jsonNumber";
import { mediaAssetIdSchema } from "./multimedia";
import {
	type Predicate,
	predicateSchema,
	type ValueExpression,
	valueExpressionSchema,
	XML_ELEMENT_NAME_PATTERN,
} from "./predicate/types";
import { type Uuid, uuidSchema } from "./uuid";
import { xpathExpressionSchema } from "./xpath";

export const FORM_TYPES = [
	"registration",
	"followup",
	"close",
	"survey",
] as const;
export type FormType = (typeof FORM_TYPES)[number];

/**
 * Person-facing display label per form type — the single source the builder's
 * add-form menu (the chooser) and the created form's default name both read, so
 * the label a user picks is the name they get. Mirrors `formTypeIcons`: form
 * types are a domain concept, so their display vocabulary lives here.
 */
export const formTypeLabels: Record<FormType, string> = {
	registration: "Registration",
	followup: "Follow-up",
	close: "Close",
	survey: "Survey",
};

export const CASE_FORM_TYPES: ReadonlySet<FormType> = new Set([
	"registration",
	"followup",
	"close",
]);

export const CASE_LOADING_FORM_TYPES: ReadonlySet<FormType> = new Set([
	"followup",
	"close",
]);

/**
 * Whether a module's running-app navigation is "case-first" — entering it
 * shows the case list (then, when more than one form, a form menu) instead
 * of a form list.
 *
 * Mirrors CommCare's runtime exactly (`commcare-core`
 * `CommCareSession.getDataNeededByAllEntries`): the case selection is
 * hoisted ahead of the form choice only when EVERY form in the module needs
 * the same `case_id` datum — i.e. every form is case-loading
 * (followup/close). A registration form needs a fresh `case_id_new_*` datum
 * and a survey form needs none, so either one breaks the shared datum and
 * the module becomes forms-first (the worker picks the form, then its case).
 * A module with no case type or no forms is never case-first.
 */
export function isCaseFirstModule(
	formTypes: readonly FormType[],
	hasCaseType: boolean,
): boolean {
	return (
		hasCaseType &&
		formTypes.length > 0 &&
		formTypes.every((t) => CASE_LOADING_FORM_TYPES.has(t))
	);
}

export const POST_SUBMIT_DESTINATIONS = [
	"app_home",
	"module",
	"previous",
] as const;
export type PostSubmitDestination = (typeof POST_SUBMIT_DESTINATIONS)[number];

/**
 * The one stored and machine-authored navigation vocabulary:
 *   "app_home" → App Home (main menu)
 *   "module"   → This Module (case list / form list)
 *   "previous" → Previous Screen (back to where the user was)
 * Form-type-aware default for post_submit when the field is absent.
 * Case-loading forms (followup, close) return to the previous screen
 * (the case list they came from); registration and survey go home.
 */
export function defaultPostSubmit(formType: FormType): PostSubmitDestination {
	return CASE_LOADING_FORM_TYPES.has(formType) ? "previous" : "app_home";
}

const closeConditionSchema = z
	.object({
		// The checked field, by stable uuid — rename-proof identity, the
		// same contract as form-link targets. The frozen one-off migration
		// converts textual ids before this final schema is installed; the live
		// schema admits no empty or unresolved placeholder.
		field: uuidSchema,
		answer: z.string(),
		operator: z.enum(["=", "selected"]).optional(),
	})
	.strict();

const formLinkDatumSchema = z
	.object({
		name: z.string().min(1),
		xpath: xpathExpressionSchema,
	})
	.strict();
export type FormLinkDatum = z.infer<typeof formLinkDatumSchema>;

/**
 * Each datum name once. HQ keys manual datums by name in a dict and would
 * silently keep the last; Nova refuses the duplicate at the boundary so the
 * emitted frame is the authored frame. Shared by the link schema and the
 * link patch schema so the rule lives in one place.
 */
export function uniqueFormLinkDatumNames(
	datums: readonly FormLinkDatum[] | null | undefined,
	ctx: z.RefinementCtx,
	path: readonly (string | number)[] = ["datums"],
): void {
	const seen = new Set<string>();
	for (const [index, datum] of (datums ?? []).entries()) {
		if (seen.has(datum.name)) {
			ctx.addIssue({
				code: "custom",
				path: [...path, index, "name"],
				message: `The session value "${datum.name}" is listed twice on this link. Name each value once.`,
			});
		}
		seen.add(datum.name);
	}
}

export const formLinkTargetSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("form"),
			moduleUuid: uuidSchema,
			formUuid: uuidSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("module"),
			moduleUuid: uuidSchema,
		})
		.strict(),
]);

/**
 * The bare link object, before the datum-uniqueness refinement. The mutation
 * layer builds the link PATCH from this shape (`clearablePartialPatch` needs
 * a plain object schema); everything else uses `formLinkSchema`.
 */
export const formLinkObjectSchema = z
	.object({
		/** Immutable identity: every editor, mutation anchor, and finding
		 *  addresses the link by it. */
		uuid: uuidSchema,
		// An empty condition is semantically meaningless (the emitters
		// treat absence as "unconditional"), so the slot is either absent
		// or a non-empty expression — the printed projection of an empty
		// AST is "", and the boundary that parses authored text never
		// stores one (an empty commit clears the slot).
		condition: xpathExpressionSchema.optional(),
		target: formLinkTargetSchema,
		/**
		 * Explicit session values for the target. Absent means CommCare
		 * matches the target's datums against this form's own session
		 * (HQ's `_get_datums_matched_to_source`); present means the link
		 * names every selection datum the target needs. `[]` is not a state:
		 * it would be a second spelling of "match automatically".
		 */
		datums: z.array(formLinkDatumSchema).min(1).optional(),
	})
	.strict();
export const formLinkSchema = formLinkObjectSchema.superRefine((link, ctx) =>
	uniqueFormLinkDatumNames(link.datums, ctx),
);
export type FormLink = z.infer<typeof formLinkSchema>;
export type FormLinkTarget = FormLink["target"];

/**
 * A typed case identity used by a form submission operation.
 *
 * The four arms deliberately model author intent rather than CommCare's
 * free-form case-id calculate. A create owns a `new` target (optionally keyed
 * by a form field through Nova's stable namespaced-id derivation); later
 * operations may name an earlier create, the loaded
 * session case, or a runtime expression. The validator owns the contextual
 * rules (earlier-create order, repeat correlation, session type, and text
 * expression result) because those require the containing form/module/doc.
 */
const newCaseTargetSchema = z
	.object({
		kind: z.literal("new"),
		idFrom: uuidSchema.optional(),
	})
	.strict();

const operationCaseTargetSchema = z
	.object({ kind: z.literal("op"), opUuid: uuidSchema })
	.strict();

const sessionCaseTargetSchema = z
	.object({ kind: z.literal("session") })
	.strict();

const expressionCaseTargetSchema = z
	.object({ kind: z.literal("expression"), expr: valueExpressionSchema })
	.strict();

export const caseTargetSchema = z.discriminatedUnion("kind", [
	newCaseTargetSchema,
	operationCaseTargetSchema,
	sessionCaseTargetSchema,
	expressionCaseTargetSchema,
]);
export type CaseTarget = z.infer<typeof caseTargetSchema>;

const existingCaseTargetSchema = z.discriminatedUnion("kind", [
	operationCaseTargetSchema,
	sessionCaseTargetSchema,
	expressionCaseTargetSchema,
]);

export const CASE_OPERATION_ACTIONS = ["create", "update", "close"] as const;
export type CaseOperationAction = (typeof CASE_OPERATION_ACTIONS)[number];

/**
 * Platform-owned case types that an authored case operation may never create,
 * update, close, link to, or retype into.
 *
 * This is domain vocabulary, not an emitter detail: every authoring surface
 * filters the same closed set before construction, while the validator remains
 * the import/replay backstop.
 */
export const RESERVED_CASE_OPERATION_TYPES: ReadonlySet<string> = new Set([
	"commcare-user",
	"commcare-case-claim",
	"user-owner-mapping-case",
]);

export const caseOperationWriteSchema = z
	.object({
		property: authoredCasePropertyNameSchema,
		value: valueExpressionSchema,
		condition: predicateSchema.optional(),
	})
	.strict();
export type CaseOperationWrite = {
	property: string;
	value: ValueExpression;
	condition?: Predicate;
};

export const caseOperationLinkSchema = z
	.object({
		identifier: z.string(),
		targetType: z.string(),
		target: caseTargetSchema.nullable(),
		relationship: z.enum(["child", "extension"]),
	})
	.strict();
export type CaseOperationLink = z.infer<typeof caseOperationLinkSchema>;

/**
 * One declared case effect of a form submission.
 *
 * `uuid` is reference identity and `id` is the author-facing/wire slug;
 * execution order is the array's own position, so an operation carries no
 * ordering slot at all. The action is the stored-shape discriminator: each arm
 * admits only the facets CommCare can execute for that action.
 */
const caseOperationCommonShape = {
	uuid: uuidSchema,
	id: z.string(),
	caseType: z.string(),
	condition: predicateSchema.optional(),
	forEach: z.object({ repeat: uuidSchema }).strict().optional(),
	writes: z.array(caseOperationWriteSchema).optional(),
} as const;

export const caseOperationSchema = z.discriminatedUnion("action", [
	z
		.object({
			...caseOperationCommonShape,
			action: z.literal("create"),
			target: newCaseTargetSchema,
			name: valueExpressionSchema,
			owner: valueExpressionSchema.optional(),
			links: z.array(caseOperationLinkSchema).optional(),
			rename: z.never().optional(),
			retype: z.never().optional(),
		})
		.strict(),
	z
		.object({
			...caseOperationCommonShape,
			action: z.literal("update"),
			target: existingCaseTargetSchema,
			name: z.never().optional(),
			owner: valueExpressionSchema.optional(),
			rename: valueExpressionSchema.optional(),
			retype: z.string().optional(),
			links: z.array(caseOperationLinkSchema).optional(),
		})
		.strict(),
	z
		.object({
			...caseOperationCommonShape,
			action: z.literal("close"),
			target: existingCaseTargetSchema,
			name: z.never().optional(),
			owner: z.never().optional(),
			rename: z.never().optional(),
			retype: z.never().optional(),
			links: z.never().optional(),
		})
		.strict(),
]);

/**
 * The read model shared by operation consumers.
 *
 * Runtime admission is deliberately stricter than this convenient projection:
 * `caseOperationSchema` is the authoritative action-discriminated stored shape.
 * Keeping the common facet view here lets generic walkers and mutation planners
 * inspect an already-parsed operation without re-distributing every helper over
 * the three action arms.
 */
export type CaseOperation = {
	uuid: Uuid;
	id: string;
	action: CaseOperationAction;
	caseType: string;
	target: CaseTarget;
	condition?: Predicate;
	forEach?: { repeat: Uuid };
	name?: ValueExpression;
	owner?: ValueExpression;
	rename?: ValueExpression;
	retype?: string;
	writes?: CaseOperationWrite[];
	links?: CaseOperationLink[];
};

/**
 * The same strict runtime parser with its output viewed through the common
 * read model. Generic containers use this when they do not need arm-specific
 * construction, while `caseOperationSchema.options` remains available to
 * action-aware mutation schemas.
 */
export const caseOperationReadSchema: z.ZodType<CaseOperation> =
	caseOperationSchema;

/**
 * The operation sequence — which is simply the array, copied so callers can
 * sort or splice it without reaching into the form.
 *
 * `caseOperations` is ordered, so there is nothing to derive and this reads as
 * a no-op. It stays because every emitter and planner names the sequence
 * through it: one seam means no two of them can order a form differently.
 */
export function orderedCaseOperations(form: {
	readonly caseOperations?: readonly CaseOperation[];
}): CaseOperation[] {
	return [...(form.caseOperations ?? [])];
}

// Connect config. Persisted blocks are complete: partial sub-configs and
// omitted ids belong only to builder/tool draft types and are finalized before
// a Form is constructed. All four ids share this one XML-element/Connect-slug
// grammar; app-wide uniqueness and app-mode compatibility need the owning
// Blueprint and are enforced by `blueprintTopologyIssues`.
export const CONNECT_ID_MAX_LENGTH = 50;
export const connectIdSchema = z
	.string()
	.min(1)
	.max(CONNECT_ID_MAX_LENGTH)
	.regex(XML_ELEMENT_NAME_PATTERN);

const connectLearnModuleSchema = z
	.object({
		id: connectIdSchema,
		name: z.string(),
		description: z.string(),
		time_estimate: persistableJsonPositiveIntegerSchema,
	})
	.strict();
const connectAssessmentSchema = z
	.object({
		id: connectIdSchema,
		// An XPath expression consumed only by the XForm bind emitter. Either
		// side may set it (the SA points it at a hidden score field; the UI
		// panel lets a user override), but if absent the wire layer in
		// `lib/commcare/xform/builder.ts` emits the canonical default at bind
		// time — the same contract `deliver_unit.entity_id` / `entity_name`
		// hold. Optional here matches what's true: the doc tracks what was
		// set, the wire layer fills the rest.
		user_score: xpathExpressionSchema.optional(),
	})
	.strict();
const connectDeliverUnitSchema = z
	.object({
		id: connectIdSchema,
		name: z.string(),
		// `entity_id` / `entity_name` are XPath expressions consumed only by
		// the XForm bind emitter. Either side may set them (the SA can opt
		// into custom expressions; a UI panel could let a user override),
		// but if absent the wire layer in `lib/commcare/xform/builder.ts`
		// emits the canonical defaults at bind time. Optional here matches
		// what's true: the doc tracks what was set, the wire layer fills
		// the rest.
		entity_id: xpathExpressionSchema.optional(),
		entity_name: xpathExpressionSchema.optional(),
	})
	.strict();
const connectTaskSchema = z
	.object({
		id: connectIdSchema,
		name: z.string(),
		description: z.string(),
	})
	.strict();
export const connectLearnConfigSchema = z
	.object({
		learn_module: connectLearnModuleSchema.optional(),
		assessment: connectAssessmentSchema.optional(),
	})
	.strict()
	.refine(
		(config) =>
			config.learn_module !== undefined || config.assessment !== undefined,
		"Connect learn configuration must contain a learn module or assessment.",
	);

export const connectDeliverConfigSchema = z
	.object({
		deliver_unit: connectDeliverUnitSchema.optional(),
		task: connectTaskSchema.optional(),
	})
	.strict()
	.refine(
		(config) => config.deliver_unit !== undefined || config.task !== undefined,
		"Connect deliver configuration must contain a deliver unit or task.",
	);

export const connectConfigSchema = z.union([
	connectLearnConfigSchema,
	connectDeliverConfigSchema,
]);

export type ConnectLearnConfig = z.infer<typeof connectLearnConfigSchema>;
export type ConnectDeliverConfig = z.infer<typeof connectDeliverConfigSchema>;
export type ConnectConfig = z.infer<typeof connectConfigSchema>;

export function isConnectLearnConfig(
	config: ConnectConfig,
): config is ConnectLearnConfig {
	return "learn_module" in config || "assessment" in config;
}
export type ConnectLearnModule = z.infer<typeof connectLearnModuleSchema>;
export type ConnectAssessment = z.infer<typeof connectAssessmentSchema>;
export type ConnectDeliverUnit = z.infer<typeof connectDeliverUnitSchema>;
export type ConnectTask = z.infer<typeof connectTaskSchema>;

export const formSchema = z
	.object({
		uuid: uuidSchema,
		id: z.string(),
		name: z.string(),
		type: z.enum(FORM_TYPES),
		purpose: z.string().optional(),
		/**
		 * Optional running-app menu visibility rule. The Predicate AST keeps
		 * references typed and rename-safe; validator context rules decide which
		 * terms are meaningful for this form's navigation position.
		 */
		displayCondition: predicateSchema.optional(),
		closeCondition: closeConditionSchema.optional(),
		connect: connectConfigSchema.optional(),
		postSubmit: z.enum(POST_SUBMIT_DESTINATIONS).optional(),
		/**
		 * Where the app goes after this form is submitted, checked in order:
		 * the first link whose condition holds is followed, and `postSubmit`
		 * is where it goes when none does. Array position IS the sequence;
		 * each link carries its own uuid. `[]` is not a state: the reducers
		 * delete the slot when the last link goes.
		 */
		formLinks: z.array(formLinkSchema).min(1).optional(),
		/** Ordered, typed case effects: what one submission does to the case
		 *  universe, in the order the runtime applies it. */
		caseOperations: z.array(caseOperationReadSchema).optional(),
		/**
		 * Image shown on the form's menu tile — the per-form
		 * affordance within a module's menu.
		 */
		icon: formIconRefSchema.optional(),
		/** Audio version of the form's menu label, for audio-prompt playback. */
		audioLabel: mediaAssetIdSchema.optional(),
	})
	.strict();
export type Form = z.infer<typeof formSchema>;

export type FormKindMetadata = {
	icon: string;
	saDocs: string;
};
export const formMetadata: FormKindMetadata = {
	icon: "tabler:file-text",
	saDocs:
		"A form is a single data-collection surface within a module. Its type (registration/followup/close/survey) determines its case behavior.",
};
