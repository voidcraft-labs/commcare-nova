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
import { MediaSlotEditor } from "@/components/builder/editor/fields/MediaSlotEditor";
import { OptionsEditor } from "@/components/builder/editor/fields/OptionsEditor";
import { RequiredEditor } from "@/components/builder/editor/fields/RequiredEditor";
import { ALWAYS_REQUIRED } from "@/components/builder/editor/fields/requiredState";
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

// `required` is the one editor whose "added but empty" state is
// meaningless — a freshly-added Required toggle that's off conveys no
// user intent. `valueOnAdd: ALWAYS_REQUIRED` makes the pill click write
// the always-required sentinel directly, so the toggle lands on the
// moment the user clicks "+ Required". The pending-activation +
// autoFocus dance still applies to text/XPath entries that legitimately
// start empty.
//
// `F extends Field & { required?: string }` is purely a type-resolution
// aid: it lets `valueOnAdd: F["required"]` and the body's
// `field.required` access typecheck cleanly without scattered
// `"required" & keyof F` widening or `field as F & {…}` casts. It does
// NOT prevent call-site misuse — TS treats absence of an optional
// property as structurally satisfying it, so `requiredEntry<GroupField>()`
// would still compile. The runtime contract that `required` only wires
// into kinds that actually carry it is enforced by convention (each
// kind's schema only includes the entries its domain type supports) and
// by the registry-wide `valueOnAdd` test in `FieldEditorPanel.test.tsx`.
function requiredEntry<F extends Field & { required?: string }>(): {
	key: "required";
	component: typeof RequiredEditor;
	label: string;
	addable: true;
	visible: (field: F) => boolean;
	valueOnAdd: F["required"];
} {
	return {
		key: "required",
		component: RequiredEditor,
		label: "Required",
		addable: true,
		visible: (field) => !!field.required,
		valueOnAdd: ALWAYS_REQUIRED,
	};
}

// A plain optional-text editor entry (help). Both type
// args are explicit at call sites (`textEntry<TextField, "help">(...)`):
// `F` isn't in a parameter position, so TS can't infer it, and once `F`
// is given `K` must be too.
function textEntry<F extends Field, K extends keyof F & string>(
	key: K,
	label: string,
): {
	key: K;
	component: typeof TextEditor;
	label: string;
	addable: true;
	visible: (field: F) => boolean;
} {
	return {
		key,
		component: TextEditor,
		label,
		addable: true,
		visible: (field) => !!field[key],
	};
}

// The hint text entry. Distinct from `textEntry` because the capture
// kinds (image/audio/video/signature) carry `hint` only structurally:
// the entry is keyed via the `"hint" & keyof F` cast so it resolves for
// any field that has the property whether or not its concrete type
// declares it. Input kinds that declare `hint` use it too.
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

// A `Media` slot editor entry (label_media / hint_media / help_media /
// validate_msg_media). Same addable + visible-iff-set shape as the
// text/XPath factories; `MediaSlotEditor` offers all three media kinds.
function mediaEntry<F extends Field, K extends keyof F & string>(
	key: K,
	label: string,
): {
	key: K;
	component: typeof MediaSlotEditor;
	label: string;
	addable: true;
	visible: (field: F) => boolean;
} {
	return {
		key,
		component: MediaSlotEditor,
		label,
		addable: true,
		visible: (field) => !!field[key],
	};
}

function casePropertyEntry<F extends Field>(): {
	key: "case_property_on" & keyof F;
	component: typeof CasePropertyEditor;
	label: string;
} {
	return {
		key: "case_property_on" as "case_property_on" & keyof F,
		component: CasePropertyEditor,
		label: "Saves to",
	};
}

// ── Per-kind schemas ────────────────────────────────────────────────────
//
// Each input kind's `ui` section carries the label/hint/help text+media
// set; `logic` carries the validation-message media (beside the
// `validate` editor it decorates). The entries are inlined per kind with concrete type args
// rather than collapsed into a generic helper: the `FieldEditorEntry<F>`
// discriminated union only resolves against a concrete field type, so a
// `<F>`-generic helper can't construct entries that typecheck (it's the
// same reason the existing `xpathEntry` calls pass concrete kinds).
// `validate_msg` is deliberately absent as a sibling entry — XPathEditor
// renders it as a nested affordance under `validate`. `validate_msg_media`
// IS a sibling logic entry (the nested XPath affordance has no media tier),
// labelled to read as the validation message's media.

