// components/builder/editor/fieldEditorSchemas.ts
//
// Per-kind declarative editor schemas. Lives outside the domain
// barrel because the schemas reference UI components from
// `components/builder/editor/fields/*`, and the domain barrel is
// evaluated during the `lib/references/provider.ts` module graph.
// Co-locating the schemas with the components they reference keeps
// the kind files (under `lib/domain/fields/*`) free of UI imports,
// which in turn keeps the `fieldKinds`/`fieldRegistry` module graph
// acyclic.
//
// Consumers (FieldEditorPanel and the inspect UI) import from here;
// the domain layer never does.

import { CasePropertyEditor } from "@/components/builder/editor/fields/CasePropertyEditor";
import { OptionsEditor } from "@/components/builder/editor/fields/OptionsEditor";
import { RequiredEditor } from "@/components/builder/editor/fields/RequiredEditor";
import { TextEditor } from "@/components/builder/editor/fields/TextEditor";
import { XPathEditor } from "@/components/builder/editor/fields/XPathEditor";
import type {
	AudioField,
	BarcodeField,
	DateField,
	DatetimeField,
	DecimalField,
	Field,
	FieldKind,
	GeopointField,
	GroupField,
	HiddenField,
	ImageField,
	IntField,
	LabelField,
	MultiSelectField,
	RepeatField,
	SecretField,
	SignatureField,
	SingleSelectField,
	TextField,
	TimeField,
	VideoField,
} from "@/lib/domain";
import type { FieldEditorSchema } from "@/lib/domain/kinds";

// ── Shared entry factories ──────────────────────────────────────────────
//
// Every kind's logic section repeats the same "addable + visible iff
// the key is set" pattern for each optional XPath/text key. The
// factories below keep the per-kind schema declarations readable by
// collapsing the boilerplate while preserving the discriminated-union
// typing — each factory returns the entry at its concrete key type so
// the `FieldEditorSchema<F>` array accepts it without a cast.

function xpathEntry<F extends Field, K extends keyof F & string>(
	key: K,
	label: string,
): {
	key: K;
	component: typeof XPathEditor;
	label: string;
	addable: true;
	visible: (field: F) => boolean;
} {
	return {
		key,
		component: XPathEditor,
		label,
		addable: true,
		visible: (field) => !!field[key],
	};
}

function requiredEntry<F extends Field>(): {
	key: "required" & keyof F;
	component: typeof RequiredEditor;
	label: string;
	addable: true;
	visible: (field: F) => boolean;
} {
	return {
		key: "required" as "required" & keyof F,
		component: RequiredEditor,
		label: "Required",
		addable: true,
		visible: (field) => !!(field as F & { required?: string }).required,
	};
}

function hintEntry<F extends Field>(): {
	key: "hint" & keyof F;
	component: typeof TextEditor;
	label: string;
	addable: true;
	visible: (field: F) => boolean;
} {
	return {
		key: "hint" as "hint" & keyof F,
		component: TextEditor,
		label: "Hint",
		addable: true,
		visible: (field) => !!(field as F & { hint?: string }).hint,
	};
}

function casePropertyEntry<F extends Field>(): {
	key: "case_property" & keyof F;
	component: typeof CasePropertyEditor;
	label: string;
} {
	return {
		key: "case_property" as "case_property" & keyof F,
		component: CasePropertyEditor,
		label: "Saves to",
	};
}

// ── Per-kind schemas ────────────────────────────────────────────────────
// The full shape every kind file used to own. `validate_msg` is
// deliberately absent from every schema — XPathEditor renders it as a
// nested affordance under `validate` rather than as a sibling entry.

const textFieldEditorSchema: FieldEditorSchema<TextField> = {
	data: [casePropertyEntry<TextField>()],
	logic: [
		requiredEntry<TextField>(),
		xpathEntry<TextField, "validate">("validate", "Validation"),
		xpathEntry<TextField, "relevant">("relevant", "Show When"),
		xpathEntry<TextField, "default_value">("default_value", "Default Value"),
		xpathEntry<TextField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<TextField>()],
};

