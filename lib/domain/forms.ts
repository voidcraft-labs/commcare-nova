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
	itextUnitSchema,
	type RelationStep,
	relationStepSchema,
	valueSchema,
} from "./expression/types";
import { formRootNameSchema } from "./formAnswerRoot";
import {
	computedEntryValueSchema,
	formCaseSelectionSchema,
	sharedFormSchema,
} from "./formEntryCases";
import { firstModuleListingForm } from "./formMembership";
import { menuBadgeSchema } from "./menuBadge";
import { mediaAssetIdSchema } from "./multimedia";
import {
	formerNavigationMediaSchema,
	navigationMediaSchema,
} from "./navigationMedia";
import {
	advancedTagSchema,
	type CasePlacement,
	casePlacementSchema,
	ownClosePlacementSchema,
} from "./placements";
import { type Uuid, uuidSchema } from "./uuid";

/** One physical form text, even when several question or choice slots use it:
 *  the slot that carries it and every other slot that shares it. */
export const behaviorTextSchema = z.strictObject({
	carrier: itextUnitSchema,
	alsoUsedBy: z.array(itextUnitSchema).min(1).optional(),
});
export type BehaviorText = z.infer<typeof behaviorTextSchema>;
export const formBehaviorRoleNames = {
	automaticSubmissionText: "Automatic submission",
	skipAutomaticSyncText: "Skip automatic sync",
	validateChangedAnswersText: "Check changed answers",
	activityKeyText: "Activity notice key",
	activityTitleText: "Activity notice record title",
	activityWindowText: "Activity notice window",
	savedFormDescriptorText: "Saved form label",
} as const;
export type FormBehaviorRole = keyof typeof formBehaviorRoleNames;
export type FormBehaviorTexts = Partial<Record<FormBehaviorRole, BehaviorText>>;
export const formBehaviorRoles = Object.keys(
	formBehaviorRoleNames,
) as FormBehaviorRole[];
export function formBehaviorTextsOf(
	form: FormBehaviorTexts,
): FormBehaviorTexts {
	const texts: FormBehaviorTexts = {};
	for (const role of formBehaviorRoles)
		if (form[role]) texts[role] = form[role];
	return texts;
}
export function behaviorTextUnits(
	text: BehaviorText,
): readonly z.infer<typeof itextUnitSchema>[] {
	return [text.carrier, ...(text.alsoUsedBy ?? [])];
}

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
 * The one stored and machine-authored navigation vocabulary:
 *   "app_home"   → App home (Android's home screen; in Web Apps the app's first screen)
 *   "firstMenu"  → the app's first menu, which lists its modules
 *   "module"     → this module's first screen (case list or form list)
 *   "parentMenu" → the parent module's menu, with its selection kept
 *   "previous"   → the screen before the form (the preceding selection or task)
 */
export interface PostSubmitMenuShape {
	/** The menu's forms read the search (`moduleFormsReadSearch`). */
	readonly formsReadSearch?: boolean;
	/** The module selects several cases. */
	readonly multiSelect?: boolean;
	/** The module's parent selects several cases. */
	readonly parentMultiSelect?: boolean;
	/** The module itself is off the menu (`hiddenFromMenu`). */
	readonly offTheMenu?: boolean;
	/** The module shows its forms in the menu above (`formsInMenuAbove`). */
	readonly formsInMenuAbove?: boolean;
	/** The module's forms list on the app's first menu: it shows its forms
	 *  above and is top-level, or sits under a parent that shows its forms
	 *  above too (`menuScreens.ts::menuScreenOf`). */
	readonly formsOnFirstMenu?: boolean;
	/** The module keeps its screen under a top-level menu that shows its
	 *  forms above, and every form of every menu that shows its forms above
	 *  opens one chosen case (`menuScreens.ts::firstMenuOpensOneCase`), which
	 *  HQ's frame to the module's screen opens with. */
	readonly opensWithFirstMenuCase?: boolean;
}

