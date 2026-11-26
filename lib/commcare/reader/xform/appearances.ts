/**
 * A control's appearance, classified, never guessed. Nova holds four
 * appearance facts, each the kind's own token (`minimal` on a trigger,
 * `signature` on an image upload, `field-list` on a group, `numeric` on a
 * text input), which the kind table reads. Every other string is classified
 * by the runtime reads the surface records in its `appearance:` family, as the
 * proof lane does (`proof/checks/manifest_value_classes.py`: `appearance_rules`,
 * `appearance_matches`, `AppearanceRule.reads`, `element_facts`), and by the
 * manifest's Appearances rows.
 */

import type { FieldKind } from "@/lib/domain";
import { recordFromEntries } from "@/lib/domain/records";
import { circumstanceFinding, type HqPlace } from "@/lib/publish/hqFindings";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { inventoryIndex } from "../../surface/inventory";
import surface from "../../surface/surface.json";
import {
	FIELD_DISPLAY_SETTING_TOKENS,
	kindAppearanceToken,
	writeFieldAppearance,
} from "../../xform/appearance";
import { fieldKindBindType } from "../../xform/bindType";
import { UPLOAD_MEDIATYPE_BY_CAPTURE_KIND } from "../../xform/captureUpload";
import { readFieldAppearance } from "../../xform/readDisplaySettings";
import type { Accounting } from "../accounting";
import { account, type Claim, defineClaims, refuse, take } from "../claims";
import type { XmlCursor } from "../xmlCursor";
import { type ControlNode, isFieldListAppearance, wrapsRepeat } from "./body";
import { stripXsd } from "./kinds";
import type { BindFacts } from "./model";

/** What Core builds of a body element, as `manifest_value_classes.py::element_facts` answers it. */
export interface AppearanceFacts {
	readonly holder: "group" | "question" | null;
	/** Core's control constant (`CONTROL_INPUT`, `CONTROL_IMAGE_CHOOSE`); null for a group. */
	readonly control: string | null;
	/** Core's data type constant (`DATATYPE_NULL` where the bind gives none); null for a group. */
	readonly datatype: string | null;
}

/** One runtime read that acts on the value: its surface item, its reader and its token. */
export interface AppearanceRead {
	readonly key: string;
	readonly reader: string;
	readonly token: string;
}

interface SurfaceRead {
	readonly match: string;
	readonly case: string;
	readonly holders?: readonly string[];
	readonly controls?: readonly string[];
	readonly datatypes?: readonly string[];
}

interface AppearanceRule extends AppearanceRead {
	readonly match: string;
	readonly case: string;
	readonly holders: ReadonlySet<string>;
	readonly controls: ReadonlySet<string>;
	readonly datatypes: ReadonlySet<string>;
}

const ITEMS: SourceTable<{
	readonly reads?: readonly SurfaceRead[];
	readonly core?: { readonly passes?: readonly string[] };
	readonly datatypes?: readonly string[];
}> = tableOf(
	(
		surface as unknown as {
			readonly items: Readonly<
				Record<
					string,
					{
						readonly reads?: readonly SurfaceRead[];
						readonly core?: { readonly passes?: readonly string[] };
						readonly datatypes?: readonly string[];
					}
				>
			>;
		}
	).items,
);

/** Every appearance read the surface records, one rule each, in key order. */
const RULES: readonly AppearanceRule[] = [...ITEMS.keys()]
	.filter((key) => key.startsWith("appearance:"))
	.sort()
	.flatMap((key) => {
		const rest = key.slice("appearance:".length);
		const slash = rest.indexOf("/");
		const reader = rest.slice(0, slash);
		const token = rest.slice(slash + 1);
		return (ITEMS.get(key)?.reads ?? []).map((read) => ({
			key,
			reader,
			token,
			match: read.match,
			case: read.case,
			holders: new Set(read.holders ?? []),
			controls: new Set(read.controls ?? []),
			datatypes: new Set(read.datatypes ?? []),
		}));
	});

function ruleReads(rule: AppearanceRule, facts: AppearanceFacts): boolean {
	return (
		(rule.holders.size === 0 ||
			(facts.holder !== null && rule.holders.has(facts.holder))) &&
		(rule.controls.size === 0 ||
			(facts.control !== null && rule.controls.has(facts.control))) &&
		(rule.datatypes.size === 0 ||
			(facts.datatype !== null && rule.datatypes.has(facts.datatype)))
	);
}

function cased(text: string, rule: AppearanceRule): string {
	return rule.case === "lowercased" || rule.case === "ignore-case"
		? text.toLowerCase()
		: text;
}

/** Python's `str.split()` with no separator: runs of whitespace, no empty words. */
function words(text: string): string[] {
	return text.split(/\s+/).filter((word) => word !== "");
}

/** A port of `appearance_matches`: whether a read's rule acts on this value. */
function ruleMatches(value: string, rule: AppearanceRule): boolean {
	const text = cased(value, rule);
	const wanted =
		rule.case === "ignore-case" ? rule.token.toLowerCase() : rule.token;
	switch (rule.match) {
		case "whole":
			return text === wanted;
		case "contains":
		case "index":
			return text.includes(wanted);
		case "prefix":
			return text.startsWith(wanted);
		case 'token split on " "':
			return text.split(" ").includes(wanted);
		case "token split on /\\s+/":
			return words(text).includes(wanted);
		case 'token-regex split on " "': {
			const pattern = new RegExp(rule.token);
			return text.split(" ").some((part) => pattern.test(part));
		}
		case 'word 1 split on " "': {
			const parts = text.split(" ");
			return parts.length > 1 && parts[1] === wanted;
		}
		default:
			throw new Error(
				`The surface records an appearance read matched by "${rule.match}", which the reader does not know how to apply. Teach lib/commcare/reader/xform/appearances.ts the rule, as proof/checks/manifest_value_classes.py::appearance_matches applies it.`,
			);
	}
}

/** Which runtime reads act on a value on an element of these facts. */
export function appearanceReads(
	value: string,
	facts: AppearanceFacts,
): readonly AppearanceRead[] {
	return RULES.filter(
		(rule) => ruleReads(rule, facts) && ruleMatches(value, rule),
	).map(({ key, reader, token }) => ({ key, reader, token }));
}

/** Every appearance surface key some runtime reads `value` as, whatever the element it stands on:
 *  the keys a refusal covering the attribute names it by. */