const textFieldEditorSchema: FieldEditorSchema<TextField> = {
	data: [casePropertyEntry<TextField>()],
	logic: [
		requiredEntry<TextField>(),
		xpathEntry<TextField, "validate">("validate", "Validation"),
		mediaEntry<TextField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<TextField, "relevant">("relevant", "Show When"),
		xpathEntry<TextField, "default_value">("default_value", "Default Value"),
		xpathEntry<TextField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<TextField, "label_media">("label_media", "Label Media"),
		hintEntry<TextField>(),
		mediaEntry<TextField, "hint_media">("hint_media", "Hint Media"),
		textEntry<TextField, "help">("help", "Help"),
		mediaEntry<TextField, "help_media">("help_media", "Help Media"),
	],
};

const intFieldEditorSchema: FieldEditorSchema<IntField> = {
	data: [casePropertyEntry<IntField>()],
	logic: [
		requiredEntry<IntField>(),
		xpathEntry<IntField, "validate">("validate", "Validation"),
		mediaEntry<IntField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<IntField, "relevant">("relevant", "Show When"),
		xpathEntry<IntField, "default_value">("default_value", "Default Value"),
		xpathEntry<IntField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<IntField, "label_media">("label_media", "Label Media"),
		hintEntry<IntField>(),
		mediaEntry<IntField, "hint_media">("hint_media", "Hint Media"),
		textEntry<IntField, "help">("help", "Help"),
		mediaEntry<IntField, "help_media">("help_media", "Help Media"),
	],
};

const decimalFieldEditorSchema: FieldEditorSchema<DecimalField> = {
	data: [casePropertyEntry<DecimalField>()],
	logic: [
		requiredEntry<DecimalField>(),
		xpathEntry<DecimalField, "validate">("validate", "Validation"),
		mediaEntry<DecimalField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<DecimalField, "relevant">("relevant", "Show When"),
		xpathEntry<DecimalField, "default_value">("default_value", "Default Value"),
		xpathEntry<DecimalField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<DecimalField, "label_media">("label_media", "Label Media"),
		hintEntry<DecimalField>(),
		mediaEntry<DecimalField, "hint_media">("hint_media", "Hint Media"),
		textEntry<DecimalField, "help">("help", "Help"),
		mediaEntry<DecimalField, "help_media">("help_media", "Help Media"),
	],
};

const dateFieldEditorSchema: FieldEditorSchema<DateField> = {
	data: [casePropertyEntry<DateField>()],
	logic: [
		requiredEntry<DateField>(),
		xpathEntry<DateField, "validate">("validate", "Validation"),
		mediaEntry<DateField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<DateField, "relevant">("relevant", "Show When"),
		xpathEntry<DateField, "default_value">("default_value", "Default Value"),
		xpathEntry<DateField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<DateField, "label_media">("label_media", "Label Media"),
		hintEntry<DateField>(),
		mediaEntry<DateField, "hint_media">("hint_media", "Hint Media"),
		textEntry<DateField, "help">("help", "Help"),
		mediaEntry<DateField, "help_media">("help_media", "Help Media"),
	],
};

const timeFieldEditorSchema: FieldEditorSchema<TimeField> = {
	data: [casePropertyEntry<TimeField>()],
	logic: [
		requiredEntry<TimeField>(),
		xpathEntry<TimeField, "validate">("validate", "Validation"),
		mediaEntry<TimeField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<TimeField, "relevant">("relevant", "Show When"),
		xpathEntry<TimeField, "default_value">("default_value", "Default Value"),
		xpathEntry<TimeField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<TimeField, "label_media">("label_media", "Label Media"),
		hintEntry<TimeField>(),
		mediaEntry<TimeField, "hint_media">("hint_media", "Hint Media"),
		textEntry<TimeField, "help">("help", "Help"),
		mediaEntry<TimeField, "help_media">("help_media", "Help Media"),
	],
};