/**
 * Form-type-aware default for `postSubmit` when the slot is absent.
 * Registration and survey go home. A case-loading form (followup, close)
 * takes the first destination its module offers of `previous`, `module`,
 * `firstMenu` (`postSubmit.ts::postSubmitDestinationsOffered`): the screen
 * before the form, unless the module's forms read the search, selects several
 * cases, sits under a parent that does, is off the menu, or lists its forms
 * on the app's first menu; then the module's first screen, unless its parent
 * selects several cases, it is off the menu, it shows its forms in the menu
 * above, or it opens through the first menu with the case every form listed
 * there opens; and otherwise the app's first menu, which is always offered.
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
		shape.formsReadSearch !== true &&
		shape.formsOnFirstMenu !== true
	) {
		return "previous";
	}
	return parentOrSelfWithholds ||
		shape.formsInMenuAbove === true ||
		shape.opensWithFirstMenuCase === true
		? "firstMenu"
		: "module";
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
	/** Start this form again: the source form, in its own menu, wherever the
	 *  form is. A `form` target naming the source form is refused
	 *  (`FORM_LINK_SELF_REFERENCE`), so this is the one spelling. */
	z.strictObject({ type: z.literal("this-form") }),
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
	/** An absent condition runs the destination every time, unless a carried
	 *  case is not on the device. Blank authored text clears it. */
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

/** Where a form goes when no destination that may not run runs. `app_home`
 *  is no value: an absent otherwise is the app home. */
export const OTHERWISE_DESTINATIONS = [
	"firstMenu",
	"module",
	"parentMenu",
	"previous",
] as const satisfies readonly PostSubmitDestination[];
export type OtherwiseDestination = (typeof OTHERWISE_DESTINATIONS)[number];

/**
 * The bare otherwise object, before the datum-uniqueness refinement: a
 * built-in destination, or a link. The mutation layer builds its payload
 * schema from this shape; everything else uses `formOtherwiseSchema`.
 */
export const formOtherwiseObjectSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("destination"),
		destination: z.enum(OTHERWISE_DESTINATIONS),
	}),
	z.strictObject({
		kind: z.literal("link"),
		/** Immutable identity, in the same namespace as the form's links:
		 *  findings and the `form_link_datum_xpath` slot address it by it. */
		uuid: uuidSchema,
		target: formLinkTargetSchema,
		/** As a destination's `datums`: absent matches automatically. */
		datums: z.array(formLinkDatumSchema).min(1).optional(),
	}),
]);
export const formOtherwiseSchema = formOtherwiseObjectSchema.superRefine(
	(value, ctx) => {
		if (value.kind === "link") uniqueFormLinkDatumNames(value.datums, ctx);
	},
);
export type FormOtherwise = z.infer<typeof formOtherwiseSchema>;
export type FormOtherwiseLink = Extract<FormOtherwise, { kind: "link" }>;

/** One link of a form as every rule, projection and index reads it: each
 *  destination in order, then the otherwise when it is a link. */
export type FormLinkEntry =
	| {
			readonly role: "destination";
			readonly link: FormLink;
			readonly index: number;
	  }
	| {
			readonly role: "otherwise";
			readonly link: {
				readonly uuid: Uuid;
				readonly target: FormLinkTarget;
				readonly datums?: readonly FormLinkDatum[];
			};
	  };

/** Every link of `form`, destinations first in array order, then the
 *  otherwise link. */
export function formLinkEntries(
	form: Pick<Form, "formLinks" | "otherwise">,
): readonly FormLinkEntry[] {
	const entries: FormLinkEntry[] = (form.formLinks ?? []).map(
		(link, index) => ({ role: "destination", link, index }),
	);
	const otherwise = form.otherwise;
	if (otherwise?.kind === "link")
		entries.push({
			role: "otherwise",
			link: {
				uuid: otherwise.uuid,
				target: otherwise.target,
				...(otherwise.datums === undefined ? {} : { datums: otherwise.datums }),
			},
		});
	return entries;
}

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
const newCaseTargetSchema = z
	.strictObject({
		kind: z.literal("new"),
		idFrom: uuidSchema.optional(),
		expr: valueSchema.optional(),
	})
	.refine(
		({ idFrom, expr }) => idFrom === undefined || expr === undefined,
		"Choose a keyed field or an exact case ID expression.",
	);

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

/** A case editor's one-time assignment after the form's opening defaults.
 * Its owning load determines when it runs and which selected record it reads. */
