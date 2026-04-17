/**
 * Shared schemas for the App Blueprint format.
 *
 * Generation schemas used by SA tools:
 * - caseTypesOutputSchema: Data model (generateSchema tool)
 * - scaffoldModulesSchema: Module/form structure (generateScaffold tool)
 * - moduleContentSchema: Case list columns (addModule tool)
 *
 * TypeScript types are derived via z.infer.
 */
import { z } from "zod";

// ── Question types ──────────────────────────────────────────────────────

// ── Form types ──────────────────────────────────────────────────────

/**
 * The four form types that determine a form's case behavior:
 * - "registration" — creates a new case
 * - "followup" — loads and updates an existing case
 * - "close" — loads an existing case, can update properties, and closes it
 * - "survey" — standalone data collection with no case management
 */
export const FORM_TYPES = [
	"registration",
	"followup",
	"close",
	"survey",
] as const;
export type FormType = (typeof FORM_TYPES)[number];

/** Form types that require a case type on the parent module. */
export const CASE_FORM_TYPES: ReadonlySet<FormType> = new Set([
	"registration",
	"followup",
	"close",
]);

/** Form types that load an existing case (need a case datum / case preloads). */
export const CASE_LOADING_FORM_TYPES: ReadonlySet<FormType> = new Set([
	"followup",
	"close",
]);

// ── Post-submit navigation ───────────────────────────────────────────

/** All destinations (internal). Includes root/parent_module for CommCare export fidelity. */
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
 * Case-loading forms (followup, close) return to the case list;
 * registration and survey go home.
 */
export function defaultPostSubmit(formType: FormType): PostSubmitDestination {
	return CASE_LOADING_FORM_TYPES.has(formType) ? "previous" : "app_home";
}

// ── Question types ──────────────────────────────────────────────────────

/**
 * Structural question types — containers (group, repeat) and display-only
 * (label). These don't produce referenceable values in XPath expressions
 * or conditions. Derived sets like VALUE_PRODUCING_TYPES exclude these.
 */
export const STRUCTURAL_QUESTION_TYPES: ReadonlySet<string> = new Set([
	"group",
	"repeat",
	"label",
]);

export const QUESTION_TYPES = [
	"text",
	"int",
	"date",
	"single_select",
	"multi_select",
	"geopoint",
	"image",
	"barcode",
	"decimal",
	"label",
	"time",
	"datetime",
	"audio",
	"video",
	"signature",
	"hidden",
	"secret",
	"group",
	"repeat",
] as const;

/**
 * Question types that accept user input and therefore support validation
 * (constraint + constraintMsg). Derived by excluding structural containers
 * (group, repeat), display-only elements (label), and computed values
 * (hidden). A hidden field has no user-facing error state — the user can't
 * correct a calculated value — so `validation` / `validation_msg` are a
 * category error there, not just a no-op.
 */
export const INPUT_QUESTION_TYPES: ReadonlySet<string> = new Set(
	QUESTION_TYPES.filter(
		(t) => !STRUCTURAL_QUESTION_TYPES.has(t) && t !== "hidden",
	),
);

/** True if the question type supports a validation constraint + message. */
export function supportsValidation(type: string): boolean {
	return INPUT_QUESTION_TYPES.has(type);
}

export const selectOptionSchema = z.object({
	value: z.string().describe("Option value (stored in data)"),
	label: z.string().describe("Option label (shown to user)"),
});

/** Typed pair for case property ↔ question mappings (replaces Record<string, string>). */
const casePropertyMappingSchema = z.object({
	case_property: z.string().describe("Case property name"),
	question_id: z.string().describe("Question id in the form"),
});

const RESERVED_CASE_PROPERTIES =
	"case_id, case_type, closed, closed_by, closed_on, date, date_modified, date_opened, doc_type, domain, external_id, index, indices, modified_on, name, opened_by, opened_on, owner_id, server_modified_on, status, type, user_id, xform_id";

// ── Case property data types (excludes media, structural, hidden/secret) ──

const CASE_PROPERTY_DATA_TYPES = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
] as const;

// ── Case property + case type schemas ────────────────────────────────