const datetimeFieldEditorSchema: FieldEditorSchema<DatetimeField> = {
	data: [casePropertyEntry<DatetimeField>()],
	logic: [
		requiredEntry<DatetimeField>(),
		xpathEntry<DatetimeField, "validate">("validate", "Validation"),
		mediaEntry<DatetimeField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<DatetimeField, "relevant">("relevant", "Show When"),
		xpathEntry<DatetimeField, "default_value">(
			"default_value",
			"Default Value",
		),
		xpathEntry<DatetimeField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<DatetimeField, "label_media">("label_media", "Label Media"),
		hintEntry<DatetimeField>(),
		mediaEntry<DatetimeField, "hint_media">("hint_media", "Hint Media"),
		textEntry<DatetimeField, "help">("help", "Help"),
		mediaEntry<DatetimeField, "help_media">("help_media", "Help Media"),
	],
};

const secretFieldEditorSchema: FieldEditorSchema<SecretField> = {
	data: [casePropertyEntry<SecretField>()],
	logic: [
		requiredEntry<SecretField>(),
		xpathEntry<SecretField, "validate">("validate", "Validation"),
		mediaEntry<SecretField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<SecretField, "relevant">("relevant", "Show When"),
		xpathEntry<SecretField, "default_value">("default_value", "Default Value"),
	],
	ui: [
		mediaEntry<SecretField, "label_media">("label_media", "Label Media"),
		hintEntry<SecretField>(),
		mediaEntry<SecretField, "hint_media">("hint_media", "Hint Media"),
		textEntry<SecretField, "help">("help", "Help"),
		mediaEntry<SecretField, "help_media">("help_media", "Help Media"),
	],
};

const barcodeFieldEditorSchema: FieldEditorSchema<BarcodeField> = {
	data: [casePropertyEntry<BarcodeField>()],
	logic: [
		requiredEntry<BarcodeField>(),
		xpathEntry<BarcodeField, "validate">("validate", "Validation"),
		mediaEntry<BarcodeField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<BarcodeField, "relevant">("relevant", "Show When"),
		xpathEntry<BarcodeField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<BarcodeField, "label_media">("label_media", "Label Media"),
		hintEntry<BarcodeField>(),
		mediaEntry<BarcodeField, "hint_media">("hint_media", "Hint Media"),
		textEntry<BarcodeField, "help">("help", "Help"),
		mediaEntry<BarcodeField, "help_media">("help_media", "Help Media"),
	],
};

// Geopoint is input-capable but has no `validate` / `validate_msg` —
// so it carries no validation-message media entry.
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
	ui: [
		mediaEntry<GeopointField, "label_media">("label_media", "Label Media"),
		hintEntry<GeopointField>(),
		mediaEntry<GeopointField, "hint_media">("hint_media", "Hint Media"),
		textEntry<GeopointField, "help">("help", "Help"),
		mediaEntry<GeopointField, "help_media">("help_media", "Help Media"),
	],
};

const singleSelectFieldEditorSchema: FieldEditorSchema<SingleSelectField> = {
	data: [
		casePropertyEntry<SingleSelectField>(),
		{ key: "options", component: OptionsEditor, label: "Options" },
	],
	logic: [
		requiredEntry<SingleSelectField>(),
		xpathEntry<SingleSelectField, "validate">("validate", "Validation"),
		mediaEntry<SingleSelectField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<SingleSelectField, "relevant">("relevant", "Show When"),
		xpathEntry<SingleSelectField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<SingleSelectField, "label_media">("label_media", "Label Media"),
		hintEntry<SingleSelectField>(),
		mediaEntry<SingleSelectField, "hint_media">("hint_media", "Hint Media"),
		textEntry<SingleSelectField, "help">("help", "Help"),
		mediaEntry<SingleSelectField, "help_media">("help_media", "Help Media"),
	],
};