export const formOpeningAssignmentSchema = z.strictObject({
	uuid: uuidSchema,
	field: uuidSchema,
	source: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("own") }),
		z.strictObject({ kind: z.literal("worker-record") }),
		z.strictObject({ kind: z.literal("selection"), selection: uuidSchema }),
	]),
	via: caseWriteViaSchema.optional(),
	property: authoredCasePropertyNameSchema,
});
export type FormOpeningAssignment = z.infer<typeof formOpeningAssignmentSchema>;

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
	/** The close leaf is conditional independently of the block. */
	closeCondition: conditionSchema.optional(),
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
	/** Follow-up and close: the rename is saved only when it differs from
	 *  the case's name (`caseFacetOnlyIfChanged`). */
	nameOnlyIfChanged: z.literal(true).optional(),
	owner: valueSchema.optional(),
	ownerCondition: z.never().optional(),
	/** The owner is saved only when the answer is not blank
	 *  (`caseFacetOnlyIfChanged`). */
	ownerOnlyIfChanged: z.literal(true).optional(),
	writes: z.array(caseOperationWriteSchema).optional(),
	links: z.array(caseOperationLinkSchema).optional(),
	placement: casePlacementSchema.optional(),
	caseType: z.never().optional(),
	target: z.never().optional(),
	condition: z.never().optional(),
	closeCondition: z.never().optional(),
	closeAfter: z.never().optional(),
	forEach: z.never().optional(),
	rename: z.never().optional(),
	renameOnlyIfChanged: z.never().optional(),
	retype: z.never().optional(),
});

// An imported create can retain a calculation without making its case type
// dynamic. The commit gate checks that the concatenation gives `caseType`.
const caseTypeLiteralTermSchema = z.strictObject({
	kind: z.literal("term"),
	term: z.strictObject({ kind: z.literal("literal"), value: z.string() }),
});
const caseTypeCalculationSchema = z.strictObject({
	kind: z.literal("concat"),
	parts: z.tuple(
		[caseTypeLiteralTermSchema, caseTypeLiteralTermSchema],
		caseTypeLiteralTermSchema,
	),
});
export type CaseTypeCalculation = z.infer<typeof caseTypeCalculationSchema>;

export function fixedCaseTypeOf(calculation: CaseTypeCalculation): string {
	return calculation.parts.map(({ term }) => term.value).join("");
}

export const caseOperationSchema = z.discriminatedUnion("action", [
	ownCaseOperationSchema,
	z.strictObject({
		...caseOperationCommonShape,
		action: z.literal("create"),
		typeCalculation: caseTypeCalculationSchema.optional(),
		ownerCondition: conditionSchema.optional(),
		closeAfter: z.literal(true).optional(),
		target: newCaseTargetSchema,
		name: valueSchema,
		nameOnlyIfChanged: z.never().optional(),
		owner: valueSchema.optional(),
		ownerOnlyIfChanged: z.literal(true).optional(),
		links: z.array(caseOperationLinkSchema).optional(),
		rename: z.never().optional(),
		renameOnlyIfChanged: z.never().optional(),
		retype: z.never().optional(),
	}),
	z.strictObject({
		...caseOperationCommonShape,
		action: z.literal("update"),
		ownerCondition: z.never().optional(),
		closeAfter: z.literal(true).optional(),
		target: updateCaseTargetSchema,
		name: z.never().optional(),
		nameOnlyIfChanged: z.never().optional(),
		owner: valueSchema.optional(),
		ownerOnlyIfChanged: z.literal(true).optional(),
		rename: valueSchema.optional(),
		renameOnlyIfChanged: z.literal(true).optional(),
		retype: z.string().optional(),
		links: z.array(caseOperationLinkSchema).optional(),
	}),
	z.strictObject({
		...caseOperationCommonShape,
		action: z.literal("close"),
		ownerCondition: z.never().optional(),
		closeAfter: z.never().optional(),
		target: existingCaseTargetSchema,
		name: z.never().optional(),
		nameOnlyIfChanged: z.never().optional(),
		owner: z.never().optional(),
		ownerOnlyIfChanged: z.never().optional(),
		rename: z.never().optional(),
		renameOnlyIfChanged: z.never().optional(),
		retype: z.never().optional(),
		links: z.never().optional(),
	}),
]);

/** A block which closes is a close operation unless it also carries
 * a facet that only an update can represent. Plain property writes fit both. */
export function hasUpdateOnlyCaseFacets(operation: {
	readonly rename?: unknown;
	readonly retype?: unknown;
	readonly owner?: unknown;
	readonly links?: readonly unknown[];
}): boolean {
	return (
		operation.rename !== undefined ||
		operation.retype !== undefined ||
		operation.owner !== undefined ||
		(operation.links?.length ?? 0) > 0
	);
}

