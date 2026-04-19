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
	| "repeat"
	| "output";

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
 * `icon` carries imported IconifyIcon data (not an iconify ID string), so
 * synchronous `<Icon icon={meta.icon} />` rendering works without a network
 * fetch. The parallel `fieldKindIcons` map in `lib/fieldTypeIcons.ts` is
 * deleted in Phase 5; consumers read `fieldRegistry[kind].icon` directly.
 *
 * `label` is the human-readable name shown in pickers, conversion menus,
 * and tooltips. Replaces the parallel `fieldKindLabels` map.
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
 * Props every per-key editor component receives. `field` is the FULL kind
 * narrowing so the component can read sibling keys (e.g. the validate
 * editor reads `field.validate_msg`); `value` is the current value of the
 * key being edited; `onChange` is the typed setter.
 *
 * `label` is provided by the schema entry — components display it in their
 * own header (label text + save-shortcut hint). `keyName` is the property
 * name the editor is bound to (used for `data-field-id` focus targeting and
 * for editors that branch on which key they were mounted for, e.g. the
 * shared XPath editor distinguishing `validate` from `relevant`).
 * `autoFocus` is set by the section when the user just clicked the entry's
 * Add Property pill or when undo/redo is restoring focus to this key.
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
 * One entry in a kind's declarative editor schema.
 *
 * `label` is required — used both as the editor header and as the Add
 * Property pill's text when the entry is hidden but addable.
 *
 * `visible(field)` decides whether the entry's editor should render. Default
 * is "always visible." Falsy `visible` + `addable=true` causes the section
 * to render an Add Property pill instead of the editor; clicking it
 * activates the entry (renders the editor with `autoFocus`).
 *
 * `addable` is opt-in. Required-by-spec keys (e.g. `calculate` on hidden)
 * stay always-visible and never become a pill.
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