const multiSelectFieldEditorSchema: FieldEditorSchema<MultiSelectField> = {
	data: [
		casePropertyEntry<MultiSelectField>(),
		{ key: "options", component: OptionsEditor, label: "Options" },
	],
	logic: [
		requiredEntry<MultiSelectField>(),
		xpathEntry<MultiSelectField, "validate">("validate", "Validation"),
		mediaEntry<MultiSelectField, "validate_msg_media">(
			"validate_msg_media",
			"Validation Message Media",
		),
		xpathEntry<MultiSelectField, "relevant">("relevant", "Show When"),
		xpathEntry<MultiSelectField, "calculate">("calculate", "Calculate"),
	],
	ui: [
		mediaEntry<MultiSelectField, "label_media">("label_media", "Label Media"),
		hintEntry<MultiSelectField>(),
		mediaEntry<MultiSelectField, "hint_media">("hint_media", "Hint Media"),
		textEntry<MultiSelectField, "help">("help", "Help"),
		mediaEntry<MultiSelectField, "help_media">("help_media", "Help Media"),
	],
};

// Capture kinds (image/audio/video/signature) carry a display `label`
// + `label_media` but no help/required/validate message slots — the
// label-media entry joins each kind's pre-existing hint entry.
const imageFieldEditorSchema: FieldEditorSchema<ImageField> = {
	data: [],
	logic: [
		requiredEntry<ImageField>(),
		xpathEntry<ImageField, "relevant">("relevant", "Show When"),
	],
	ui: [
		mediaEntry<ImageField, "label_media">("label_media", "Label Media"),
		hintEntry<ImageField>(),
	],
};

const audioFieldEditorSchema: FieldEditorSchema<AudioField> = {
	data: [],
	logic: [
		requiredEntry<AudioField>(),
		xpathEntry<AudioField, "relevant">("relevant", "Show When"),
	],
	ui: [
		mediaEntry<AudioField, "label_media">("label_media", "Label Media"),
		hintEntry<AudioField>(),
	],
};

const videoFieldEditorSchema: FieldEditorSchema<VideoField> = {
	data: [],
	logic: [
		requiredEntry<VideoField>(),
		xpathEntry<VideoField, "relevant">("relevant", "Show When"),
	],
	ui: [
		mediaEntry<VideoField, "label_media">("label_media", "Label Media"),
		hintEntry<VideoField>(),
	],
};

const signatureFieldEditorSchema: FieldEditorSchema<SignatureField> = {
	data: [],
	logic: [
		requiredEntry<SignatureField>(),
		xpathEntry<SignatureField, "relevant">("relevant", "Show When"),
	],
	ui: [
		mediaEntry<SignatureField, "label_media">("label_media", "Label Media"),
		hintEntry<SignatureField>(),
	],
};

// Hidden's `calculate` is required-by-schema — always-visible, never
// addable, never collapses. The other logic keys follow the standard
// optional pattern. No `ui` section (hidden fields have no label, no
// label media, and never render to the user).
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

// Group/repeat are structural containers shown with minimal chrome
// (Logic only). Their `label_media` carrier exists in the schema and is
// set via the SA tools; the inline inspector keeps them uncluttered
// rather than adding an Appearance section to every container.
const groupFieldEditorSchema: FieldEditorSchema<GroupField> = {
	data: [],
	logic: [xpathEntry<GroupField, "relevant">("relevant", "Show When")],
	ui: [],
};

// `repeat_mode` and the mode-specific keys (`repeat_count`,
// `data_source.ids_query`) are reachable only via the SA tool surface
// (`addField` / `editField`). The inspector exposes only `relevant`
// here because mode editing requires a mode picker plus mode-
// conditional XPath editors (count visible iff
// `repeat_mode === "count_bound"`, ids_query visible iff
// `repeat_mode === "query_bound"`) with clear-on-mode-change semantics
// — a custom widget tier this schema's flat-key entry vocabulary doesn't
// directly support.
const repeatFieldEditorSchema: FieldEditorSchema<RepeatField> = {
	data: [],
	logic: [xpathEntry<RepeatField, "relevant">("relevant", "Show When")],
	ui: [],
};

const labelFieldEditorSchema: FieldEditorSchema<LabelField> = {
	data: [],
	logic: [xpathEntry<LabelField, "relevant">("relevant", "Show When")],
	ui: [mediaEntry<LabelField, "label_media">("label_media", "Label Media")],
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
