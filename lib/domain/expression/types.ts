/** The one persisted expression vocabulary. Contextual admission belongs to profiles/check. */
import { z } from "zod";
import {
	AUTHORED_CASE_PROPERTY_NAME_PATTERN,
	authoredCasePropertyNameSchema,
} from "../casePropertyName";
import { casePropertyDataTypeSchema } from "../casePropertyTypes";
import { externalUserPropertyNameSchema } from "../externalUserProperty";
import {
	persistableJsonNumberSchema,
	persistableJsonPositiveNumberSchema,
} from "../jsonNumber";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "../lookupIds";
import { isStandardCaseListProperty } from "../standardCaseProperties";
import { type Uuid, uuidSchema } from "../uuid";
import {
	DISTANCE_UNITS,
	type DistanceUnit,
	distanceValidationIssue,
} from "./distance";

export { SESSION_USER_FIELD_PATTERN } from "../externalUserProperty";
export type { DistanceUnit } from "./distance";

export type CheckPath = readonly (string | number)[];
export const CASE_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export const CASE_PROPERTY_PATTERN = AUTHORED_CASE_PROPERTY_NAME_PATTERN;
export const XML_ELEMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const caseTypeNameSchema = z.string().regex(CASE_TYPE_PATTERN);
const xmlNameSchema = z.string().regex(XML_ELEMENT_NAME_PATTERN);
export const relationStepSchema = z.strictObject({
	identifier: xmlNameSchema,
	throughCaseType: caseTypeNameSchema.optional(),
});
export type RelationStep = z.infer<typeof relationStepSchema>;
export const relationPathSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("self") }),
	z.strictObject({
		kind: z.literal("ancestor"),
		via: z.tuple([relationStepSchema], relationStepSchema),
	}),
	z.strictObject({
		kind: z.literal("subcase"),
		identifier: xmlNameSchema,
		ofCaseType: caseTypeNameSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("any-relation"),
		identifier: xmlNameSchema,
		ofCaseType: caseTypeNameSchema.optional(),
	}),
]);
export type RelationPath = z.infer<typeof relationPathSchema>;
export const propertyRefSchema = z
	.strictObject({
		kind: z.literal("prop"),
		caseType: caseTypeNameSchema.optional(),
		property: authoredCasePropertyNameSchema,
		via: relationPathSchema.optional(),
	})
	.refine(
		(v) => v.caseType !== undefined || isStandardCaseListProperty(v.property),
		{
			message: "A custom property read needs its record type.",
			path: ["caseType"],
		},
	);