export function appearanceKeysMatching(value: string): readonly string[] {
	return [
		...new Set(
			RULES.filter((rule) => ruleMatches(value, rule)).map((rule) => rule.key),
		),
	];
}

/** The control type Core gives an upload by its media type (`XFormParser.parseUpload`). */
const UPLOAD_CONTROLS: SourceTable<string> = tableOf({
	[UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.image]: "CONTROL_IMAGE_CHOOSE",
	[UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.audio]: "CONTROL_AUDIO_CAPTURE",
	[UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.video]: "CONTROL_VIDEO_CAPTURE",
	[UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.file]: "CONTROL_DOCUMENT_UPLOAD",
});

/** What Core builds of a control, as `element_facts` reads it from the surface. */
export function appearanceFacts(
	control: ControlNode,
	bind: BindFacts | undefined,
): AppearanceFacts {
	const passes = (
		ITEMS.get(`jr-control:${control.tag}`)?.core?.passes ?? []
	).map((constant) => constant.slice(constant.lastIndexOf(".") + 1));
	if (
		passes.some(
			(one) => one === "CONTAINER_GROUP" || one === "CONTAINER_REPEAT",
		)
	)
		return { holder: "group", control: null, datatype: null };
	const controls = passes.filter((one) => one.startsWith("CONTROL_")).sort();
	const first = controls[0];
	if (first === undefined)
		return { holder: null, control: null, datatype: null };
	const type =
		control.tag === "upload"
			? UPLOAD_CONTROLS.get(control.mediaType ?? "")
			: undefined;
	const written = bind?.type;
	const datatype =
		written === undefined
			? "DATATYPE_NULL"
			: (ITEMS.get(
					`jr-type:${written.includes(":") ? written.slice(written.indexOf(":") + 1) : written}`,
				)?.datatypes?.[0] ?? "DATATYPE_UNSUPPORTED");
	return { holder: "question", control: type ?? first, datatype };
}

// ── The control a row applies to ───────────────────────────────────────────

/** A control as the Appearances rows name it. */
type RowControl =
	| "text"
	| "secret"
	| "int"
	| "decimal"
	| "date"
	| "time"
	| "datetime"
	| "geopoint"
	| "barcode"
	| "intent"
	| "input-other"
	| "select1"
	| "select"
	| "trigger"
	| "image"
	| "audio"
	| "video"
	| "document"
	| "upload-other"
	| "group"
	| "repeat-wrapper"
	| "repeat";

const written = (kind: Parameters<typeof fieldKindBindType>[0]) =>
	stripXsd(fieldKindBindType(kind) ?? "");

function rowControl(
	control: ControlNode,
	bind: BindFacts | undefined,
): RowControl {
	const type = bind?.type === undefined ? undefined : stripXsd(bind.type);
	switch (control.tag) {
		case "input":
			if (type === undefined || type === written("text")) return "text";
			if (type === written("int") || type === "integer") return "int";
			if (type === written("decimal")) return "decimal";
			if (type === written("date")) return "date";
			if (type === written("time")) return "time";
			if (type === written("datetime")) return "datetime";
			if (type === written("geopoint")) return "geopoint";
			if (type === written("barcode")) return "barcode";
			if (type === "intent") return "intent";
			return "input-other";
		case "secret":
			return "secret";
		case "select1":
			return "select1";
		case "select":
			return "select";
		case "trigger":
			return "trigger";
		case "upload":
			if (control.mediaType === UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.image)
				return "image";
			if (control.mediaType === UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.audio)
				return "audio";
			if (control.mediaType === UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.video)
				return "video";
			if (control.mediaType === UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.file)
				return "document";
			return "upload-other";
		case "group":
			return wrapsRepeat(control) ? "repeat-wrapper" : "group";
		case "repeat":
			return "repeat";
	}
}

const QUESTION_CONTROLS: ReadonlySet<RowControl> = new Set([
	"text",
	"secret",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"geopoint",
	"barcode",
	"intent",
	"input-other",
	"select1",
	"select",
	"trigger",
	"image",
	"audio",
	"video",
	"document",
	"upload-other",
]);
const INPUTS: ReadonlySet<RowControl> = new Set([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"geopoint",
	"barcode",
	"intent",
	"input-other",
]);

// ── The rows ───────────────────────────────────────────────────────────────

export interface AppearanceRow {
	/** The table's first column: whether the row applies to this control and its bind. */
	readonly applies: (
		control: ControlNode,
		bind: BindFacts | undefined,
	) => boolean;
	/** The table's second column: whether the whole appearance string is one the row names. */
	readonly matches: (value: string) => boolean;
	/** Held rows take the control’s values. Other rows account for a finding. */
	readonly claim: Claim<"account" | "take">;
}

const DISPLAY_ROWS = new Set([
	"select1-minimal",
	"select1-compact-compact-n",
	"select1-quick",
	"select1-quick-compact-n",
	"select1-combobox",
	"select1-combobox-multiword",
	"select1-combobox-fuzzy",
	"select1-list",
	"select1-list-nolabel",
	"select1-label",
	"select1-button-select",
	"select1-receive-topic-field",
	"select-minimal",
	"select-compact-compact-n",
	"select-list",
	"select-list-nolabel",
	"select-label",
	"secret-numeric",
	"text-secret-numbers",
	"short",
	"medium",
	"text-address",
	"broadcast-topic-an-address-entry-under-the-gates-above-and",
	"text-receive-topic-field",
	"secret-address",
	"secret-receive-topic-field",
	"barcode-numeric-address-or-receive-topic-field",
	"hint-as-placeholder-on-text-other-than-a-secret-without-numeric",
	"hint-as-placeholder-on-any-other-entry",
	"barcode-quick",
	"date-ethiopian",
	"date-nepali",
	"date-gregorian-gregorian-cancel",
	"time-12-hour",
	"geopoint-maps",
	"barcode-editable",
	"image-acquire",
	"image-overlay-small",
	"audio-legacy",
	"audio-acquire-or-upload",
	"audio-long",
	"video-acquire",
	"trigger-selectable",
	"floating-good-floating-caution-floating-bad",
	"a-label-whose-appearance-string-starts-with-floating-other-than",
	"group-compact",
	"group-group-collapse",
	"group-collapse-open",
	"group-group-border",
	"n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one",
	"n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or",
	"any-other-per-row-token-the-first-token-web-apps-per-row-pattern",
	"text-align-center-text-align-right",
	"multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2",
	"a-multi-token-string-holding-tokens-no-runtime-reads-on-that",
	"a-single-string-no-row-names-that-holds-values-android-matches",
	"a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of",
]);

