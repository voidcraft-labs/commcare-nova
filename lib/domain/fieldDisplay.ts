// lib/domain/fieldDisplay.ts
//
// The one registry of question display settings: each thing an author can
// choose about how a question is drawn, held as its own typed key on the
// schema of exactly the kinds whose control reads it. A setting is named for
// what the worker sees, takes a value from a closed set, and is absent for
// the platform's own behavior. No slot holds free text for a runtime to
// interpret.
//
// `__tests__/fieldDisplay.test.ts` holds this table to the kind schemas both
// ways. The XForm writer of `appearance`
// (`lib/commcare/xform/appearance.ts::fieldAppearance`) keys its tokens by
// this table, and `platformUses.ts` finds every use of a value that names a
// platform row through `fieldDisplayValues`, so a new setting needs no
// detector of its own.

import { CHOICE_LAYOUT_LABELS } from "./choicePresentation";
import type { Field, FieldKind } from "./fields";
import type { PlatformFeatureId } from "./platforms";

export interface FieldDisplayValue {
	/** The value's name where the builder offers it. */
	readonly label: string;
	/** The platform row that states how each platform reads it, where they differ. */
	readonly feature?: PlatformFeatureId;
}

export interface FieldDisplaySetting {
	readonly parameterFeature?: PlatformFeatureId;
	readonly key: string;
	readonly label: string;
	readonly input:
		| "enum"
		| "choice"
		| "channels"
		| "receiver"
		| "flag"
		| "count";
	readonly kinds: readonly FieldKind[];
	readonly values: Readonly<Record<string, FieldDisplayValue>>;
}

const visibleQuestions = [
	"text",
	"secret",
	"barcode",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"geopoint",
	"single_select",
	"multi_select",
	"label",
	"image",
	"audio",
	"video",
	"file",
	"signature",
] as const;

