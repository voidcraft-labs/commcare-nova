/**
 * The type CommCare HQ's question reader gives a question with a control
 * (`corehq/apps/app_manager/xform.py::_infer_vellum_type`, which
 * `XForm.get_questions` calls for every control): `VELLUM_TYPE_INDEX`, the
 * index `_index_on_fields` builds of `VELLUM_TYPES` on the control's tag, its
 * bind's `type` as written, an upload's `mediatype` and the control's
 * `appearance`, in that order, each compared exactly. A value the index does
 * not hold at a field reads the types that name no value there, so a group
 * whose appearance is `Field-List` is a Group and an upload whose appearance
 * is `signature` is an Image (`VELLUM_TYPES` holds no Signature). The type is
 * what the lane's question reading records as `mug:<type>`; null where the
 * index gives no single type, which HQ logs and reads as none.
 */

/** The fields `VELLUM_TYPE_INDEX` is built on, in its order. */
const FIELDS = ["tag", "type", "media", "appearance"] as const;
type Field = (typeof FIELDS)[number];

/** One row of `VELLUM_TYPES`: each field's value, a list where HQ holds a tuple, and null standing for
 *  Python's `None` inside one. A field the row leaves out names no value. */
interface VellumType {
	readonly name: string;
	readonly tag?: string;
	readonly type?: string | readonly (string | null)[];
	readonly media?: string;
	readonly appearance?: string;
}

/** `xform.py::VELLUM_TYPES` at the pin, the four indexed fields of each row. */
const VELLUM_TYPES: readonly VellumType[] = [
	{ name: "AndroidIntent", tag: "input", type: "intent" },
	{ name: "Audio", tag: "upload", media: "audio/*", type: "binary" },
	{ name: "Barcode", tag: "input", type: "barcode" },
	{ name: "DataBindOnly" },
	{ name: "Date", tag: "input", type: "xsd:date" },
	{ name: "DateTime", tag: "input", type: "xsd:dateTime" },
	{ name: "Double", tag: "input", type: "xsd:double" },
	{
		name: "Document",
		tag: "upload",
		media: "application/*,text/*",
		type: "binary",
	},
	{ name: "FieldList", tag: "group", appearance: "field-list" },
	{ name: "Geopoint", tag: "input", type: "geopoint" },
	{ name: "Group", tag: "group" },
	{ name: "Image", tag: "upload", media: "image/*", type: "binary" },
	{ name: "Int", tag: "input", type: ["xsd:int", "xsd:integer"] },
	{ name: "Long", tag: "input", type: "xsd:long" },
	{ name: "MSelect", tag: "select" },
	{
		name: "PhoneNumber",
		tag: "input",
		type: ["xsd:string", null],
		appearance: "numeric",
	},
	{ name: "Repeat", tag: "repeat" },
	{ name: "SaveToCase", tag: "save_to_case" },
	{ name: "Secret", tag: "secret", type: ["xsd:string", null] },
	{ name: "Select", tag: "select1" },
	{ name: "Text", tag: "input", type: ["xsd:string", null] },
	{ name: "Time", tag: "input", type: "xsd:time" },
	{ name: "Trigger", tag: "trigger" },
	{ name: "Video", tag: "upload", media: "video/*", type: "binary" },
];

/** What `_infer_vellum_type` reads of one control. */
export interface HqControlFacts {
	/** The control's local name (`WrappedNode.tag_name`). */
	readonly tag: string;
	/** The bind's `type` as written; undefined where the bind holds none or there is no bind. */
	readonly type: string | undefined;
	readonly mediaType: string | undefined;
	readonly appearance: string | undefined;
}

/** One level of `_index_on_fields`: the index of the rest of the fields by each value the level's
 *  field names, and the default, the index over the rows that name no value there; past the last
 *  field, the rows themselves. */
type Index =
	| {
			readonly byValue: ReadonlyMap<string, Index>;
			readonly fallback: Index;
	  }
	| readonly VellumType[];

/** `_index_on_fields` over `rows` from the field at `at`, built once as HQ builds it. */
function indexOn(rows: readonly VellumType[], at: number): Index {
	const field: Field | undefined = FIELDS[at];
	if (field === undefined) return rows;
	const partition = new Map<string, VellumType[]>();
	const leftOver: VellumType[] = [];
	for (const row of rows) {
		const named = row[field];
		const each = Array.isArray(named) ? named : [named ?? null];
		for (const value of each) {
			if (value === null) leftOver.push(row);
			else partition.set(value, [...(partition.get(value) ?? []), row]);
		}
	}
	return {
		byValue: new Map(
			[...partition].map(([value, held]) => [value, indexOn(held, at + 1)]),
		),
		fallback: indexOn(leftOver, at + 1),
	};
}

/** `xform.py::VELLUM_TYPE_INDEX`. */
const VELLUM_TYPE_INDEX = indexOn(VELLUM_TYPES, 0);

/** The type HQ's question reader gives a control, or null where its index gives none or several:
 *  each field's value read at its level, a value the level does not hold and an absent value both
 *  reading the level's default. */
export function hqQuestionType(facts: HqControlFacts): string | null {
	let index = VELLUM_TYPE_INDEX;
	for (const value of [
		facts.tag,
		facts.type,
		facts.mediaType,
		facts.appearance,
	]) {
		if (Array.isArray(index)) break;
		const level = index as Exclude<Index, readonly VellumType[]>;
		index =
			value === undefined
				? level.fallback
				: (level.byValue.get(value) ?? level.fallback);
	}
	const found = index as readonly VellumType[];
	const [only] = found;
	return found.length === 1 && only !== undefined ? only.name : null;
}