const casePropertySchema = z.object({
	name: z
		.string()
		.describe(
			"Property name in snake_case. " +
				`Must NOT be a reserved word: ${RESERVED_CASE_PROPERTIES}. ` +
				"Must NOT be media/binary (photos, audio, video, signatures). " +
				'Use descriptive alternatives (e.g. "visit_date" not "date", "full_name" not "name").',
		),
	label: z
		.string()
		.describe(
			"Human-readable label for this property. Used as the default question label in all forms.",
		),
	data_type: z
		.enum(CASE_PROPERTY_DATA_TYPES)
		.optional()
		.describe(
			'Data type. Determines the default question type. Omit for "text".',
		),
	hint: z
		.string()
		.optional()
		.describe("Hint text shown below questions collecting this property."),
	required: z
		.string()
		.optional()
		.describe(
			"\"true()\" if always required. Omit if optional. String values must be quoted: `'text'`, not `text`.",
		),
	validation: z
		.string()
		.optional()
		.describe(
			"XPath validation expression, e.g. \". > 0 and . < 150\". String values must be quoted: `'text'`, not `text`.",
		),
	validation_msg: z
		.string()
		.optional()
		.describe("Error message when validation fails."),
	options: z
		.array(selectOptionSchema)
		.optional()
		.describe("Options for single_select/multi_select properties."),
});

const caseTypeSchema = z.object({
	name: z
		.string()
		.describe('Case type name in snake_case (e.g., "patient", "household")'),
	properties: z
		.array(casePropertySchema)
		.describe(
			'Case properties to track. Forms will create questions to capture these. The case name question must always have id "case_name".',
		),
	parent_type: z
		.string()
		.optional()
		.describe(
			'Parent case type name. Present only for child case types (e.g., a "child" case type with parent_type "mother").',
		),
	relationship: z
		.enum(["child", "extension"])
		.optional()
		.describe(
			'"child" (default) or "extension". Only used when parent_type is set. Use "extension" when the child should prevent the parent from being closed.',
		),
});

// ── Case Types Output Schema (for generateSchema tool) ─────────────────

export const caseTypesOutputSchema = z.object({
	case_types: z
		.array(caseTypeSchema)
		.describe("Case types and their properties"),
});

// ── Scaffold Modules Schema (for generateScaffold tool, minus case_types) ──

export const scaffoldModulesSchema = z.object({
	app_name: z.string().describe("Name of the CommCare application"),
	description: z
		.string()
		.describe("Brief description of the app purpose and target users"),
	connect_type: z
		.enum(["learn", "deliver", ""])
		.describe(
			'CommCare Connect app type: "learn" for training/certification, "deliver" for paid service delivery. Empty string for standard apps.',
		),
	modules: z.array(
		z.object({
			name: z.string().describe("Display name for the module/menu"),
			case_type: z
				.string()
				.nullable()
				.describe(
					'References a case_type name from the data model. Required if any form is "registration", "followup", or "close". null for survey-only modules.',
				),
			case_list_only: z
				.boolean()
				.describe(
					"True when this module exists solely to display a case list with no forms. " +
						"Use for child case types that need to be viewable but have no follow-up workflow.",
				),
			purpose: z
				.string()
				.describe("Brief description of this module's role in the app"),
			forms: z.array(
				z.object({
					name: z.string().describe("Display name for the form"),
					type: z
						.enum(FORM_TYPES)
						.describe(
							'"registration" creates a new case. "followup" updates an existing case. "close" loads and closes an existing case. "survey" is standalone.',
						),
					purpose: z
						.string()
						.describe("Brief description of what this form collects and why"),
					post_submit: z
						.enum(USER_FACING_DESTINATIONS)
						.optional()
						.describe(
							'Where the user goes after submitting. Defaults to "previous" for followup forms, "app_home" for registration/survey. Only set to override.',
						),
					formDesign: z
						.string()
						.describe(
							"Free-text UX design spec for this form. Describe the intended question flow, " +
								"grouping, skip logic patterns, calculated fields, and how this form relates to " +
								"sibling forms.",
						),
				}),
			),
		}),
	),
});

// ── Module Content Schema (case list columns) ─────────────────────────

export const moduleContentSchema = z.object({
	case_list_columns: z
		.array(
			z.object({
				field: z.string().describe("Case property name to display"),
				header: z.string().describe("Column header text"),
			}),
		)
		.nullable()
		.describe("Columns for the case list. null for survey-only modules."),
	case_detail_columns: z
		.array(
			z.object({
				field: z.string().describe("Case property name"),
				header: z.string().describe("Display label for this detail field"),
			}),
		)
		.nullable()
		.describe(
			"Columns shown in the case detail view (when a user taps on a case). null to auto-mirror case_list_columns.",
		),
});

