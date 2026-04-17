// lib/domain/kinds.ts
//
// Types that describe per-field-kind metadata and declarative editor
// schemas. Every file under lib/domain/fields/* exports values of these
// shapes so the compiler, validator, editor panel, and SA tool schema
// generator can all read one table.

import type { ComponentType, ReactNode } from "react";
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

/** Non-behavioral metadata for a field kind. */
export type FieldKindMetadata<K extends FieldKind> = {
	kind: K;
	xformKind: XFormControlKind;
	dataType: XFormDataType;
	icon: string;
	isStructural: boolean;
	isContainer: boolean;
	saDocs: string;
	convertTargets: readonly FieldKind[];
};

/** Props a declarative editor component receives for a single field key. */
export type FieldEditorComponentProps<F extends Field, K extends keyof F> = {
	field: F;
	value: F[K];
	onChange: (next: F[K]) => void;
};

/** A declarative editor component, narrowed to one field key. */
export type FieldEditorComponent<
	F extends Field,
	K extends keyof F,
> = ComponentType<FieldEditorComponentProps<F, K>>;

/** One entry in a kind's declarative editor schema. */
export type FieldEditorEntry<F extends Field> = {
	[K in keyof F]: {
		key: K;
		component: FieldEditorComponent<F, K>;
		label?: string;
		visible?: (field: F) => boolean;
		// Override how the entry renders. Used for headers or grouped entries.
		renderOverride?: (props: FieldEditorComponentProps<F, K>) => ReactNode;
	};
}[keyof F];

/** Declarative per-kind editor schema — three fixed sections. */
export type FieldEditorSchema<F extends Field> = {
	data: FieldEditorEntry<F>[];
	logic: FieldEditorEntry<F>[];
	ui: FieldEditorEntry<F>[];
};