/** One row's claim, registered under the entry's id less its area. */
function rowClaim(id: string, key: string): Claim<"account" | "take"> {
	const claim = (DISPLAY_ROWS.has(id) ? take : account)(`questions/${id}`, key);
	defineClaims("xform-appearance", recordFromEntries([[id, claim]]));
	return claim;
}

const on =
	(...controls: RowControl[]) =>
	(control: ControlNode, bind: BindFacts | undefined) =>
		controls.includes(rowControl(control, bind));
const onQuestion = (control: ControlNode, bind: BindFacts | undefined) =>
	QUESTION_CONTROLS.has(rowControl(control, bind));
const onInput = (control: ControlNode, bind: BindFacts | undefined) =>
	INPUTS.has(rowControl(control, bind)) ||
	rowControl(control, bind) === "secret";

const exactly =
	(...values: string[]) =>
	(value: string) =>
		values.includes(value);
/** `<n>`: one or more digits. */
const COMPACT_N = /^compact-\d+$/;
const RECEIVE = /^receive-[^ ]*-[^ -]*$/;
const BROADCAST = /^broadcast-[^ ]*$/;
const FLOATING = ["floating-good", "floating-caution", "floating-bad"];
/** Web Apps' per-row patterns (`const.js::PER_ROW_PATTERN`, `PER_ROW_REPEAT_PATTERN`), as the
 *  surface records them. */
const PER_ROW = /\d+-per-row(\s|$)/;
const PER_ROW_REPEAT = /\d+-per-row-repeat(\s|$)/;
const N_PER_ROW = /^\d+-per-row$/;
const N_PER_ROW_REPEAT = /^\d+-per-row-repeat$/;

/** A single token: no whitespace at all. */
function singleToken(value: string): boolean {
	return value !== "" && !/\s/.test(value);
}

/** The values every question reads, which the inert catch-alls leave to their own rows. */
function readByEveryQuestion(value: string): boolean {
	return (
		value === "short" ||
		value === "medium" ||
		value === "hint-as-placeholder" ||
		value.startsWith("text-align-") ||
		FLOATING.includes(value) ||
		PER_ROW.test(value)
	);
}

/** Any value on a Vellum Repeat, written on its wrapping group or on the `repeat` itself, which
 *  Core discards at parse (`XFormParser::collapseRepeatGroups`). */
const VELLUM_REPEAT = rowClaim(
	"any-value-on-a-vellum-repeat-written-on-its-wrapping-group-or-on",
	"xform:repeat@appearance",
);