// ── Connect Config ────────────────────────────────────────────────────

const connectLearnModuleSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	description: z.string(),
	time_estimate: z.number().int().positive(),
});

const connectAssessmentSchema = z.object({
	id: z.string().optional(),
	user_score: z.string(),
});

const connectDeliverUnitSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	entity_id: z.string(),
	entity_name: z.string(),
});

const connectTaskSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	description: z.string(),
});

const connectConfigSchema = z.object({
	learn_module: connectLearnModuleSchema.optional(),
	assessment: connectAssessmentSchema.optional(),
	deliver_unit: connectDeliverUnitSchema.optional(),
	task: connectTaskSchema.optional(),
});

// ── Question Field Descriptions ───────────────────────────────────────
//
// Single source of truth for question field guidance, consumed by the
// blueprint validation schema and all SA tool schemas.

export const QUESTION_DOCS = {
	id: "Unique identifier per parent level. Use alphanumeric snake_case (must start with a letter).",
	type:
		"Question type. Always pick the most specific type available: " +
		'"text" for free text values (shape can be enforced with validation expression), ' +
		'"date"/"time"/"datetime" for temporal values, ' +
		'"int" for whole numbers (age, count, quantity), ' +
		'"decimal" for measurements (weight, height, price), ' +
		'"single_select" for any fixed single-choice (yes/no, gender, status), ' +
		'"multi_select" for multi-choice (symptoms, services), ' +
		'"geopoint" for GPS, "image"/"audio"/"video"/"signature"/"barcode" for media capture, ' +
		'"hidden" with "calculate" for any computed values, ' +
		'"secret" for passwords/PINs, ' +
		'"group"/"repeat" for nesting.',
	label:
		"Human-friendly label for the element. " +
		"Supports hashtag references and markdown." +
		"Do NOT use {curly_brace} template syntax — it is not supported. " +
		"Omit for hidden questions.",
	hint: "Help text shown below the question.",
	required:
		"An XPath expression for requiring the element (can be `true()` for always required). " +
		"Supports hashtag references.",
	validation:
		'XPath expression for validation (e.g. ". > 0 and . < 150"). ' +
		"Supports hashtag references.",
	validation_msg: "Error message shown when validation fails.",
	relevant:
		"XPath expression evaluated to conditionally show or hide this element. " +
		"Supports hashtag references.",
	calculate:
		"XPath expression evaluated on form load and whenever any of the calculation's dependencies update. " +
		"Supports hashtag references.",
	default_value:
		"XPath expression evaluated once on form load. " +
		"Supports hashtag references.",
	options:
		"Options for single_select/multi_select questions — at least 2 options. Omit for all other question types.",
	case_property_on:
		"Case type name this question saves to. " +
		"When this matches the module's case_type, the question is a normal case property. " +
		"When different, it creates a child case of that type. " +
		'The question for the case name must always have id "case_name". ' +
		`Question id must NOT be a reserved name: ${RESERVED_CASE_PROPERTIES}. ` +
		"Must NOT be set on media questions (image, audio, video, signature).",
} as const satisfies Record<string, string>;

// ── Question Schema ───────────────────────────────────────────────────

export const questionFields = {
	id: z.string().describe(QUESTION_DOCS.id),
	type: z.enum(QUESTION_TYPES).describe(QUESTION_DOCS.type),
	label: z.string().optional().describe(QUESTION_DOCS.label),
	hint: z.string().optional().describe(QUESTION_DOCS.hint),
	required: z.string().optional().describe(QUESTION_DOCS.required),
	validation: z.string().optional().describe(QUESTION_DOCS.validation),
	validation_msg: z.string().optional().describe(QUESTION_DOCS.validation_msg),
	relevant: z.string().optional().describe(QUESTION_DOCS.relevant),
	calculate: z.string().optional().describe(QUESTION_DOCS.calculate),
	default_value: z.string().optional().describe(QUESTION_DOCS.default_value),
	options: z
		.array(selectOptionSchema)
		.optional()
		.describe(QUESTION_DOCS.options),
	case_property_on: z
		.string()
		.optional()
		.describe(QUESTION_DOCS.case_property_on),
};