export type PropertyRef = z.infer<typeof propertyRefSchema>;
export const formCasePropertyRefSchema = z.strictObject({
	kind: z.literal("form-case"),
	caseType: caseTypeNameSchema,
	property: authoredCasePropertyNameSchema,
});
export type FormCasePropertyRef = z.infer<typeof formCasePropertyRefSchema>;
export const searchInputRefSchema = z.strictObject({
	kind: z.literal("input"),
	searchInputUuid: uuidSchema,
});
export type SearchInputRef = z.infer<typeof searchInputRefSchema>;
export const SESSION_CONTEXT_FIELDS = [
	"userid",
	"username",
	"deviceid",
	"appversion",
	"drift",
	"window_width",
	"applanguage",
] as const;
export type SessionContextField = (typeof SESSION_CONTEXT_FIELDS)[number];
const workerSourceSchema = z.literal("worker-record").optional();
export const sessionUserSchema = z.strictObject({
	kind: z.literal("session-user"),
	field: externalUserPropertyNameSchema,
	source: workerSourceSchema,
});
export type SessionUserRef = z.infer<typeof sessionUserSchema>;
export const sessionUserPropertySchema = z.strictObject({
	kind: z.literal("session-user-property"),
	userPropertyUuid: uuidSchema,
	source: workerSourceSchema,
});
export type SessionUserPropertyRef = z.infer<typeof sessionUserPropertySchema>;
export const sessionContextSchema = z.strictObject({
	kind: z.literal("session-context"),
	field: z.enum(SESSION_CONTEXT_FIELDS),
});
export type SessionContextRef = z.infer<typeof sessionContextSchema>;
export const datumRefSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("selected-case"), module: uuidSchema }),
	z.strictObject({ kind: z.literal("new-case") }),
	z.strictObject({
		kind: z.literal("new-child-case"),
		caseType: caseTypeNameSchema,
	}),
	z.strictObject({ kind: z.literal("worker-record") }),
	z.strictObject({ kind: z.literal("tile-group-parents"), module: uuidSchema }),
]);
export type DatumRef = z.infer<typeof datumRefSchema>;
export type FormLinkDatumName = Extract<DatumRef, { kind: "selected-case" }>;
export const formLinkDatumNameSchema = z.strictObject({
	kind: z.literal("selected-case"),
	module: uuidSchema,
});
export function datumRefKey(datum: DatumRef): string {
	switch (datum.kind) {
		case "selected-case":
		case "tile-group-parents":
			return `${datum.kind}:${datum.module}`;
		case "new-child-case":
			return `${datum.kind}:${datum.caseType}`;
		case "new-case":
		case "worker-record":
			return datum.kind;
	}
}
export const fieldSpellingSchema = z.enum(["absolute", "relative", "current"]);
export type FieldSpelling = z.infer<typeof fieldSpellingSchema>;
export const fieldNodeRefSchema = z.strictObject({
	kind: z.literal("field"),
	uuid: uuidSchema,
	role: z.literal("query-wrapper").optional(),
});
export type FieldNodeRef = z.infer<typeof fieldNodeRefSchema>;
export const repeatRowNodeRefSchema = z.strictObject({
	kind: z.literal("repeat-row"),
	repeat: uuidSchema,
	attribute: z.enum(["id", "index"]),
});
export type RepeatRowNodeRef = z.infer<typeof repeatRowNodeRefSchema>;
export const formNodeRefSchema = z.discriminatedUnion("kind", [
	fieldNodeRefSchema,
	repeatRowNodeRefSchema,
	z.strictObject({ kind: z.literal("form-root"), form: uuidSchema }),
	z.strictObject({
		kind: z.literal("repeat"),
		repeat: uuidSchema,
		role: z.enum([
			"query-ids",
			"query-count",
			"query-position",
			"count-result",
		]),
	}),
	z.strictObject({
		kind: z.literal("connect-learn"),
		form: uuidSchema,
		role: z.enum([
			"block",
			"content",
			"id",
			"name",
			"description",
			"time-estimate",
		]),
	}),
	z.strictObject({
		kind: z.literal("connect-assessment"),
		form: uuidSchema,
		role: z.enum(["block", "content", "id", "score"]),
	}),
	z.strictObject({
		kind: z.literal("connect-delivery"),
		form: uuidSchema,
		role: z.enum([
			"block",
			"content",
			"id",
			"name",
			"entity-id",
			"entity-name",
			"work-area-id",
		]),
	}),
	z.strictObject({
		kind: z.literal("connect-task"),
		form: uuidSchema,
		role: z.enum(["block", "content", "name", "description"]),
	}),
]);
export type FormNodeRef = z.infer<typeof formNodeRefSchema>;
export type FormStepFilter = {
	step: Exclude<FormNodeRef, { kind: "form-root" }>;
	where: [Expression, ...Expression[]];
};
export function formNodeKey(node: FormNodeRef): string {
	switch (node.kind) {
		case "field":
			return `field:${node.uuid}:${node.role ?? "row"}`;
		case "repeat-row":
			return `repeat-row:${node.repeat}:${node.attribute}`;
		case "form-root":
			return `form-root:${node.form}`;
		case "repeat":
			return `repeat:${node.repeat}:${node.role}`;
		case "connect-learn":
		case "connect-assessment":
		case "connect-delivery":
		case "connect-task":
			return `${node.kind}:${node.form}:${node.role}`;
	}
}
const E: z.ZodType<Expression> = z.lazy(() => expressionSchema);
export const formStepFilterSchema: z.ZodType<FormStepFilter> = z.strictObject({
	step: formNodeRefSchema.refine(
		(v): v is FormStepFilter["step"] => v.kind !== "form-root",
		"The form root cannot carry a path filter.",
	),
	where: z.tuple([E], E),
}) as z.ZodType<FormStepFilter>;
const formFiltersSchema = z
	.tuple([formStepFilterSchema], formStepFilterSchema)
	.refine(
		(filters) =>
			new Set(filters.map((f) => formNodeKey(f.step))).size === filters.length,
		"Each form path step has one filter group.",
	);
function needsRelativeFilter(
	filters: [FormStepFilter, ...FormStepFilter[]] | undefined,
): boolean {
	return (
		filters?.some(
			({ step }) =>
				step.kind !== "repeat-row" &&
				(step.kind !== "field" || step.role === "query-wrapper"),
		) ?? false
	);
}
export type FormFieldRef = {
	kind: "field";
	uuid: Uuid;
	role?: "query-wrapper";
	spelling?: FieldSpelling;
	filters?: [FormStepFilter, ...FormStepFilter[]];
};
export const formFieldRefSchema = z
	.strictObject({
		kind: z.literal("field"),
		uuid: uuidSchema,
		role: z.literal("query-wrapper").optional(),
		spelling: fieldSpellingSchema.optional(),
		filters: formFiltersSchema.optional(),
	})
	.refine(
		(v) =>
			!(v.role === "query-wrapper" || needsRelativeFilter(v.filters)) ||
			v.spelling === "relative" ||
			v.spelling === "current",
		"Generated form nodes use a relative or current path.",
	);
