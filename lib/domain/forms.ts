// lib/domain/forms.ts
import { z } from "zod";
import { assetIdSchema } from "./multimedia";
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
	"root",
	"module",
	"parent_module",
	"previous",
] as const;
export type PostSubmitDestination = (typeof POST_SUBMIT_DESTINATIONS)[number];

/**
 * User-facing destinations (UI + SA tools). Three clear choices:
 *   "app_home" → App Home (main menu)
 *   "module"   → This Module (case list / form list)
 *   "previous" → Previous Screen (back to where the user was)
 *
 * Internal-only values (not exposed to users):
 *   "root"           → resolved automatically when put_in_root is modeled
 *   "parent_module"  → resolved automatically when nested modules are modeled
 */
export const USER_FACING_DESTINATIONS = [
	"app_home",
	"module",
	"previous",
] as const;

/**
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
		// same contract as form-link targets. The schema stays permissive
		// over the string (a legacy doc can carry an unresolvable id or a
		// transient empty value); the validator's close-condition rules
		// adjudicate resolution, and every reader resolves through
		// `doc.fields` with the verbatim text as the dangling fallback.
		field: z.string().transform((s) => s as Uuid),
		answer: z.string(),
		operator: z.enum(["=", "selected"]).optional(),
	})
	.strict();

const formLinkDatumSchema = z
	.object({
		name: z.string(),
		xpath: xpathExpressionSchema,
	})
	.strict();

const formLinkTargetSchema = z.discriminatedUnion("type", [
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

const formLinkSchema = z
	.object({
		// An empty condition is semantically meaningless (the emitters
		// treat absence as "unconditional"), so the slot is either absent
		// or a non-empty expression — the printed projection of an empty
		// AST is "", and the boundary that parses authored text never
		// stores one (an empty commit clears the slot).
		condition: xpathExpressionSchema.optional(),
		target: formLinkTargetSchema,
		datums: z.array(formLinkDatumSchema).optional(),
	})
	.strict();
export type FormLink = z.infer<typeof formLinkSchema>;

// Connect config. Each sub-config's `id` stays `z.string().optional()` on
// purpose: it's a transient in-progress state (a block can exist briefly
// before its id is filled) and the doc-store type tolerates that. The real
// invariant — every connect id is present, a legal XML element name, ≤50
// chars, and unique across the app by the time it's emitted — is enforced at
// RUNTIME, not by this type: `deriveConnectId` autofills at creation, the
// UI/tool guards reject bad explicit input, and `buildConnectSlugMap`'s
// `narrowId` is the emit-time tripwire that throws if a block somehow reaches
// the wire id-less. Don't tighten this to required.
const connectLearnModuleSchema = z
	.object({
		id: z.string().optional(),
		name: z.string(),
		description: z.string(),
		time_estimate: z.number().int().positive(),
	})
	.strict();
const connectAssessmentSchema = z
	.object({
		id: z.string().optional(),
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
		id: z.string().optional(),
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
		id: z.string().optional(),
		name: z.string(),
		description: z.string(),
	})
	.strict();
const connectConfigSchema = z
	.object({
		learn_module: connectLearnModuleSchema.optional(),
		assessment: connectAssessmentSchema.optional(),
		deliver_unit: connectDeliverUnitSchema.optional(),
		task: connectTaskSchema.optional(),
	})
	.strict();
export type ConnectConfig = z.infer<typeof connectConfigSchema>;
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
		closeCondition: closeConditionSchema.optional(),
		connect: connectConfigSchema.nullable().optional(),
		postSubmit: z.enum(POST_SUBMIT_DESTINATIONS).optional(),
		formLinks: z.array(formLinkSchema).optional(),
		/**
		 * Image shown on the form's menu tile — the per-form
		 * affordance within a module's menu.
		 */
		icon: assetIdSchema.optional(),
		/** Audio version of the form's menu label, for audio-prompt playback. */
		audioLabel: assetIdSchema.optional(),
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