const intFieldEditorSchema: FieldEditorSchema<IntField> = {
	data: [casePropertyEntry<IntField>()],
	logic: [
		requiredEntry<IntField>(),
		xpathEntry<IntField, "validate">("validate", "Validation"),
		xpathEntry<IntField, "relevant">("relevant", "Show When"),
		xpathEntry<IntField, "default_value">("default_value", "Default Value"),
		xpathEntry<IntField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<IntField>()],
};

const decimalFieldEditorSchema: FieldEditorSchema<DecimalField> = {
	data: [casePropertyEntry<DecimalField>()],
	logic: [
		requiredEntry<DecimalField>(),
		xpathEntry<DecimalField, "validate">("validate", "Validation"),
		xpathEntry<DecimalField, "relevant">("relevant", "Show When"),
		xpathEntry<DecimalField, "default_value">("default_value", "Default Value"),
		xpathEntry<DecimalField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<DecimalField>()],
};

const dateFieldEditorSchema: FieldEditorSchema<DateField> = {
	data: [casePropertyEntry<DateField>()],
	logic: [
		requiredEntry<DateField>(),
		xpathEntry<DateField, "validate">("validate", "Validation"),
		xpathEntry<DateField, "relevant">("relevant", "Show When"),
		xpathEntry<DateField, "default_value">("default_value", "Default Value"),
		xpathEntry<DateField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<DateField>()],
};

const timeFieldEditorSchema: FieldEditorSchema<TimeField> = {
	data: [casePropertyEntry<TimeField>()],
	logic: [
		requiredEntry<TimeField>(),
		xpathEntry<TimeField, "validate">("validate", "Validation"),
		xpathEntry<TimeField, "relevant">("relevant", "Show When"),
		xpathEntry<TimeField, "default_value">("default_value", "Default Value"),
		xpathEntry<TimeField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<TimeField>()],
};

const datetimeFieldEditorSchema: FieldEditorSchema<DatetimeField> = {
	data: [casePropertyEntry<DatetimeField>()],
	logic: [
		requiredEntry<DatetimeField>(),
		xpathEntry<DatetimeField, "validate">("validate", "Validation"),
		xpathEntry<DatetimeField, "relevant">("relevant", "Show When"),
		xpathEntry<DatetimeField, "default_value">(
			"default_value",
			"Default Value",
		),
		xpathEntry<DatetimeField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<DatetimeField>()],
};

const secretFieldEditorSchema: FieldEditorSchema<SecretField> = {
	data: [casePropertyEntry<SecretField>()],
	logic: [
		requiredEntry<SecretField>(),
		xpathEntry<SecretField, "validate">("validate", "Validation"),
		xpathEntry<SecretField, "relevant">("relevant", "Show When"),
		xpathEntry<SecretField, "default_value">("default_value", "Default Value"),
	],
	ui: [hintEntry<SecretField>()],
};

const barcodeFieldEditorSchema: FieldEditorSchema<BarcodeField> = {
	data: [casePropertyEntry<BarcodeField>()],
	logic: [
		requiredEntry<BarcodeField>(),
		xpathEntry<BarcodeField, "validate">("validate", "Validation"),
		xpathEntry<BarcodeField, "relevant">("relevant", "Show When"),
		xpathEntry<BarcodeField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<BarcodeField>()],
};

const geopointFieldEditorSchema: FieldEditorSchema<GeopointField> = {
	data: [casePropertyEntry<GeopointField>()],
	logic: [
		requiredEntry<GeopointField>(),
		xpathEntry<GeopointField, "relevant">("relevant", "Show When"),
		xpathEntry<GeopointField, "default_value">(
			"default_value",
			"Default Value",
		),
		xpathEntry<GeopointField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<GeopointField>()],
};

const singleSelectFieldEditorSchema: FieldEditorSchema<SingleSelectField> = {
	data: [
		casePropertyEntry<SingleSelectField>(),
		{ key: "options", component: OptionsEditor, label: "Options" },
	],
	logic: [
		requiredEntry<SingleSelectField>(),
		xpathEntry<SingleSelectField, "validate">("validate", "Validation"),
		xpathEntry<SingleSelectField, "relevant">("relevant", "Show When"),
		xpathEntry<SingleSelectField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<SingleSelectField>()],
};

