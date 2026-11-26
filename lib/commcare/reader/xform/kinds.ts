/**
 * The kind of a question read from a form's source: one table over its
 * control, its bind's type, an upload's media type, its appearance and
 * whether it holds a value of its own. Every cell is read from the table the
 * emitter writes with: a kind's bind type from `xform/bindType.ts`, an
 * upload's media type and appearance from `xform/captureUpload.ts`, the
 * kind's own appearance token and the Phone Number keypad from
 * `xform/appearance.ts`. A bind's type is compared after one leading `xsd:`
 * is removed, exactly and with its case, as Core reads it
 * (`XFormParser.getDataType`); Vellum lower-cases first, which is why a case
 * variant is a refusal.
 */

import type { FieldKind } from "@/lib/domain";
import {
	FIELD_DISPLAY_SETTING_TOKENS,
	kindAppearanceToken,
} from "../../xform/appearance";
import { fieldKindBindType } from "../../xform/bindType";
import {
	UPLOAD_APPEARANCE_BY_CAPTURE_KIND,
	UPLOAD_MEDIATYPE_BY_CAPTURE_KIND,
	UPLOAD_MEDIATYPES,
} from "../../xform/captureUpload";
import type { Claim } from "../claims";
import { type KindSites, X } from "./claims";

export interface FieldKindFacts {
	readonly control:
		| "input"
		| "secret"
		| "select1"
		| "select"
		| "trigger"
		| "upload"
		| "none";
	/** The bind's type with one leading `xsd:` removed; undefined where it has none. */
	readonly bindType: string | undefined;
	readonly mediaType: string | undefined;
	readonly appearance: string | undefined;
	readonly hasCalculate: boolean;
	readonly hasDefault: boolean;
	/** Whether the node stands in a repeat. */
	readonly inRepeat: boolean;
}

export interface FieldKindRow {
	/** Whether the row takes these facts: the cells of the table, as a predicate. */
	readonly matches: (facts: FieldKindFacts) => boolean;
	/** The kind the row gives; undefined for a row that refuses. */
	readonly kind: FieldKind | undefined;
	/** Slots the row sets beside the kind (`keypad: "numbers"`). */
	readonly slots?: Readonly<Record<string, unknown>>;
	/** The row's claim, made at the question's data node. A refusing row's claim also covers the
	 *  question's control and its bind's `type`. */
	readonly claim: Claim<"take" | "refuse">;
	/** The claim on the bind's `type` where the manifest holds it apart (a select's, an upload's,
	 *  a Hidden Value's date and time). */
	readonly typeClaim?: Claim<"take">;
	/** The claims on the question's other sites, under the row's entry. Absent on a refusing row. */
	readonly sites?: KindSites;
}

/** A bind type as the emitter writes it for a kind, with one leading `xsd:` removed. */
function writtenType(kind: FieldKind): string {
	const type = fieldKindBindType(kind);
	if (type === null)
		throw new Error(
			`The emitter writes no bind type for the kind "${kind}", so the reader has no type to read it by. Read that kind by its control alone.`,
		);
	return stripXsd(type);
}

/** One leading `xsd:` removed, as the kind table compares a bind's type. */
export function stripXsd(type: string): string {
	return type.startsWith("xsd:") ? type.slice("xsd:".length) : type;
}

const STRING = writtenType("text");
const DATETIME = writtenType("datetime");
const BINARY = writtenType("image");
/** Core reads `integer` as it reads `int` (`XFormParser.typeMappings`), and Vellum's integer
 *  adaptor takes both. */
const INTEGER_TYPES = new Set([writtenType("int"), "integer"]);
/** The numeric types Vellum's Secret never writes. */
const NUMERIC_TYPES = new Set([
	...INTEGER_TYPES,
	"long",
	writtenType("decimal"),
]);
/** `numeric` or `numbers` as the whole appearance, in any letter case: what Android reads as a
 *  number pad on an input with no type. */
function numericAppearance(appearance: string | undefined): boolean {
	const lowered = appearance?.toLowerCase();
	return lowered === "numeric" || lowered === "numbers";
}

const PHONE_TOKEN = FIELD_DISPLAY_SETTING_TOKENS.keypad.numbers;
const LABEL_TOKEN = kindAppearanceToken("label");
const SIGNATURE_TOKEN = UPLOAD_APPEARANCE_BY_CAPTURE_KIND.signature;
const FACE_TOKEN = FIELD_DISPLAY_SETTING_TOKENS.captureSource["face-camera"];

