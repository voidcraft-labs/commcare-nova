// lib/domain/forms.ts
import { z } from "zod";
import { formIconRefSchema } from "./builtinIcons";
import { authoredCasePropertyNameSchema } from "./casePropertyName";
import { formEntryPointSchema } from "./entryPoints";
import {
	conditionSchema,
	datumRefKey,
	type Expression,
	formLinkDatumNameSchema,
	formLogicSchema,
	type RelationStep,
	relationStepSchema,
	valueSchema,
	XML_ELEMENT_NAME_PATTERN,
} from "./expression/types";
import { persistableJsonPositiveIntegerSchema } from "./jsonNumber";
import { mediaAssetIdSchema } from "./multimedia";
import {
	type CasePlacement,
	casePlacementSchema,
	ownClosePlacementSchema,
} from "./placements";
import { type Uuid, uuidSchema } from "./uuid";

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
	"firstMenu",
	"module",
	"parentMenu",
	"previous",
] as const;
export type PostSubmitDestination = (typeof POST_SUBMIT_DESTINATIONS)[number];

/**
 * How a form is reached when it is not a menu item. The one kind today is
 * the no-matches registration form: it opens from Results after a search
 * on its module found nothing, carries the search answers, and is listed
 * nowhere else. A form with no `entry` enters from the module menu.
 */
export const formEntrySchema = z.strictObject({
	kind: z.literal("search-no-matches"),
	/** The action's label on Results; the form's name when absent. */
	label: z.string().min(1).optional(),
});
export type FormEntry = z.infer<typeof formEntrySchema>;

/** Whether the form is a menu item of its module. */
export function formEntersFromMenu(form: Pick<Form, "entry">): boolean {
	return form.entry === undefined;
}

/** Whether the form opens from Results after a search found nothing. */
export function isNoMatchesForm(form: Pick<Form, "entry">): boolean {
	return form.entry?.kind === "search-no-matches";
}

/**
 * The one stored and machine-authored navigation vocabulary:
 *   "app_home"   → App home (Android's home screen; in Web Apps the app's first screen)
 *   "firstMenu"  → the app's first menu, which lists its modules
 *   "module"     → this module's first screen (case list or form list)
 *   "parentMenu" → the parent module's menu, with its selection kept
 *   "previous"   → the screen before the form (the preceding selection or task)
 */
export interface PostSubmitMenuShape {
	/** The module opens on its Search screen (`moduleOpensOnSearch`). */
	readonly searchFirst?: boolean;
	/** The module selects several cases. */
	readonly multiSelect?: boolean;
	/** The module's parent selects several cases. */
	readonly parentMultiSelect?: boolean;
	/** The module itself is off the menu (`hiddenFromMenu`). */
	readonly offTheMenu?: boolean;
}

/**
 * Form-type-aware default for `postSubmit` when the slot is absent.
 * Registration and survey go home. A case-loading form (followup, close)
 * takes the first destination its module offers of `previous`, `module`,
 * `firstMenu` (`postSubmit.ts::postSubmitDestinationsOffered`): the screen
 * before the form, unless the module opens on Search, selects several
 * cases, sits under a parent that does, or is off the menu; then the
 * module's first screen, unless its parent selects several cases or it is
 * off the menu; and otherwise the app's first menu, which is always offered.
 */
export function defaultPostSubmit(
	formType: FormType,
	shape: PostSubmitMenuShape = {},
): PostSubmitDestination {
	if (!CASE_LOADING_FORM_TYPES.has(formType)) return "app_home";
	const parentOrSelfWithholds =
		shape.parentMultiSelect === true || shape.offTheMenu === true;
	if (
		!parentOrSelfWithholds &&
		shape.multiSelect !== true &&
		shape.searchFirst !== true
	) {
		return "previous";
	}
	return parentOrSelfWithholds ? "firstMenu" : "module";
}

const formLinkDatumSchema = z.strictObject({
	name: formLinkDatumNameSchema,
	xpath: formLogicSchema,
});

export type { FormLinkDatumName } from "./expression/types";
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
		const key = datumRefKey(datum.name);
		if (seen.has(key)) {
			ctx.addIssue({
				code: "custom",
				path: [...path, index, "name"],
				message:
					"This selected record is listed twice on the link. Include each selected record once.",
			});
		}
		seen.add(key);
	}
}

export const formLinkTargetSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("form"),
		moduleUuid: uuidSchema,
		formUuid: uuidSchema,
	}),
	z.strictObject({
		type: z.literal("module"),
		moduleUuid: uuidSchema,
	}),
]);