/**
 * The name and owner facets an operation saves only when changed, as HQ's
 * build applies `update_mode: "edit"` to the `name` and `owner_id` keys of
 * an update map (`xform.py::XFormCaseBlock.add_case_updates`): the key's
 * leaf is relevant only while the answer differs from the case's
 * `case/<key>` in the casedb when the form opened. A case holds its name as
 * `case_name`, so a rename is saved only when it differs from the name; a
 * case holds its owner as an attribute, so `case/owner_id` is empty
 * (`XPathNodeset.unpack` of no node is "") and the owner is saved only when
 * the answer is not blank. On a case the form creates, HQ's build then
 * leaves the create block's own owner as `-` (`autoset_owner_id_for_*`
 * finds `owner_id` among the updates), so a blank answer leaves it unowned.
 *
 * - `nameOnlyIfChanged`: the own arm's rename on a follow-up or close form.
 * - `renameOnlyIfChanged`: an update's rename.
 * - `ownerOnlyIfChanged`: the owner of the own arm, a create or an update.
 */
export type CaseFacetOnlyIfChanged =
	| "nameOnlyIfChanged"
	| "renameOnlyIfChanged"
	| "ownerOnlyIfChanged";

/** The facet each flag saves only when changed. */
export const CASE_FACET_OF_ONLY_IF_CHANGED = {
	nameOnlyIfChanged: "name",
	renameOnlyIfChanged: "rename",
	ownerOnlyIfChanged: "owner",
} as const satisfies Record<
	CaseFacetOnlyIfChanged,
	"name" | "rename" | "owner"
>;

/** Whether some write or facet of `operation` is saved only when changed. */
export function operationSavesOnlyChanged(operation: {
	readonly writes?: readonly CaseOperationWrite[];
	readonly nameOnlyIfChanged?: true;
	readonly renameOnlyIfChanged?: true;
	readonly ownerOnlyIfChanged?: true;
}): boolean {
	return (
		operation.nameOnlyIfChanged === true ||
		operation.renameOnlyIfChanged === true ||
		operation.ownerOnlyIfChanged === true ||
		(operation.writes ?? []).some((write) => write.onlyIfChanged === true)
	);
}

type CaseOperationFacets = {
	uuid: Uuid;
	id: string;
	name?: Expression;
	nameOnlyIfChanged?: true;
	owner?: Expression;
	ownerOnlyIfChanged?: true;
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
	ownerCondition?: undefined;
	closeCondition?: undefined;
	closeAfter?: undefined;
	forEach?: undefined;
	rename?: undefined;
	renameOnlyIfChanged?: undefined;
	retype?: undefined;
};