export const FIELD_DISPLAY_SETTINGS = [
	{
		key: "keypad",
		label: "Keyboard",
		input: "enum",
		kinds: ["text", "secret", "barcode"],
		values: {
			numbers: { label: "Number keypad", feature: "number-keypad" },
			"android-numbers": {
				label: "Number keypad on Android",
				feature: "android-keypad",
			},
		},
	},
	{
		key: "choiceLayout",
		label: "Choice layout",
		input: "choice",
		kinds: ["single_select", "multi_select"],
		values: Object.fromEntries(
			Object.entries(CHOICE_LAYOUT_LABELS).map(([kind, label]) => [
				kind,
				{ label },
			]),
		),
	},
	{
		key: "inputWidth",
		label: "Input width",
		input: "enum",
		kinds: [
			"text",
			"secret",
			"barcode",
			"int",
			"decimal",
			"date",
			"time",
			"datetime",
			"geopoint",
		],
		values: {
			short: { label: "Short", feature: "short-input" },
			medium: { label: "Medium", feature: "medium-input" },
		},
	},
	{
		key: "addressLookup",
		label: "Find an address",
		input: "flag",
		kinds: ["text", "secret", "barcode"],
		values: {
			true: { label: "Look up the address", feature: "address-lookup" },
		},
	},
	{
		key: "sendTopics",
		parameterFeature: "question-sender",
		label: "Send updates to",
		input: "channels",
		kinds: ["text", "secret", "barcode", "image", "audio", "video", "file"],
		values: {},
	},
	{
		key: "receiveFrom",
		parameterFeature: "question-receiver",
		label: "Fill from a channel",
		input: "receiver",
		kinds: ["text", "secret", "barcode", "single_select"],
		values: {},
	},
	{
		key: "hintPlacement",
		label: "Hint",
		input: "enum",
		kinds: visibleQuestions,
		values: {
			placeholder: { label: "In the entry box", feature: "placeholder-hint" },
			"hidden-on-web": { label: "Hide in Web Apps", feature: "hide-web-hint" },
		},
	},
	{
		key: "scanOnOpen",
		label: "Scan on opening",
		input: "flag",
		kinds: ["barcode"],
		values: {
			true: { label: "Open the scanner automatically", feature: "auto-scan" },
		},
	},
	{
		key: "canEditScan",
		label: "Edit scanned answer",
		input: "flag",
		kinds: ["barcode"],
		values: { true: { label: "Allow editing", feature: "edit-scan" } },
	},
	{
		key: "calendar",
		label: "Calendar",
		input: "enum",
		kinds: ["date"],
		values: {
			ethiopian: { label: "Ethiopian" },
			nepali: { label: "Nepali", feature: "android-calendar" },
			gregorian: { label: "Gregorian", feature: "android-calendar" },
			"gregorian-with-cancel": {
				label: "Gregorian with a cancel button",
				feature: "android-calendar",
			},
		},
	},
	{
		key: "clock",
		label: "Clock",
		input: "enum",
		kinds: ["time"],
		values: {
			"twelve-hour": { label: "12-hour clock", feature: "twelve-hour-clock" },
		},
	},
	{
		key: "locationPicker",
		label: "Location entry",
		input: "enum",
		kinds: ["geopoint"],
		values: { map: { label: "Map", feature: "android-map" } },
	},
	{
		key: "captureSource",
		label: "Capture from",
		input: "enum",
		kinds: ["image", "video", "audio"],
		values: {
			camera: { label: "Camera only", feature: "camera-only" },
			"record-or-choose": {
				label: "Record or choose a file",
				feature: "record-or-choose",
			},
		},
	},
	{
		key: "overlaySize",
		label: "Photo overlay",
		input: "enum",
		kinds: ["image"],
		values: { small: { label: "Small", feature: "photo-overlay" } },
	},
	{
		key: "recorder",
		label: "Recording controls",
		input: "enum",
		kinds: ["audio"],
		values: {
			legacy: { label: "Classic recorder", feature: "classic-recorder" },
		},
	},
	{
		key: "pauseRecording",
		label: "Pause recording",
		input: "flag",
		kinds: ["audio"],
		values: {
			true: { label: "Allow pausing a recording", feature: "long-recording" },
		},
	},
	{
		key: "selectableText",
		label: "Let workers select text",
		input: "flag",
		kinds: ["label"],
		values: { true: { label: "Selectable", feature: "select-label-text" } },
	},
	{
		key: "banner",
		label: "Banner",
		input: "enum",
		kinds: visibleQuestions,
		values: {
			good: { label: "Good", feature: "question-banner" },
			caution: { label: "Caution", feature: "question-banner" },
			bad: { label: "Bad", feature: "question-banner" },
			hidden: { label: "Hidden on Android", feature: "hidden-label" },
		},
	},
	{
		key: "compact",
		label: "Compact group",
		input: "flag",
		kinds: ["group"],
		values: { true: { label: "Compact", feature: "compact-group" } },
	},
	{
		key: "collapse",
		label: "Collapsible group",
		input: "enum",
		kinds: ["group"],
		values: {
			open: { label: "Start open", feature: "collapse-group" },
			closed: { label: "Start closed", feature: "collapse-group" },
		},
	},
	{
		key: "border",
		label: "Group border",
		input: "flag",
		kinds: ["group"],
		values: { true: { label: "Show a border", feature: "group-border" } },
	},
	{
		key: "itemsPerRow",
		parameterFeature: "questions-across",
		label: "Items per row",
		input: "count",
		kinds: [...visibleQuestions, "group"],
		values: {},
	},
	{
		key: "repeatsPerRow",
		parameterFeature: "repeats-across",
		label: "Repeat items per row",
		input: "count",
		kinds: ["group"],
		values: {},
	},
	{
		key: "textAlignment",
		label: "Text alignment",
		input: "enum",
		kinds: visibleQuestions,
		values: {
			center: { label: "Center", feature: "question-alignment" },
			right: { label: "Right", feature: "question-alignment" },
		},
	},
	{
		key: "webSignature",
		label: "Sign on Web Apps",
		input: "flag",
		kinds: ["image"],
		values: { true: { label: "Ask for a signature" } },
	},
] as const satisfies readonly FieldDisplaySetting[];