const multiSelectFieldEditorSchema: FieldEditorSchema<MultiSelectField> = {
	data: [
		casePropertyEntry<MultiSelectField>(),
		{ key: "options", component: OptionsEditor, label: "Options" },
	],
	logic: [
		requiredEntry<MultiSelectField>(),
		xpathEntry<MultiSelectField, "validate">("validate", "Validation"),
		xpathEntry<MultiSelectField, "relevant">("relevant", "Show When"),
		xpathEntry<MultiSelectField, "calculate">("calculate", "Calculate"),
	],
	ui: [hintEntry<MultiSelectField>()],
};

const imageFieldEditorSchema: FieldEditorSchema<ImageField> = {
	data: [],
	logic: [
		requiredEntry<ImageField>(),
		xpathEntry<ImageField, "relevant">("relevant", "Show When"),
	],
	ui: [hintEntry<ImageField>()],
};

const audioFieldEditorSchema: FieldEditorSchema<AudioField> = {
	data: [],
	logic: [
		requiredEntry<AudioField>(),
		xpathEntry<AudioField, "relevant">("relevant", "Show When"),
	],
	ui: [hintEntry<AudioField>()],
};

const videoFieldEditorSchema: FieldEditorSchema<VideoField> = {
	data: [],
	logic: [
		requiredEntry<VideoField>(),
		xpathEntry<VideoField, "relevant">("relevant", "Show When"),
	],
	ui: [hintEntry<VideoField>()],
};

const signatureFieldEditorSchema: FieldEditorSchema<SignatureField> = {
	data: [],
	logic: [
		requiredEntry<SignatureField>(),
		xpathEntry<SignatureField, "relevant">("relevant", "Show When"),
	],
	ui: [hintEntry<SignatureField>()],
};

// Hidden's `calculate` is required-by-schema — always-visible, never
// addable, never collapses. The other logic keys follow the standard
// optional pattern. No `ui` section (hidden fields have no label, no
// hint, and never render to the user).
const hiddenFieldEditorSchema: FieldEditorSchema<HiddenField> = {
	data: [casePropertyEntry<HiddenField>()],
	logic: [
		{ key: "calculate", component: XPathEditor, label: "Calculate" },
		xpathEntry<HiddenField, "default_value">("default_value", "Default Value"),
		requiredEntry<HiddenField>(),
		xpathEntry<HiddenField, "relevant">("relevant", "Show When"),
	],
	ui: [],
};

const groupFieldEditorSchema: FieldEditorSchema<GroupField> = {
	data: [],
	logic: [xpathEntry<GroupField, "relevant">("relevant", "Show When")],
	ui: [],
};

const repeatFieldEditorSchema: FieldEditorSchema<RepeatField> = {
	data: [],
	logic: [xpathEntry<RepeatField, "relevant">("relevant", "Show When")],
	ui: [],
};

const labelFieldEditorSchema: FieldEditorSchema<LabelField> = {
	data: [],
	logic: [xpathEntry<LabelField, "relevant">("relevant", "Show When")],
	ui: [],
};

/**
 * All per-kind editor schemas, keyed by `FieldKind`. Consumers
 * (FieldEditorPanel) read this record to dispatch the correct schema
 * per selected field.
 */
export const fieldEditorSchemas: {
	[K in FieldKind]: FieldEditorSchema<Extract<Field, { kind: K }>>;
} = {
	text: textFieldEditorSchema,
	int: intFieldEditorSchema,
	decimal: decimalFieldEditorSchema,
	date: dateFieldEditorSchema,
	time: timeFieldEditorSchema,
	datetime: datetimeFieldEditorSchema,
	single_select: singleSelectFieldEditorSchema,
	multi_select: multiSelectFieldEditorSchema,
	geopoint: geopointFieldEditorSchema,
	image: imageFieldEditorSchema,
	audio: audioFieldEditorSchema,
	video: videoFieldEditorSchema,
	barcode: barcodeFieldEditorSchema,
	signature: signatureFieldEditorSchema,
	label: labelFieldEditorSchema,
	hidden: hiddenFieldEditorSchema,
	secret: secretFieldEditorSchema,
	group: groupFieldEditorSchema,
	repeat: repeatFieldEditorSchema,
};
