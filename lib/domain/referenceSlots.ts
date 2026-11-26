// lib/domain/referenceSlots.ts
//
// The reference-slot registry: one declarative enumeration of every
// blueprint slot that can carry a reference to another part of the
// app. A "reference" here is anything that names an entity, a case
// property, or a case type — an Expression tree, a prose template whose typed atoms name references,
// an entity pointer, an
// entity uuid, or a bare case-type/case-property name.
//
// The registry is shared vocabulary: the validator's per-surface
// unions (`FormLogicSurface` / `ProseSurface` / Connect slots in
// `lib/commcare/validator/index.ts`) are asserted equal to projections
// of this data by `lib/commcare/validator/__tests__/referenceSlotUnions.test.ts`.
// One enumeration, no drift surface.
//
// ## Totality contract
//
// Every key the field / form / module Zod schemas declare is
// classified exactly once — either by a registry entry below or by an
// explicit entry in the matching `NON_REFERENCE_*_PATHS` map. The
// audit test (`__tests__/referenceSlots.test.ts`) walks the real
// schemas and fails on any unclassified key, so adding an
// expression-bearing property without registering it is a failing
// test, not a silent rewriter gap. The same test resolves every
// registry path into the schemas, so a registry entry whose path (or
// kind applicability) doesn't exist is equally a failing test.
//
// ## What is deliberately NOT here
//
//   - Derived case wiring (form actions, Save to Case blocks): never
//     stored on the doc — `lib/commcare` derives it from the form's case
//     operations on demand.
//   - Blueprint-root slots (`appId` / `appName` / `connectType` /
//     `logo` / the order arrays / the `caseTypes` catalog): the
//     registry's owning entities are field / form / module. The
//     `caseTypes` catalog is outside this field/form/module registry;
//     its ancestry and property declarations have their own domain consumers.
//   - Media asset slots: they reference stored media by `MediaAssetId`, and
//     `mediaRefs.ts::walkAssetRefs` is the single walk that owns them.
//     They are classified `media` in the non-reference maps so the
//     audit stays total without duplicating that registry.

import type { BlueprintDoc } from "./blueprint";
import {
	datumRefKey,
	type Expression,
	type ExpressionSlotRef,
	isExpression,
	type ProseSlotRef,
	type SlotContextRef,
} from "./expression/types";
import type { Field } from "./fields";
import { captureFieldKinds, type FieldKind, type RepeatMode } from "./fields";
import { FORM_TYPES, type FormType } from "./forms";
import { LABEL_TEXT_SLOTS } from "./labelForms";
import {
	makeTranslationUnitId,
	type TranslationEntry,
	translationSourceFingerprint,
	translationSourceFingerprintsEqual,
} from "./localization";
import type { ColumnKind, SearchInputDef } from "./modules";
import type { ProseTemplate } from "./prose";
import { ownRecordValue } from "./records";
import { isDeeplySettled } from "./settled";
import type { Uuid } from "./uuid";

/**
 * How a slot carries its reference — the dispatch key consumers use to
 * pick an extraction/rewrite strategy:
 *
 *   - `expression` — the single typed Expression vocabulary. Stable identities
 *     are walked structurally; authored source is a projection, never storage.
 *   - `prose` — a `ProseTemplate` whose reference atoms carry stable
 *     identity. Hashtag-looking text is ordinary authored text; friendly
 *     `#form/...` and `#<case_type>/...` spellings are projections of the
 *     typed atoms, never reparsed storage.
 *   - `relation-path` — a typed relation path whose declared type hints are
 *     references; property destinations resolve through the actual catalog.
 *   - `datum-ref` — a typed entry-datum identity, never an emitted wire name.
 *   - `options-source` — a whole identity-bearing lookup or case choice source.
 *     Table/column identities belong to the lookup-reference registry; case
 *     types, label properties, and optional predicates are walked by the
 *     ordinary blueprint reference index for form/case dependencies.
 *   - `entity-uuid` — names an entity (module/form/field) by stable
 *     uuid.
 *   - `case-property-ref` — names a case property by bare name; the
 *     owning case type comes from context (the module's `caseType`,
 *     or a relation walk's destination).
 *   - `case-type-ref` — names a case type by bare name.
 */
const REFERENCE_SURFACE_KINDS = [
	"expression",
	"prose",
	"relation-path",
	"datum-ref",
	"options-source",
	"entity-uuid",
	"worker-property-ref",
	"case-property-ref",
	"case-type-ref",
] as const;
export type ReferenceSurfaceKind = (typeof REFERENCE_SURFACE_KINDS)[number];

/**
 * One reference-carrying slot on a `Field`. `path` is the key path
 * into the kind's Zod schema (`.` for object steps, `[]` for array
 * elements); `slot` is the stable surface id the validator's unions
 * and error locations speak (`ids_query`, `option_label`), kept
 * distinct from `path` because nested slots flatten to one id.
 *
 * `appliesTo` lists exactly the kinds whose schema declares the path —
 * audited both directions (a claimed kind whose schema lacks the path
 * fails resolution; an unclaimed kind whose schema has it fails the
 * audit). `repeatModes` narrows applicability within the repeat
 * union's variants and may only be present when `appliesTo` includes
 * `"repeat"`; absent means every variant declares the path.
 */
export interface FieldReferenceSlot {
	readonly entity: "field";
	readonly slot: string;
	readonly path: string;
	readonly kind: ReferenceSurfaceKind;
	readonly appliesTo: readonly FieldKind[];
	readonly repeatModes?: readonly RepeatMode[];
}

/**
 * One reference-carrying slot on a `Form`. The form schema is one
 * object across all four form types, so applicability is semantic, not
 * structural: `formTypes` lists the types the slot is VALID on per the
 * validator's rules (a `closeCondition` off a registration or a close
 * form is `CLOSE_CONDITION_WRONG_TYPE`), while the path
 * resolves on every form. Connect slots are additionally gated by the app-level
 * `connectType` (learn apps carry `assessment`, deliver apps carry
 * `deliver_unit`) — an app-level axis, so it isn't encoded per-slot.
 */
export interface FormReferenceSlot {
	readonly entity: "form";
	readonly slot: string;
	readonly path: string;
	readonly kind: ReferenceSurfaceKind;
	readonly formTypes: readonly FormType[];
}

type SearchInputArmKind = SearchInputDef["kind"];

/**
 * The search-input union's second axis. `searchInputDefSchema` is seven arms over
 * TWO independent dimensions — `kind` (simple | advanced | hidden) and widget
 * shape (scalar | date-range | select; the hidden arm has no widget).
 * Options live only on choice widgets. Starting values live on every
 * visible widget, including both date-range arms.
 */
type SearchInputWidget = "scalar" | "date-range" | "select";

/**
 * One reference-carrying slot on a `Module`. `columnKinds` /
 * `searchInputKinds` / `searchInputWidgets` narrow applicability within the
 * case-list column union and the search-input union — same role `repeatModes`
 * plays on field slots; absent means every arm declares the path.
 */
export interface ModuleReferenceSlot {
	readonly entity: "module";
	readonly slot: string;
	readonly path: string;
	readonly kind: ReferenceSurfaceKind;
	readonly columnKinds?: readonly ColumnKind[];
	readonly searchInputKinds?: readonly SearchInputArmKind[];
	readonly searchInputWidgets?: readonly SearchInputWidget[];
}

export type ReferenceSlot =
	| FieldReferenceSlot
	| FormReferenceSlot
	| ModuleReferenceSlot;

// ── Field-kind applicability groups ───────────────────────────────
//
// Named for the schema base they share, so each slot's `appliesTo`
// reads as a contract, not a list to eyeball. The audit test proves
// each group exact against the per-kind schemas.

/** Kinds extending `inputFieldBaseSchema` — full input wiring
 *  (hint / help / required / relevant). */
const INPUT_KINDS = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"barcode",
	"secret",
] as const satisfies readonly FieldKind[];

/** Input kinds that also carry `validate` / `validate_msg` /
 *  `default_value` (every input kind except `geopoint`, whose
 *  sensor-shaped value takes a default but no constraint). */
const VALIDATED_INPUT_KINDS = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"barcode",
	"secret",
] as const satisfies readonly FieldKind[];

/** Binary capture kinds — label + hint + required + relevant plus the
 *  capture case-write destination (no help, no validation, no default).
 *  Aliases the domain's `captureFieldKinds`; the audit test proves the
 *  group exact against the per-kind schemas. */
const CAPTURE_KINDS = captureFieldKinds;

