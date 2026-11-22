import type { FieldKind } from "@/lib/domain";
import {
	type Field,
	fieldDisplaySettingsFor,
	fieldKindDeclaresKey,
} from "@/lib/domain";
import type { ChoiceLayout } from "@/lib/domain/choicePresentation";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

import type { DisplaySettings } from "./appearance";
import { writeFieldAppearance } from "./appearance";
import { readChoiceLayout } from "./choiceAppearance";

function deepEqual(a: unknown, b: unknown): boolean {
	return (
		a === b ||
		(a !== undefined &&
			b !== undefined &&
			canonicalJsonText(a) === canonicalJsonText(b))
	);
}

/** Web Apps splits on literal spaces and takes the first per-row style
 * matched by its regex. parseInt reads the digits at the start, including
 * on a prefixed value such as 3x4-per-row. */
function rowCount(
	parts: readonly string[],
	repeat: boolean,
): string | undefined {
	const suffix = repeat ? /\d+-per-row-repeat(?:\s|$)/ : /\d+-per-row(?:\s|$)/;
	const token = parts.find((part) => suffix.test(part));
	const digits = token?.match(/^\+?(\d+)/)?.[1];
	return digits?.replace(/^0+(?=\d)/, "");
}

interface ChoiceWidgets {
	web:
		| "ordinary"
		| "dropdown"
		| "search"
		| "buttons"
		| "headings"
		| "unlabelled";
	android:
		| "ordinary"
		| "dropdown"
		| "search"
		| "grid"
		| "advance"
		| "row"
		| "headings"
		| "unlabelled";
	webMatch?: "multiword" | "fuzzy";
	androidMatch?: "multiword" | "fuzzy";
	columns?: number;
	advance?: true;
}

/** The two factories choose independently. The whole suffix after the first
 * hyphen must fit a Java int to select a fixed Android grid. */
export function choiceWidgets(value: string, single: boolean): ChoiceWidgets {
	const words = value.split(" ");
	const web = words.includes("minimal")
		? "dropdown"
		: single && words.includes("combobox")
			? "search"
			: single && words.includes("button-select")
				? "buttons"
				: words.includes("label")
					? "headings"
					: words.includes("list-nolabel")
						? "unlabelled"
						: "ordinary";
	const android = value.includes("compact")
		? "grid"
		: value === "minimal"
			? "dropdown"
			: single && value.includes("combobox")
				? "search"
				: single && value === "quick"
					? "advance"
					: value === "list"
						? "row"
						: value === "list-nolabel"
							? "unlabelled"
							: value === "label"
								? "headings"
								: "ordinary";
	const suffix = value.slice(value.indexOf("-") + 1);
	const columns = /^[+-]?[0-9]+$/.test(suffix) ? Number(suffix) : NaN;
	return {
		web,
		android,
		...(web === "search" &&
			(words[1] === "multiword" || words[1] === "fuzzy") && {
				webMatch: words[1],
			}),
		...(android === "search" &&
			(value.includes("multiword")
				? { androidMatch: "multiword" as const }
				: value.includes("fuzzy")
					? { androidMatch: "fuzzy" as const }
					: {})),
		...(android === "grid" &&
			columns > 0 &&
			columns <= 2_147_483_647 && { columns }),
		...(single &&
			android === "grid" &&
			value.includes("quick") && { advance: true as const }),
	};
}

function platformPair(w: ChoiceWidgets): ChoiceLayout | undefined {
	if (!["ordinary", "search", "grid"].includes(w.android)) return undefined;
	const web =
		w.web === "unlabelled"
			? { kind: "row-without-label" as const }
			: w.web === "search"
				? {
						kind: "search" as const,
						...(w.webMatch && { matchWords: w.webMatch }),
					}
				: { kind: w.web };
	const android =
		w.android === "grid"
			? {
					kind: "grid" as const,
					...(w.columns && { columns: w.columns }),
					...(w.advance && { advanceOnChoice: true as const }),
				}
			: w.android === "search"
				? {
						kind: "search" as const,
						...(w.androidMatch && { matchWords: w.androidMatch }),
					}
				: { kind: "ordinary" as const };
	return { kind: "platforms", web, android };
}

function hintInEntry(
	kind: FieldKind,
	numeric: boolean,
	address: boolean,
	value: string,
): boolean {
	if (kind === "single_select" || kind === "multi_select")
		return ["dropdown", "search"].includes(
			choiceWidgets(value, kind === "single_select").web,
		);
	return (
		!address &&
		(["int", "decimal", "barcode", "text"].includes(kind) ||
			(kind === "secret" && numeric))
	);
}

/** The facts that differentiate a spelling beyond its set of typed slots.
 * In particular Vellum changes mug type only on exact appearance strings. */