export type FormNodeTerm = {
	kind: "form-node";
	node: Exclude<FormNodeRef, FieldNodeRef | RepeatRowNodeRef>;
	spelling: "relative" | "current";
	filters?: [FormStepFilter, ...FormStepFilter[]];
};
export const formNodeTermSchema: z.ZodType<FormNodeTerm> = z
	.strictObject({
		kind: z.literal("form-node"),
		node: formNodeRefSchema.refine(
			(v): v is FormNodeTerm["node"] =>
				v.kind !== "field" && v.kind !== "repeat-row",
			"Use the field or repeat-row leaf for that node.",
		),
		spelling: z.enum(["relative", "current"]),
		filters: formFiltersSchema.optional(),
	})
	.refine(
		(v) => v.node.kind !== "form-root" || v.filters === undefined,
		"The form root cannot carry path filters.",
	) as z.ZodType<FormNodeTerm>;
export type RepeatRowTerm = {
	kind: "repeat-row";
	repeat: Uuid;
	attribute: "id" | "index";
	spelling?: FieldSpelling;
	filters?: [FormStepFilter, ...FormStepFilter[]];
};
export const repeatRowTermSchema = z
	.strictObject({
		kind: z.literal("repeat-row"),
		repeat: uuidSchema,
		attribute: z.enum(["id", "index"]),
		spelling: fieldSpellingSchema.optional(),
		filters: formFiltersSchema.optional(),
	})
	.refine(
		(v) =>
			!needsRelativeFilter(v.filters) ||
			v.spelling === "relative" ||
			v.spelling === "current",
		"Generated form nodes use a relative or current path.",
	);
export const tableColumnTermSchema = z.strictObject({
	kind: z.literal("table-column"),
	tableId: lookupTableIdSchema,
	columnId: lookupColumnIdSchema,
});
export type TableColumnTerm = z.infer<typeof tableColumnTermSchema>;
export const fixedLocationTermSchema = z.strictObject({
	kind: z.literal("fixed-location"),
	locationUuid: uuidSchema,
});
export type FixedLocationTerm = z.infer<typeof fixedLocationTermSchema>;
export const ownerLocationAtLevelTermSchema = z.strictObject({
	kind: z.literal("owner-location-at-level"),
	levelUuid: uuidSchema,
	ownerCaseType: caseTypeNameSchema,
});
export type OwnerLocationAtLevelTerm = z.infer<
	typeof ownerLocationAtLevelTermSchema
>;
export const literalSchema = z.strictObject({
	kind: z.literal("literal"),
	value: z.union([
		z.string(),
		persistableJsonNumberSchema,
		z.boolean(),
		z.null(),
	]),
	data_type: casePropertyDataTypeSchema.optional(),
});
export type Literal = z.infer<typeof literalSchema>;
export const choiceSchema = z.strictObject({
	kind: z.literal("choice"),
	field: uuidSchema,
	options: z.tuple([uuidSchema], uuidSchema),
});
export type Choice = z.infer<typeof choiceSchema>;
export const caseTypeTermSchema = z.strictObject({
	kind: z.literal("case-type"),
	caseType: caseTypeNameSchema,
});
export type CaseTypeTerm = z.infer<typeof caseTypeTermSchema>;
export const caseRowTypeTermSchema = z.strictObject({
	kind: z.literal("case-row-type"),
});
export type CaseRowTypeTerm = z.infer<typeof caseRowTypeTermSchema>;
export const caseIndexTermSchema = z.strictObject({
	kind: z.literal("case-index"),
	caseType: caseTypeNameSchema.optional(),
	identifier: xmlNameSchema,
});
export type CaseIndexTerm = z.infer<typeof caseIndexTermSchema>;
export const sessionDatumTermSchema = z.strictObject({
	kind: z.literal("session-datum"),
	datum: datumRefSchema,
});
export type SessionDatumTerm = z.infer<typeof sessionDatumTermSchema>;
export const locationLevelTermSchema = z.strictObject({
	kind: z.literal("location-level"),
	levelUuid: uuidSchema,
});
export type LocationLevelTerm = z.infer<typeof locationLevelTermSchema>;
export const locationRowFieldSchema = z.union([
	z.enum([
		"id",
		"type",
		"name",
		"site_code",
		"external_id",
		"latitude",
		"longitude",
	]),
	z.strictObject({ level: uuidSchema }),
	z.strictObject({ property: uuidSchema }),
]);
export type LocationRowField = z.infer<typeof locationRowFieldSchema>;
export const locationFieldTermSchema = z.strictObject({
	kind: z.literal("location-field"),
	field: locationRowFieldSchema,
});
export type LocationFieldTerm = z.infer<typeof locationFieldTermSchema>;
export type Term =
	| PropertyRef
	| FormCasePropertyRef
	| SearchInputRef
	| SessionUserRef
	| SessionUserPropertyRef
	| SessionContextRef
	| FormFieldRef
	| FormNodeTerm
	| TableColumnTerm
	| FixedLocationTerm
	| OwnerLocationAtLevelTerm
	| Literal
	| Choice
	| CaseTypeTerm
	| CaseRowTypeTerm
	| CaseIndexTerm
	| SessionDatumTerm
	| RepeatRowTerm
	| LocationLevelTerm
	| LocationFieldTerm;