function takeRow(
	sites: KindSites,
	kind: FieldKind,
	matches: (facts: FieldKindFacts) => boolean,
	extra: Pick<FieldKindRow, "slots" | "typeClaim"> = {},
): FieldKindRow {
	return { matches, kind, claim: sites.node, sites, ...extra };
}

function refuseRow(
	claim: Claim<"refuse">,
	matches: (facts: FieldKindFacts) => boolean,
): FieldKindRow {
	return { matches, kind: undefined, claim };
}

const input = (facts: FieldKindFacts) => facts.control === "input";
const typed =
	(...types: string[]) =>
	(facts: FieldKindFacts) =>
		facts.bindType !== undefined && types.includes(facts.bindType);
const upload = (kind: "image" | "audio" | "video" | "file" | "signature") =>
	UPLOAD_MEDIATYPE_BY_CAPTURE_KIND[kind];

/** A Hidden Value's three cells of one line, by the value sources it holds. */
function hiddenRows(
	types: (facts: FieldKindFacts) => boolean,
	typeClaim: Claim<"take"> | undefined,
): FieldKindRow[] {
	const extra = typeClaim === undefined ? {} : { typeClaim };
	const none = (facts: FieldKindFacts) =>
		facts.control === "none" && types(facts);
	return [
		takeRow(
			X.kind.hiddenOneSource,
			"hidden",
			(facts) => none(facts) && facts.hasCalculate !== facts.hasDefault,
			extra,
		),
		takeRow(
			X.kind.hiddenNeither,
			"hidden",
			(facts) => none(facts) && !facts.hasCalculate && !facts.hasDefault,
			extra,
		),
		// A source outside a repeat is classified after its consumers bind.
		takeRow(
			X.kind.hiddenBothUnread,
			"hidden",
			(facts) =>
				none(facts) &&
				facts.hasCalculate &&
				facts.hasDefault &&
				!facts.inRepeat,
			extra,
		),
		takeRow(
			X.kind.hiddenBothObserved,
			"hidden",
			(facts) =>
				none(facts) && facts.hasCalculate && facts.hasDefault && facts.inRepeat,
			extra,
		),
	];
}

