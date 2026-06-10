// lib/domain/kinds.ts
//
// Types that describe per-field-kind metadata and declarative editor
// schemas. Every file under lib/domain/fields/* exports values of these
// shapes so the compiler, validator, editor panel, and SA tool schema
// generator can all read one table.

import type { IconifyIcon } from "@iconify/react/offline";
import type { ComponentType } from "react";
import type { Field, FieldKind } from "./fields";

/** XForm control element emitted by the compiler for a given field kind. */
export type XFormControlKind =
	| "input"
	| "select1"
	| "select"
	| "trigger"
	| "group"
	| "repeat";

/** XForm data type (xsd:* or CommCare extensions). "" for structural kinds. */
export type XFormDataType =
	| ""
	| "xsd:string"
	| "xsd:int"
	| "xsd:decimal"
	| "xsd:date"
	| "xsd:time"
	| "xsd:dateTime"
	| "geopoint"
	| "binary";

/**
 * Non-behavioral metadata for a field kind. The single source of truth for
 * everything a UI/compiler consumer needs to know about a kind without
 * branching on it. Adding a kind = adding one entry to `fieldRegistry`.
 *
 * `icon` carries imported IconifyIcon data (the object literal shape
 * `{ body, width?, height?, ... }`), not an iconify ID string. Synchronous
 * icon data lets `<Icon icon={meta.icon} />` render on first paint without
 * a network fetch or an empty-span hydration frame — the default
 * `@iconify/react` export hydrates via effects and renders an empty span
 * for 1-3 frames, which we explicitly avoid by routing every icon import
 * through `@iconify/react/offline`.
 *
 * `label` is the human-readable name for the kind — used in field-type
 * pickers, conversion menus, and tooltips. Kept on the registry so UI
 * surfaces don't each invent their own casing/wording.
 */
export type FieldKindMetadata<K extends FieldKind> = {
	kind: K;
	xformKind: XFormControlKind;
	dataType: XFormDataType;
	icon: IconifyIcon;
	label: string;
	isStructural: boolean;
	isContainer: boolean;
	saDocs: string;
	/**
	 * Sibling kinds this kind can be converted into. The type excludes
	 * `K` so a kind cannot list itself as a target — the compiler error
	 * fires at the metadata declaration site, before any consumer.
	 *
	 * Three runtime consumers read the list:
	 *   - The FieldHeader convert-type submenu renders one row per
	 *     target.
	 *   - The `editField` SA tool gates kind changes against
	 *     `getConvertibleTypes(fromKind)` and lists the allowed targets
	 *     back in the rejection message when the pair is invalid.
	 *   - The `convertField` reducer mutation enforces the same gate as
	 *     the authoritative second layer.
	 *
	 * The SA's `editField.kind` enum exposes every kind in `fieldKinds`,
	 * not just the per-kind targets — the runtime gate is what surfaces
	 * an unsupported pair as a tool error rather than a compile-time
	 * impossibility.
	 */
	convertTargets: readonly Exclude<FieldKind, K>[];
};

/**
 * Props every per-key editor component receives.
 *
 * `field` is the full field value (narrowed by discriminant) so a component
 * can read sibling keys when its UI depends on them (e.g. an editor that
 * needs to show a nested control conditioned on another key's state).
 *
 * `value` is the current value of the key being edited; `onChange` is the
 * typed setter.
 *
 * `label` is provided by the schema entry — components display it in their
 * own header.
 *
 * `keyName` is the property name the editor is bound to. It supports DOM
 * targeting (`data-field-id`) and lets editors mounted on multiple keys
 * branch on which one they were mounted for.
 *
 * `autoFocus` asks the editor to take focus on mount. Consumers set it when
 * the editor has just been made visible in response to a user action and
 * the user would naturally expect the new input to receive keyboard focus.
 */
/**
 * Result of a gated commit, as seen by editor components. Mirrors the
 * doc layer's mutation-gate verdict structurally (declared here rather
 * than imported so the domain package keeps no edge into `lib/doc`):
 *
 *   - `ok: true` — the edit dispatched.
 *   - `ok: false` — the edit did NOT dispatch. `messages` carries the
 *     gate's person-to-person findings when the validity gate rejected
 *     it; an EMPTY `messages` means a silent no-op (a stale uuid the
 *     dispatch couldn't resolve) — editors keep the legacy quiet
 *     behavior for that case and render inline errors only when there
 *     are messages to show.
 */