export const termSchema: z.ZodType<Term> = z.union([
	propertyRefSchema,
	formCasePropertyRefSchema,
	searchInputRefSchema,
	sessionUserSchema,
	sessionUserPropertySchema,
	sessionContextSchema,
	formFieldRefSchema,
	formNodeTermSchema,
	tableColumnTermSchema,
	fixedLocationTermSchema,
	ownerLocationAtLevelTermSchema,
	literalSchema,
	choiceSchema,
	caseTypeTermSchema,
	caseRowTypeTermSchema,
	caseIndexTermSchema,
	sessionDatumTermSchema,
	repeatRowTermSchema,
	locationLevelTermSchema,
	locationFieldTermSchema,
]);
export const itextUnitSchema = z.union([
	z.strictObject({
		field: uuidSchema,
		role: z.enum([
			"field-label",
			"field-hint",
			"field-help",
			"field-validation-message",
		]),
	}),
	z.strictObject({
		field: uuidSchema,
		option: uuidSchema,
		role: z.literal("select-option-label"),
	}),
]);
export type ItextUnit = z.infer<typeof itextUnitSchema>;
export const ARITH_OPS = ["+", "-", "*", "div", "mod", "quotient"] as const;
export type ArithOp = (typeof ARITH_OPS)[number];
export const DATE_ADD_INTERVALS = [
	"seconds",
	"minutes",
	"hours",
	"days",
	"weeks",
	"months",
	"years",
] as const;
export type DateAddInterval = (typeof DATE_ADD_INTERVALS)[number];
export const FORMAT_DATE_PRESETS = ["short", "long", "iso"] as const;
export type FormatDatePreset = (typeof FORMAT_DATE_PRESETS)[number];
export const COMPARISON_KINDS = [
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];
export const MATCH_MODES = [
	"fuzzy",
	"phonetic",
	"fuzzy-date",
	"starts-with",
] as const;
export type MatchMode = (typeof MATCH_MODES)[number];
export const MULTI_SELECT_QUANTIFIERS = ["any", "all"] as const;
export type MultiSelectQuantifier = (typeof MULTI_SELECT_QUANTIFIERS)[number];
export const CALL_FUNCTIONS = [
	"abs",
	"acos",
	"asin",
	"atan",
	"atan2",
	"boolean",
	"boolean-from-string",
	"ceiling",
	"checklist",
	"checksum",
	"closest-point-on-polygon",
	"cond",
	"contains",
	"cos",
	"count-selected",
	"decrypt-string",
	"depend",
	"distance",
	"distinct-values",
	"encrypt-string",
	"ends-with",
	"exp",
	"floor",
	"format-date-for-calendar",
	"id-compress",
	"index-of",
	"int",
	"is-point-inside-polygon",
	"join",
	"join-chunked",
	"json-property",
	"log",
	"log10",
	"lower-case",
	"max",
	"min",
	"normalize-space",
	"number",
	"pi",
	"position",
	"pow",
	"random",
	"replace",
	"round",
	"selected-at",
	"sin",
	"sleep",
	"sort",
	"sort-by",
	"sqrt",
	"string",
	"string-length",
	"substr",
	"substring-after",
	"substring-before",
	"sum",
	"tan",
	"translate",
	"upper-case",
	"uuid",
	"weighted-checklist",
] as const;
export type CallFunction = (typeof CALL_FUNCTIONS)[number];
export type SwitchCase = { when: Literal | Choice; then: Expression };
export type ConditionArm =
	| { kind: ComparisonKind; left: Expression; right: Expression }
	| {
			kind: "in";
			left: Expression;
			values: [Literal | Choice, ...(Literal | Choice)[]];
	  }
	| {
			kind: "within-distance";
			property: PropertyRef;
			center: Expression;
			distance: number | Expression;
			unit: DistanceUnit | Expression;
	  }
	| {
			kind: "match";
			property: PropertyRef | Expression;
			value: Expression;
			mode: MatchMode;
	  }
	| {
			kind: "multi-select-contains";
			property: PropertyRef | Expression;
			values: [
				Literal | Choice | Expression,
				...(Literal | Choice | Expression)[],
			];
			quantifier: MultiSelectQuantifier;
	  }
	| { kind: "match-all" }
	| { kind: "match-none" }
	| { kind: "is-blank"; left: Expression }
	| { kind: "matches-pattern"; left: Expression; pattern: string | Expression }
	| {
			kind: "between";
			left: Expression;
			lower?: Expression;
			upper?: Expression;
			lowerInclusive: boolean;
			upperInclusive: boolean;
	  }
	| { kind: "and"; clauses: [Expression, ...Expression[]] }
	| { kind: "or"; clauses: [Expression, ...Expression[]] }
	| { kind: "not"; clause: Expression }
	| { kind: "when-input-present"; input: SearchInputRef; clause: Expression }
	| { kind: "exists"; via: RelationPath; where?: Expression }
	| { kind: "missing"; via: RelationPath; where?: Expression };