/**
 * The bare link object, before the datum-uniqueness refinement. The mutation
 * layer builds the link PATCH from this shape (`clearablePartialPatch` needs
 * a plain object schema); everything else uses `formLinkSchema`.
 */
export const formLinkObjectSchema = z.strictObject({
	/** Immutable identity: every editor, mutation anchor, and finding
	 *  addresses the link by it. */
	uuid: uuidSchema,
	// An absent condition is unconditional. Blank authored text clears it.
	condition: formLogicSchema.optional(),
	target: formLinkTargetSchema,
	/**
	 * Explicit session values for the target. Absent means CommCare
	 * matches the target's datums against this form's own session
	 * (HQ's `_get_datums_matched_to_source`); present means the link
	 * names every selection datum the target needs. `[]` is not a state:
	 * it would be a second spelling of "match automatically".
	 */
	datums: z.array(formLinkDatumSchema).min(1).optional(),
});
export const formLinkSchema = formLinkObjectSchema.superRefine((link, ctx) =>
	uniqueFormLinkDatumNames(link.datums, ctx),
);
export type FormLink = z.infer<typeof formLinkSchema>;
export type FormLinkTarget = FormLink["target"];

/**
 * A typed case identity used by a form submission operation.
 *
 * The five arms deliberately model author intent rather than CommCare's
 * free-form case-id calculate. A create owns a `new` target (optionally keyed
 * by a form field through Nova's stable namespaced-id derivation); later
 * operations may name an earlier create, the loaded
 * session case, a runtime expression, or the submitting worker's own record
 * (`worker-record`, the target of an `update` of `commcare-user` only). The
 * validator owns the contextual rules (earlier-create order, repeat
 * correlation, session type, text expression result, and the worker record's
 * one operation per form) because those require the containing
 * form/module/doc.
 */
const newCaseTargetSchema = z.strictObject({
	kind: z.literal("new"),
	idFrom: uuidSchema.optional(),
});

const operationCaseTargetSchema = z.strictObject({
	kind: z.literal("op"),
	opUuid: uuidSchema,
});

const sessionCaseTargetSchema = z.strictObject({ kind: z.literal("session") });

const expressionCaseTargetSchema = z.strictObject({
	kind: z.literal("expression"),
	expr: valueSchema,
});

const workerRecordCaseTargetSchema = z.strictObject({
	kind: z.literal("worker-record"),
});

export const caseTargetSchema = z.discriminatedUnion("kind", [
	newCaseTargetSchema,
	operationCaseTargetSchema,
	sessionCaseTargetSchema,
	expressionCaseTargetSchema,
	workerRecordCaseTargetSchema,
]);
export type CaseTarget = z.infer<typeof caseTargetSchema>;

const existingCaseTargetSchema = z.discriminatedUnion("kind", [
	operationCaseTargetSchema,
	sessionCaseTargetSchema,
	expressionCaseTargetSchema,
]);

/** An update's target: an existing case, or the submitting worker's record. */
const updateCaseTargetSchema = z.discriminatedUnion("kind", [
	operationCaseTargetSchema,
	sessionCaseTargetSchema,
	expressionCaseTargetSchema,
	workerRecordCaseTargetSchema,
]);

/**
 * `own` is the form's own case: the case a registration creates, or the one
 * a follow-up or close form loaded. Its case type is the module's and its
 * target follows the form's type, so it stores neither.
 */
export const CASE_OPERATION_ACTIONS = [
	"own",
	"create",
	"update",
	"close",
] as const;
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

/**
 * The indices a write walks from its operation's case to the case it saves
 * to, each step the one a `prop` read's `ancestor` arm takes. Absent: the
 * operation's own case.
 */
export const caseWriteViaSchema = z.tuple(
	[relationStepSchema],
	relationStepSchema,
);
export type CaseWriteVia = [RelationStep, ...RelationStep[]];

export const caseOperationWriteSchema = z.strictObject({
	property: authoredCasePropertyNameSchema,
	value: valueSchema,
	condition: conditionSchema.optional(),
	/** Saves to the case these indices reach rather than the operation's own. */
	via: caseWriteViaSchema.optional(),
	/** Saves only when the answer differs from the case's current value. */
	onlyIfChanged: z.literal(true).optional(),
});
export type CaseOperationWrite = {
	property: string;
	value: Expression;
	condition?: Expression;
	via?: CaseWriteVia;
	onlyIfChanged?: true;
};