const SELECT_KINDS = [
	"single_select",
	"multi_select",
] as const satisfies readonly FieldKind[];

/** Every kind whose schema declares `relevant`: input kinds, capture
 *  kinds, display `label`, `hidden`, and the `group` / `repeat`
 *  containers gate visibility with the same slot. A `section` is the one
 *  kind without it: a page has no logic, by schema. */
const RELEVANT_KINDS = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"image",
	"audio",
	"video",
	"file",
	"barcode",
	"signature",
	"label",
	"hidden",
	"secret",
	"group",
	"repeat",
] as const satisfies readonly FieldKind[];

/** Every kind with a display label — all but `hidden` (never shown,
 *  nothing to label). Containers carry it optionally; the slot is the
 *  same prose surface either way. */
const LABELED_KINDS = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"image",
	"audio",
	"video",
	"file",
	"barcode",
	"signature",
	"label",
	"secret",
	"group",
	"repeat",
	"section",
] as const satisfies readonly FieldKind[];

/** Kinds whose label carries media and the label's other texts
 *  (`labelForms.ts`): every visible question, a display label included. */
const LABEL_TEXT_KINDS = [
	...INPUT_KINDS,
	...CAPTURE_KINDS,
	"label",
] as const satisfies readonly FieldKind[];

// ── Field slots ───────────────────────────────────────────────────

export const FIELD_REFERENCE_SLOTS = [
	// Entry order is observable: consumers that walk a field's slots in
	// registry order (the rename rewriters, the deep validator's scan —
	// whose error order user-facing surfaces preserve) see slots in this
	// sequence, so it stays aligned with the validator's long-standing
	// relevant → validate → calculate → default_value → required walk.
	{
		entity: "field",
		slot: "relevant",
		path: "relevant",
		kind: "expression",
		appliesTo: RELEVANT_KINDS,
	},
	{
		entity: "field",
		slot: "validate",
		path: "validate",
		kind: "expression",
		appliesTo: VALIDATED_INPUT_KINDS,
	},
	{
		entity: "field",
		slot: "calculate",
		path: "calculate",
		kind: "expression",
		// Computed values live on hidden fields only — a `calculate` bind
		// makes a control read-only, so visible kinds carry `default_value`
		// (a one-shot seed) instead.
		appliesTo: ["hidden"],
	},
	{
		entity: "field",
		slot: "default_value",
		path: "default_value",
		kind: "expression",
		appliesTo: [...VALIDATED_INPUT_KINDS, "geopoint", "hidden"],
	},
	{
		entity: "field",
		slot: "required",
		path: "required",
		kind: "expression",
		appliesTo: [...INPUT_KINDS, ...CAPTURE_KINDS],
	},
	{
		entity: "field",
		slot: "repeat_count",
		path: "repeat_count",
		kind: "expression",
		appliesTo: ["repeat"],
		repeatModes: ["count_bound"],
	},
	{
		entity: "field",
		slot: "ids_query",
		path: "data_source.ids_query",
		kind: "expression",
		appliesTo: ["repeat"],
		repeatModes: ["query_bound"],
	},
	{
		entity: "field",
		slot: "label",
		path: "label",
		kind: "prose",
		appliesTo: LABELED_KINDS,
	},
	...LABEL_TEXT_SLOTS.map(
		(slot) =>
			({
				entity: "field",
				slot,
				path: slot,
				kind: "prose",
				appliesTo: LABEL_TEXT_KINDS,
			}) as const,
	),
	{
		entity: "field",
		slot: "hint",
		path: "hint",
		kind: "prose",
		appliesTo: [...INPUT_KINDS, ...CAPTURE_KINDS],
	},
	{
		entity: "field",
		slot: "help",
		path: "help",
		kind: "prose",
		appliesTo: INPUT_KINDS,
	},
	{
		entity: "field",
		slot: "validate_msg",
		path: "validate_msg",
		kind: "prose",
		appliesTo: VALIDATED_INPUT_KINDS,
	},
	{
		entity: "field",
		slot: "option_label",
		path: "optionsSource.options[].label",
		kind: "prose",
		appliesTo: SELECT_KINDS,
	},
	{
		entity: "field",
		slot: "lookup_options_source",
		path: "optionsSource",
		kind: "options-source",
		appliesTo: SELECT_KINDS,
	},
] as const satisfies readonly FieldReferenceSlot[];

// ── Form slots ────────────────────────────────────────────────────