const questionSchema: z.ZodType<Question> = z.object({
	/* uuid is internal — NOT in questionFields (which feeds SA tool schemas).
	 * Must be in the Zod schema so it survives Firestore read validation
	 * (z.object strips unknown keys by default). Always present: assigned by
	 * buildQuestionTree (generation) or newQuestionToBlueprint (manual add). */
	uuid: z.string(),
	...questionFields,
	children: z
		.lazy(() => z.array(questionSchema))
		.optional()
		.describe("Nested questions for group/repeat types"),
});

// ── Form Link Schema ─────────────────────────────────────────────────

const formLinkDatumSchema = z.object({
	name: z.string().describe('Target datum ID (e.g. "case_id")'),
	xpath: z.string().describe("XPath expression for the datum value"),
});

const formLinkTargetSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("form"),
		moduleIndex: z.number().describe("0-based target module index"),
		formIndex: z.number().describe("0-based target form index"),
	}),
	z.object({
		type: z.literal("module"),
		moduleIndex: z.number().describe("0-based target module index"),
	}),
]);

const formLinkSchema = z.object({
	condition: z
		.string()
		.optional()
		.describe("XPath condition. Omit = always matches."),
	target: formLinkTargetSchema.describe("Navigation target — a form or module"),
	datums: z
		.array(formLinkDatumSchema)
		.optional()
		.describe("Manual datum overrides when auto-matching fails"),
});

// ── Form Schema ──────────────────────────────────────────────────────

export const blueprintFormSchema = z
	.object({
		/* uuid is internal — stable form identity across sessions. Required
		 * (matches Question.uuid). The legacy migration path lives in
		 * scripts/migrate-module-form-uuids.ts, which stamps uuids on any
		 * pre-uuid blueprint in Firestore. SA tools that create forms call
		 * bpAddForm/bpReplaceForm in blueprintHelpers.ts, which mint uuids
		 * at the wire-format boundary. */
		uuid: z.string(),
		name: z.string().describe("Display name for the form"),
		type: z
			.enum(FORM_TYPES)
			.describe(
				'"registration" creates a new case. "followup" updates an existing case. "close" loads and closes an existing case. "survey" is standalone data collection with no case management.',
			),
		close_condition: z
			.object({
				question: z
					.string()
					.describe("Question id to check for conditional close"),
				answer: z.string().describe("Value that triggers case closure"),
				operator: z
					.enum(["=", "selected"])
					.optional()
					.describe(
						'Comparison operator. "=" for exact match (default). "selected" for multi-select questions (checks if the option is among selected values).',
					),
			})
			.optional()
			.describe(
				'Close forms only. When present, the case is closed only when the condition is met. When absent, the case is always closed unconditionally. Use operator "selected" for multi-select questions.',
			),
		/** @deprecated Replaced by form type "close" + close_condition. Kept for Firestore migration. */
		close_case: z
			.object({
				question: z.string().optional(),
				answer: z.string().optional(),
			})
			.optional()
			.describe("Deprecated — migrated to close form type on read."),
		post_submit: z
			.enum(POST_SUBMIT_DESTINATIONS)
			.optional()
			.describe(
				"Where the user goes after submitting this form (also serves as fallback when form_links have conditions). " +
					'"app_home" = main menu. ' +
					'"module" = this module\'s form list. ' +
					'"previous" = back to where the user was (e.g. case list for followup forms). ' +
					'Internal values "root" and "parent_module" are resolved automatically during build. ' +
					'Defaults to "previous" for followup/close, "app_home" for registration/survey.',
			),
		form_links: z
			.array(formLinkSchema)
			.optional()
			.describe(
				"Conditional navigation to other forms/modules after submission. " +
					"When present, links are evaluated in order — the first matching condition wins. " +
					"post_submit serves as the fallback when no condition matches. " +
					"Not yet exposed in the UI or SA tools.",
			),
		connect: connectConfigSchema
			.optional()
			.describe(
				"CommCare Connect configuration. Present when this form is part of a Connect Learn or Deliver app.",
			),
		questions: z
			.array(questionSchema)
			.describe(
				"Array of questions with nested children for groups/repeats. Every form must have at least one question.",
			),
	})
	.describe("A form within a module");

// ── Module and App schemas ──────────────────────────────────────────────

const caseListColumnSchema = z.object({
	field: z.string().describe("Case property name"),
	header: z.string().describe("Column header display text"),
});