export type ValueArm =
	| { kind: "term"; term: Term }
	| { kind: "today" }
	| { kind: "now" }
	| { kind: "id-of"; opUuid: Uuid }
	| { kind: "acting-user" }
	| { kind: "unowned" }
	| {
			kind: "table-lookup";
			tableId: LookupTableId;
			resultColumnId: LookupColumnId;
			where: Expression;
	  }
	| {
			kind: "date-add";
			date: Expression;
			interval: DateAddInterval;
			quantity: Expression;
	  }
	| { kind: "date-coerce"; value: Expression }
	| { kind: "datetime-coerce"; value: Expression }
	| { kind: "double"; value: Expression }
	| { kind: "arith"; op: ArithOp; left: Expression; right: Expression }
	| { kind: "concat"; parts: [Expression, ...Expression[]] }
	| { kind: "coalesce"; values: [Expression, ...Expression[]] }
	| { kind: "if"; cond: Expression; then: Expression; else: Expression }
	| {
			kind: "switch";
			on: Expression;
			cases: [SwitchCase, ...SwitchCase[]];
			fallback: Expression;
	  }
	| { kind: "count"; via: RelationPath | Expression; where?: Expression }
	| { kind: "format-date"; date: Expression; pattern: string | Expression }
	| { kind: "negate"; value: Expression }
	| { kind: "call"; fn: CallFunction; args: Expression[] }
	| { kind: "itext"; unit: ItextUnit }
	| { kind: "choice-name"; field: Uuid; value: Expression }
	| { kind: "here" }
	/** What the worker typed into the case list's search box, on the entry's
	 * one case list: `session/data/stringquery`, which only Android sets. */
	| { kind: "case-list-search-text" }
	| { kind: "value-list"; items: [Expression, ...Expression[]] };
export type InstanceArm =
	| { kind: "cases"; source: "casedb" | "search-results"; where: Expression[] }
	| { kind: "table-rows"; tableId: LookupTableId; where: Expression[] }
	| { kind: "locations"; where: Expression[] }
	| { kind: "selected-cases"; module: Uuid }
	| { kind: "project"; of: Expression; value: Term };
export type Expression = ConditionArm | ValueArm | InstanceArm;
export type ExpressionOfKind<K extends Expression["kind"]> = Expression & {
	kind: K;
};
export type TermOfKind<K extends Term["kind"]> = Term & { kind: K };
const CONDITION_KINDS = new Set<string>([
	...COMPARISON_KINDS,
	"in",
	"within-distance",
	"match",
	"multi-select-contains",
	"match-all",
	"match-none",
	"is-blank",
	"matches-pattern",
	"between",
	"and",
	"or",
	"not",
	"when-input-present",
	"exists",
	"missing",
]);
const VALUE_KINDS = new Set<string>([
	"term",
	"today",
	"now",
	"id-of",
	"acting-user",
	"unowned",
	"table-lookup",
	"date-add",
	"date-coerce",
	"datetime-coerce",
	"double",
	"arith",
	"concat",
	"coalesce",
	"if",
	"switch",
	"count",
	"format-date",
	"negate",
	"call",
	"itext",
	"choice-name",
	"here",
	"case-list-search-text",
	"value-list",
]);
const INSTANCE_KINDS = new Set<string>([
	"cases",
	"table-rows",
	"locations",
	"selected-cases",
	"project",
]);
const TERM_KINDS = new Set<string>([
	"prop",
	"form-case",
	"input",
	"session-user",
	"session-user-property",
	"session-context",
	"field",
	"form-node",
	"table-column",
	"fixed-location",
	"owner-location-at-level",
	"literal",
	"choice",
	"case-type",
	"case-row-type",
	"case-index",
	"session-datum",
	"repeat-row",
	"location-level",
	"location-field",
]);
function hasKind(value: unknown): value is { kind: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		typeof value.kind === "string"
	);
}
/** Discriminator guards classify already-admitted trees; expressionSchema owns validation. */
export function isExpression(value: unknown): value is Expression {
	return (
		hasKind(value) &&
		(CONDITION_KINDS.has(value.kind) ||
			VALUE_KINDS.has(value.kind) ||
			INSTANCE_KINDS.has(value.kind))
	);
}
export function isTerm(value: unknown): value is Term {
	return hasKind(value) && TERM_KINDS.has(value.kind);
}
export function isRelationPath(value: unknown): value is RelationPath {
	return (
		hasKind(value) &&
		["self", "ancestor", "subcase", "any-relation"].includes(value.kind)
	);
}
export function isConditionArm(value: Expression): value is ConditionArm {
	return CONDITION_KINDS.has(value.kind);
}
export function isValueArm(value: Expression): value is ValueArm {
	return VALUE_KINDS.has(value.kind);
}
export function isInstanceArm(value: Expression): value is InstanceArm {
	return INSTANCE_KINDS.has(value.kind);
}
const manyE = z.tuple([E], E);
const literalOrChoice = z.union([literalSchema, choiceSchema]);
const propOrE = z
	.union([propertyRefSchema, E])
	.refine(
		(v) => v.kind !== "term" || v.term.kind !== "prop",
		"Write a property reference directly.",
	);