/**
 * What one write saves to: its property on the case its `via` reaches. Two
 * writes of one key in one operation save to the same place, which the
 * validator refuses.
 */
export const caseWriteKeySchema = z.strictObject({
	property: authoredCasePropertyNameSchema,
	via: caseWriteViaSchema.optional(),
});
export type CaseWriteKey = {
	property: string;
	via?: CaseWriteVia;
};

/** The key of `write`. */
export function caseWriteKeyOf(write: CaseOperationWrite): CaseWriteKey {
	return write.via === undefined
		? { property: write.property }
		: { property: write.property, via: write.via };
}

/** Whether two keys name the same property on the same case. */
export function sameCaseWriteKey(a: CaseWriteKey, b: CaseWriteKey): boolean {
	if (a.property !== b.property) return false;
	const aVia = a.via ?? [];
	const bVia = b.via ?? [];
	return (
		aVia.length === bVia.length &&
		aVia.every(
			(step, index) =>
				step.identifier === bVia[index]?.identifier &&
				step.throughCaseType === bVia[index]?.throughCaseType,
		)
	);
}

export const caseOperationLinkSchema = z.strictObject({
	identifier: z.string(),
	targetType: z.string(),
	target: caseTargetSchema.nullable(),
	relationship: z.enum(["child", "extension"]),
});
export type CaseOperationLink = z.infer<typeof caseOperationLinkSchema>;

/**
 * One declared case effect of a form submission.
 *
 * `uuid` is reference identity and `id` is the author-facing/wire slug;
 * execution order is the array's own position, so an operation carries no
 * ordering slot at all. The action is the stored-shape discriminator: each arm
 * admits only the facets CommCare can execute for that action.
 *
 * Every arm holds an optional `placement`: where a published app already
 * keeps the change in CommCare HQ, held so a later publish keeps it there.
 * No mutation payload carries it.
 */
const caseOperationCommonShape = {
	uuid: uuidSchema,
	id: z.string(),
	caseType: z.string(),
	condition: conditionSchema.optional(),
	forEach: z.strictObject({ repeat: uuidSchema }).optional(),
	writes: z.array(caseOperationWriteSchema).optional(),
	placement: casePlacementSchema.optional(),
} as const;

/**
 * The form's own case, first in every registration, follow-up and close form
 * of a module with a case type. Its `id` is the module's case type at birth,
 * made unique among the form's operation ids
 * (`caseOperationIdentifiers.ts::ownCaseOperationId`). Whether it runs is
 * the form's `openCondition` and `closeCondition`, never a condition of its
 * own, and it runs once per submission, never per repeat row.
 */
export const ownCaseOperationSchema = z.strictObject({
	uuid: uuidSchema,
	id: z.string(),
	action: z.literal("own"),
	/** Registration: the new case's name. Follow-up and close: a rename of
	 *  the case the form loaded. */
	name: valueSchema.optional(),
	owner: valueSchema.optional(),
	writes: z.array(caseOperationWriteSchema).optional(),
	links: z.array(caseOperationLinkSchema).optional(),
	placement: casePlacementSchema.optional(),
	caseType: z.never().optional(),
	target: z.never().optional(),
	condition: z.never().optional(),
	forEach: z.never().optional(),
	rename: z.never().optional(),
	retype: z.never().optional(),
});

export const caseOperationSchema = z.discriminatedUnion("action", [
	ownCaseOperationSchema,
	z.strictObject({
		...caseOperationCommonShape,
		action: z.literal("create"),
		target: newCaseTargetSchema,
		name: valueSchema,
		owner: valueSchema.optional(),
		links: z.array(caseOperationLinkSchema).optional(),
		rename: z.never().optional(),
		retype: z.never().optional(),
	}),
	z.strictObject({
		...caseOperationCommonShape,
		action: z.literal("update"),
		target: updateCaseTargetSchema,
		name: z.never().optional(),
		owner: valueSchema.optional(),
		rename: valueSchema.optional(),
		retype: z.string().optional(),
		links: z.array(caseOperationLinkSchema).optional(),
	}),
	z.strictObject({
		...caseOperationCommonShape,
		action: z.literal("close"),
		target: existingCaseTargetSchema,
		name: z.never().optional(),
		owner: z.never().optional(),
		rename: z.never().optional(),
		retype: z.never().optional(),
		links: z.never().optional(),
	}),
]);