const blueprintModuleSchema = z
	.object({
		/* uuid is internal — stable module identity across sessions. Required
		 * (matches Question.uuid + BlueprintForm.uuid). SA tools that create
		 * modules call bpAddModule/bpSetScaffold, which mint uuids at the
		 * wire-format boundary. Legacy blueprints with no uuid run through
		 * scripts/migrate-module-form-uuids.ts. */
		uuid: z.string(),
		name: z.string().describe("Display name for the module/menu"),
		case_type: z
			.string()
			.optional()
			.describe(
				'Required if any form is "registration" or "followup". Use short snake_case (e.g. "patient", "household_visit"). Only letters, digits, underscores, hyphens.',
			),
		case_list_only: z
			.boolean()
			.optional()
			.describe(
				"True when this module exists solely to display a case list with no forms. " +
					"CommCare requires every case type to have its own module — use this for child case types " +
					"that have no follow-up workflow but still need to be viewable.",
			),
		forms: z
			.array(blueprintFormSchema)
			.describe("Array of forms in this module"),
		case_list_columns: z
			.array(caseListColumnSchema)
			.optional()
			.describe(
				'Columns shown in the case list. Each has "field" (case property) and "header" (display text). Use "case_name" to display the case name.',
			),
		case_detail_columns: z
			.array(caseListColumnSchema)
			.optional()
			.describe(
				"Columns shown in the case detail view (when a user taps on a case). Omit to auto-mirror case_list_columns.",
			),
	})
	.describe("A module (menu) in the app");

/** Top-level schema for a complete CommCare app in blueprint format. */
export const appBlueprintSchema = z
	.object({
		app_name: z.string().describe("Name of the CommCare application"),
		connect_type: z
			.enum(["learn", "deliver"])
			.optional()
			.describe(
				'CommCare Connect app type. "learn" for training/certification apps. "deliver" for paid service delivery apps.',
			),
		modules: z
			.array(blueprintModuleSchema)
			.describe("Array of modules. Each module is a menu containing forms."),
		case_types: z
			.array(caseTypeSchema)
			.nullable()
			.describe(
				"Case type definitions with property metadata. null if all modules are survey-only.",
			),
	})
	.describe("A CommCare application definition in blueprint format");

// ── Types ──────────────────────────────────────────────────────────────

export type BlueprintForm = z.infer<typeof blueprintFormSchema>;
export type BlueprintModule = z.infer<typeof blueprintModuleSchema>;
export type AppBlueprint = z.infer<typeof appBlueprintSchema>;
/** The two CommCare Connect app modes — learn (training/certification) or deliver (paid service delivery). */
export type ConnectType = NonNullable<AppBlueprint["connect_type"]>;
/** Recursive question type — supports arbitrary nesting depth for groups/repeats.
 *  `uuid` is a stable crypto UUID assigned at creation time — used as the identity
 *  key for React reconciliation, dnd-kit, DOM selectors, and selection state.
 *  The user-editable `id` stays the semantic CommCare property name. */
export interface Question {
	uuid: string;
	id: string;
	type: (typeof QUESTION_TYPES)[number];
	label?: string;
	hint?: string;
	required?: string;
	validation?: string;
	validation_msg?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	options?: Array<{ value: string; label: string }>;
	case_property_on?: string;
	children?: Question[];
}
export type CaseProperty = z.infer<typeof casePropertySchema>;
export type CaseType = z.infer<typeof caseTypeSchema>;

export type ConnectConfig = z.infer<typeof connectConfigSchema>;
export type ConnectLearnModule = z.infer<typeof connectLearnModuleSchema>;
export type ConnectAssessment = z.infer<typeof connectAssessmentSchema>;
export type ConnectDeliverUnit = z.infer<typeof connectDeliverUnitSchema>;
export type ConnectTask = z.infer<typeof connectTaskSchema>;
export type FormLink = z.infer<typeof formLinkSchema>;
export type FormLinkDatum = z.infer<typeof formLinkDatumSchema>;
export type CasePropertyMapping = z.infer<typeof casePropertyMappingSchema>;
export type Scaffold = z.infer<typeof scaffoldModulesSchema>;
export type ModuleContent = z.infer<typeof moduleContentSchema>;

// ── JSON Schema export ─────────────────────────────────────────────────

export function getAppBlueprintJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(appBlueprintSchema);
}

// `deriveCaseConfig` moved to lib/services/deriveCaseConfig.ts — it's a
// pure derivation over duck-typed questions, not a schema concern.