export const APPEARANCE_ROWS: readonly AppearanceRow[] = [
	{
		applies: on("select1"),
		matches: exactly("minimal"),
		claim: rowClaim("select1-minimal", "appearance:web-apps/minimal"),
	},
	{
		applies: on("select1"),
		matches: (value) => value === "compact" || COMPACT_N.test(value),
		claim: rowClaim("select1-compact-compact-n", "appearance:android/compact"),
	},
	{
		applies: on("select1"),
		matches: exactly("quick"),
		claim: rowClaim("select1-quick", "appearance:android/quick"),
	},
	{
		applies: on("select1"),
		matches: (value) => {
			const [a, b, ...rest] = value.split(" ");
			return (
				rest.length === 0 &&
				((a === "quick" && COMPACT_N.test(b ?? "")) ||
					(b === "quick" && COMPACT_N.test(a ?? "")))
			);
		},
		claim: rowClaim("select1-quick-compact-n", "appearance:android/quick"),
	},
	{
		applies: on("select1"),
		matches: exactly("combobox"),
		claim: rowClaim("select1-combobox", "appearance:web-apps/combobox"),
	},
	{
		applies: on("select1"),
		matches: exactly("combobox multiword"),
		claim: rowClaim(
			"select1-combobox-multiword",
			"appearance:web-apps/combobox",
		),
	},
	{
		applies: on("select1"),
		matches: exactly("combobox fuzzy"),
		claim: rowClaim("select1-combobox-fuzzy", "appearance:web-apps/combobox"),
	},
	{
		applies: on("select1"),
		matches: exactly("list"),
		claim: rowClaim("select1-list", "appearance:android/list"),
	},
	{
		applies: on("select1"),
		matches: exactly("list-nolabel"),
		claim: rowClaim("select1-list-nolabel", "appearance:web-apps/list-nolabel"),
	},
	{
		applies: on("select1"),
		matches: exactly("label"),
		claim: rowClaim("select1-label", "appearance:web-apps/label"),
	},
	{
		applies: on("select1"),
		matches: exactly("button-select"),
		claim: rowClaim(
			"select1-button-select",
			"appearance:web-apps/button-select",
		),
	},
	{
		applies: on("select1"),
		matches: (value) => RECEIVE.test(value),
		claim: rowClaim(
			"select1-receive-topic-field",
			"appearance:web-apps/receive-*",
		),
	},
	{
		applies: on("select"),
		matches: exactly("minimal"),
		claim: rowClaim("select-minimal", "appearance:web-apps/minimal"),
	},
	{
		applies: on("select"),
		matches: (value) => value === "compact" || COMPACT_N.test(value),
		claim: rowClaim("select-compact-compact-n", "appearance:android/compact"),
	},
	{
		applies: on("select"),
		matches: exactly("list"),
		claim: rowClaim("select-list", "appearance:android/list"),
	},
	{
		applies: on("select"),
		matches: exactly("list-nolabel"),
		claim: rowClaim("select-list-nolabel", "appearance:web-apps/list-nolabel"),
	},
	{
		applies: on("select"),
		matches: exactly("label"),
		claim: rowClaim("select-label", "appearance:web-apps/label"),
	},
	{
		applies: on("select"),
		matches: (value) =>
			value.startsWith("combobox") ||
			value === "quick" ||
			value === "button-select",
		claim: rowClaim(
			"select-combobox-quick-button-select",
			"xform:select@appearance",
		),
	},
	{
		applies: on("secret"),
		matches: exactly("numeric"),
		claim: rowClaim("secret-numeric", "appearance:web-apps/numeric"),
	},
	{
		applies: on("text", "secret"),
		matches: exactly("numbers"),
		claim: rowClaim("text-secret-numbers", "appearance:android/numbers"),
	},
	{
		applies: onInput,
		matches: exactly("short"),
		claim: rowClaim("short", "appearance:web-apps/short"),
	},
	{
		applies: onInput,
		matches: exactly("medium"),
		claim: rowClaim("medium", "appearance:web-apps/medium"),
	},
	{
		applies: on("secret"),
		matches: exactly("address"),
		claim: rowClaim("secret-address", "appearance:web-apps/address"),
	},
	{
		applies: on("secret"),
		matches: (value) => RECEIVE.test(value),
		claim: rowClaim(
			"secret-receive-topic-field",
			"appearance:web-apps/receive-*",
		),
	},
	{
		applies: on("text"),
		matches: exactly("address"),
		claim: rowClaim("text-address", "appearance:web-apps/address"),
	},
	{
		applies: on(
			"text",
			"secret",
			"barcode",
			"image",
			"audio",
			"video",
			"document",
		),
		matches: (value) => BROADCAST.test(value),
		claim: rowClaim(
			"broadcast-topic-an-address-entry-under-the-gates-above-and",
			"appearance:web-apps/broadcast-*",
		),
	},
	{
		applies: on("text"),
		matches: (value) => RECEIVE.test(value),
		claim: rowClaim(
			"text-receive-topic-field",
			"appearance:web-apps/receive-*",
		),
	},
	{
		applies: on("barcode"),
		matches: (value) =>
			value === "numeric" || value === "address" || RECEIVE.test(value),
		claim: rowClaim(
			"barcode-numeric-address-or-receive-topic-field",
			"appearance:web-apps/numeric",
		),
	},
	{
		applies: on("barcode"),
		matches: exactly("quick"),
		claim: rowClaim("barcode-quick", "appearance:android/quick"),
	},
	{
		applies: on("barcode"),
		matches: exactly("editable"),
		claim: rowClaim("barcode-editable", "appearance:android/editable"),
	},
	{
		applies: on("text", "int", "decimal", "barcode"),
		matches: exactly("hint-as-placeholder"),
		claim: rowClaim(
			"hint-as-placeholder-on-text-other-than-a-secret-without-numeric",
			"appearance:web-apps/hint-as-placeholder",
		),
	},
	{
		applies: onQuestion,
		matches: exactly("hint-as-placeholder"),
		claim: rowClaim(
			"hint-as-placeholder-on-any-other-entry",
			"appearance:web-apps/hint-as-placeholder",
		),
	},
	{
		applies: on("date"),
		matches: exactly("ethiopian"),
		claim: rowClaim("date-ethiopian", "appearance:web-apps/ethiopian"),
	},
	{
		applies: on("date"),
		matches: exactly("nepali"),
		claim: rowClaim("date-nepali", "appearance:android/nepali"),
	},
	{
		applies: on("date"),
		matches: exactly("gregorian", "gregorian cancel"),
		claim: rowClaim(
			"date-gregorian-gregorian-cancel",
			"appearance:android/gregorian",
		),
	},
	{
		applies: on("time"),
		matches: exactly("12-hour"),
		claim: rowClaim("time-12-hour", "appearance:web-apps/12-hour"),
	},
	{
		applies: on("geopoint"),
		matches: exactly("maps"),
		claim: rowClaim("geopoint-maps", "appearance:android/maps"),
	},
	{
		applies: on("image"),
		matches: exactly("acquire"),
		claim: rowClaim("image-acquire", "appearance:android/acquire"),
	},
	{
		applies: on("image"),
		matches: exactly("overlay-small"),
		claim: rowClaim("image-overlay-small", "appearance:android/overlay-small"),
	},
	{
		applies: on("audio"),
		matches: exactly("legacy"),
		claim: rowClaim("audio-legacy", "appearance:android/legacy"),
	},
	{
		applies: on("audio"),
		matches: exactly("acquire-or-upload"),
		claim: rowClaim(
			"audio-acquire-or-upload",
			"appearance:android/acquire-or-upload",
		),
	},
	{
		applies: on("audio"),
		matches: exactly("long"),
		claim: rowClaim("audio-long", "appearance:android/long"),
	},
	{
		applies: on("audio"),
		matches: exactly("acquire"),
		claim: rowClaim("audio-acquire", "appearance:android/acquire"),
	},
	{
		applies: on("video"),
		matches: exactly("acquire"),
		claim: rowClaim("video-acquire", "appearance:android/acquire"),
	},
	{
		applies: on("trigger"),
		matches: exactly("selectable"),
		claim: rowClaim("trigger-selectable", "appearance:android/selectable"),
	},
	{
		applies: onQuestion,
		matches: exactly(...FLOATING),
		claim: rowClaim(
			"floating-good-floating-caution-floating-bad",
			"appearance:android/floating-good",
		),
	},
	{
		applies: on("trigger"),
		matches: (value) =>
			value.startsWith("floating-") && !PER_ROW.test(value.split(" ")[0] ?? ""),
		claim: rowClaim(
			"a-label-whose-appearance-string-starts-with-floating-other-than",
			"appearance:android/floating-",
		),
	},
	{
		applies: on("group"),
		matches: exactly("compact"),
		claim: rowClaim("group-compact", "appearance:core/compact"),
	},
	{
		applies: on("group"),
		matches: exactly("group-collapse"),
		claim: rowClaim(
			"group-group-collapse",
			"appearance:web-apps/group-collapse",
		),
	},
	{
		applies: on("group"),
		matches: (value) =>
			value.split(/\s+/).includes("group-collapse") &&
			value.split(/\s+/).includes("collapse-open"),
		claim: rowClaim("group-collapse-open", "appearance:web-apps/collapse-open"),
	},
	{
		applies: on("group"),
		matches: exactly("collapse-open"),
		claim: rowClaim(
			"group-collapse-open-without-collapsing",
			"appearance:web-apps/collapse-open",
		),
	},
	{
		applies: on("group"),
		matches: exactly("group-border"),
		claim: rowClaim("group-group-border", "appearance:web-apps/group-border"),
	},
	{
		applies: on("group"),
		matches: exactly("collapse-closed"),
		claim: rowClaim("group-collapse-closed", "xform:group@appearance"),
	},
	{
		applies: (control) =>
			rowControl(control, undefined) === "group" &&
			control.children.some(
				(child) => child.tag === "repeat" || wrapsRepeat(child),
			),
		matches: (value) => N_PER_ROW_REPEAT.test(value),
		claim: rowClaim(
			"n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or",
			"appearance:web-apps/\\d+-per-row-repeat(\\s|$)",
		),
	},
	{
		applies: on("repeat-wrapper"),
		matches: () => true,
		claim: VELLUM_REPEAT,
	},
	{
		applies: (control) =>
			rowControl(control, undefined) === "group" &&
			!control.children.some(
				(child) => child.tag === "repeat" || wrapsRepeat(child),
			),
		matches: (value) => N_PER_ROW_REPEAT.test(value),
		claim: rowClaim(
			"group-repeat-row-without-a-repeat",
			"appearance:web-apps/\\d+-per-row-repeat(\\s|$)",
		),
	},
	{ applies: on("repeat"), matches: () => true, claim: VELLUM_REPEAT },
	{
		applies: (control, bind) =>
			onQuestion(control, bind) || rowControl(control, bind) === "group",
		matches: (value) => N_PER_ROW.test(value),
		claim: rowClaim(
			"n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one",
			"appearance:web-apps/\\d+-per-row(\\s|$)",
		),
	},
	{
		applies: (control, bind) => {
			const at = rowControl(control, bind);
			return (
				QUESTION_CONTROLS.has(at) || at === "group" || at === "repeat-wrapper"
			);
		},
		matches: (value) =>
			singleToken(value) && (PER_ROW.test(value) || PER_ROW_REPEAT.test(value)),
		claim: rowClaim(
			"any-other-per-row-token-the-first-token-web-apps-per-row-pattern",
			"appearance:web-apps/\\d+-per-row(\\s|$)",
		),
	},
	{
		applies: onQuestion,
		matches: exactly("text-align-center", "text-align-right"),
		claim: rowClaim(
			"text-align-center-text-align-right",
			"appearance:web-apps/text-align-center",
		),
	},
	{
		applies: onQuestion,
		matches: exactly("field-list", "compact"),
		claim: rowClaim(
			"field-list-on-any-question-compact-on-a-question-that-is-not-a",
			"xform:input@appearance",
		),
	},
	{
		applies: on("int", "decimal"),
		matches: (value) =>
			singleToken(value) &&
			!readByEveryQuestion(value) &&
			!value.startsWith("intent:"),
		claim: rowClaim(
			"numeric-input-int-decimal-any-other-value-apart-from-the-values",
			"xform:input@appearance",
		),
	},
	{
		applies: on("datetime"),
		matches: (value) =>
			singleToken(value) &&
			!readByEveryQuestion(value) &&
			!value.startsWith("intent:"),
		claim: rowClaim(
			"datetime-any-value-apart-from-the-values-every-question-reads",
			"xform:input@appearance",
		),
	},
	{
		applies: on("document"),
		matches: (value) =>
			singleToken(value) &&
			!readByEveryQuestion(value) &&
			!BROADCAST.test(value),
		claim: rowClaim(
			"document-upload-any-value-except-broadcast-and-the-values-every",
			"xform:upload@appearance",
		),
	},
];

