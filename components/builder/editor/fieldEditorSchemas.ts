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

"use client";

import dynamic from "next/dynamic";
import {
	type ComponentType,
	createElement,
	useEffect,
	useSyncExternalStore,
} from "react";
import { CaseWriteEditor } from "@/components/builder/editor/fields/CaseWriteEditor";
import type { MediaSlotEditor as MediaSlotEditorComponent } from "@/components/builder/editor/fields/MediaSlotEditor";
import type { OptionsSourceEditor as OptionsSourceEditorComponent } from "@/components/builder/editor/fields/OptionsSourceEditor";
import { RequiredEditor } from "@/components/builder/editor/fields/RequiredEditor";
import { ALWAYS_REQUIRED_EXPRESSION } from "@/components/builder/editor/fields/requiredState";
import type { TextEditor as TextEditorComponent } from "@/components/builder/editor/fields/TextEditor";
import type { XPathEditor as XPathEditorComponent } from "@/components/builder/editor/fields/XPathEditor";
import {
	getLoadedXPathEditor,
	loadXPathEditor,
	subscribeLoadedXPathEditor,
} from "@/components/builder/inspector/lazyInspectorBodies";
import type {
	AudioField,
	BarcodeField,
	DateField,
	DatetimeField,
	DecimalField,
	Field,
	FieldKind,
	FileField,
	GeopointField,
	GroupField,
	HiddenField,
	ImageField,
	IntField,
	LabelField,
	MultiSelectField,
	ProseTemplate,
	RepeatField,
	SecretField,
	SectionField,
	SignatureField,
	SingleSelectField,
	TextField,
	TimeField,
	VideoField,
	XPathExpression,
} from "@/lib/domain";
import type {
	FieldEditorComponentProps,
	FieldEditorSchema,
	XPathExpressionKeys,
} from "@/lib/domain/kinds";

function EditorLoading() {
	return createElement(
		"div",
		{
			className: "py-2 text-xs text-nova-text-muted",
			role: "status",
		},
		"Opening editor",
	);
}

/* Rich text, XPath, media, and lookup-source controls each carry substantial
 * editor-only dependencies. A field's identity and Saves to controls remain
 * synchronous; these uncommon controls load only when the selected field's
 * schema actually renders them. */
const MediaSlotEditor = dynamic(
	() =>
		import("@/components/builder/editor/fields/MediaSlotEditor").then(
			(module) => module.MediaSlotEditor,
		),
	{ loading: EditorLoading },
) as typeof MediaSlotEditorComponent;
const OptionsSourceEditor = dynamic(
	() =>
		import("@/components/builder/editor/fields/OptionsSourceEditor").then(
			(module) => module.OptionsSourceEditor,
		),
	{ loading: EditorLoading },
) as typeof OptionsSourceEditorComponent;
const TextEditor = dynamic(
	() =>
		import("@/components/builder/editor/fields/TextEditor").then(
			(module) => module.TextEditor,
		),
	{ loading: EditorLoading },
) as typeof TextEditorComponent;
function WarmXPathEditor<F extends Field, K extends XPathExpressionKeys<F>>(
	props: FieldEditorComponentProps<F, K>,
) {
	const loaded = useSyncExternalStore(
		subscribeLoadedXPathEditor,
		getLoadedXPathEditor,
		() => null,
	);
	useEffect(() => {
		if (loaded === null) void loadXPathEditor();
	}, [loaded]);
	if (loaded === null) return createElement(EditorLoading);
	const LoadedXPathEditor = loaded.XPathEditor as ComponentType<
		FieldEditorComponentProps<F, K>
	>;
	return createElement(LoadedXPathEditor, props);
}
const XPathEditor = WarmXPathEditor as typeof XPathEditorComponent;

// ── Shared entry factories ──────────────────────────────────────────────
//
// Every kind's logic section repeats the same "addable + visible iff
// the key is set" pattern for each optional XPath/text key. The
// factories below keep the per-kind schema declarations readable by
// collapsing the boilerplate while preserving the discriminated-union
// typing: each factory returns the entry at its concrete key type so
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
		visible: (field) => {
			const value = field[key];
			return (
				value !== undefined &&
				typeof value === "object" &&
				value !== null &&
				"parts" in value &&
				(value as ProseTemplate).parts.length > 0
			);
		},
	};
}