const computedSelectionValue = z
	.union([literalSchema, choiceSchema, E])
	.refine(
		(v) =>
			v.kind !== "term" ||
			(v.term.kind !== "literal" && v.term.kind !== "choice"),
		"Write a literal or choice value directly.",
	);
function untypedLiteral(value: Expression): Literal | undefined {
	return value.kind === "term" &&
		value.term.kind === "literal" &&
		value.term.data_type === undefined
		? value.term
		: undefined;
}
const computedString = E.refine(
	(v) => typeof untypedLiteral(v)?.value !== "string",
	"Write a string value directly.",
);
const computedPattern = E.refine((v) => {
	const lit = untypedLiteral(v);
	return (
		typeof lit?.value !== "string" ||
		(FORMAT_DATE_PRESETS as readonly string[]).includes(lit.value)
	);
}, "Write a date pattern directly.");
export const PATTERN_MAX_LENGTH = 1000;
export const idOfSchema = z.strictObject({
	kind: z.literal("id-of"),
	opUuid: uuidSchema,
});
export const actingUserSchema = z.strictObject({
	kind: z.literal("acting-user"),
});
export const unownedSchema = z.strictObject({ kind: z.literal("unowned") });
export const tableLookupExpressionSchema = z.strictObject({
	kind: z.literal("table-lookup"),
	tableId: lookupTableIdSchema,
	resultColumnId: lookupColumnIdSchema,
	where: E,
});
const conditionSchemas = [
	z.strictObject({ kind: z.enum(COMPARISON_KINDS), left: E, right: E }),
	z.strictObject({
		kind: z.literal("in"),
		left: E,
		values: z
			.tuple([literalOrChoice], literalOrChoice)
			.refine(
				(v) => v.some((x) => x.kind !== "literal" || x.value !== null),
				"Choose at least one non-null value.",
			),
	}),
	z
		.strictObject({
			kind: z.literal("within-distance"),
			property: propertyRefSchema,
			center: E,
			distance: z.union([
				persistableJsonPositiveNumberSchema,
				E.refine(
					(v) => typeof untypedLiteral(v)?.value !== "number",
					"Write a distance value directly.",
				),
			]),
			unit: z.union([
				z.enum(DISTANCE_UNITS),
				E.refine((v) => {
					const lit = untypedLiteral(v);
					return (
						typeof lit?.value !== "string" ||
						!(DISTANCE_UNITS as readonly string[]).includes(lit.value)
					);
				}, "Write a distance unit directly."),
			]),
		})
		.superRefine((v, ctx) => {
			if (
				typeof v.distance === "number" &&
				typeof v.unit === "string" &&
				distanceValidationIssue(v.distance, v.unit) === "meters-overflow"
			)
				ctx.addIssue({
					code: "custom",
					path: ["distance"],
					message: "Distance is too large to convert to meters.",
				});
		}),
	z.strictObject({
		kind: z.literal("match"),
		property: propOrE,
		value: E,
		mode: z.enum(MATCH_MODES),
	}),
	z
		.strictObject({
			kind: z.literal("multi-select-contains"),
			property: propOrE,
			values: z.tuple([computedSelectionValue], computedSelectionValue),
			quantifier: z.enum(MULTI_SELECT_QUANTIFIERS),
		})
		.refine(
			(v) => v.values.some((x) => x.kind !== "literal" || x.value !== null),
			"Choose at least one non-null value.",
		),
	z.strictObject({ kind: z.literal("match-all") }),
	z.strictObject({ kind: z.literal("match-none") }),
	z.strictObject({ kind: z.literal("is-blank"), left: E }),
	z.strictObject({
		kind: z.literal("matches-pattern"),
		left: E,
		pattern: z.union([z.string(), computedString]),
	}),
	z
		.strictObject({
			kind: z.literal("between"),
			left: E,
			lower: E.optional(),
			upper: E.optional(),
			lowerInclusive: z.boolean(),
			upperInclusive: z.boolean(),
		})
		.refine(
			(v) => v.lower !== undefined || v.upper !== undefined,
			"A range needs at least one bound.",
		),
	z.strictObject({ kind: z.literal("and"), clauses: manyE }),
	z.strictObject({ kind: z.literal("or"), clauses: manyE }),
	z.strictObject({ kind: z.literal("not"), clause: E }),
	z.strictObject({
		kind: z.literal("when-input-present"),
		input: searchInputRefSchema,
		clause: E,
	}),
	z.strictObject({
		kind: z.literal("exists"),
		via: relationPathSchema,
		where: E.optional(),
	}),
	z.strictObject({
		kind: z.literal("missing"),
		via: relationPathSchema,
		where: E.optional(),
	}),
] as const;
// biome-ignore lint/suspicious/noThenProperty: Persisted AST branch data is never callable.
const switchCaseSchema = z.strictObject({ when: literalOrChoice, then: E });
const valueSchemas = [
	z.strictObject({ kind: z.literal("term"), term: termSchema }),
	z.strictObject({ kind: z.literal("today") }),
	z.strictObject({ kind: z.literal("now") }),
	idOfSchema,
	actingUserSchema,
	unownedSchema,
	tableLookupExpressionSchema,
	z.strictObject({
		kind: z.literal("date-add"),
		date: E,
		interval: z.enum(DATE_ADD_INTERVALS),
		quantity: E,
	}),
	z.strictObject({ kind: z.literal("date-coerce"), value: E }),
	z.strictObject({ kind: z.literal("datetime-coerce"), value: E }),
	z.strictObject({ kind: z.literal("double"), value: E }),
	z.strictObject({
		kind: z.literal("arith"),
		op: z.enum(ARITH_OPS),
		left: E,
		right: E,
	}),
	z.strictObject({ kind: z.literal("concat"), parts: manyE }),
	z.strictObject({ kind: z.literal("coalesce"), values: manyE }),
	// biome-ignore lint/suspicious/noThenProperty: Persisted AST branch data is never callable.
	z.strictObject({ kind: z.literal("if"), cond: E, then: E, else: E }),
	z.strictObject({
		kind: z.literal("switch"),
		on: E,
		cases: z.tuple([switchCaseSchema], switchCaseSchema),
		fallback: E,
	}),
	z
		.strictObject({
			kind: z.literal("count"),
			via: z.union([relationPathSchema, E]),
			where: E.optional(),
		})
		.refine(
			(v) => v.where === undefined || isRelationPath(v.via),
			"Put the filter in the selected rows when counting an expression.",
		),
	z.strictObject({
		kind: z.literal("format-date"),
		date: E,
		pattern: z.union([z.string(), computedPattern]),
	}),
	z.strictObject({ kind: z.literal("negate"), value: E }),
	z.strictObject({
		kind: z.literal("call"),
		fn: z.enum(CALL_FUNCTIONS),
		args: z.array(E),
	}),
	z.strictObject({ kind: z.literal("itext"), unit: itextUnitSchema }),
	z.strictObject({
		kind: z.literal("choice-name"),
		field: uuidSchema,
		value: E,
	}),
	z.strictObject({ kind: z.literal("here") }),
	z.strictObject({ kind: z.literal("case-list-search-text") }),
	z.strictObject({ kind: z.literal("value-list"), items: manyE }),
] as const;
const instanceSchemas = [
	z.strictObject({
		kind: z.literal("cases"),
		source: z.enum(["casedb", "search-results"]),
		where: z.array(E),
	}),
	z.strictObject({
		kind: z.literal("table-rows"),
		tableId: lookupTableIdSchema,
		where: z.array(E),
	}),
	z.strictObject({ kind: z.literal("locations"), where: z.array(E) }),
	z.strictObject({ kind: z.literal("selected-cases"), module: uuidSchema }),
	z.strictObject({
		kind: z.literal("project"),
		of: E,
		value: termSchema.refine(
			(v) =>
				[
					"prop",
					"case-row-type",
					"case-index",
					"table-column",
					"location-field",
				].includes(v.kind),
			"Project one value from the selected row.",
		),
	}),
] as const;
const expressionDefinition = z.discriminatedUnion("kind", [
	...conditionSchemas,
	...valueSchemas,
	...instanceSchemas,
]);
export const expressionSchema: z.ZodType<Expression> = expressionDefinition;