type CaseOperationFacets = {
	uuid: Uuid;
	id: string;
	name?: Expression;
	owner?: Expression;
	writes?: CaseOperationWrite[];
	links?: CaseOperationLink[];
	placement?: CasePlacement;
};

/** The form's own case: no stored case type, target, condition or repeat. */
export type OwnCaseOperation = CaseOperationFacets & {
	action: "own";
	caseType?: undefined;
	target?: undefined;
	condition?: undefined;
	forEach?: undefined;
	rename?: undefined;
	retype?: undefined;
};

/** A create, update or close: it names its case type and its target. */
export type TargetedCaseOperation = CaseOperationFacets & {
	action: Exclude<CaseOperationAction, "own">;
	caseType: string;
	target: CaseTarget;
	condition?: Expression;
	forEach?: { repeat: Uuid };
	rename?: Expression;
	retype?: string;
};

/**
 * The read model shared by operation consumers.
 *
 * Runtime admission is deliberately stricter than this convenient projection:
 * `caseOperationSchema` is the authoritative action-discriminated stored shape.
 * Keeping the common facet view here lets generic walkers and mutation planners
 * inspect an already-parsed operation without re-distributing every helper over
 * the create, update and close arms; only the own arm stands apart, because
 * its case type and target are the form's. Read them through
 * `operationCaseType` and `operationTarget`.
 */
export type CaseOperation = OwnCaseOperation | TargetedCaseOperation;

/**
 * The same strict runtime parser with its output viewed through the common
 * read model. Generic containers use this when they do not need arm-specific
 * construction, while `caseOperationSchema.options` remains available to
 * action-aware mutation schemas.
 */
export const caseOperationReadSchema: z.ZodType<CaseOperation> =
	caseOperationSchema;

/** Whether `operation` is the form's own case. */
export function isOwnCaseOperation(
	operation: CaseOperation,
): operation is OwnCaseOperation {
	return operation.action === "own";
}

/**
 * The case type `operation` works on: the module's case type for the own
 * arm (`undefined` when the form's module has none or the form is in no
 * module), else the type it stores.
 */
export function operationCaseType(
	doc: {
		readonly formOrder: Readonly<Record<string, readonly string[]>>;
		readonly modules: Readonly<
			Record<string, { readonly caseType?: string } | undefined>
		>;
	},
	formUuid: Uuid,
	operation: CaseOperation,
): string | undefined {
	if (operation.action !== "own") return operation.caseType;
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) return doc.modules[moduleUuid]?.caseType;
	}
	return undefined;
}

/**
 * The case `operation` works on: for the own arm, the case a registration
 * creates (`new`) or the case any other form loaded (`session`); else the
 * target it stores. The own arm on a survey form is refused by the
 * validator, so the `session` answer there is never acted on.
 */
export function operationTarget(
	operation: CaseOperation,
	formType: FormType,
): CaseTarget {
	if (operation.action !== "own") return operation.target;
	return formType === "registration" ? { kind: "new" } : { kind: "session" };
}

/**
 * Whether `operation` runs once for each case a several-case form selected:
 * the own arm, an update or close of the loaded case (`session` target), and
 * a create with a link to the loaded case, which makes one case under each
 * selected case. Inside that iteration, `session` names the current selected
 * case, so a session reference there is never ambiguous; every other
 * operation runs once for the form, where `session` names no one case. On a
 * form that loads one case the iteration has one member and the answer
 * changes nothing.
 */
export function caseOperationRunsPerSelectedCase(
	operation: CaseOperation,
): boolean {
	if (operation.action === "own") return true;
	if (operation.action === "create")
		return (operation.links ?? []).some(
			(link) => link.target?.kind === "session",
		);
	return operation.target.kind === "session";
}

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