function wholeValueEffects(kind: FieldKind, value: string) {
	const lower = value.toLowerCase();
	return {
		choice:
			kind === "single_select" || kind === "multi_select"
				? choiceWidgets(value, kind === "single_select")
				: undefined,
		phone: kind === "text" && value === "numeric",
		androidKeypad:
			(kind === "text" || kind === "secret") &&
			(lower === "numeric" || lower === "numbers"),
		shortAction:
			["text", "secret", "int", "decimal"].includes(kind) && lower === "short",
		signature:
			kind === "signature" || kind === "image"
				? value === "signature"
				: undefined,
		trigger:
			kind === "label"
				? value === "minimal" ||
					value === "selectable" ||
					value.startsWith("floating-")
				: undefined,
		ethiopian: kind === "date" && lower === "ethiopian",
		groupLayout:
			kind === "group" || kind === "section"
				? lower === "field-list" || lower === "compact"
				: undefined,
	};
}

function settingsReadAt(kind: FieldKind, value: string): DisplaySettings {
	const words = value.split(" ");
	const lower = value.toLowerCase();
	const has = (token: string) => words.includes(token);
	const admits = (key: keyof DisplaySettings) =>
		fieldKindDeclaresKey(kind, key);
	const settings: DisplaySettings = {};
	if ((kind === "group" || kind === "section") && lower === "field-list")
		settings.fieldList = true;
	if (admits("choiceLayout")) {
		const single = kind === "single_select";
		const widgets = choiceWidgets(value, single);
		settings.choiceLayout = readChoiceLayout(value, single);
		if (!settings.choiceLayout) {
			if (widgets.android === "grid")
				settings.choiceLayout = {
					kind: "grid",
					...(widgets.columns && { columns: widgets.columns }),
					...(widgets.advance && { advanceOnChoice: true }),
				};
			else if (widgets.android === "search" || widgets.web === "search") {
				const mode =
					widgets.webMatch ??
					(widgets.androidMatch &&
						(`android-${widgets.androidMatch}` as const));
				settings.choiceLayout = {
					kind: "search",
					...(mode && { matchWords: mode }),
				};
			} else if (
				widgets.web === "dropdown" ||
				widgets.web === "buttons" ||
				widgets.web === "headings"
			)
				settings.choiceLayout = { kind: widgets.web };
			else if (widgets.web === "unlabelled")
				settings.choiceLayout = { kind: "row-without-label" };
		}
		if (!settings.choiceLayout) delete settings.choiceLayout;
	}
	if (admits("keypad")) {
		if (has("numeric")) settings.keypad = "numbers";
		else if (lower === "numbers" && kind !== "barcode")
			settings.keypad = "android-numbers";
	}
	if (admits("addressLookup") && has("address")) settings.addressLookup = true;
	if (admits("inputWidth")) {
		if (has("short")) settings.inputWidth = "short";
		else if (has("medium")) settings.inputWidth = "medium";
	}
	if (admits("hintPlacement") && has("hint-as-placeholder"))
		settings.hintPlacement = hintInEntry(
			kind,
			settings.keypad === "numbers",
			!!settings.addressLookup,
			value,
		)
			? "placeholder"
			: "hidden-on-web";
	if (admits("calendar")) {
		if (has("ethiopian")) settings.calendar = "ethiopian";
		else if (lower === "nepali") settings.calendar = "nepali";
		else if (lower.includes("gregorian"))
			settings.calendar = lower.includes("cancel")
				? "gregorian-with-cancel"
				: "gregorian";
	}
	if (admits("clock") && has("12-hour")) settings.clock = "twelve-hour";
	if (admits("locationPicker") && lower === "maps")
		settings.locationPicker = "map";
	if (admits("scanOnOpen") && value === "quick") settings.scanOnOpen = true;
	if (admits("canEditScan") && value.includes("editable"))
		settings.canEditScan = true;
	if (kind === "image") {
		if (value !== "signature" && has("signature")) settings.webSignature = true;
		if (value.includes("overlay-small")) settings.overlaySize = "small";
		if (value.includes("acquire")) settings.captureSource = "camera";
	}
	if (kind === "video" && lower === "acquire")
		settings.captureSource = "camera";
	if (kind === "audio") {
		if (value.includes("legacy")) settings.recorder = "legacy";
		else if (value === "acquire-or-upload")
			settings.captureSource = "record-or-choose";
		if (value === "long") settings.pauseRecording = true;
	}
	if (kind === "label" && value === "selectable")
		settings.selectableText = true;
	if (admits("banner")) {
		if (value === "floating-good") settings.banner = "good";
		else if (value === "floating-caution") settings.banner = "caution";
		else if (value === "floating-bad") settings.banner = "bad";
		else if (kind === "label" && value.startsWith("floating-"))
			settings.banner = "hidden";
	}
	if (kind === "group") {
		if (lower === "compact") settings.compact = true;
		if (has("group-collapse"))
			settings.collapse = has("collapse-open") ? "open" : "closed";
		if (has("group-border")) settings.border = true;
	}
	const rows = admits("itemsPerRow") && rowCount(words, false);
	if (rows !== false && rows !== undefined) settings.itemsPerRow = rows;
	const repeats = admits("repeatsPerRow") && rowCount(words, true);
	if (repeats !== false && repeats !== undefined)
		settings.repeatsPerRow = repeats;
	if (admits("textAlignment")) {
		if (has("text-align-center")) settings.textAlignment = "center";
		else if (has("text-align-right")) settings.textAlignment = "right";
	}
	if (
		admits("sendTopics") &&
		(settings.addressLookup ||
			["image", "file", "video", "audio"].includes(kind)) &&
		!settings.webSignature
	) {
		const topics = words.flatMap((word) => {
			const match = word.match(/broadcast-(.*)/);
			return match ? [match[1]] : [];
		});
		if (topics.length) settings.sendTopics = [...new Set(topics)];
	}
	if (admits("receiveFrom") && !settings.addressLookup) {
		const receiver = words
			.find((word) => /receive-*/.test(word))
			?.match(/receive-(.*)-(.*)/);
		const usable =
			kind !== "single_select" ||
			["ordinary", "search"].includes(choiceWidgets(value, true).web);
		if (receiver && usable)
			settings.receiveFrom = {
				channel: receiver[1],
				field: receiver[2] === "indexed" ? "filename" : receiver[2],
			};
	}
	return settings;
}