/** Stored slots share one language; these distinct definitions select only
 * their authoring grammar and served description. */
export const formLogicSchema: z.ZodType<Expression> = z.lazy(
	() => expressionSchema,
);
export const conditionSchema: z.ZodType<Expression> = z.lazy(
	() => expressionSchema,
);
export const valueSchema: z.ZodType<Expression> = z.lazy(
	() => expressionSchema,
);

type TypesEqual<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const _expressionSchemaDrift: TypesEqual<
	Expression,
	z.infer<typeof expressionDefinition>
> = true;

/** Syntax subsets describe record-dialect positions, never stored-slot admission. */
export const conditionArmSchema: z.ZodType<ConditionArm> =
	z.union(conditionSchemas);
export const valueArmSchema: z.ZodType<ValueArm> = z.union(valueSchemas);
export const instanceArmSchema: z.ZodType<InstanceArm> =
	z.union(instanceSchemas);

export type FieldExpressionSlotRef = {
	readonly entity: "field";
	readonly uuid: Uuid;
	readonly slot:
		| "relevant"
		| "validate"
		| "calculate"
		| "default_value"
		| "required"
		| "repeat_count"
		| "ids_query"
		| "lookup_options_source";
};
export type FormExpressionSlotRef =
	| {
			readonly entity: "form";
			readonly uuid: Uuid;
			readonly slot:
				| "form_display_condition"
				| "assessment_user_score"
				| "deliver_entity_id"
				| "deliver_entity_name";
	  }
	| {
			readonly entity: "form";
			readonly uuid: Uuid;
			readonly slot: "form_link_condition";
			readonly member: { readonly linkUuid: Uuid };
	  }
	| {
			readonly entity: "form";
			readonly uuid: Uuid;
			readonly slot: "form_link_datum_xpath";
			readonly member: {
				readonly linkUuid: Uuid;
				readonly datum: FormLinkDatumName;
			};
	  }
	| {
			readonly entity: "form";
			readonly uuid: Uuid;
			readonly slot:
				| "case_operation_target_expression"
				| "case_operation_condition"
				| "case_operation_name"
				| "case_operation_owner"
				| "case_operation_rename";
			readonly member: { readonly operationUuid: Uuid };
	  }
	| {
			readonly entity: "form";
			readonly uuid: Uuid;
			readonly slot:
				| "case_operation_write_value"
				| "case_operation_write_condition";
			readonly member: {
				readonly operationUuid: Uuid;
				readonly property: string;
			};
	  }
	| {
			readonly entity: "form";
			readonly uuid: Uuid;
			readonly slot: "case_operation_link_target_expression";
			readonly member: {
				readonly operationUuid: Uuid;
				readonly identifier: string;
			};
	  };