const connectLearnModuleSchema = z.strictObject({
	id: connectIdSchema,
	name: z.string(),
	description: z.string(),
	time_estimate: persistableJsonPositiveIntegerSchema,
});
const connectAssessmentSchema = z.strictObject({
	id: connectIdSchema,
	// An XPath expression consumed only by the XForm bind emitter. Either
	// side may set it (the SA points it at a hidden score field; the UI
	// panel lets a user override), but if absent the wire layer in
	// `lib/commcare/xform/builder.ts` emits the canonical default at bind
	// time — the same contract `deliver_unit.entity_id` / `entity_name`
	// hold. Optional here matches what's true: the doc tracks what was
	// set, the wire layer fills the rest.
	user_score: formLogicSchema.optional(),
});
const connectDeliverUnitSchema = z.strictObject({
	id: connectIdSchema,
	name: z.string(),
	// `entity_id` / `entity_name` are XPath expressions consumed only by
	// the XForm bind emitter. Either side may set them (the SA can opt
	// into custom expressions; a UI panel could let a user override),
	// but if absent the wire layer in `lib/commcare/xform/builder.ts`
	// emits the canonical defaults at bind time. Optional here matches
	// what's true: the doc tracks what was set, the wire layer fills
	// the rest.
	entity_id: formLogicSchema.optional(),
	entity_name: formLogicSchema.optional(),
});
const connectTaskSchema = z.strictObject({
	id: connectIdSchema,
	name: z.string(),
	description: z.string(),
});
export const connectLearnConfigSchema = z
	.strictObject({
		learn_module: connectLearnModuleSchema.optional(),
		assessment: connectAssessmentSchema.optional(),
	})
	.refine(
		(config) =>
			config.learn_module !== undefined || config.assessment !== undefined,
		"Connect learn configuration must contain a learn module or assessment.",
	);

export const connectDeliverConfigSchema = z
	.strictObject({
		deliver_unit: connectDeliverUnitSchema.optional(),
		task: connectTaskSchema.optional(),
	})
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

/**
 * Whether a deliver config holds both a deliver unit and a task. Connect
 * reads a submission's deliver unit before its task and turns the delivery
 * away while the worker has a pending task (commcare-connect
 * `form_receiver/processor.py::process_deliver_form`,
 * `_has_blocking_pending_task`), so the visit made in the form that also
 * completes the task is never paid. A task goes in a form of its own. The
 * validator, the builder and the tools ask this one predicate;
 * it takes a stored config or a draft alike.
 */
export function connectDeliverFormHoldsTask(
	config:
		| ConnectConfig
		| { readonly deliver_unit?: unknown; readonly task?: unknown },
): boolean {
	return (
		"deliver_unit" in config &&
		config.deliver_unit !== undefined &&
		"task" in config &&
		config.task !== undefined
	);
}
export type ConnectLearnModule = z.infer<typeof connectLearnModuleSchema>;
export type ConnectAssessment = z.infer<typeof connectAssessmentSchema>;
export type ConnectDeliverUnit = z.infer<typeof connectDeliverUnitSchema>;
export type ConnectTask = z.infer<typeof connectTaskSchema>;

export const formSchema = z.strictObject({
	entryPoint: formEntryPointSchema.optional(),
	uuid: uuidSchema,
	id: z.string(),
	name: z.string(),
	type: z.enum(FORM_TYPES),
	purpose: z.string().optional(),
	/**
	 * Optional running-app menu visibility rule. The Expression AST keeps
	 * references typed and rename-safe; validator context rules decide which
	 * terms are meaningful for this form's navigation position.
	 */
	displayCondition: conditionSchema.optional(),
	/**
	 * Present when the form is off the menu: no menu lists it, whatever
	 * `displayCondition` says. The condition keeps applying once the form
	 * is back on the menu. A form off the menu still opens from an
	 * after-submit link and from an entry point.
	 */
	hiddenFromMenu: z.literal(true).optional(),
	/**
	 * When a registration creates its case; absent, on every submission.
	 * Registration only (`OPEN_CONDITION_WRONG_TYPE`).
	 */
	openCondition: conditionSchema.optional(),
	/**
	 * When the form closes its own case. A close form closes it on every
	 * submission when this is absent; a registration closes the case it
	 * creates only when this is present. Registration and close only
	 * (`CLOSE_CONDITION_WRONG_TYPE`).
	 */
	closeCondition: conditionSchema.optional(),
	/**
	 * Where a published app keeps this form's own close when it has a Save
	 * to Case block of its own, held so a later publish keeps it there. No
	 * mutation payload carries it.
	 */
	ownClosePlacement: ownClosePlacementSchema.optional(),
	connect: connectConfigSchema.optional(),
	postSubmit: z.enum(POST_SUBMIT_DESTINATIONS).optional(),
	/**
	 * Present when the form is not a menu item. A no-matches form has a
	 * fixed after-submit (Results showing the case it registered), so
	 * only an explicit `firstMenu` is allowed for `postSubmit`; `formLinks`,
	 * `displayCondition` and `hiddenFromMenu` are refused on it
	 * by the validator rather than the schema, which keeps the patch and
	 * clear shapes ordinary.
	 */
	entry: formEntrySchema.optional(),
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
});
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