/** A create, update or close: it names its case type and its target. */
export type TargetedCaseOperation = CaseOperationFacets & {
	action: Exclude<CaseOperationAction, "own">;
	caseType: string;
	typeCalculation?: CaseTypeCalculation;
	target: CaseTarget;
	condition?: Expression;
	ownerCondition?: Expression;
	closeCondition?: Expression;
	closeAfter?: true;
	forEach?: { repeat: Uuid };
	rename?: Expression;
	renameOnlyIfChanged?: true;
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
	const moduleUuid = firstModuleListingForm(doc.formOrder, formUuid);
	return moduleUuid === undefined
		? undefined
		: doc.modules[moduleUuid]?.caseType;
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

export const formSchema = z.strictObject({
	/** Source or first-published names of the records this form opens. */
	heldSelectionTags: z.record(uuidSchema, advancedTagSchema).optional(),
	/** Absent derives the ordinary menu choices. An empty list explicitly opens without a selection. */
	caseSelections: z.array(formCaseSelectionSchema).optional(),
	/** A second way to open an ordinary form, in its own menu position. */
	shadowOf: sharedFormSchema.optional(),
	computedDatums: z.array(computedEntryValueSchema).optional(),
	openingAssignments: z.array(formOpeningAssignmentSchema).optional(),
	/** The opened record's saved assignment map in an adopted basic form.
	 * Its case editor preserves that map. New forms get an editor with an
	 * Add property control for these values. */
	heldBasicOpening: z.literal(true).optional(),
	/** The finish button on Web Apps. An absent source uses the platform's
	 * default; an explicitly empty source is a button with no text. Other
	 * languages use the form's submit-label translation unit. */
	submitLabel: z.strictObject({ text: z.string().optional() }).optional(),
	dataRootName: formRootNameSchema.optional(),
	entryPoint: formEntryPointSchema.optional(),
	/** Case creations whose IDs a caller supplies when opening this form through a deep link.
	 * The source form owns these choices even when only a second menu offers the link. */
	entryCaseCreations: z.array(uuidSchema).min(1).optional(),
	/** The existing form text whose presence submits this form when Web Apps opens it. */
	automaticSubmissionText: behaviorTextSchema.optional(),
	skipAutomaticSyncText: behaviorTextSchema.optional(),
	validateChangedAnswersText: behaviorTextSchema.optional(),
	activityKeyText: behaviorTextSchema.optional(),
	activityTitleText: behaviorTextSchema.optional(),
	activityWindowText: behaviorTextSchema.optional(),
	savedFormDescriptorText: behaviorTextSchema.optional(),
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
	badge: menuBadgeSchema.optional(),
	/**
	 * Present when the form is off the menu: no menu lists it, whatever
	 * `displayCondition` says. The condition keeps applying once the form
	 * is back on the menu. A form off the menu still opens from an
	 * after-submit link and from an entry point.
	 */
	hiddenFromMenu: z.literal(true).optional(),
	/** Independently requests device location when this form opens on Android. */
	captureLocation: z.literal(true).optional(),
	/** Text formatting is off for the whole form: no label, choice or help text writes a markdown
	 *  form, so each shows as its platform shows a text without one. */
	plainText: z.literal(true).optional(),
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
	/**
	 * Where a form without destinations goes after submit. Refused beside
	 * `formLinks` (`POST_SUBMIT_BESIDE_FORM_LINKS`); a form with destinations
	 * says where it goes when none runs with `otherwise`.
	 */
	postSubmit: z.enum(POST_SUBMIT_DESTINATIONS).optional(),
	/**
	 * Where the app goes after this form is submitted. Every destination
	 * whose condition holds runs, in array order: on Android each after the
	 * one before it finishes, in Web Apps only the first (`platforms.ts`,
	 * `after-submit-several-destinations`). A destination with no condition
	 * and no carried case runs every time. `otherwise` is where the form goes
	 * when no destination that may not run runs
	 * (`afterSubmit.ts::formLinkMayNotRun`). Array position is the order;
	 * each link carries its own uuid. `[]` is not a state: the reducers
	 * delete the slot when the last link goes.
	 */
	formLinks: z.array(formLinkSchema).min(1).optional(),
	/**
	 * Present only beside `formLinks`, and only while some destination may
	 * not run (`FORM_OTHERWISE_UNREACHABLE`). A built-in destination or a
	 * link; absent, the app home follows.
	 */
	otherwise: formOtherwiseSchema.optional(),
	/** Ordered, typed case effects: what one submission does to the case
	 *  universe, in the order the runtime applies it. */
	caseOperations: z.array(caseOperationReadSchema).optional(),
	/**
	 * Image shown on the form's menu tile — the per-form
	 * affordance within a module's menu.
	 */
	icon: formIconRefSchema.optional(),
	mediaByLanguage: navigationMediaSchema(formIconRefSchema).optional(),
	mediaByFormerCode: formerNavigationMediaSchema(formIconRefSchema).optional(),
	/** Audio version of the form's menu label, for audio-prompt playback. */
	audioLabel: mediaAssetIdSchema.optional(),
});
export type Form = z.infer<typeof formSchema>;
/** A worker starting value runs on an editable worker load. HQ's basic
 * User Properties editor can create updates, but has no starting-value control. */
export function opensWithWorkerValue(form: Form): boolean {
	return Boolean(
		form.openingAssignments?.some((row) => row.source.kind === "worker-record"),
	);
}

export function usesFormEntryActions(form: Form): boolean {
	return (
		form.caseSelections !== undefined ||
		Boolean(form.computedDatums?.length) ||
		Boolean(
			form.openingAssignments?.some(
				(row) => row.source.kind !== "own" || !form.heldBasicOpening,
			),
		)
	);
}

export type FormKindMetadata = {
	icon: string;
	saDocs: string;
};
export const formMetadata: FormKindMetadata = {
	icon: "tabler:file-text",
	saDocs:
		"A form is a single data-collection surface within a module. Its type (registration/followup/close/survey) determines its case behavior.",
};
