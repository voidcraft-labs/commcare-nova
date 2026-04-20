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
 * `{ body, width?, height?, ... }`), not an iconify ID string. This matches
 * the project's synchronous-icon convention (see CLAUDE.md) so
 * `<Icon icon={meta.icon} />` renders on first paint without a network fetch
 * or an empty-span hydration frame.
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
	convertTargets: readonly FieldKind[];
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
export type FieldEditorComponentProps<F extends Field, K extends keyof F> = {
	field: F;
	value: F[K];
	onChange: (next: F[K]) => void;
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
 */
export type FieldEditorEntry<F extends Field> = {
	[K in keyof F]: {
		key: K;
		component: FieldEditorComponent<F, K>;
		label: string;
		visible?: (field: F) => boolean;
		addable?: boolean;
	};
}[keyof F];

/** Declarative per-kind editor schema — three fixed sections. */
export type FieldEditorSchema<F extends Field> = {
	data: FieldEditorEntry<F>[];
	logic: FieldEditorEntry<F>[];
	ui: FieldEditorEntry<F>[];
};