export const FORM_REFERENCE_SLOTS = [
	{
		entity: "form",
		slot: "form_badge",
		path: "badge.expression",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "form_display_condition",
		path: "displayCondition",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "form_open_condition",
		path: "openCondition",
		// When a registration creates its case, read once as the form is
		// submitted (`OPEN_CONDITION_WRONG_TYPE` off a registration).
		kind: "expression",
		formTypes: ["registration"],
	},
	{
		entity: "form",
		slot: "form_close_condition",
		path: "closeCondition",
		// When the form closes its own case, read once as the form is
		// submitted (`CLOSE_CONDITION_WRONG_TYPE` off a registration or a
		// close form).
		kind: "expression",
		formTypes: ["registration", "close"],
	},
	{
		entity: "form",
		slot: "form_link_condition",
		path: "formLinks[].condition",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "form_link_target",
		path: "formLinks[].target",
		kind: "entity-uuid",
		// The whole discriminated target value is the reference: the
		// `form` arm carries `moduleUuid` + `formUuid`, the `module` arm
		// `moduleUuid` alone. Consumers read the arm structurally.
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "form_link_datum_name",
		path: "formLinks[].datums[].name",
		kind: "datum-ref",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "form_link_datum_xpath",
		path: "formLinks[].datums[].xpath",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	// The otherwise link is a link: its target and carried values take the
	// destinations' slots, addressed by its own uuid. It has no condition.
	// These are the registry's only slot ids held at two paths.
	{
		entity: "form",
		slot: "form_link_target",
		path: "otherwise.target",
		kind: "entity-uuid",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "form_link_datum_name",
		path: "otherwise.datums[].name",
		kind: "datum-ref",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "form_link_datum_xpath",
		path: "otherwise.datums[].xpath",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "assessment_user_score",
		path: "connect.assessment.user_score",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "deliver_entity_id",
		path: "connect.deliver_unit.entity_id",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "deliver_entity_name",
		path: "connect.deliver_unit.entity_name",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_case_type",
		path: "caseOperations[].caseType",
		kind: "case-type-ref",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_retype",
		path: "caseOperations[].retype",
		kind: "case-type-ref",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_target_op",
		path: "caseOperations[].target.opUuid",
		kind: "entity-uuid",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_target_id_from",
		path: "caseOperations[].target.idFrom",
		kind: "entity-uuid",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_target_expression",
		path: "caseOperations[].target.expr",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_repeat",
		path: "caseOperations[].forEach.repeat",
		kind: "entity-uuid",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_condition",
		path: "caseOperations[].condition",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_name",
		path: "caseOperations[].name",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_owner",
		path: "caseOperations[].owner",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_rename",
		path: "caseOperations[].rename",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_write_property",
		path: "caseOperations[].writes[].property",
		kind: "case-property-ref",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_write_value",
		path: "caseOperations[].writes[].value",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_write_condition",
		path: "caseOperations[].writes[].condition",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_write_via",
		path: "caseOperations[].writes[].via",
		// The index steps a write walks to the case above its operation's,
		// each step the one a `prop` read's `ancestor` arm takes: a
		// `throughCaseType` names a case type, and the walk decides which
		// case type the write's property belongs to.
		kind: "relation-path",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_placement_repeat",
		path: "caseOperations[].placement.repeat",
		// A held Save to Case placement's repeat, the operation's `forEach`
		// repeat by the validator's `scope` rule.
		kind: "entity-uuid",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_link_target_type",
		path: "caseOperations[].links[].targetType",
		kind: "case-type-ref",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_link_target_op",
		path: "caseOperations[].links[].target.opUuid",
		kind: "entity-uuid",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_link_target_id_from",
		path: "caseOperations[].links[].target.idFrom",
		kind: "entity-uuid",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "case_operation_link_target_expression",
		path: "caseOperations[].links[].target.expr",
		kind: "expression",
		formTypes: FORM_TYPES,
	},
] as const satisfies readonly FormReferenceSlot[];

// ── Module slots ──────────────────────────────────────────────────

export const MODULE_REFERENCE_SLOTS = [
	{
		entity: "module",
		slot: "listed_forms_source",
		path: "formsFromMenu.menuUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "unlisted_source_form",
		path: "formsFromMenu.excludedFormUuids[]",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "listed_form_link",
		path: "formsFromMenu.entryPoints[].formUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "case_form_context_menu",
		path: "caseListConfig.contextAboveForm.moduleUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "case_form_context_line",
		path: "caseListConfig.contextAboveForm.expression",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "module_case_parent",
		path: "parentCaseModuleUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "module_parent",
		path: "parentModuleUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "module_case_list_registration_form",
		path: "caseListRegistrationForm.formUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "case_list_action_condition",
		path: "caseListRegistrationForm.showWhen.condition",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "module_badge",
		path: "badge.expression",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "case_list_action_created_case",
		path: "caseListRegistrationForm.target.operationUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "case_list_action_chosen_parent",
		path: "caseListRegistrationForm.target.moduleUuid",
		kind: "entity-uuid",
	},
	{
		entity: "module",
		slot: "module_display_condition",
		path: "displayCondition",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "case_type",
		path: "caseType",
		kind: "case-type-ref",
	},
	{
		entity: "module",
		slot: "case_list_icon_action",
		path: "caseListConfig.columns[].entryPointUuid",
		kind: "entity-uuid",
		columnKinds: ["image-map"],
	},
	{
		entity: "module",
		slot: "case_list_column_field",
		path: "caseListConfig.columns[].field",
		kind: "case-property-ref",
		// Every property-rooted column arm; `calculated` has no `field` —
		// its expression is the source.
		columnKinds: [
			"plain",
			"date-count",
			"overdue-marker",
			"map-location",
			"map-layer",
			"worker-distance",
			"formatted-text",
			"date",
			"phone",
			"id-mapping",
			"image-map",
			"interval",
			"link",
		],
	},
	{
		entity: "module",
		slot: "case_list_column_worker_information",
		path: "caseListConfig.columns[].workerPropertyUuid",
		kind: "worker-property-ref",
		columnKinds: [
			"plain",
			"date-count",
			"overdue-marker",
			"map-location",
			"map-layer",
			"worker-distance",
			"formatted-text",
			"date",
			"phone",
			"id-mapping",
			"image-map",
			"interval",
			"link",
		],
	},
	{
		entity: "module",
		slot: "case_list_column_via",
		path: "caseListConfig.columns[].via",
		// The index steps a property column walks to the case whose property
		// it shows, each the step a `prop` read's `ancestor` arm takes: a
		// `throughCaseType` names a case type, and the walk decides which
		// case type the column's `field` belongs to.
		kind: "relation-path",
		columnKinds: [
			"plain",
			"date-count",
			"overdue-marker",
			"map-location",
			"map-layer",
			"worker-distance",
			"formatted-text",
			"date",
			"phone",
			"id-mapping",
			"image-map",
			"interval",
			"link",
		],
	},
	{
		entity: "module",
		slot: "case_detail_tab_child_type",
		path: "caseListConfig.detailTabs[].rowSource.caseType",
		kind: "case-type-ref",
	},
	{
		entity: "module",
		slot: "case_detail_tab_search_child_type",
		path: "caseListConfig.detailTabs[].rowSource.includeChildrenOfType",
		kind: "case-type-ref",
	},
	{
		entity: "module",
		slot: "case_detail_tab_filter",
		path: "caseListConfig.detailTabs[].rowSource.condition",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "case_detail_tab_rows",
		path: "caseListConfig.detailTabs[].rowSource.rows",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "case_detail_tab_condition",
		path: "caseListConfig.detailTabs[].displayCondition",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "case_list_column_expression",
		path: "caseListConfig.columns[].expression",
		kind: "expression",
		columnKinds: ["calculated"],
	},
	{
		entity: "module",
		slot: "case_list_mapping_condition",
		path: "caseListConfig.columns[].mapping[].when",
		kind: "expression",
		columnKinds: ["id-mapping", "image-map"],
	},
	{
		entity: "module",
		slot: "case_list_sort_expression",
		path: "caseListConfig.calculatedSorts[].expression",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "case_list_filter",
		path: "caseListConfig.filter",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "search_filter_value",
		path: "caseListConfig.searchFilters[].value",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "case_search_filter",
		path: "caseListConfig.searchCondition",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "search_order_property",
		path: "caseSearchConfig.requestOrder[].property",
		kind: "case-property-ref",
	},
	{
		entity: "module",
		slot: "search_filter_order_property",
		path: "caseListConfig.searchFilters[].order[].property",
		kind: "case-property-ref",
	},
	{
		entity: "module",
		slot: "search_filter_property",
		path: "caseListConfig.searchFilters[].target.property",
		kind: "case-property-ref",
	},
	{
		entity: "module",
		slot: "search_filter_ancestor_type",
		path: "caseListConfig.searchFilters[].target.ancestors[].throughCaseType",
		kind: "case-type-ref",
	},
	{
		entity: "module",
		slot: "search_input_property",
		path: "caseListConfig.searchInputs[].property",
		kind: "case-property-ref",
		searchInputKinds: ["simple"],
	},
	{
		entity: "module",
		slot: "search_input_via",
		path: "caseListConfig.searchInputs[].via",
		kind: "relation-path",
		// A bare `RelationPath` — the same structured walk shape the
		// predicate AST embeds, so it shares the AST surface kind and the
		// structural (never string) traversal contract.
		searchInputKinds: ["simple"],
	},
	{
		entity: "module",
		slot: "search_input_default",
		path: "caseListConfig.searchInputs[].default",
		kind: "expression",
		searchInputKinds: ["simple", "advanced"],
	},
	{
		entity: "module",
		slot: "search_input_predicate",
		path: "caseListConfig.searchInputs[].predicate",
		kind: "expression",
		searchInputKinds: ["advanced"],
	},
	{
		entity: "module",
		slot: "search_input_options",
		path: "caseListConfig.searchInputs[].options",
		kind: "options-source",
		searchInputKinds: ["simple", "advanced"],
		searchInputWidgets: ["select"],
	},
	{
		entity: "module",
		slot: "search_input_required_when",
		path: "caseListConfig.searchInputs[].required.when",
		kind: "expression",
		searchInputKinds: ["simple", "advanced"],
	},
	{
		entity: "module",
		slot: "search_input_validation_rule",
		path: "caseListConfig.searchInputs[].validation.rule",
		kind: "expression",
		searchInputKinds: ["simple", "advanced"],
	},
	{
		entity: "module",
		slot: "search_input_hidden_value",
		path: "caseListConfig.searchInputs[].value",
		kind: "expression",
		searchInputKinds: ["hidden"],
	},
	{
		entity: "module",
		slot: "search_button_display_condition",
		path: "caseSearchConfig.searchButtonDisplayCondition",
		kind: "expression",
	},
	{
		entity: "module",
		slot: "excluded_owner_ids",
		path: "caseSearchConfig.excludedOwnerIds",
		kind: "expression",
	},
] as const satisfies readonly ModuleReferenceSlot[];

// ── Slot-id projections ───────────────────────────────────────────
//
// Literal unions derived from the registry data (the `as const`
// entries above), so the validator's `XPathSurface` / `ProseSurface` /
// `ConnectXPathSlot` unions can be asserted equal to the registry in
// `lib/commcare/validator/__tests__/` without a hand-maintained copy.

type FieldSlotEntry = (typeof FIELD_REFERENCE_SLOTS)[number];
type FormSlotEntry = (typeof FORM_REFERENCE_SLOTS)[number];
type ModuleSlotEntry = (typeof MODULE_REFERENCE_SLOTS)[number];

/** Field slot ids carrying an XPath expression (AST-stored) — the
 *  registry side of the validator's `XPathSurface` union; the read
 *  surface is the printed TEXT. */
export type FieldFormLogicSlotId = Extract<
	FieldSlotEntry,
	{ kind: "expression" }
>["slot"];

/** Field slot ids carrying prose — the registry side of the
 *  validator's `ProseSurface` union. */
export type FieldProseSlotId = Extract<
	FieldSlotEntry,
	{ kind: "prose" }
>["slot"];

/** Connect-block XPath slot ids — the registry side of the validator's
 *  `ConnectXPathSlot` union. */
export type ConnectExpressionSlotId = Extract<
	FormSlotEntry,
	{ path: `connect.${string}` }
>["slot"];

/** Form-link XPath slot ids — fan-out form carriers validated and emitted
 *  once per link (and, for datum XPath, once per datum). */
export type FormLinkExpressionSlotId = Extract<
	FormSlotEntry,
	{ kind: "expression"; path: `formLinks[]${string}` }
>["slot"];

export type FieldSlotId = FieldSlotEntry["slot"];
export type FormSlotId = FormSlotEntry["slot"];
export type ModuleSlotId = ModuleSlotEntry["slot"];

// ── Applicability helpers ─────────────────────────────────────────

/**
 * Does `slot` exist on a field of `kind` (and, for repeats, of
 * `repeatMode`)? When `kind` is `"repeat"` and no mode is given, the
 * answer is kind-level ("some variant carries it") — mirroring
 * `fieldKindDeclaresKey`'s umbrella behavior.
 */
export function fieldSlotApplies(
	slot: FieldReferenceSlot,
	kind: FieldKind,
	repeatMode?: RepeatMode,
): boolean {
	if (!slot.appliesTo.includes(kind)) return false;
	if (kind === "repeat" && slot.repeatModes && repeatMode !== undefined) {
		return slot.repeatModes.includes(repeatMode);
	}
	return true;
}

/**
 * The reference slots a field of `kind` (narrowed by `repeatMode` when
 * known) carries — the per-kind projection rewriters and extractors
 * iterate instead of a hand-rolled key list.
 */
export function fieldReferenceSlotsFor(
	kind: FieldKind,
	repeatMode?: RepeatMode,
): FieldReferenceSlot[] {
	return FIELD_REFERENCE_SLOTS.filter((slot) =>
		fieldSlotApplies(slot, kind, repeatMode),
	);
}

/** The stored entities needed to resolve an expression address. */
export type ExpressionReadableDoc = Pick<
	BlueprintDoc,
	"fields" | "forms" | "modules" | "localization"
>;

export interface ExpressionCarrierRef {
	readonly entity: "field" | "form" | "module";
	readonly uuid: Uuid;
}

export interface ExpressionSlotValue {
	/** The slot the expression is checked in. A calculated value in prose
	 *  carries its prose slot. */
	readonly ref: SlotContextRef;
	readonly expression: Expression;
	/** The key path from the owner entity to the value, collection positions
	 * included: the walk a scope takes through what encloses the slot. */
	readonly path: readonly (string | number)[];
}

type ExpressionRegistryEntry = Extract<
	FieldSlotEntry | FormSlotEntry | ModuleSlotEntry,
	{ kind: "expression" | "options-source" }
>;

/** A stable address key. Collection positions are never part of identity. A
 *  prose slot keys as its owner and slot, with the option's uuid after them
 *  for a choice label; no prose slot shares a name with an expression slot. */
export function expressionSlotKey(ref: SlotContextRef): string {
	const base = [ref.entity, ref.uuid, ref.slot];
	if (!("member" in ref)) return JSON.stringify(base);
	const member = ref.member;
	if ("optionUuid" in member)
		return JSON.stringify([...base, member.optionUuid]);
	if ("datum" in member) {
		return JSON.stringify([
			...base,
			member.linkUuid,
			datumRefKey(member.datum),
		]);
	}
	if ("linkUuid" in member) return JSON.stringify([...base, member.linkUuid]);
	if ("property" in member) {
		// A write's key is its property through its `via`: two writes of one
		// property, one through `via`, are two slots.
		return JSON.stringify([
			...base,
			member.operationUuid,
			member.property,
			...(member.via === undefined
				? []
				: [
						member.via.map((step) => [
							step.identifier,
							step.throughCaseType ?? null,
						]),
					]),
		]);
	}
	if ("identifier" in member) {
		return JSON.stringify([...base, member.operationUuid, member.identifier]);
	}
	if ("operationUuid" in member) {
		return JSON.stringify([...base, member.operationUuid]);
	}
	if ("rowUuid" in member)
		return JSON.stringify([...base, member.columnUuid, member.rowUuid]);
	if ("tabUuid" in member) return JSON.stringify([...base, member.tabUuid]);
	if ("columnUuid" in member) {
		return JSON.stringify([...base, member.columnUuid]);
	}
	if ("sortUuid" in member) return JSON.stringify([...base, member.sortUuid]);
	if ("filterUuid" in member)
		return JSON.stringify([...base, member.filterUuid]);
	return JSON.stringify([...base, member.searchInputUuid]);
}

/**
 * Resolve the registry walk's array positions to stable member identities.
 * This is the one address implementation used by both enumeration and reads.
 */
function expressionRefForEntry(
	doc: ExpressionReadableDoc,
	owner: ExpressionCarrierRef,
	entry: ExpressionRegistryEntry,
	indices: readonly number[],
): ExpressionSlotRef | undefined {
	const uuid = owner.uuid;
	if (entry.entity === "field") {
		return { entity: "field", uuid, slot: entry.slot };
	}
	if (entry.entity === "module") {
		const mod = ownRecordValue(doc.modules, uuid);
		if (mod === undefined) return undefined;
		switch (entry.slot) {
			case "module_badge":
			case "module_display_condition":
			case "case_list_action_condition":
			case "case_list_filter":
			case "case_form_context_line":
			case "case_search_filter":
			case "search_button_display_condition":
			case "excluded_owner_ids":
				return { entity: "module", uuid, slot: entry.slot };
			case "case_list_mapping_condition": {
				const column = mod.caseListConfig?.columns[indices[0] ?? -1];
				if (column?.kind !== "id-mapping" && column?.kind !== "image-map")
					return undefined;
				const row = column.mapping[indices[1] ?? -1];
				return row?.uuid === undefined
					? undefined
					: {
							entity: "module",
							uuid,
							slot: entry.slot,
							member: { columnUuid: column.uuid, rowUuid: row.uuid },
						};
			}
			case "case_list_sort_expression": {
				const sort = mod.caseListConfig?.calculatedSorts?.[indices[0] ?? -1];
				return sort === undefined
					? undefined
					: {
							entity: "module",
							uuid,
							slot: entry.slot,
							member: { sortUuid: sort.uuid },
						};
			}
			case "case_detail_tab_filter":
			case "case_detail_tab_rows":
			case "case_detail_tab_condition": {
				const tab = mod.caseListConfig?.detailTabs?.[indices[0] ?? -1];
				return (
					tab && {
						entity: "module",
						uuid,
						slot: entry.slot,
						member: { tabUuid: tab.uuid },
					}
				);
			}
			case "search_filter_value": {
				const filter = mod.caseListConfig?.searchFilters?.[indices[0] ?? -1];
				return filter === undefined
					? undefined
					: {
							entity: "module",
							uuid,
							slot: entry.slot,
							member: { filterUuid: filter.uuid },
						};
			}
			case "case_list_column_expression": {
				const column = mod.caseListConfig?.columns[indices[0] ?? -1];
				return column === undefined
					? undefined
					: {
							entity: "module",
							uuid,
							slot: entry.slot,
							member: { columnUuid: column.uuid },
						};
			}
			case "search_input_default":
			case "search_input_predicate":
			case "search_input_options":
			case "search_input_required_when":
			case "search_input_validation_rule":
			case "search_input_hidden_value": {
				const input = mod.caseListConfig?.searchInputs?.[indices[0] ?? -1];
				return input === undefined
					? undefined
					: {
							entity: "module",
							uuid,
							slot: entry.slot,
							member: { searchInputUuid: input.uuid },
						};
			}
			default: {
				const exhaustive: never = entry;
				return exhaustive;
			}
		}
	}
	const form = ownRecordValue(doc.forms, uuid);
	if (form === undefined) return undefined;
	switch (entry.slot) {
		case "form_badge":
		case "form_display_condition":
		case "form_open_condition":
		case "form_close_condition":
		case "assessment_user_score":
		case "deliver_entity_id":
		case "deliver_entity_name":
			return { entity: "form", uuid, slot: entry.slot };
		case "form_link_condition": {
			const link = form.formLinks?.[indices[0] ?? -1];
			return link === undefined
				? undefined
				: {
						entity: "form",
						uuid,
						slot: entry.slot,
						member: { linkUuid: link.uuid },
					};
		}
		case "form_link_datum_xpath": {
			if (entry.path === "otherwise.datums[].xpath") {
				const otherwise = form.otherwise;
				const datum =
					otherwise?.kind === "link"
						? otherwise.datums?.[indices[0] ?? -1]
						: undefined;
				return otherwise?.kind !== "link" || datum === undefined
					? undefined
					: {
							entity: "form",
							uuid,
							slot: entry.slot,
							member: { linkUuid: otherwise.uuid, datum: datum.name },
						};
			}
			const link = form.formLinks?.[indices[0] ?? -1];
			const datum = link?.datums?.[indices[1] ?? -1];
			return link === undefined || datum === undefined
				? undefined
				: {
						entity: "form",
						uuid,
						slot: entry.slot,
						member: { linkUuid: link.uuid, datum: datum.name },
					};
		}
		case "case_operation_target_expression":
		case "case_operation_condition":
		case "case_operation_name":
		case "case_operation_owner":
		case "case_operation_rename": {
			const operation = form.caseOperations?.[indices[0] ?? -1];
			return operation === undefined
				? undefined
				: {
						entity: "form",
						uuid,
						slot: entry.slot,
						member: { operationUuid: operation.uuid },
					};
		}
		case "case_operation_write_value":
		case "case_operation_write_condition": {
			const operation = form.caseOperations?.[indices[0] ?? -1];
			const write = operation?.writes?.[indices[1] ?? -1];
			return operation === undefined || write === undefined
				? undefined
				: {
						entity: "form",
						uuid,
						slot: entry.slot,
						member: {
							operationUuid: operation.uuid,
							property: write.property,
							...(write.via === undefined ? {} : { via: write.via }),
						},
					};
		}
		case "case_operation_link_target_expression": {
			const operation = form.caseOperations?.[indices[0] ?? -1];
			const link = operation?.links?.[indices[1] ?? -1];
			return operation === undefined || link === undefined
				? undefined
				: {
						entity: "form",
						uuid,
						slot: entry.slot,
						member: {
							operationUuid: operation.uuid,
							identifier: link.identifier,
						},
					};
		}
		default: {
			const exhaustive: never = entry;
			return exhaustive;
		}
	}
}

function visitExpressionSlots(
	doc: ExpressionReadableDoc,
	owner: ExpressionCarrierRef,
	visit: (
		holder: Record<string, unknown>,
		key: string,
		value: unknown,
		ref: SlotContextRef,
		path: readonly (string | number)[],
	) => void,
	onlySlot?: SlotContextRef["slot"],
): void {
	const entity =
		owner.entity === "field"
			? ownRecordValue(doc.fields, owner.uuid)
			: owner.entity === "form"
				? ownRecordValue(doc.forms, owner.uuid)
				: ownRecordValue(doc.modules, owner.uuid);
	if (entity === undefined) return;
	const entries =
		owner.entity === "field"
			? FIELD_REFERENCE_SLOTS
			: owner.entity === "form"
				? FORM_REFERENCE_SLOTS
				: MODULE_REFERENCE_SLOTS;
	for (const entry of entries) {
		if (entry.kind !== "expression" && entry.kind !== "options-source") {
			continue;
		}
		if (onlySlot !== undefined && entry.slot !== onlySlot) continue;
		if (entry.entity === "field" && owner.entity === "field") {
			const field = ownRecordValue(doc.fields, owner.uuid);
			if (
				field === undefined ||
				!fieldSlotApplies(
					entry,
					field.kind,
					field.kind === "repeat" ? field.repeat_mode : undefined,
				)
			) {
				continue;
			}
		}
		const path =
			entry.kind === "options-source" ? `${entry.path}.filter` : entry.path;
		const segments = path.split(".");
		walkSlotValues(entity, segments, [], (holder, key, value, indices) => {
			const ref = expressionRefForEntry(doc, owner, entry, indices);
			if (ref !== undefined)
				visit(holder, key, value, ref, concreteSlotPath(segments, indices));
		});
	}
	if (owner.entity === "field") visitProseValues(doc, owner, visit, onlySlot);
}

/** A field's calculated values in prose, after its expression entries: each
 *  applicable prose entry in registry order and, within a template, each
 *  `value` part in part order, addressed by its prose slot and the concrete
 *  key path to the part's expression. */
function visitProseValues(
	doc: ExpressionReadableDoc,
	owner: ExpressionCarrierRef,
	visit: (
		holder: Record<string, unknown>,
		key: string,
		value: unknown,
		ref: SlotContextRef,
		path: readonly (string | number)[],
	) => void,
	onlySlot: SlotContextRef["slot"] | undefined,
): void {
	const field = ownRecordValue(doc.fields, owner.uuid);
	if (field === undefined) return;
	for (const entry of FIELD_REFERENCE_SLOTS) {
		if (entry.kind !== "prose") continue;
		if (onlySlot !== undefined && entry.slot !== onlySlot) continue;
		if (
			!fieldSlotApplies(
				entry,
				field.kind,
				field.kind === "repeat" ? field.repeat_mode : undefined,
			)
		)
			continue;
		const segments = entry.path.split(".");
		walkSlotValues(field, segments, [], (_holder, _key, template, indices) => {
			const ref = proseRefForEntry(field, owner.uuid, entry.slot, indices);
			if (ref === undefined) return;
			const parts = (template as { parts?: unknown } | undefined)?.parts;
			if (!Array.isArray(parts)) return;
			const base = concreteSlotPath(segments, indices);
			parts.forEach((part: unknown, index) => {
				if (
					typeof part !== "object" ||
					part === null ||
					(part as { kind?: unknown }).kind !== "value"
				)
					return;
				const holder = part as Record<string, unknown>;
				visit(holder, "expression", holder.expression, ref, [
					...base,
					"parts",
					index,
					"expression",
				]);
			});
		});
	}
}

/** The prose slot a registry walk position names: an option label carries
 *  its option's uuid. */
function proseRefForEntry(
	field: object,
	uuid: Uuid,
	slot: FieldProseSlotId,
	indices: readonly number[],
): ProseSlotRef | undefined {
	if (slot !== "option_label") return { entity: "field", uuid, slot };
	const options = (
		field as { optionsSource?: { options?: readonly { uuid?: Uuid }[] } }
	).optionsSource?.options;
	const optionUuid = options?.[indices[0] ?? -1]?.uuid;
	return optionUuid === undefined
		? undefined
		: { entity: "field", uuid, slot, member: { optionUuid } };
}

/** A registry path with each `[]` fan-out replaced by the position the walk chose. */
function concreteSlotPath(
	segments: readonly string[],
	indices: readonly number[],
): (string | number)[] {
	const path: (string | number)[] = [];
	let fanOut = 0;
	for (const segment of segments) {
		if (segment.endsWith("[]")) {
			path.push(segment.slice(0, -2), indices[fanOut] ?? -1);
			fanOut++;
		} else path.push(segment);
	}
	return path;
}

interface TranslatedFieldProse {
	ref: ProseSlotRef;
	template: ProseTemplate;
	language: string;
	unitId: string;
	indices: number[];
}

type Translations = NonNullable<BlueprintDoc["localization"]>["translations"];
type IndependentEntries = Map<
	string,
	{ language: string; entry: TranslationEntry }[]
>;
const independentByOverlay = new WeakMap<Translations, IndependentEntries>();

function independentEntries(translations: Translations): IndependentEntries {
	const cached = independentByOverlay.get(translations);
	if (cached !== undefined) return cached;
	const byUnit: IndependentEntries = new Map();
	for (const [language, entries] of Object.entries(translations)) {
		for (const [unitId, entry] of Object.entries(entries)) {
			if (entry.valueMode !== "independent-values") continue;
			const held = byUnit.get(unitId);
			if (held === undefined) byUnit.set(unitId, [{ language, entry }]);
			else held.push({ language, entry });
		}
	}
	if (isDeeplySettled(translations))
		independentByOverlay.set(translations, byUnit);
	return byUnit;
}

/** Translations with their own live references. The field supplies the
 * expression site even though the target text lives in the app overlay. */
export function translatedFieldProse(
	localization: BlueprintDoc["localization"],
	field: Field,
): TranslatedFieldProse[] {
	const result: TranslatedFieldProse[] = [];
	if (localization === undefined) return result;
	const byUnit = independentEntries(localization.translations);
	if (!byUnit.size) return result;
	for (const entry of FIELD_REFERENCE_SLOTS) {
		if (entry.kind !== "prose") continue;
		if (
			!fieldSlotApplies(
				entry,
				field.kind,
				field.kind === "repeat" ? field.repeat_mode : undefined,
			)
		)
			continue;
		for (const { value: source, indices } of readSlotValues(
			field,
			entry.path,
		)) {
			const ref = proseRefForEntry(field, field.uuid, entry.slot, indices);
			if (source === undefined || ref === undefined) continue;
			const unitId =
				ref.slot === "option_label"
					? makeTranslationUnitId(
							"field",
							field.uuid,
							"option",
							ref.member.optionUuid,
						)
					: makeTranslationUnitId("field", field.uuid, ref.slot);
			const targets = byUnit.get(unitId);
			if (targets === undefined) continue;
			const fingerprint = translationSourceFingerprint(
				"prose",
				source as ProseTemplate,
			);
			for (const { language, entry: translated } of targets) {
				if (typeof translated.value === "string") continue;
				if (
					translationSourceFingerprintsEqual(
						fingerprint,
						translated.sourceFingerprint,
					)
				)
					result.push({
						ref,
						template: translated.value,
						language,
						unitId,
						indices: [...indices],
					});
			}
		}
	}
	return result;
}

/** Present expressions on one owner, in registry and collection order, then a
 *  field's calculated values in prose under their prose slots. */
export function expressionSlotValues(
	doc: ExpressionReadableDoc,
	owner: ExpressionCarrierRef,
): readonly ExpressionSlotValue[] {
	const source = ownerExpressionSlotValues(doc, owner);
	if (owner.entity !== "field" || doc.localization === undefined) return source;
	const field = ownRecordValue(doc.fields, owner.uuid);
	if (field === undefined) return source;
	const additional: ExpressionSlotValue[] = [];
	for (const { ref, template, language, unitId } of translatedFieldProse(
		doc.localization,
		field,
	)) {
		template.parts.forEach((part, index) => {
			if (part.kind === "value")
				additional.push({
					ref,
					expression: part.expression,
					path: [
						"localization",
						"translations",
						language,
						unitId,
						"value",
						"parts",
						index,
						"expression",
					],
				});
		});
	}
	return additional.length === 0 ? source : [...source, ...additional];
}

function ownerExpressionSlotValues(
	doc: ExpressionReadableDoc,
	owner: ExpressionCarrierRef,
): readonly ExpressionSlotValue[] {
	const entity =
		owner.entity === "field"
			? ownRecordValue(doc.fields, owner.uuid)
			: owner.entity === "form"
				? ownRecordValue(doc.forms, owner.uuid)
				: ownRecordValue(doc.modules, owner.uuid);
	const known =
		entity === undefined ? undefined : slotValuesByEntity.get(entity);
	if (
		known !== undefined &&
		known.entity === owner.entity &&
		known.uuid === owner.uuid
	)
		return known.values;
	const values: ExpressionSlotValue[] = [];
	visitExpressionSlots(doc, owner, (_holder, _key, value, ref, path) => {
		if (isExpression(value)) values.push({ ref, expression: value, path });
	});
	if (entity !== undefined && isDeeplySettled(entity)) {
		const held = Object.freeze(values.map((value) => Object.freeze(value)));
		slotValuesByEntity.set(entity, {
			entity: owner.entity,
			uuid: owner.uuid,
			values: held,
		});
		return held;
	}
	return values;
}

/**
 * Each settled owner's expression values. The walk reads the owner's own
 * record value alone (`visitExpressionSlots`, `expressionRefForEntry`), so its
 * answer is a projection of that object, remembered by the object's identity
 * only once it and everything it holds are frozen and no Immer draft
 * (`settled.ts::isDeeplySettled`): documents that share an unchanged module,
 * form or field, as a document under a declaration choice shares the
 * reading's, walk it once. The owner's kind and uuid are kept beside the
 * answer, since the slots a walk names carry them.
 */
const slotValuesByEntity = new WeakMap<
	object,
	{
		readonly entity: ExpressionCarrierRef["entity"];
		readonly uuid: Uuid;
		readonly values: readonly ExpressionSlotValue[];
	}
>();

/** Read one stored expression without parsing or a second address vocabulary. */
export function expressionSlotValue(
	doc: ExpressionReadableDoc,
	ref: ExpressionSlotRef,
): Expression | undefined {
	let expression: Expression | undefined;
	const key = expressionSlotKey(ref);
	visitExpressionSlots(
		doc,
		ref,
		(_holder, _key, value, at) => {
			if (expressionSlotKey(at) === key && isExpression(value))
				expression = value;
		},
		ref.slot,
	);
	return expression;
}

/** Rewrite present registered expression values by their stable address.
 * Shape-changing migrations and fixture assembly can inspect raw source before
 * admission; normal consumers use the typed expression readers above. */
export function rewriteExpressionSlotValues(
	doc: ExpressionReadableDoc,
	owner: ExpressionCarrierRef,
	rewrite: (value: unknown, ref: SlotContextRef) => unknown,
): number {
	let changed = 0;
	visitExpressionSlots(doc, owner, (holder, key, value, ref) => {
		const next = rewrite(value, ref);
		if (next === value) return;
		holder[key] = next;
		changed++;
	});
	return changed;
}

// ── Slot-path value walker ────────────────────────────────────────
//
// One traversal interprets the registry's path grammar — `.` for
// object steps, a `[]` suffix for array fan-out (e.g.
// `optionsSource.options[].label`, `formLinks[].datums[].xpath`,
// `data_source.ids_query`) — so the schema-resolving audit test, the
// write-side rewriter, and the read accessor
// (`expressionSource.ts`) interpret one vocabulary. Total over any
// value shape: a missing key, a non-object step, or a non-array under
// a `[]` segment resolves to zero visits rather than a throw
// (optional slots are absent on most entities — that is the normal
// case, not an error).

/**
 * One string value a slot path resolved to on a live entity.
 * `indices` carries the array index chosen at each `[]` fan-out step,
 * outermost first (empty for scalar paths), so callers can pair the
 * value with sibling data on the same element (an option's `value`
 * next to its `label`).
 */
export interface SlotStringEntry {
	readonly indices: readonly number[];
	readonly text: string;
}

/**
 * Rewrite every string value a registry slot `path` resolves to on a
 * live entity, in place. Only non-empty strings whose rewritten form
 * differs are written back. Returns the number of leaf values changed.
 */
export function rewriteSlotStrings(
	entity: unknown,
	path: string,
	rewrite: (value: string) => string,
): number {
	let changed = 0;
	walkSlotStrings(entity, path.split("."), [], (holder, key, value) => {
		if (value.length === 0) return;
		const next = rewrite(value);
		if (next === value) return;
		holder[key] = next;
		changed++;
	});
	return changed;
}

/**
 * Read every string value a registry slot `path` resolves to on a
 * live entity, in resolution (array) order. Empty strings are
 * reported as-is — emptiness policy belongs to the caller (the
 * validator's blank-skip rules differ per slot), not the walk.
 */
export function readSlotStrings(
	entity: unknown,
	path: string,
): SlotStringEntry[] {
	const entries: SlotStringEntry[] = [];
	walkSlotStrings(entity, path.split("."), [], (_holder, _key, text, indices) =>
		entries.push({ indices, text }),
	);
	return entries;
}

/** One non-absent value a slot path resolved to — the shape-agnostic
 *  sibling of `SlotStringEntry` for slots whose stored value is a
 *  structure (the expression AST) rather than a string. */
export interface SlotValueEntry {
	readonly indices: readonly number[];
	readonly value: unknown;
}

/**
 * Read every present value a registry slot `path` resolves to,
 * whatever its shape. Absent keys resolve to zero visits; the caller
 * owns narrowing the value (`isExpression` et al).
 */
export function readSlotValues(
	entity: unknown,
	path: string,
): SlotValueEntry[] {
	const entries: SlotValueEntry[] = [];
	walkSlotValues(entity, path.split("."), [], (_holder, _key, value, indices) =>
		entries.push({ indices, value }),
	);
	return entries;
}

/**
 * Replace every present value a registry slot `path` resolves to, in
 * place. `rewrite` returns the replacement (returning the same
 * reference leaves the slot untouched). The migration converter and
 * shape-changing one-time passes drive this; steady-state code reads
 * via `readSlotValues` and mutates leaves structurally.
 */
export function rewriteSlotValues(
	entity: unknown,
	path: string,
	rewrite: (value: unknown) => unknown,
): number {
	let changed = 0;
	walkSlotValues(entity, path.split("."), [], (holder, key, value) => {
		const next = rewrite(value);
		if (next === value) return;
		holder[key] = next;
		changed++;
	});
	return changed;
}

function walkSlotStrings(
	node: unknown,
	segments: readonly string[],
	indices: readonly number[],
	visit: (
		holder: Record<string, unknown>,
		key: string,
		value: string,
		indices: readonly number[],
	) => void,
): void {
	walkSlotValues(node, segments, indices, (holder, key, value, at) => {
		if (typeof value === "string") visit(holder, key, value, at);
	});
}

function walkSlotValues(
	node: unknown,
	segments: readonly string[],
	indices: readonly number[],
	visit: (
		holder: Record<string, unknown>,
		key: string,
		value: unknown,
		indices: readonly number[],
	) => void,
): void {
	const head = segments[0];
	if (head === undefined || node === null || typeof node !== "object") {
		return;
	}
	const fanOut = head.endsWith("[]");
	const key = fanOut ? head.slice(0, -2) : head;
	const value = (node as Record<string, unknown>)[key];
	const rest = segments.slice(1);

	if (fanOut) {
		if (!Array.isArray(value)) return;
		value.forEach((element, index) => {
			if (rest.length === 0)
				visit(
					value as unknown as Record<string, unknown>,
					String(index),
					element,
					[...indices, index],
				);
			else walkSlotValues(element, rest, [...indices, index], visit);
		});
		return;
	}

	if (rest.length > 0) {
		walkSlotValues(value, rest, indices, visit);
		return;
	}

	if (value === undefined) return;
	visit(node as Record<string, unknown>, key, value, indices);
}

// ── Non-reference classification ──────────────────────────────────
//
// Every schema key that does NOT carry a reference, with the reason it
// doesn't. The audit test requires each schema leaf to appear either
// in the registry above or here — so this map is the reviewed record
// of "looked at it, it's not a reference", and a new key that lands in
// neither fails the audit until a human classifies it.

export type NonReferenceReason =
	/** Stable entity identity (uuid) — never points elsewhere. */
	| "identity"
	/** Declares a name other slots reference (field id, search-input
	 *  name, connect sub-config id) — the referent, not a reference. */
	| "declaration"
	/** Union/enum discriminator selecting a schema arm or behavior. */
	| "discriminator"
	/** Plain configuration value (number / boolean / closed enum /
	 *  format pattern) with no naming power. */
	| "config"
	/** Static display text no emitter or validator scans for refs. */
	| "display-text"
	/** Literal data value compared against case/form data at runtime
	 *  (option values, mapping values, close-condition answers). */
	| "data-literal"
	/** Media `MediaAssetId` slot — owned by the `mediaRefs.ts` walk. */
	| "media"
	/** CommCare wire-vocabulary token (a session-datum name the target
	 *  form's entry expects), not a blueprint-entity reference. */
	| "wire-token";

export const NON_REFERENCE_FIELD_PATHS: Readonly<
	Record<string, NonReferenceReason>
> = {
	uuid: "identity",
	id: "declaration",
	kind: "discriminator",
	repeat_mode: "discriminator",
	// A query repeat's held placement: a closed enum, naming nothing.
	placement: "config",
	// Display flags: a group shown on one screen, a label (a field's or a
	// choice's) or a help text written with no markdown form, and a Text
	// question's number keypad. Literals, naming nothing.
	fieldList: "config",
	plainLabel: "config",
	plainHelp: "config",
	keypad: "config",
	choiceLayout: "config",
	inputWidth: "config",
	addressLookup: "config",
	sendTopics: "config",
	receiveFrom: "config",
	hintPlacement: "config",
	scanOnOpen: "config",
	canEditScan: "config",
	calendar: "config",
	clock: "config",
	locationPicker: "config",
	captureSource: "config",
	overlaySize: "config",
	recorder: "config",
	pauseRecording: "config",
	selectableText: "config",
	banner: "config",
	compact: "config",
	collapse: "config",
	border: "config",
	itemsPerRow: "config",
	repeatsPerRow: "config",
	textAlignment: "config",
	webSignature: "config",
	"optionsSource.options[].plainLabel": "config",
	label_media: "media",
	help_media: "media",
	"optionsSource.kind": "discriminator",
	"optionsSource.options[].uuid": "identity",
	"optionsSource.options[].value": "data-literal",
	"optionsSource.options[].media": "media",
};

export const NON_REFERENCE_FORM_PATHS: Readonly<
	Record<string, NonReferenceReason>
> = {
	uuid: "identity",
	// An owned entry point declares identity and an external name; it has no expression or foreign reference.
	"entryPoint.uuid": "identity",
	"entryPoint.id": "declaration",
	"entryPoint.ignoreDisplayConditions": "config",
	// The form's own case creations whose IDs a deep link supplies: UUIDs of
	// this form's case operations, like a column order's column UUIDs. No
	// rename follows them; the commit gate places a finding on one that no
	// longer names a creation on the form's frame.
	"entryCaseCreations[]": "identity",
	id: "declaration",
	name: "display-text",
	type: "discriminator",
	purpose: "display-text",
	postSubmit: "config",
	hiddenFromMenu: "config",
	// The form's text formatting switch: a literal, naming nothing.
	plainText: "config",
	// The form's own location request switch: a literal, naming nothing.
	captureLocation: "config",
	"formLinks[].uuid": "identity",
	"otherwise.kind": "discriminator",
	"otherwise.destination": "config",
	"otherwise.uuid": "identity",
	"caseOperations[].uuid": "identity",
	"caseOperations[].id": "declaration",
	"caseOperations[].action": "discriminator",
	"caseOperations[].target.kind": "discriminator",
	"caseOperations[].links[].identifier": "wire-token",
	"caseOperations[].links[].target.kind": "discriminator",
	"caseOperations[].links[].relationship": "config",
	"caseOperations[].writes[].onlyIfChanged": "config",
	// A held placement names the slot or the block CommCare HQ keeps the
	// change in: closed enums, an index, and the element names of a Save to
	// Case block's path in the form's source.
	"caseOperations[].placement.kind": "discriminator",
	"caseOperations[].placement.slot": "discriminator",
	"caseOperations[].placement.index": "config",
	"caseOperations[].placement.path": "wire-token",
	// An advanced action's tag is the element name HQ writes its block at
	// (`case_<tag>`); `row` is a flag.
	"caseOperations[].placement.tag": "wire-token",
	"caseOperations[].placement.row": "config",
	"ownClosePlacement.kind": "discriminator",
	"ownClosePlacement.path": "wire-token",
	"connect.learn_module.id": "declaration",
	"connect.learn_module.name": "display-text",
	"connect.learn_module.description": "display-text",
	"connect.learn_module.time_estimate": "config",
	"connect.assessment.id": "declaration",
	"connect.deliver_unit.id": "declaration",
	"connect.deliver_unit.name": "display-text",
	"connect.task.id": "declaration",
	"connect.task.name": "display-text",
	"connect.task.description": "display-text",
	icon: "media",
	audioLabel: "media",
	mediaByLanguage: "media",
	mediaByFormerCode: "media",
	// A badge's kind selects text or a calculation; its text is display text
	// with its own translation unit. The calculation is the `form_badge` slot.
	"badge.kind": "discriminator",
	"badge.text": "display-text",
};

export const NON_REFERENCE_MODULE_PATHS: Readonly<
	Record<string, NonReferenceReason>
> = {
	"formsFromMenu.entryPoints[].entryPoint.uuid": "identity",
	"formsFromMenu.entryPoints[].entryPoint.id": "declaration",
	uuid: "identity",
	"entryPoint.uuid": "identity",
	"entryPoint.id": "declaration",
	"caseListEntryPoint.uuid": "identity",
	"caseListEntryPoint.id": "declaration",
	id: "declaration",
	name: "display-text",
	hiddenFromMenu: "config",
	formsInMenuAbove: "config",
	menuLayout: "config",
	// The kind a publish recorded: one literal, written only by holds.
	heldKind: "config",
	purpose: "display-text",
	icon: "media",
	audioLabel: "media",
	mediaByLanguage: "media",
	mediaByFormerCode: "media",
	// A badge's kind selects text or a calculation; its text is display text
	// with its own translation unit. The calculation is the `module_badge` slot.
	"badge.kind": "discriminator",
	"badge.text": "display-text",
	// The case list menu entry: its label is plain display text (the
	// module's name when absent), its icon and spoken label media.
	"caseListMenuItem.label": "display-text",
	"caseListMenuItem.icon": "media",
	"caseListMenuItem.audioLabel": "media",
	"caseListMenuItem.mediaByLanguage": "media",
	"caseListMenuItem.mediaByFormerCode": "media",
	// The case list registration form: `kind` selects when the list offers
	// it, `label` is the Register action's text, its icon and spoken label
	// are media, `afterSubmit` is where a worker goes after registering, and
	// `formUuid` is the `module_case_list_registration_form` reference slot.
	"caseListRegistrationForm.kind": "discriminator",
	"caseListRegistrationForm.target.kind": "discriminator",
	"caseListRegistrationForm.showWhen.kind": "discriminator",
	"caseListRegistrationForm.label": "display-text",
	"caseListRegistrationForm.icon": "media",
	"caseListRegistrationForm.audioLabel": "media",
	"caseListRegistrationForm.mediaByLanguage": "media",
	"caseListRegistrationForm.mediaByFormerCode": "media",
	"caseListRegistrationForm.afterSubmit": "config",
	// The two Results/Details sequences are lists of column uuids — identity,
	// not a reference a rename or a case-type retirement would follow.
	"caseListConfig.listColumnOrder[]": "identity",
	"caseListConfig.detailColumnOrder[]": "identity",
	"caseListConfig.selection.kind": "discriminator",
	"caseListConfig.selection.maximum": "config",
	"caseListConfig.emptyText": "display-text",
	"caseListConfig.selectButtonText": "display-text",
	"caseListConfig.optimizations": "config",
	"caseListConfig.columns[].loadBehavior": "config",
	"caseListConfig.columns[].uuid": "identity",
	"caseListConfig.columns[].kind": "discriminator",
	"caseListConfig.columns[].readFrom": "discriminator",
	"caseListConfig.columns[].showOwner": "config",
	"caseListConfig.columns[].header": "display-text",
	// Display text, but NOT a translation unit: a link cell is emitted as
	// `<template form="markdown">`, and CommCare HQ builds locale variables
	// only for its `Enum` format subclasses, so an HQ-imported app has
	// nowhere to carry a translated label. See `linkColumnSchema`.
	"caseListConfig.columns[].linkText": "display-text",
	"caseListConfig.columns[].pattern": "config",
	"caseListConfig.columns[].sort.direction": "config",
	"caseListConfig.columns[].sort.priority": "config",
	"caseListConfig.columns[].sort.blanks": "config",
	"caseListConfig.columns[].sort.comparator": "config",
	"caseListConfig.columns[].sort.menuPosition": "config",
	// The name a hidden column's sort rule gives it in Sort by.
	"caseListConfig.columns[].sort.label": "display-text",
	// An independent default-order calculation: its expression is the
	// `case_list_sort_expression` reference slot; the rest is its identity,
	// its place and comparison in the order, and its Sort by name.
	"caseListConfig.calculatedSorts[].uuid": "identity",
	"caseListConfig.calculatedSorts[].priority": "config",
	"caseListConfig.calculatedSorts[].direction": "config",
	"caseListConfig.calculatedSorts[].blanks": "config",
	"caseListConfig.calculatedSorts[].comparator": "config",
	"caseListConfig.calculatedSorts[].label": "display-text",
	// A Details tab: its identity, its title (a translation unit of its own),
	// and the column uuids it starts at and orders by, which are identity
	// like the two display sequences. Its condition, row source and child
	// types are reference slots.
	"caseListConfig.detailTabs[].uuid": "identity",
	"caseListConfig.detailTabs[].title": "display-text",
	"caseListConfig.detailTabs[].startColumnUuid": "identity",
	"caseListConfig.detailTabs[].orderFields[]": "identity",
	"caseListConfig.detailTabs[].rowSource.kind": "discriminator",
	// The Details tile's cells and the named Results positions, each keyed
	// by a column uuid or naming one; their geometry is closed config.
	"caseListConfig.detailTile.cells": "config",
	"caseListConfig.tile.namedSlots": "identity",
	"caseListConfig.tile.rawSlots[]": "config",
	// Which source shows the selected case above a form and whether it
	// expands; its menu and its line are reference slots.
	"caseListConfig.contextAboveForm.kind": "discriminator",
	"caseListConfig.contextAboveForm.expandDetails": "config",
	// A table or place field shown as HQ's direct property field, and a
	// placed cell only Android draws.
	"caseListConfig.columns[].rowField": "config",
	"caseListConfig.columns[].tile.androidOnly": "config",
	"caseListConfig.columns[].visibleInList": "config",
	"caseListConfig.columns[].visibleInDetail": "config",
	"caseListConfig.columns[].notOnList": "config",
	// Tile placement and presentation. Every slot is `config`: the four
	// coordinates are geometry and the five presentation slots are closed
	// enumerations or booleans, so none of them can carry a reference, a
	// case property, or authored prose a rename would need to follow.
	"caseListConfig.tile.persistOnForms": "config",
	// The grouping connection name is a CommCare case-INDEX identifier,
	// written straight into the emitted `string(./index/<id>)` path step.
	// It is wire vocabulary rather than a blueprint-entity reference:
	// Nova models the case graph through `parent_type` plus free
	// identifiers, so there is no entity here whose rename this slot
	// would have to follow — the same reason
	// `caseOperations[].links[].identifier` is a wire token.
	"caseListConfig.tile.grouping.identifier": "wire-token",
	"caseListConfig.tile.grouping.headerRows": "config",
	"caseListConfig.columns[].tile.x": "config",
	"caseListConfig.columns[].tile.y": "config",
	"caseListConfig.columns[].tile.width": "config",
	"caseListConfig.columns[].tile.height": "config",
	"caseListConfig.columns[].tile.horizontalAlign": "config",
	"caseListConfig.columns[].tile.verticalAlign": "config",
	"caseListConfig.columns[].tile.fontSize": "config",
	"caseListConfig.columns[].tile.showBorder": "config",
	"caseListConfig.columns[].tile.showShading": "config",
	"caseListConfig.columns[].showAs": "config",
	"caseListConfig.columns[].showChoice": "config",
	"caseListConfig.columns[].behavior": "config",
	"caseListConfig.columns[].afterDays": "config",
	"caseListConfig.columns[].period": "config",
	"caseListConfig.columns[].layer": "config",
	"caseListConfig.columns[].texts[].uuid": "identity",
	"caseListConfig.columns[].texts[].label": "display-text",
	"caseListConfig.columns[].mapping[].uuid": "identity",
	"caseListConfig.columns[].mapping[].match": "config",
	"caseListConfig.columns[].mapping[].altText": "display-text",
	"caseListConfig.columns[].mapping[].value": "data-literal",
	"caseListConfig.columns[].mapping[].label": "display-text",
	"caseListConfig.columns[].mapping[].assetId": "media",
	"caseListConfig.columns[].threshold": "config",
	"caseListConfig.columns[].unit": "config",
	"caseListConfig.columns[].display": "discriminator",
	"caseListConfig.columns[].text": "display-text",
	"caseListConfig.searchInputs[].uuid": "identity",
	"caseListConfig.searchInputs[].kind": "discriminator",
	"caseListConfig.searchInputs[].matching": "config",
	"caseListConfig.searchInputs[].allowBlank": "config",
	"caseListConfig.searchInputs[].hidden": "config",
	"caseListConfig.searchFilters[].uuid": "identity",
	"caseListConfig.searchFilters[].target.kind": "discriminator",
	"caseListConfig.searchFilters[].target.attribute": "config",
	"caseListConfig.searchFilters[].target.identifier": "config",
	"caseListConfig.searchFilters[].target.ancestors[].identifier": "config",
	"caseListConfig.searchInputs[].name": "declaration",
	"caseListConfig.searchInputs[].label": "display-text",
	"caseListConfig.searchInputs[].type": "config",
	"caseListConfig.searchInputs[].mode.kind": "discriminator",
	"caseListConfig.searchInputs[].hint": "display-text",
	"caseListConfig.searchInputs[].required.message": "display-text",
	"caseListConfig.searchInputs[].required.noMessage": "config",
	"caseListConfig.searchInputs[].validation.message": "display-text",
	"caseSearchConfig.searchActionEnabled": "config",
	"caseListConfig.searchFilters[].target.placement": "config",
	"caseSearchConfig.requestOrder[].comparison": "config",
	"caseSearchConfig.requestOrder[].recordName": "config",
	"caseSearchConfig.requestOrder[].implicitComparison": "config",
	"caseSearchConfig.requestOrder[].implicitDirection": "config",
	"caseSearchConfig.requestOrder[].direction": "config",
	"caseListConfig.searchFilters[].kind": "discriminator",
	"caseListConfig.searchFilters[].order[].comparison": "config",
	"caseListConfig.searchFilters[].order[].recordName": "config",
	"caseListConfig.searchFilters[].order[].implicitComparison": "config",
	"caseListConfig.searchFilters[].order[].implicitDirection": "config",
	"caseListConfig.searchFilters[].order[].direction": "config",
	"caseSearchConfig.workflow": "config",
	"caseSearchConfig.formsReadSearch": "config",
	"caseSearchConfig.searchOnClear": "config",
	"caseSearchConfig.searchScreenTitle": "display-text",
	"caseSearchConfig.searchScreenSubtitle": "display-text",
};