export type ModuleExpressionSlotRef =
	| {
			readonly entity: "module";
			readonly uuid: Uuid;
			readonly slot:
				| "module_display_condition"
				| "case_list_filter"
				| "search_button_display_condition"
				| "excluded_owner_ids";
	  }
	| {
			readonly entity: "module";
			readonly uuid: Uuid;
			readonly slot: "case_list_column_expression";
			readonly member: { readonly columnUuid: Uuid };
	  }
	| {
			readonly entity: "module";
			readonly uuid: Uuid;
			readonly slot:
				| "search_input_default"
				| "search_input_predicate"
				| "search_input_options"
				| "search_input_required_when"
				| "search_input_validation_rule"
				| "search_input_hidden_value";
			readonly member: { readonly searchInputUuid: Uuid };
	  };
export type ExpressionSlotRef =
	| FieldExpressionSlotRef
	| FormExpressionSlotRef
	| ModuleExpressionSlotRef;
export type ProseSlotRef =
	| {
			readonly entity: "field";
			readonly uuid: Uuid;
			readonly slot: "label" | "hint" | "help" | "validate_msg";
	  }
	| {
			readonly entity: "field";
			readonly uuid: Uuid;
			readonly slot: "option_label";
			readonly member: { readonly optionUuid: Uuid };
	  };
export type SlotContextRef = ExpressionSlotRef | ProseSlotRef;

z.globalRegistry.add(expressionSchema, { id: "Expression" });
z.globalRegistry.add(termSchema, { id: "Term" });
z.globalRegistry.add(relationPathSchema, { id: "RelationPath" });
z.globalRegistry.add(datumRefSchema, { id: "DatumRef" });
z.globalRegistry.add(formNodeRefSchema, { id: "FormNodeRef" });

z.globalRegistry.add(conditionSchema, { id: "Predicate" });
z.globalRegistry.add(valueSchema, { id: "ValueExpression" });
z.globalRegistry.add(relationStepSchema, { id: "RelationStep" });
z.globalRegistry.add(propertyRefSchema, { id: "PropertyRef" });
z.globalRegistry.add(searchInputRefSchema, { id: "SearchInputRef" });
z.globalRegistry.add(sessionUserSchema, { id: "SessionUser" });
z.globalRegistry.add(sessionUserPropertySchema, { id: "SessionUserProperty" });
z.globalRegistry.add(sessionContextSchema, { id: "SessionContext" });
z.globalRegistry.add(formFieldRefSchema, { id: "FormFieldRef" });
z.globalRegistry.add(tableColumnTermSchema, { id: "TableColumnTerm" });
z.globalRegistry.add(fixedLocationTermSchema, { id: "FixedLocationTerm" });
z.globalRegistry.add(ownerLocationAtLevelTermSchema, {
	id: "OwnerLocationAtLevelTerm",
});
z.globalRegistry.add(literalSchema, { id: "Literal" });
z.globalRegistry.add(idOfSchema, { id: "IdOf" });
z.globalRegistry.add(actingUserSchema, { id: "ActingUser" });
z.globalRegistry.add(unownedSchema, { id: "Unowned" });
z.globalRegistry.add(tableLookupExpressionSchema, {
	id: "TableLookupExpression",
});