// `required` is the one editor whose "added but empty" state is
// meaningless: a freshly-added Required toggle that's off conveys no
// user intent. `valueOnAdd: ALWAYS_REQUIRED_EXPRESSION` makes the pill click write
// the always-required sentinel directly, so the toggle lands on the
// moment the user clicks "+ Required". The pending-activation +
// autoFocus dance still applies to text/XPath entries that legitimately
// start empty.
//
// `F extends Field & { required?: string }` is purely a type-resolution
// aid: it lets `valueOnAdd: F["required"]` and the body's
// `field.required` access typecheck cleanly without scattered
// `"required" & keyof F` widening or `field as F & {…}` casts. It does
// NOT prevent call-site misuse: TS treats absence of an optional
// property as structurally satisfying it, so `requiredEntry<GroupField>()`
// would still compile. The runtime contract that `required` only wires
// into kinds that actually carry it is enforced by convention (each
// kind's schema only includes the entries its domain type supports) and
// by the registry-wide `valueOnAdd` test in `FieldEditorPanel.test.tsx`.
function requiredEntry<F extends Field & { required?: XPathExpression }>(): {
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
		valueOnAdd: ALWAYS_REQUIRED_EXPRESSION as F["required"],
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
// kinds (image/audio/video/signature/file) carry `hint` only structurally:
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
		visible: (field) =>
			!!(field as F & { hint?: ProseTemplate }).hint?.parts.length,
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

function caseWriteEntry<F extends Field>(): {
	key: "caseWrite" & keyof F;
	component: typeof CaseWriteEditor;
	label: string;
} {
	return {
		key: "caseWrite" as "caseWrite" & keyof F,
		component: CaseWriteEditor,
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
// `validate_msg` is deliberately absent as a sibling entry, XPathEditor
// renders it as a nested affordance under `validate`. `validate_msg_media`
// IS a sibling logic entry (the nested XPath affordance has no media tier),
// labelled to read as the validation message's media.

const textFieldEditorSchema: FieldEditorSchema<TextField> = {
	data: [caseWriteEntry<TextField>()],
	logic: [
		requiredEntry<TextField>(),
		xpathEntry<TextField, "validate">("validate", "Validation"),
		mediaEntry<TextField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<TextField, "relevant">("relevant", "Show when"),
		xpathEntry<TextField, "default_value">("default_value", "Default value"),
	],
	ui: [
		mediaEntry<TextField, "label_media">("label_media", "Label media"),
		hintEntry<TextField>(),
		mediaEntry<TextField, "hint_media">("hint_media", "Hint media"),
		textEntry<TextField, "help">("help", "Help"),
		mediaEntry<TextField, "help_media">("help_media", "Help media"),
	],
};

const intFieldEditorSchema: FieldEditorSchema<IntField> = {
	data: [caseWriteEntry<IntField>()],
	logic: [
		requiredEntry<IntField>(),
		xpathEntry<IntField, "validate">("validate", "Validation"),
		mediaEntry<IntField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<IntField, "relevant">("relevant", "Show when"),
		xpathEntry<IntField, "default_value">("default_value", "Default value"),
	],
	ui: [
		mediaEntry<IntField, "label_media">("label_media", "Label media"),
		hintEntry<IntField>(),
		mediaEntry<IntField, "hint_media">("hint_media", "Hint media"),
		textEntry<IntField, "help">("help", "Help"),
		mediaEntry<IntField, "help_media">("help_media", "Help media"),
	],
};

const decimalFieldEditorSchema: FieldEditorSchema<DecimalField> = {
	data: [caseWriteEntry<DecimalField>()],
	logic: [
		requiredEntry<DecimalField>(),
		xpathEntry<DecimalField, "validate">("validate", "Validation"),
		mediaEntry<DecimalField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<DecimalField, "relevant">("relevant", "Show when"),
		xpathEntry<DecimalField, "default_value">("default_value", "Default value"),
	],
	ui: [
		mediaEntry<DecimalField, "label_media">("label_media", "Label media"),
		hintEntry<DecimalField>(),
		mediaEntry<DecimalField, "hint_media">("hint_media", "Hint media"),
		textEntry<DecimalField, "help">("help", "Help"),
		mediaEntry<DecimalField, "help_media">("help_media", "Help media"),
	],
};

const dateFieldEditorSchema: FieldEditorSchema<DateField> = {
	data: [caseWriteEntry<DateField>()],
	logic: [
		requiredEntry<DateField>(),
		xpathEntry<DateField, "validate">("validate", "Validation"),
		mediaEntry<DateField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<DateField, "relevant">("relevant", "Show when"),
		xpathEntry<DateField, "default_value">("default_value", "Default value"),
	],
	ui: [
		mediaEntry<DateField, "label_media">("label_media", "Label media"),
		hintEntry<DateField>(),
		mediaEntry<DateField, "hint_media">("hint_media", "Hint media"),
		textEntry<DateField, "help">("help", "Help"),
		mediaEntry<DateField, "help_media">("help_media", "Help media"),
	],
};

const timeFieldEditorSchema: FieldEditorSchema<TimeField> = {
	data: [caseWriteEntry<TimeField>()],
	logic: [
		requiredEntry<TimeField>(),
		xpathEntry<TimeField, "validate">("validate", "Validation"),
		mediaEntry<TimeField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<TimeField, "relevant">("relevant", "Show when"),
		xpathEntry<TimeField, "default_value">("default_value", "Default value"),
	],
	ui: [
		mediaEntry<TimeField, "label_media">("label_media", "Label media"),
		hintEntry<TimeField>(),
		mediaEntry<TimeField, "hint_media">("hint_media", "Hint media"),
		textEntry<TimeField, "help">("help", "Help"),
		mediaEntry<TimeField, "help_media">("help_media", "Help media"),
	],
};

const datetimeFieldEditorSchema: FieldEditorSchema<DatetimeField> = {
	data: [caseWriteEntry<DatetimeField>()],
	logic: [
		requiredEntry<DatetimeField>(),
		xpathEntry<DatetimeField, "validate">("validate", "Validation"),
		mediaEntry<DatetimeField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<DatetimeField, "relevant">("relevant", "Show when"),
		xpathEntry<DatetimeField, "default_value">(
			"default_value",
			"Default value",
		),
	],
	ui: [
		mediaEntry<DatetimeField, "label_media">("label_media", "Label media"),
		hintEntry<DatetimeField>(),
		mediaEntry<DatetimeField, "hint_media">("hint_media", "Hint media"),
		textEntry<DatetimeField, "help">("help", "Help"),
		mediaEntry<DatetimeField, "help_media">("help_media", "Help media"),
	],
};

const secretFieldEditorSchema: FieldEditorSchema<SecretField> = {
	data: [caseWriteEntry<SecretField>()],
	logic: [
		requiredEntry<SecretField>(),
		xpathEntry<SecretField, "validate">("validate", "Validation"),
		mediaEntry<SecretField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<SecretField, "relevant">("relevant", "Show when"),
		xpathEntry<SecretField, "default_value">("default_value", "Default value"),
	],
	ui: [
		mediaEntry<SecretField, "label_media">("label_media", "Label media"),
		hintEntry<SecretField>(),
		mediaEntry<SecretField, "hint_media">("hint_media", "Hint media"),
		textEntry<SecretField, "help">("help", "Help"),
		mediaEntry<SecretField, "help_media">("help_media", "Help media"),
	],
};

const barcodeFieldEditorSchema: FieldEditorSchema<BarcodeField> = {
	data: [caseWriteEntry<BarcodeField>()],
	logic: [
		requiredEntry<BarcodeField>(),
		xpathEntry<BarcodeField, "validate">("validate", "Validation"),
		mediaEntry<BarcodeField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<BarcodeField, "relevant">("relevant", "Show when"),
		xpathEntry<BarcodeField, "default_value">("default_value", "Default value"),
	],
	ui: [
		mediaEntry<BarcodeField, "label_media">("label_media", "Label media"),
		hintEntry<BarcodeField>(),
		mediaEntry<BarcodeField, "hint_media">("hint_media", "Hint media"),
		textEntry<BarcodeField, "help">("help", "Help"),
		mediaEntry<BarcodeField, "help_media">("help_media", "Help media"),
	],
};

// Geopoint is input-capable but has no `validate` / `validate_msg`:
// so it carries no validation-message media entry.
const geopointFieldEditorSchema: FieldEditorSchema<GeopointField> = {
	data: [caseWriteEntry<GeopointField>()],
	logic: [
		requiredEntry<GeopointField>(),
		xpathEntry<GeopointField, "relevant">("relevant", "Show when"),
		xpathEntry<GeopointField, "default_value">(
			"default_value",
			"Default value",
		),
	],
	ui: [
		mediaEntry<GeopointField, "label_media">("label_media", "Label media"),
		hintEntry<GeopointField>(),
		mediaEntry<GeopointField, "hint_media">("hint_media", "Hint media"),
		textEntry<GeopointField, "help">("help", "Help"),
		mediaEntry<GeopointField, "help_media">("help_media", "Help media"),
	],
};

const singleSelectFieldEditorSchema: FieldEditorSchema<SingleSelectField> = {
	data: [
		caseWriteEntry<SingleSelectField>(),
		{
			key: "optionsSource",
			component: OptionsSourceEditor,
			label: "Where the choices come from",
		},
	],
	logic: [
		requiredEntry<SingleSelectField>(),
		xpathEntry<SingleSelectField, "validate">("validate", "Validation"),
		mediaEntry<SingleSelectField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<SingleSelectField, "relevant">("relevant", "Show when"),
		xpathEntry<SingleSelectField, "default_value">(
			"default_value",
			"Default value",
		),
	],
	ui: [
		mediaEntry<SingleSelectField, "label_media">("label_media", "Label media"),
		hintEntry<SingleSelectField>(),
		mediaEntry<SingleSelectField, "hint_media">("hint_media", "Hint media"),
		textEntry<SingleSelectField, "help">("help", "Help"),
		mediaEntry<SingleSelectField, "help_media">("help_media", "Help media"),
	],
};

const multiSelectFieldEditorSchema: FieldEditorSchema<MultiSelectField> = {
	data: [
		caseWriteEntry<MultiSelectField>(),
		{
			key: "optionsSource",
			component: OptionsSourceEditor,
			label: "Where the choices come from",
		},
	],
	logic: [
		requiredEntry<MultiSelectField>(),
		xpathEntry<MultiSelectField, "validate">("validate", "Validation"),
		mediaEntry<MultiSelectField, "validate_msg_media">(
			"validate_msg_media",
			"Validation message media",
		),
		xpathEntry<MultiSelectField, "relevant">("relevant", "Show when"),
		xpathEntry<MultiSelectField, "default_value">(
			"default_value",
			"Default value",
		),
	],
	ui: [
		mediaEntry<MultiSelectField, "label_media">("label_media", "Label media"),
		hintEntry<MultiSelectField>(),
		mediaEntry<MultiSelectField, "hint_media">("hint_media", "Hint media"),
		textEntry<MultiSelectField, "help">("help", "Help"),
		mediaEntry<MultiSelectField, "help_media">("help_media", "Help media"),
	],
};

// Capture kinds (image/audio/video/signature/file) carry a display `label`
// + `label_media` but no help/required/validate message slots, the
// label-media entry joins each kind's pre-existing hint entry.
const imageFieldEditorSchema: FieldEditorSchema<ImageField> = {
	data: [caseWriteEntry<ImageField>()],
	logic: [
		requiredEntry<ImageField>(),
		xpathEntry<ImageField, "relevant">("relevant", "Show when"),
	],
	ui: [
		mediaEntry<ImageField, "label_media">("label_media", "Label media"),
		hintEntry<ImageField>(),
	],
};

const audioFieldEditorSchema: FieldEditorSchema<AudioField> = {
	data: [caseWriteEntry<AudioField>()],
	logic: [
		requiredEntry<AudioField>(),
		xpathEntry<AudioField, "relevant">("relevant", "Show when"),
	],
	ui: [
		mediaEntry<AudioField, "label_media">("label_media", "Label media"),
		hintEntry<AudioField>(),
	],
};

const videoFieldEditorSchema: FieldEditorSchema<VideoField> = {
	data: [caseWriteEntry<VideoField>()],
	logic: [
		requiredEntry<VideoField>(),
		xpathEntry<VideoField, "relevant">("relevant", "Show when"),
	],
	ui: [
		mediaEntry<VideoField, "label_media">("label_media", "Label media"),
		hintEntry<VideoField>(),
	],
};

const fileFieldEditorSchema: FieldEditorSchema<FileField> = {
	data: [caseWriteEntry<FileField>()],
	logic: [
		requiredEntry<FileField>(),
		xpathEntry<FileField, "relevant">("relevant", "Show when"),
	],
	ui: [
		mediaEntry<FileField, "label_media">("label_media", "Label media"),
		hintEntry<FileField>(),
	],
};

const signatureFieldEditorSchema: FieldEditorSchema<SignatureField> = {
	data: [caseWriteEntry<SignatureField>()],
	logic: [
		requiredEntry<SignatureField>(),
		xpathEntry<SignatureField, "relevant">("relevant", "Show when"),
	],
	ui: [
		mediaEntry<SignatureField, "label_media">("label_media", "Label media"),
		hintEntry<SignatureField>(),
	],
};

// Hidden's value comes from `calculate` OR `default_value`, both optional,
// both addable (the `HIDDEN_NO_VALUE` validator enforces at least one). No
// `required` entry: a hidden field is never shown, so it can't be required
// (the `requiredOnHidden` validator enforces this, mirroring Vellum's
// DataBindOnly). No `ui` section (hidden fields have no label, no label
// media, and never render to the user).
const hiddenFieldEditorSchema: FieldEditorSchema<HiddenField> = {
	data: [caseWriteEntry<HiddenField>()],
	logic: [
		xpathEntry<HiddenField, "calculate">("calculate", "Calculate"),
		xpathEntry<HiddenField, "default_value">("default_value", "Default value"),
		xpathEntry<HiddenField, "relevant">("relevant", "Show when"),
	],
	ui: [],
};

// Group/repeat are structural containers shown with minimal chrome
// (Logic only). Their `label_media` carrier exists in the schema and is
// set via the SA tools; the inline inspector keeps them uncluttered
// rather than adding an Appearance section to every container.
const groupFieldEditorSchema: FieldEditorSchema<GroupField> = {
	data: [],
	logic: [xpathEntry<GroupField, "relevant">("relevant", "Show when")],
	ui: [],
};

// `repeat_mode` and the mode-specific keys (`repeat_count`,
// `data_source.ids_query`) are reachable only via the SA tool surface
// (`addField` / `editField`). The inspector exposes only `relevant`
// here because mode editing requires a mode picker plus mode-
// conditional XPath editors (count visible iff
// `repeat_mode === "count_bound"`, ids_query visible iff
// `repeat_mode === "query_bound"`) with clear-on-mode-change semantics:
// a custom widget tier this schema's flat-key entry vocabulary doesn't
// directly support.
const repeatFieldEditorSchema: FieldEditorSchema<RepeatField> = {
	data: [],
	logic: [xpathEntry<RepeatField, "relevant">("relevant", "Show when")],
	ui: [],
};

const labelFieldEditorSchema: FieldEditorSchema<LabelField> = {
	data: [],
	logic: [xpathEntry<LabelField, "relevant">("relevant", "Show when")],
	ui: [mediaEntry<LabelField, "label_media">("label_media", "Label media")],
};

// A section has no slots beyond its identity and title: no data, no logic,
// no media. Its inspector body (`SectionInspectorBody`) is the gestures
// that re-page the form, not a schema-driven panel.
const sectionFieldEditorSchema: FieldEditorSchema<SectionField> = {
	data: [],
	logic: [],
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
	file: fileFieldEditorSchema,
	barcode: barcodeFieldEditorSchema,
	signature: signatureFieldEditorSchema,
	label: labelFieldEditorSchema,
	hidden: hiddenFieldEditorSchema,
	secret: secretFieldEditorSchema,
	group: groupFieldEditorSchema,
	section: sectionFieldEditorSchema,
	repeat: repeatFieldEditorSchema,
};