/** A case variant of a value every runtime reads alike, whose row is the control's: a row
 *  whose whole-string test reads the control and the value together. */
const CASE_VARIANT_READ_ALIKE = rowClaim(
	"a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of",
	"appearance:android/numbers",
);

/** The intent row and the three rows rule 4 and the multi-token strings need beside the table. */
const INTENT_ROW_CLAIM = rowClaim(
	"intent-id-on-any-input-other-than-an-intent-typed-one-where-id",
	"appearance:android/intent:",
);
const ANDROID_INSIDE_HELD = rowClaim(
	"a-single-string-no-row-names-that-holds-values-android-matches",
	"appearance:android/compact",
);
const MULTI_TOKEN = rowClaim(
	"multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2",
	"xform:input@appearance",
);
const MULTI_TOKEN_DROPPED = rowClaim(
	"a-multi-token-string-holding-tokens-no-runtime-reads-on-that",
	"xform:input@appearance",
);
const READ_BY_NO_RUNTIME = rowClaim(
	"any-other-value-read-by-no-runtime-not-an-intent-value-on-an",
	"appearance:web-apps/full",
);

/** The refused classes (rule 2), each a function named for its entry. */
const REFUSED = defineClaims("xform-appearance-refused", {
	whitespace: refuse(
		"questions/an-appearance-holding-such-whitespace-that-some-runtime-reads",
		"xform:input@appearance",
	),
	perRowWithoutDigits: refuse(
		"questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does",
		"appearance:web-apps/\\d+-per-row(\\s|$)",
	),
	perRowHoldingRead: refuse(
		"questions/a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts",
		"appearance:web-apps/\\d+-per-row(\\s|$)",
	),
	caseVariant: refuse(
		"questions/a-case-variant-of-numeric-short-or-ethiopian-as-the-whole",
		"appearance:android/numeric",
	),
	intentNamingOrphan: refuse(
		"questions/intent-id-naming-an-odkx-intent-that-no-callout-question-writes",
		"appearance:android/intent:",
	),
	intentNamingNothing: refuse(
		"questions/intent-id-on-any-input-naming-no-odkx-intent-in-the-form",
		"appearance:android/intent:",
	),
	unreadToken: refuse(
		"questions/any-other-multi-token-string-holding-a-token-no-runtime-reads-on",
		"xform:input@appearance",
	),
	androidInsideOther: refuse(
		"questions/any-other-single-string-no-row-names-that-holds-a-value-android",
		"appearance:android/compact",
	),
});

/** Every rule of this file, by its entry: what `appearanceRows.test.ts` holds to the manifest. */
export const APPEARANCE_RULE_ENTRIES: readonly string[] = [
	...APPEARANCE_ROWS.map((row) => row.claim.entry),
	CASE_VARIANT_READ_ALIKE.entry,
	INTENT_ROW_CLAIM.entry,
	ANDROID_INSIDE_HELD.entry,
	MULTI_TOKEN.entry,
	MULTI_TOKEN_DROPPED.entry,
	READ_BY_NO_RUNTIME.entry,
	...Object.values(REFUSED).map((claim) => claim.entry),
];

// ── Rule 2: the refused classes ────────────────────────────────────────────

const rulesOn = (facts: AppearanceFacts) =>
	RULES.filter((rule) => ruleReads(rule, facts));

/** A port of `appearance_whitespace_read_otherwise`. */
function appearanceWhitespaceReadOtherwise(
	value: string,
	facts: AppearanceFacts,
): boolean {
	const spaced = words(value).join(" ");
	if (spaced === value) return false;
	return rulesOn(facts).some(
		(rule) => ruleMatches(value, rule) !== ruleMatches(spaced, rule),
	);
}

/** A port of `appearance_words`: the keys whose reads act on the value, and each word no such read
 *  takes, in order. */