export const FIELD_KIND_ROWS: readonly FieldKindRow[] = [
	// input
	takeRow(
		X.kind.text,
		"text",
		(facts) =>
			input(facts) &&
			facts.bindType === STRING &&
			facts.appearance !== PHONE_TOKEN,
	),
	takeRow(
		X.kind.phone,
		"text",
		(facts) =>
			input(facts) &&
			facts.bindType === STRING &&
			facts.appearance === PHONE_TOKEN,
		{ slots: { keypad: "numbers" } },
	),
	takeRow(
		X.kind.untypedText,
		"text",
		(facts) =>
			input(facts) &&
			facts.bindType === undefined &&
			!numericAppearance(facts.appearance),
	),
	refuseRow(
		X.refusedKind.untypedTextNumeric,
		(facts) =>
			input(facts) &&
			facts.bindType === undefined &&
			numericAppearance(facts.appearance),
	),
	takeRow(
		X.kind.int,
		"int",
		(facts) => input(facts) && typed(...INTEGER_TYPES)(facts),
	),
	takeRow(
		X.kind.decimal,
		"decimal",
		(facts) => input(facts) && typed(writtenType("decimal"))(facts),
	),
	takeRow(
		X.kind.date,
		"date",
		(facts) => input(facts) && typed(writtenType("date"))(facts),
	),
	takeRow(
		X.kind.time,
		"time",
		(facts) => input(facts) && typed(writtenType("time"))(facts),
	),
	takeRow(
		X.kind.datetime,
		"datetime",
		(facts) => input(facts) && typed(DATETIME)(facts),
	),
	takeRow(
		X.kind.geopoint,
		"geopoint",
		(facts) => input(facts) && typed(writtenType("geopoint"))(facts),
	),
	takeRow(
		X.kind.barcode,
		"barcode",
		(facts) => input(facts) && typed(writtenType("barcode"))(facts),
	),
	refuseRow(
		X.refusedKind.long,
		(facts) => input(facts) && typed("long")(facts),
	),
	takeRow(
		X.kind.androidApp,
		"text",
		(facts) => input(facts) && typed("intent")(facts),
	),
	refuseRow(
		X.refusedKind.inputOtherType,
		(facts) => input(facts) && facts.bindType !== undefined,
	),
	// secret
	takeRow(
		X.kind.secret,
		"secret",
		(facts) => facts.control === "secret" && facts.bindType === STRING,
	),
	takeRow(
		X.kind.untypedSecret,
		"secret",
		(facts) =>
			facts.control === "secret" &&
			facts.bindType === undefined &&
			!numericAppearance(facts.appearance),
	),
	refuseRow(
		X.refusedKind.untypedSecretNumeric,
		(facts) =>
			facts.control === "secret" &&
			facts.bindType === undefined &&
			numericAppearance(facts.appearance),
	),
	refuseRow(
		X.refusedKind.secretNumericType,
		(facts) =>
			facts.control === "secret" &&
			facts.bindType !== undefined &&
			NUMERIC_TYPES.has(facts.bindType),
	),
	// selects
	takeRow(
		X.kind.singleSelect,
		"single_select",
		(facts) =>
			facts.control === "select1" &&
			(facts.bindType === undefined ||
				[STRING, "listItem", "select1"].includes(facts.bindType)),
		{ typeClaim: X.selectType },
	),
	takeRow(
		X.kind.multiSelect,
		"multi_select",
		(facts) =>
			facts.control === "select" &&
			(facts.bindType === undefined ||
				[STRING, "listItems", "select"].includes(facts.bindType)),
		{ typeClaim: X.selectType },
	),
	refuseRow(
		X.refusedKind.contradictingChoiceType,
		(facts) =>
			(facts.control === "select1" && typed("listItems", "select")(facts)) ||
			(facts.control === "select" && typed("listItem", "select1")(facts)),
	),
	refuseRow(
		X.refusedKind.selectOtherType,
		(facts) =>
			(facts.control === "select" || facts.control === "select1") &&
			facts.bindType !== undefined,
	),
	// trigger
	takeRow(
		X.kind.label,
		"label",
		(facts) => facts.control === "trigger" && facts.appearance === LABEL_TOKEN,
	),
	takeRow(X.kind.acknowledge, "label", (facts) => facts.control === "trigger", {
		slots: { askForConfirmation: true },
	}),
	// upload
	takeRow(
		X.kind.image,
		"image",
		(facts) =>
			facts.control === "upload" &&
			facts.bindType === BINARY &&
			facts.mediaType === upload("image") &&
			facts.appearance !== SIGNATURE_TOKEN &&
			facts.appearance !== FACE_TOKEN,
		{ typeClaim: X.binaryType },
	),
	takeRow(
		X.kind.signature,
		"signature",
		(facts) =>
			facts.control === "upload" &&
			facts.bindType === BINARY &&
			facts.mediaType === upload("signature") &&
			facts.appearance === SIGNATURE_TOKEN,
		{ typeClaim: X.binaryType },
	),
	takeRow(
		X.kind.face,
		"image",
		(facts) =>
			facts.control === "upload" &&
			facts.bindType === BINARY &&
			facts.mediaType === upload("image") &&
			facts.appearance === FACE_TOKEN,
		{ slots: { captureSource: "face-camera" }, typeClaim: X.binaryType },
	),
	takeRow(
		X.kind.audio,
		"audio",
		(facts) =>
			facts.control === "upload" &&
			facts.bindType === BINARY &&
			facts.mediaType === upload("audio"),
		{ typeClaim: X.binaryType },
	),
	takeRow(
		X.kind.video,
		"video",
		(facts) =>
			facts.control === "upload" &&
			facts.bindType === BINARY &&
			facts.mediaType === upload("video"),
		{ typeClaim: X.binaryType },
	),
	takeRow(
		X.kind.file,
		"file",
		(facts) =>
			facts.control === "upload" &&
			facts.bindType === BINARY &&
			facts.mediaType === upload("file"),
		{ typeClaim: X.binaryType },
	),
	refuseRow(
		X.refusedKind.uploadOther,
		(facts) =>
			facts.control === "upload" &&
			(facts.mediaType === undefined ||
				!(UPLOAD_MEDIATYPES as readonly string[]).includes(facts.mediaType)),
	),
	// no control: a Hidden Value
	...hiddenRows(
		(facts) => facts.bindType === undefined || facts.bindType === STRING,
		undefined,
	),
	...hiddenRows(typed(DATETIME), X.hiddenDatetimeType),
	...hiddenRows(
		(facts) =>
			facts.bindType !== undefined &&
			facts.bindType !== STRING &&
			facts.bindType !== DATETIME,
		X.hiddenTypedAnswer,
	),
];

/** The first row that matches; undefined for the one shape the table leaves unclaimed, an upload
 *  of one of the four media types whose bind is not `binary`. */
export function fieldKindOf(facts: FieldKindFacts): FieldKindRow | undefined {
	return FIELD_KIND_ROWS.find((row) => row.matches(facts));
}