export type FieldDisplaySettingKey =
	(typeof FIELD_DISPLAY_SETTINGS)[number]["key"];

/** The settings a kind's schema declares, in registry order. */
export function fieldDisplaySettingsFor(
	kind: FieldKind,
): readonly FieldDisplaySetting[] {
	return FIELD_DISPLAY_SETTINGS.filter((setting) =>
		(setting.kinds as readonly FieldKind[]).includes(kind),
	);
}

/** The palette for this kind. The independent schema audit checks the
 * admitted values even where two kinds share a setting. */
export function fieldDisplayOptionsFor(
	kind: FieldKind,
	setting: FieldDisplaySetting,
): Readonly<Record<string, FieldDisplayValue>> {
	const admits = (value: string) => {
		if (setting.key === "choiceLayout" && kind === "multi_select")
			return !["search", "buttons", "advance-on-choice"].includes(value);
		if (setting.key === "banner" && kind !== "label") return value !== "hidden";
		if (setting.key === "keypad" && kind === "barcode")
			return value === "numbers";
		if (setting.key === "captureSource")
			return kind === "audio"
				? value === "record-or-choose"
				: value === "camera";
		return true;
	};
	return Object.fromEntries(
		Object.entries(setting.values).filter(([value]) => admits(value)),
	);
}

/** Each setting a field holds, with its value's registry row, in registry order. */
export function fieldDisplayValues(field: Field): readonly {
	key: FieldDisplaySettingKey;
	value: string;
	row: FieldDisplayValue;
}[] {
	const held: {
		key: FieldDisplaySettingKey;
		value: string;
		row: FieldDisplayValue;
	}[] = [];
	for (const setting of fieldDisplaySettingsFor(field.kind)) {
		const stored: unknown = (field as Readonly<Record<string, unknown>>)[
			setting.key
		];
		const value =
			setting.key === "choiceLayout" &&
			typeof stored === "object" &&
			stored !== null &&
			"kind" in stored
				? stored.kind
				: stored;
		if (stored === undefined) continue;
		if (setting.parameterFeature) {
			held.push({
				key: setting.key as FieldDisplaySettingKey,
				value: String(value),
				row: { label: setting.label, feature: setting.parameterFeature },
			});
			continue;
		}
		if (typeof value !== "string" && value !== true) continue;
		const spelling = String(value);
		const row = Object.hasOwn(setting.values, spelling)
			? setting.values[spelling]
			: undefined;
		if (row === undefined) continue;
		held.push({
			key: setting.key as FieldDisplaySettingKey,
			value: spelling,
			row:
				setting.key === "keypad" &&
				spelling === "numbers" &&
				field.kind !== "text"
					? {
							...row,
							feature:
								field.kind === "barcode"
									? "barcode-text-options"
									: "secret-keypad",
						}
					: row,
		});
	}
	return held;
}

/** A choice's search and advance behavior depends on its parameters. Mixed
 * reader layouts and whole-control combinations have their own advice. */
export function choiceDisplayFeatures(field: Field): PlatformFeatureId[] {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return [];
	const layout = field.choiceLayout;
	if (!layout) return [];
	switch (layout.kind) {
		case "platforms":
			return ["combined-question-display"];
		case "buttons":
			return ["choice-cycle"];
		case "advance-on-choice":
			return ["choice-advance"];
		case "row":
			return ["choice-row"];
		case "grid":
			return "advanceOnChoice" in layout && layout.advanceOnChoice
				? ["choice-grid", "choice-advance"]
				: ["choice-grid"];
		case "search":
			return layout.matchWords?.endsWith("multiword")
				? ["choice-multiword"]
				: layout.matchWords?.endsWith("fuzzy")
					? ["choice-fuzzy"]
					: [];
		default:
			return [];
	}
}