function appearanceWords(
	value: string,
	facts: AppearanceFacts,
): {
	readonly matched: ReadonlySet<string>;
	readonly unread: readonly string[];
} {
	const rules = rulesOn(facts);
	const matched = new Set(
		rules.filter((rule) => ruleMatches(value, rule)).map((rule) => rule.key),
	);
	const split = value.split(" ");
	const unread: string[] = [];
	words(value).forEach((word, index) => {
		const read = rules.some(
			(rule) =>
				matched.has(rule.key) &&
				(ruleMatches(word, rule) ||
					(rule.match === 'word 1 split on " "' &&
						index === 1 &&
						split.length > 1 &&
						ruleMatches(value, rule))),
		);
		if (!read) unread.push(word);
	});
	return { matched, unread };
}

/** The values Android matches inside an appearance, by the widget family that reads them
 *  (`manifest_value_classes.py::ANDROID_INSIDE`). */
const ANDROID_INSIDE: SourceTable<ReadonlySet<string>> = tableOf({
	select1: new Set(["compact", "quick", "-", "combobox", "multiword", "fuzzy"]),
	select: new Set(["compact", "-"]),
	barcode: new Set(["editable"]),
	date: new Set(["gregorian", "cancel"]),
	image: new Set(["acquire", "overlay-small"]),
	audio: new Set(["legacy"]),
});

/** A port of `_android_kind`. */
function androidKind(facts: AppearanceFacts): string | undefined {
	switch (facts.control) {
		case "CONTROL_SELECT_ONE":
			return "select1";
		case "CONTROL_SELECT_MULTI":
			return "select";
		case "CONTROL_IMAGE_CHOOSE":
			return "image";
		case "CONTROL_AUDIO_CAPTURE":
			return "audio";
		case "CONTROL_INPUT":
		case "CONTROL_SECRET":
			return facts.datatype === "DATATYPE_BARCODE"
				? "barcode"
				: facts.datatype === "DATATYPE_DATE"
					? "date"
					: undefined;
		default:
			return undefined;
	}
}

/** The tokens of Android's inside matches that act on a value on these facts. */
function androidInside(value: string, facts: AppearanceFacts): Set<string> {
	return new Set(
		rulesOn(facts)
			.filter(
				(rule) =>
					rule.reader === "android" &&
					(rule.match === "contains" || rule.match === "index") &&
					ruleMatches(value, rule),
			)
			.map((rule) => rule.token),
	);
}

/** A port of `android_inside_match_other`: true in the class, false outside it, undefined where
 *  the export alone does not settle it. */
function androidInsideMatchOther(
	value: string,
	facts: AppearanceFacts,
): boolean | undefined {
	if (words(value).length !== 1 || value !== value.trim()) return false;
	const inside = androidInside(value, facts);
	if (inside.size === 0) return false;
	const kind = androidKind(facts);
	if (kind === undefined) return undefined;
	const known = ANDROID_INSIDE.get(kind) ?? new Set<string>();
	if ([...inside].some((token) => !known.has(token))) return undefined;
	if (kind === "select1") {
		if (
			!value.includes("compact") &&
			value !== "minimal" &&
			value.includes("combobox")
		)
			return value !== "combobox";
		for (const token of ["combobox", "multiword", "fuzzy"])
			inside.delete(token);
	}
	const webApps = new Set(
		RULES.filter((rule) => rule.reader === "web-apps").map(
			(rule) => rule.token,
		),
	);
	return [...inside].some((token) => webApps.has(token)) ? undefined : false;
}

/** The first token a per-row pattern matches, on a group wrapping a repeat the per-row-repeat
 *  pattern's where the token's text before its first `-` ends in a digit. */
function perRowToken(value: string, wrapper: boolean): string | undefined {
	const tokens = value.split(" ");
	if (wrapper)
		return tokens.find((token) => {
			if (!PER_ROW_REPEAT.test(token)) return false;
			const head = token.slice(0, token.indexOf("-"));
			return /\d$/.test(head);
		});
	return tokens.find((token) => PER_ROW.test(token));
}

/** `a-per-row-token-…-does`: the per-row token's text before its first `-` does not start,
 *  after at most one `+`, with a digit (`x2-per-row`, `floating-2-per-row`). */
function perRowWithoutLeadingDigits(
	value: string,
	control: RowControl,
): boolean {
	if (control === "repeat") return false;
	const token = perRowToken(value, control === "repeat-wrapper");
	if (token === undefined) return false;
	return !/^\+?\d/.test(token.slice(0, token.indexOf("-")));
}

/** The controls whose receive or broadcast row Web Apps reads. */
const RECEIVE_CONTROLS: ReadonlySet<RowControl> = new Set([
	"select1",
	"text",
	"barcode",
]);
const BROADCAST_CONTROLS: ReadonlySet<RowControl> = new Set([
	"text",
	"image",
	"audio",
	"video",
	"document",
]);

/** `a-per-row-token-…-starts`: a per-row token with leading digits that itself holds `receive`
 *  or `broadcast` where its row is read, or a value Android matches inside it, so holding it as
 *  `<k>-per-row` (or `<k>-per-row-repeat`) would drop that read. The row speaks of the token: a
 *  separate `receive-…` or `broadcast-…` word, or a value Android matches in another word, stays
 *  its own row's, and a token already spelled `<k>-per-row` drops nothing. */
function perRowHoldingAnotherReadValue(
	value: string,
	control: RowControl,
	facts: AppearanceFacts,
): boolean {
	if (control === "repeat") return false;
	const token = perRowToken(value, control === "repeat-wrapper");
	if (token === undefined) return false;
	const digits = /^\+?(\d+)/.exec(token.slice(0, token.indexOf("-")))?.[1];
	if (digits === undefined) return false;
	const held = `${digits}${control === "repeat-wrapper" ? "-per-row-repeat" : "-per-row"}`;
	if (token === held) return false;
	if (RECEIVE_CONTROLS.has(control) && token.includes("receive")) return true;
	if (BROADCAST_CONTROLS.has(control) && token.includes("broadcast"))
		return true;
	const kept = androidInside(held, facts);
	return [...androidInside(token, facts)].some((one) => !kept.has(one));
}

/** The lowercase values whose case variant two runtimes read differently, with the controls whose
 *  row names each. */
