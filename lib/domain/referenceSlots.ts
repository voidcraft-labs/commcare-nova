// lib/domain/referenceSlots.ts
//
// The reference-slot registry: one declarative enumeration of every
// blueprint slot that can carry a reference to another part of the
// app. A "reference" here is anything that names an entity, a case
// property, or a case type — an XPath expression with hashtag refs, a
// prose string with embedded hashtag refs, a predicate/value-expression
// AST whose typed leaves name case properties, a field-id pointer, an
// entity uuid, or a bare case-type/case-property name.
//
// The registry is shared vocabulary: the validator's per-surface
// unions (`XPathSurface` / `ProseSurface` / `ConnectXPathSlot` in
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
//   - Derived case wiring (`case_preload`, form actions, child-case
//     buckets): never stored on the doc — `lib/commcare`'s
//     `deriveCaseConfig` re-derives it from field ids +
//     `case_property_on` on demand, so a field rename is followed by
//     construction and there is no stored slot to register or rewrite.
//   - Blueprint-root slots (`appId` / `appName` / `connectType` /
//     `logo` / the order arrays / the `caseTypes` catalog): the
//     registry's owning entities are field / form / module. The
//     `caseTypes` catalog is a generation-time artifact (defaults are
//     baked into fields at add time; the record is never consulted at
//     runtime), and its `parent_type` case-type link is consumed
//     through `caseTypes.ts`'s reachability helpers, not through a
//     per-entity rewrite walk.
//   - Media asset slots: they reference stored media by `AssetId`, and
//     `mediaRefs.ts::walkAssetRefs` is the single walk that owns them.
//     They are classified `media` in the non-reference maps so the
//     audit stays total without duplicating that registry.

import type { FieldKind, RepeatMode } from "./fields";
import { FORM_TYPES, type FormType } from "./forms";
import type { ColumnKind, SearchInputDef } from "./modules";

/**
 * How a slot carries its reference — the dispatch key consumers use to
 * pick an extraction/rewrite strategy:
 *
 *   - `xpath-ast` — an XPath expression stored as the typed AST
 *     (`lib/domain/xpath`): references are identity leaves walked
 *     structurally; source text is a PROJECTION (`printXPath`), so
 *     consumers that speak text read the printed form and consumers
 *     that follow references walk the leaves — never a re-parse.
 *   - `prose` — markdown/plain text that may embed bare hashtag refs;
 *     only the hashtag substrings are reference-bearing, never the
 *     surrounding text.
 *   - `predicate-ast` — a structured AST from `lib/domain/predicate`
 *     (`Predicate`, `ValueExpression`, or `RelationPath`); references
 *     live on typed leaves (`PropertyRef`, relation steps' case-type
 *     hints) and are walked structurally, never as strings.
 *   - `entity-uuid` — names an entity (module/form/field) by stable
 *     uuid.
 *   - `case-property-ref` — names a case property by bare name; the
 *     owning case type comes from context (the module's `caseType`,
 *     or a relation walk's destination).
 *   - `case-type-ref` — names a case type by bare name.
 */
const REFERENCE_SURFACE_KINDS = [
	"xpath-ast",
	"prose",
	"predicate-ast",
	"entity-uuid",
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
 * validator's rules (a `closeCondition` off a close form is rejected
 * by `rules/form.ts::closeConditionValidation`), while the path
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
 * One reference-carrying slot on a `Module`. `columnKinds` /
 * `searchInputKinds` narrow applicability within the case-list
 * column union and the search-input union — same role `repeatModes`
 * plays on field slots; absent means every arm declares the path.
 */