export type CommitOutcome = { ok: true } | { ok: false; messages: string[] };

export type FieldEditorComponentProps<F extends Field, K extends keyof F> = {
	field: F;
	value: F[K];
	/** Dispatch the new value through the gated mutation hook. Returns
	 *  the commit outcome so draft-holding editors can keep the user's
	 *  typed input and surface the findings inline on a rejection. */
	onChange: (next: F[K]) => CommitOutcome;
	label: string;
	keyName: K;
	autoFocus?: boolean;
};

/** A declarative editor component, narrowed to one field key. */
export type FieldEditorComponent<
	F extends Field,
	K extends keyof F,
> = ComponentType<FieldEditorComponentProps<F, K>>;

/**
 * Keys of `F` whose declared type is exactly `string | undefined`
 * (i.e. an optional-string property like `hint`, `relevant`,
 * `validate`, `default_value`, or a mostly-optional `calculate`).
 *
 * TextEditor constrains its key generic to this set because its UX
 * relies on empty commits clearing the property via
 * `onChange(undefined)`. A key whose type was strictly `string` would
 * silently tolerate the undefined dispatch through the generic cast
 * but leave the field in an invalid state — forbidding that at the
 * type level is the whole point of the narrowing.
 */
export type OptionalStringKeys<F extends Field> = {
	[K in keyof F]-?: string | undefined extends F[K]
		? F[K] extends string | undefined
			? K
			: never
		: never;
}[keyof F] &
	string;

/**
 * Keys of `F` whose declared type is `string` — either required (`string`)
 * or optional (`string | undefined`). Covers every XPath-valued property
 * the XPathEditor might be mounted on, including `hidden.calculate`
 * which the schema declares as required.
 *
 * The editor's cast `next as F[K]` is sound when `F[K]` includes
 * `undefined` and tolerated when it doesn't — the caller-side registry
 * invariant is the authoritative guarantee that each key's runtime
 * value is always a string or undefined, and the reducer accepts
 * both shapes as a removal-or-replace patch regardless of the schema's
 * optionality declaration.
 */
export type XPathStringKeys<F extends Field> = {
	[K in keyof F]-?: F[K] extends string | undefined ? K : never;
}[keyof F] &
	string;

/**
 * One entry in a kind's declarative editor schema.
 *
 * `label` is required — used as the editor's header text and as the
 * display string when the entry is offered as an add-affordance instead of
 * an active editor.
 *
 * `visible(field)` decides whether the entry's editor should render.
 * Default is "always visible." Falsy `visible` + `addable=true` means the
 * section renders the entry as an affordance to add it (clicking activates
 * the editor with `autoFocus`) rather than as an active editor.
 *
 * `addable` is opt-in. Required-by-spec keys (e.g. `calculate` on hidden)
 * stay always-visible and never collapse into an add-affordance.
 *
 * `valueOnAdd` opts the entry out of the empty-editor + pending-focus
 * dance: when the user clicks the Add Property pill, the section writes
 * this value directly instead of activating an empty editor in autoFocus
 * mode. Use this for boolean-shaped properties (e.g. `required`) where
 * "the user added the property" unambiguously means "turn it on" — an
 * empty editor + manual toggle requires two clicks to express one
 * intent. Leave undefined for text/XPath entries where the user must
 * type a real value into the editor.
 */
export type FieldEditorEntry<F extends Field> = {
	[K in keyof F]: {
		key: K;
		component: FieldEditorComponent<F, K>;
		label: string;
		visible?: (field: F) => boolean;
		addable?: boolean;
		valueOnAdd?: F[K];
	};
}[keyof F];

/** Declarative per-kind editor schema — three fixed sections. */
export type FieldEditorSchema<F extends Field> = {
	data: FieldEditorEntry<F>[];
	logic: FieldEditorEntry<F>[];
	ui: FieldEditorEntry<F>[];
};