const CASE_VARIANT_REFUSED: SourceTable<ReadonlySet<RowControl>> = tableOf({
	numeric: new Set(["text", "secret", "barcode"]),
	short: new Set([...INPUTS, "secret"]),
	ethiopian: new Set(["date"]),
});
/** The lowercase values whose case variant every runtime reads alike, with their controls. */
const CASE_VARIANT_ALIKE: SourceTable<ReadonlySet<RowControl>> = tableOf({
	numbers: new Set(["text", "secret"]),
	nepali: new Set(["date"]),
	maps: new Set(["geopoint"]),
	acquire: new Set(["video"]),
	compact: new Set(["group"]),
});

function caseVariantOf(
	value: string,
	control: RowControl,
	table: SourceTable<ReadonlySet<RowControl>>,
): boolean {
	const lowered = value.toLowerCase();
	return lowered !== value && (table.get(lowered)?.has(control) ?? false);
}

/** The intents of a form an `intent:<id>` appearance is read against. */
export interface AppearanceForm {
	/** Every `odkx:intent` id the head holds. */
	readonly intents: ReadonlySet<string>;
	/** The ids a callout question (an input typed `intent`) writes as its own appearance. */
	readonly callouts: ReadonlySet<string>;
}

const NO_INTENTS: AppearanceForm = { intents: new Set(), callouts: new Set() };

// ── Rules 1, 3 and 4 ──────────────────────────────────────────────────────

/** Whether a whole string is the control's kind's own token (rule 1). */
function heldToken(
	control: ControlNode,
	bind: BindFacts | undefined,
	value: string,
): boolean {
	const at = rowControl(control, bind);
	switch (at) {
		case "trigger":
			return value === kindAppearanceToken("label");
		case "image":
			return (
				value === kindAppearanceToken("signature") ||
				value === FIELD_DISPLAY_SETTING_TOKENS.captureSource["face-camera"]
			);
		case "group":
			return isFieldListAppearance(value);
		case "text":
			return (
				bind?.type !== undefined &&
				stripXsd(bind.type) === written("text") &&
				value === FIELD_DISPLAY_SETTING_TOKENS.keypad.numbers
			);
		default:
			return false;
	}
}

/** The row that names a whole string on this control, without the multi-token rows. */
function rowFor(
	control: ControlNode,
	bind: BindFacts | undefined,
	value: string,
	form: AppearanceForm,
): Claim<"account" | "take"> | undefined {
	const at = rowControl(control, bind);
	if (caseVariantOf(value, at, CASE_VARIANT_ALIKE))
		return CASE_VARIANT_READ_ALIKE;
	if (
		INPUTS.has(at) &&
		at !== "intent" &&
		value.startsWith("intent:") &&
		form.callouts.has(value.slice("intent:".length))
	)
		return INTENT_ROW_CLAIM;
	for (const row of APPEARANCE_ROWS)
		if (row.applies(control, bind) && row.matches(value)) return row.claim;
	return undefined;
}

export type AppearanceVerdict =
	/** Rule 1: the kind's own token, which the kind table's row claims. */
	| { readonly kind: "held" }
	/** Rules 2 to 4. */
	| {
			readonly kind: "claim";
			readonly claim: Claim<"account" | "take" | "refuse">;
	  }
	/** Rule 5: left unclaimed. */
	| { readonly kind: "unclaimed" };

/** A string of several words each a held token or one a row names alone, with none refused. */
function everyTokenRead(
	control: ControlNode,
	bind: BindFacts | undefined,
	tokens: readonly string[],
	form: AppearanceForm,
): boolean {
	return tokens.every((token) => {
		if (heldToken(control, bind, token)) return true;
		const verdict = classifyOne(control, bind, token, form);
		return (
			verdict.kind === "claim" &&
			verdict.claim.use !== "refuse" &&
			!isInertCatchAll(verdict.claim)
		);
	});
}

/** The rows that take a value only because no runtime reads it. */
function isInertCatchAll(claim: Claim): boolean {
	return (
		claim === READ_BY_NO_RUNTIME ||
		claim.entry ===
			"questions/numeric-input-int-decimal-any-other-value-apart-from-the-values" ||
		claim.entry ===
			"questions/datetime-any-value-apart-from-the-values-every-question-reads" ||
		claim.entry ===
			"questions/document-upload-any-value-except-broadcast-and-the-values-every"
	);
}

/** Whether dropping a string's unread words leaves every runtime's reading the same: the rest is
 *  a string a row names, no whole-string read takes it, no dropped word holds a value Android
 *  matches inside the string, and the second word, which Web Apps reads by position, stays. */
function droppingKeepsReading(
	control: ControlNode,
	bind: BindFacts | undefined,
	value: string,
	unread: readonly string[],
	facts: AppearanceFacts,
	form: AppearanceForm,
): boolean {
	const rest = words(value).filter((word) => !unread.includes(word));
	if (rest.length === 0) return false;
	const restText = rest.join(" ");
	const rules = rulesOn(facts);
	if (
		rules.some((rule) => rule.match === "whole" && ruleMatches(restText, rule))
	)
		return false;
	if (unread.some((word) => androidInside(word, facts).size > 0)) return false;
	if (
		rules.some((rule) => rule.match === 'word 1 split on " "') &&
		value.split(" ")[1] !== restText.split(" ")[1]
	)
		return false;
	if (heldToken(control, bind, restText)) return true;
	const verdict = classifyOne(control, bind, restText, form);
	return verdict.kind === "claim" && verdict.claim.use !== "refuse";
}