export interface ModuleReferenceSlot {
	readonly entity: "module";
	readonly slot: string;
	readonly path: string;
	readonly kind: ReferenceSurfaceKind;
	readonly columnKinds?: readonly ColumnKind[];
	readonly searchInputKinds?: readonly SearchInputArmKind[];
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
 *  (hint / help / required / relevant / case_property_on). */
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

/** Binary capture kinds — label + hint + required + relevant only
 *  (no help, no case wiring, no validation, no default). */
const CAPTURE_KINDS = [
	"image",
	"audio",
	"video",
	"signature",
] as const satisfies readonly FieldKind[];

const SELECT_KINDS = [
	"single_select",
	"multi_select",
] as const satisfies readonly FieldKind[];

/** Every kind whose schema declares `relevant` — all of them: input
 *  kinds, capture kinds, display `label`, `hidden`, and both
 *  containers gate visibility with the same slot. */
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
	"barcode",
	"signature",
	"label",
	"secret",
	"group",
	"repeat",
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
		kind: "xpath-ast",
		appliesTo: RELEVANT_KINDS,
	},
	{
		entity: "field",
		slot: "validate",
		path: "validate",
		kind: "xpath-ast",
		appliesTo: VALIDATED_INPUT_KINDS,
	},
	{
		entity: "field",
		slot: "calculate",
		path: "calculate",
		kind: "xpath-ast",
		// Computed values live on hidden fields only — a `calculate` bind
		// makes a control read-only, so visible kinds carry `default_value`
		// (a one-shot seed) instead.
		appliesTo: ["hidden"],
	},
	{
		entity: "field",
		slot: "default_value",
		path: "default_value",
		kind: "xpath-ast",
		appliesTo: [...VALIDATED_INPUT_KINDS, "geopoint", "hidden"],
	},
	{
		entity: "field",
		slot: "required",
		path: "required",
		kind: "xpath-ast",
		appliesTo: [...INPUT_KINDS, ...CAPTURE_KINDS],
	},
	{
		entity: "field",
		slot: "repeat_count",
		path: "repeat_count",
		kind: "xpath-ast",
		appliesTo: ["repeat"],
		repeatModes: ["count_bound"],
	},
	{
		entity: "field",
		slot: "ids_query",
		path: "data_source.ids_query",
		kind: "xpath-ast",
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
		path: "options[].label",
		kind: "prose",
		appliesTo: SELECT_KINDS,
	},
	{
		entity: "field",
		slot: "case_property_on",
		path: "case_property_on",
		kind: "case-type-ref",
		// The field's declaration site doubles as a reference: the value
		// names the case type whose property this field writes (and, via
		// "field id = case property name", which property catalog the
		// field's id lands in).
		appliesTo: [...INPUT_KINDS, "hidden"],
	},
] as const satisfies readonly FieldReferenceSlot[];

// ── Form slots ────────────────────────────────────────────────────

export const FORM_REFERENCE_SLOTS = [
	{
		entity: "form",
		slot: "form_display_condition",
		path: "displayCondition",
		kind: "predicate-ast",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "close_condition_field",
		path: "closeCondition.field",
		// The checked field's stable uuid (a legacy doc may carry an
		// unresolvable id verbatim — a dangling pointer, adjudicated by
		// the validator from the same slot).
		kind: "entity-uuid",
		formTypes: ["close"],
	},
	{
		entity: "form",
		slot: "form_link_condition",
		path: "formLinks[].condition",
		kind: "xpath-ast",
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
		slot: "form_link_datum_xpath",
		path: "formLinks[].datums[].xpath",
		kind: "xpath-ast",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "assessment_user_score",
		path: "connect.assessment.user_score",
		kind: "xpath-ast",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "deliver_entity_id",
		path: "connect.deliver_unit.entity_id",
		kind: "xpath-ast",
		formTypes: FORM_TYPES,
	},
	{
		entity: "form",
		slot: "deliver_entity_name",
		path: "connect.deliver_unit.entity_name",
		kind: "xpath-ast",
		formTypes: FORM_TYPES,
	},
] as const satisfies readonly FormReferenceSlot[];

// ── Module slots ──────────────────────────────────────────────────

