import type { CaseType } from "@/lib/domain/blueprint";
import type { Field, FieldKind } from "@/lib/domain/fields";
import { fieldValueType } from "@/lib/domain/fieldValueType";

/**
 * XForm `<bind>` `type` attribute per domain `FieldKind`.
 *
 * This value is load-bearing for how an uploaded app reads back in
 * CommCare HQ: HQ infers each question's editor type from the
 * `(control-tag, bind-type, media-type, appearance)` tuple
 * (`commcare-hq/corehq/apps/app_manager/xform.py::_infer_vellum_type`
 * against the `VELLUM_TYPES` table). So the bind type is not just
 * "how the runtime parses the value" — it decides whether HQ shows a
 * GPS-capture widget or a plain text box. A geopoint emitted with the
 * wrong type uploads as a Text question.
 *
 * Most kinds carry an `xsd:*` type, but three groups carry the bare
 * ODK type HQ's table keys on — these are NOT XSD types
 * (`commcare-hq/corehq/apps/app_manager/xform_builder.py::ODK_TYPES`
 * lists them outside `XSD_TYPES`):
 *   - `geopoint` → `geopoint` (HQ `Geopoint`: `input` + `geopoint`).
 *   - `barcode`  → `barcode`  (HQ `Barcode`:  `input` + `barcode`).
 *   - the capture kinds (`image`/`audio`/`video`/`signature`/`file`) →
 *     `binary`, which is what HQ's `<upload>` types
 *     (`Image`/`Audio`/`Video`/`Document`) key on; an `xsd:string`
 *     upload matches no row and HQ fails to classify it.
 *
 * Decide the bind type here, independently of
 * `fieldRegistry[kind].dataType` — a separate descriptor serving a
 * different purpose. Their values coincide for most kinds but not all
 * (e.g. `barcode`'s registry dataType is `xsd:string` while its bind
 * type is `barcode`), so don't derive one from the other.
 *
 * Structural kinds (`group`, `repeat`, `label`) get no `type` — HQ
 * treats them as grouping nodes. Selects rely on their `<select1>` /
 * `<select>` tag for classification, so their `xsd:string` type is
 * inert (HQ's table has no typed select row to mis-match against).
 *
 * Declaring this as satisfying `Record<FieldKind, ...>` keyed off the domain
 * tuple makes TypeScript a gate on adding a new kind: a missing entry
 * here fails `tsc`, so the compile pipeline cannot silently emit an
 * XForm without a decided bind type for a new kind.
 */
const BIND_TYPE_BY_KIND = {
	text: "xsd:string",
	int: "xsd:int",
	decimal: "xsd:double",
	date: "xsd:date",
	time: "xsd:time",
	datetime: "xsd:dateTime",
	geopoint: "geopoint",
	barcode: "barcode",
	image: "binary",
	audio: "binary",
	video: "binary",
	file: "binary",
	signature: "binary",
	hidden: "xsd:string",
	secret: "xsd:string",
	single_select: "xsd:string",
	multi_select: "xsd:string",
	label: null,
	group: null,
	repeat: null,
	section: null,
} as const satisfies Record<FieldKind, string | null>;

/** Every `type` a field's bind can carry. */
export type FieldBindType = NonNullable<(typeof BIND_TYPE_BY_KIND)[FieldKind]>;

/**
 * The `type` attribute of a field's `<bind>`, or `null` for a field with
 * none. A field binds by its kind, except that a field whose value type is
 * date and time (`fieldValueType`: a datetime question, a Hidden Value
 * writing a date-and-time property, or a Hidden Value that writes nothing
 * calculated by the clock-keeping date) binds `xsd:dateTime`. A Hidden Value
 * writing a property of any other type keeps `xsd:string`, even one
 * calculated by the clock-keeping date: the bind follows the property.
 *
 * The XForm emitter and Preview's setvalue casts both read this one rule,
 * so they agree on which questions are typed.
 */
export function fieldBindType(
	field: Field,
	caseTypes: readonly CaseType[],
): FieldBindType | null {
	return fieldValueType(field, caseTypes) === "datetime"
		? "xsd:dateTime"
		: BIND_TYPE_BY_KIND[field.kind];
}

/** The bind type of a field kind, before a Hidden Value's destination is
 * read: what `fieldBindType` gives a field with no case catalog. */
export function fieldKindBindType(kind: FieldKind): FieldBindType | null {
	return BIND_TYPE_BY_KIND[kind];
}