/** Rules 2 to 5, for a string that is not the kind's own token. */
function classifyOne(
	control: ControlNode,
	bind: BindFacts | undefined,
	value: string,
	form: AppearanceForm,
): AppearanceVerdict {
	const at = rowControl(control, bind);
	const facts = appearanceFacts(control, bind);
	const claim = (
		one: Claim<"account" | "take" | "refuse">,
	): AppearanceVerdict => ({
		kind: "claim",
		claim: one,
	});
	// Core collapses the Vellum wrapping group into the repeat and transfers
	// its label, never the group's appearance. Formplayer emits no style on
	// the repeat itself. Neither can supply a per-repeat width to the parent.
	if (at === "repeat" || at === "repeat-wrapper") return claim(VELLUM_REPEAT);
	// Rule 2, the refused classes.
	if (appearanceWhitespaceReadOtherwise(value, facts))
		return claim(REFUSED.whitespace);
	if (perRowWithoutLeadingDigits(value, at))
		return claim(REFUSED.perRowWithoutDigits);
	if (perRowHoldingAnotherReadValue(value, at, facts))
		return claim(REFUSED.perRowHoldingRead);
	if (caseVariantOf(value, at, CASE_VARIANT_REFUSED))
		return claim(REFUSED.caseVariant);
	if (INPUTS.has(at) && value.startsWith("intent:")) {
		const id = value.slice("intent:".length);
		if (!form.intents.has(id)) return claim(REFUSED.intentNamingNothing);
		if (!form.callouts.has(id)) return claim(REFUSED.intentNamingOrphan);
	}
	const tokens = words(value);
	if (
		tokens.length > 1 &&
		!(at === "trigger" && value.startsWith("floating-"))
	) {
		const { unread } = appearanceWords(value, facts);
		if (unread.length > 0)
			return droppingKeepsReading(control, bind, value, unread, facts, form)
				? claim(MULTI_TOKEN_DROPPED)
				: claim(REFUSED.unreadToken);
	}
	const inside = androidInsideMatchOther(value, facts);
	if (inside === true) return claim(REFUSED.androidInsideOther);
	// Rule 3, the rows.
	const row = rowFor(control, bind, value, form);
	if (row !== undefined) return claim(row);
	if (
		inside === false &&
		tokens.length === 1 &&
		androidInside(value, facts).size > 0
	)
		return claim(ANDROID_INSIDE_HELD);
	if (tokens.length > 1 && everyTokenRead(control, bind, tokens, form))
		return claim(MULTI_TOKEN);
	// Rule 4, read by no runtime.
	if (
		appearanceReads(value, facts).length === 0 &&
		!(INPUTS.has(at) && value.startsWith("intent:"))
	)
		return claim(READ_BY_NO_RUNTIME);
	return { kind: "unclaimed" };
}

/** Classifies a control's appearance by the first rule that applies. `form` gives the
 *  intents an `intent:<id>` value is read against; absent, the form holds none. */
export function classifyAppearance(
	control: ControlNode,
	bind: BindFacts | undefined,
	value: string,
	form: AppearanceForm = NO_INTENTS,
): AppearanceVerdict {
	if (heldToken(control, bind, value)) return { kind: "held" };
	return classifyOne(control, bind, value, form);
}

/** The rows that leave a trigger a label: Android's `TriggerWidget` draws no acknowledge for
 *  exactly `selectable`, and hides every widget whose appearance starts `floating-`. */
const TRIGGER_LABEL_ENTRIES: ReadonlySet<string> = new Set([
	"questions/trigger-selectable",
	"questions/floating-good-floating-caution-floating-bad",
	"questions/a-label-whose-appearance-string-starts-with-floating-other-than",
]);

/**
 * Whether a trigger whose appearance is not exactly `minimal` stays a label: its verdict is
 * the `selectable` row or a floating row, or a per-row refusal of a string starting `floating-`,
 * which the per-row rows take from the floating row. Any other string is an acknowledge on
 * Android, which draws a checkbox for every appearance but exactly `minimal` or `selectable`
 * (`TriggerWidget`).
 */
export function triggerStaysLabel(
	verdict: AppearanceVerdict,
	value: string,
): boolean {
	if (verdict.kind !== "claim") return false;
	if (TRIGGER_LABEL_ENTRIES.has(verdict.claim.entry)) return true;
	return (
		value.startsWith("floating-") &&
		(verdict.claim === REFUSED.perRowWithoutDigits ||
			verdict.claim === REFUSED.perRowHoldingRead)
	);
}

/** The refusal of an `intent:<id>` naming an `odkx:intent` no callout question writes, which
 *  the head's `odkx:intent` it names is refused under too. */
export const INTENT_NAMING_ORPHAN: Claim<"refuse"> = REFUSED.intentNamingOrphan;

/** Whether a claim's entry is one whose standing is `inert`: the appearances a first publish
 *  drops, which acceptance cuts from CommCare HQ's side. */
export function isInertAppearanceClaim(claim: Claim): boolean {
	return inventoryIndex().entry(claim.entry)?.standing === "inert";
}

/**
 * Applies a verdict's claim to a control's `appearance` attribute, its finding carrying the string
 * as written. A value no rule takes (rule 5) is `unrecognized` under that string, never under the
 * attribute's surface key, and the attribute stands behind that one finding. Answers whether the
 * claim's entry is inert, which `ReadFormFacts.inertAppearances` lists, and whether the settings
 * it takes are written back in another spelling, which `ReadFormFacts.respelledAppearances` lists.
 */
export function claimAppearance(
	cursor: XmlCursor,
	accounting: Accounting,
	control: ControlNode,
	verdict: AppearanceVerdict,
	place: HqPlace,
	field?: { kind: FieldKind; field: Record<string, unknown> },
): { readonly inert: boolean; readonly respelled: boolean } {
	const value = control.appearance;
	if (value === undefined || verdict.kind === "held")
		return { inert: false, respelled: false };
	const node = { element: control.element, attribute: "appearance" };
	if (verdict.kind === "unclaimed") {
		const detail = { name: value };
		accounting.circumstance("unrecognized", place, detail);
		accounting.cover(node, circumstanceFinding("unrecognized", place, detail));
		return { inert: false, respelled: false };
	}
	const claim = verdict.claim;
	let respelled = false;
	if (isUse(claim, "take")) {
		const askForConfirmation = field?.field.askForConfirmation === true;
		const next =
			field &&
			readFieldAppearance(
				field.kind,
				value,
				control.children.some(
					(child) => child.tag === "repeat" || wrapsRepeat(child),
				),
				askForConfirmation,
			);
		/* A reading that writes nothing back took no setting from the value
		 * (a lone `broadcast-…` on a text question with no address search,
		 * which no entry sends from), so the value stands unrecognized rather
		 * than vanish from the question. */
		const written =
			next &&
			field &&
			writeFieldAppearance(field.kind, { ...next, askForConfirmation });
		if (!next || !field || written === undefined) {
			const detail = { name: value };
			accounting.circumstance("unrecognized", place, detail);
			accounting.cover(
				node,
				circumstanceFinding("unrecognized", place, detail),
			);
		} else {
			Object.assign(field.field, next);
			cursor.take(node, claim).value;
			respelled = written !== value;
		}
	} else if (isUse(claim, "refuse"))
		cursor.refuse(node, claim, place, { name: value });
	else if (isUse(claim, "account"))
		cursor.account(node, claim, place, { name: value });
	return { inert: isInertAppearanceClaim(claim), respelled };
}

function isUse<U extends Claim["use"]>(
	claim: Claim,
	use: U,
): claim is Claim<U> {
	return claim.use === use;
}