export const MODULE_REFERENCE_SLOTS = [
	{
		entity: "module",
		slot: "module_display_condition",
		path: "displayCondition",
		kind: "predicate-ast",
	},
	{
		entity: "module",
		slot: "case_type",
		path: "caseType",
		kind: "case-type-ref",
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
			"date",
			"phone",
			"id-mapping",
			"image-map",
			"interval",
		],
	},
	{
		entity: "module",
		slot: "case_list_column_expression",
		path: "caseListConfig.columns[].expression",
		kind: "predicate-ast",
		columnKinds: ["calculated"],
	},
	{
		entity: "module",
		slot: "case_list_filter",
		path: "caseListConfig.filter",
		kind: "predicate-ast",
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
		kind: "predicate-ast",
		// A bare `RelationPath` — the same structured walk shape the
		// predicate AST embeds, so it shares the AST surface kind and the
		// structural (never string) traversal contract.
		searchInputKinds: ["simple"],
	},
	{
		entity: "module",
		slot: "search_input_default",
		path: "caseListConfig.searchInputs[].default",
		kind: "predicate-ast",
		searchInputKinds: ["simple", "advanced"],
	},
	{
		entity: "module",
		slot: "search_input_predicate",
		path: "caseListConfig.searchInputs[].predicate",
		kind: "predicate-ast",
		searchInputKinds: ["advanced"],
	},
	{
		entity: "module",
		slot: "search_button_display_condition",
		path: "caseSearchConfig.searchButtonDisplayCondition",
		kind: "predicate-ast",
	},
	{
		entity: "module",
		slot: "excluded_owner_ids",
		path: "caseSearchConfig.excludedOwnerIds",
		kind: "predicate-ast",
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
export type FieldXPathSlotId = Extract<
	FieldSlotEntry,
	{ kind: "xpath-ast" }
>["slot"];

/** Field slot ids carrying prose — the registry side of the
 *  validator's `ProseSurface` union. */
export type FieldProseSlotId = Extract<
	FieldSlotEntry,
	{ kind: "prose" }
>["slot"];

/** Connect-block XPath slot ids — the registry side of the validator's
 *  `ConnectXPathSlot` union. */
export type ConnectXPathSlotId = Extract<
	FormSlotEntry,
	{ path: `connect.${string}` }
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

// ── Slot-path value walker ────────────────────────────────────────
//
// One traversal interprets the registry's path grammar — `.` for
// object steps, a `[]` suffix for array fan-out (e.g.
// `options[].label`, `formLinks[].datums[].xpath`,
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
 * owns narrowing the value (`isXPathExpression` et al).
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
			walkSlotValues(element, rest, [...indices, index], visit);
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
	/** Media `AssetId` slot — owned by the `mediaRefs.ts` walk. */
	| "media"
	/** CommCare wire-vocabulary token (a session-datum name the target
	 *  form's entry expects), not a blueprint-entity reference. */
	| "wire-token";

export const NON_REFERENCE_FIELD_PATHS: Readonly<
	Record<string, NonReferenceReason>
> = {
	uuid: "identity",
	id: "declaration",
	order: "config",
	kind: "discriminator",
	repeat_mode: "discriminator",
	label_media: "media",
	hint_media: "media",
	help_media: "media",
	validate_msg_media: "media",
	"options[].uuid": "identity",
	"options[].order": "config",
	"options[].value": "data-literal",
	"options[].media": "media",
};

export const NON_REFERENCE_FORM_PATHS: Readonly<
	Record<string, NonReferenceReason>
> = {
	uuid: "identity",
	id: "declaration",
	order: "config",
	name: "display-text",
	type: "discriminator",
	purpose: "display-text",
	postSubmit: "config",
	"closeCondition.answer": "data-literal",
	"closeCondition.operator": "config",
	"formLinks[].datums[].name": "wire-token",
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
};

export const NON_REFERENCE_MODULE_PATHS: Readonly<
	Record<string, NonReferenceReason>
> = {
	uuid: "identity",
	id: "declaration",
	order: "config",
	name: "display-text",
	caseListOnly: "config",
	purpose: "display-text",
	icon: "media",
	audioLabel: "media",
	"caseListConfig.icon": "media",
	"caseListConfig.audioLabel": "media",
	"caseListConfig.columns[].uuid": "identity",
	"caseListConfig.columns[].order": "config",
	"caseListConfig.columns[].listOrder": "config",
	"caseListConfig.columns[].detailOrder": "config",
	"caseListConfig.columns[].kind": "discriminator",
	"caseListConfig.columns[].header": "display-text",
	"caseListConfig.columns[].pattern": "config",
	"caseListConfig.columns[].sort.direction": "config",
	"caseListConfig.columns[].sort.priority": "config",
	"caseListConfig.columns[].visibleInList": "config",
	"caseListConfig.columns[].visibleInDetail": "config",
	"caseListConfig.columns[].mapping[].value": "data-literal",
	"caseListConfig.columns[].mapping[].label": "display-text",
	"caseListConfig.columns[].mapping[].assetId": "media",
	"caseListConfig.columns[].threshold": "config",
	"caseListConfig.columns[].unit": "config",
	"caseListConfig.columns[].display": "discriminator",
	"caseListConfig.columns[].text": "display-text",
	"caseListConfig.searchInputs[].uuid": "identity",
	"caseListConfig.searchInputs[].order": "config",
	"caseListConfig.searchInputs[].kind": "discriminator",
	"caseListConfig.searchInputs[].name": "declaration",
	"caseListConfig.searchInputs[].label": "display-text",
	"caseListConfig.searchInputs[].type": "config",
	"caseListConfig.searchInputs[].mode.kind": "discriminator",
	"caseListConfig.searchInputs[].mode.quantifier": "config",
	"caseSearchConfig.searchActionEnabled": "config",
	"caseSearchConfig.searchScreenTitle": "display-text",
	"caseSearchConfig.searchScreenSubtitle": "display-text",
	"caseSearchConfig.searchButtonLabel": "display-text",
};