export function readFieldAppearance(
	kind: FieldKind,
	value: string,
	hasRepeatingRows = true,
): DisplaySettings | undefined {
	let settings = settingsReadAt(kind, value);
	if (!hasRepeatingRows) delete settings.repeatsPerRow;
	if (kind === "single_select" || kind === "multi_select") {
		const expected = choiceWidgets(value, kind === "single_select");
		const proposed = writeFieldAppearance(kind, settings) ?? "";
		if (
			!deepEqual(expected, choiceWidgets(proposed, kind === "single_select"))
		) {
			const pair = platformPair(expected);
			if (pair) settings = { ...settings, choiceLayout: pair };
		}
	}
	const candidate = writeFieldAppearance(kind, settings) ?? "";
	return deepEqual(
		wholeValueEffects(kind, value),
		wholeValueEffects(kind, candidate),
	) &&
		deepEqual(
			{ ...settings, choiceLayout: undefined },
			{ ...settingsReadAt(kind, candidate), choiceLayout: undefined },
		)
		? settings
		: undefined;
}

/** A setting is valid on an authored question only when its export still
 * reads as that question and conveys all selected values. No UI-only guard
 * can cover MCP, replay, and a kind conversion. */
export function fieldDisplayProblem(field: Field): string | undefined {
	const options = fieldDisplaySettingsFor(field.kind);
	const active = options.filter((option) => Object.hasOwn(field, option.key));
	if (!active.length) return undefined;
	const held = Object.fromEntries(
		active.map((option) => [option.key, Reflect.get(field, option.key)]),
	);
	if (field.kind === "group" && field.fieldList) held.fieldList = true;
	const emitted = writeFieldAppearance(field.kind, held) ?? "";
	const read = readFieldAppearance(field.kind, emitted);
	if (
		field.kind === "label" &&
		emitted !== "minimal" &&
		emitted !== "selectable" &&
		!emitted.startsWith("floating-")
	)
		return "These settings would turn the label into a question the worker must acknowledge. You can keep a banner or use the label's ordinary display.";
	if (field.kind === "signature" && emitted !== "signature")
		return "These settings would replace the signature pad on Android. You can keep this signature's ordinary display.";
	if (field.kind === "image" && emitted === "signature")
		return "Web Apps signing on its own would also change this picture to a signature on Android. You can use a Signature question for signing on both platforms.";
	if (field.kind === "group" && field.fieldList && !read?.fieldList)
		return "This group needs its ordinary display to keep its questions together on one screen. You can remove the other display settings or show one question per screen.";
	if (deepEqual(read, held)) return undefined;
	const missing = active
		.filter(
			(option) =>
				!deepEqual(
					Reflect.get(held, option.key),
					read && Reflect.get(read, option.key),
				),
		)
		.map((option) => option.label);
	return `Workers would see a different result for ${missing.join(", ") || "this combination"}. You can keep this setting on its own or use the question's ordinary display.`;
}
