import type { ColumnRecordSource, ColumnVia } from "@/lib/domain/modules";
import { RESERVED_CASE_ATTRIBUTES } from "../casePropertyWire";
import { type SourceTable, tableOf } from "../sourceKeys";
import { USERCASE_CASE_SELECTOR } from "../usercaseWire";
import { w } from "../xpath/wire/builders";
import { groupsInstance, sessionInstance } from "../xpath/wire/instances";
import {
	buildAncestorJoinNodeset,
	type InstanceRoot,
} from "../xpath/wire/rowScope";
import type { WireExpr, WirePath } from "../xpath/wire/tree";

/** A case-row property, with standard metadata kept on its attribute axis. */
export function casePropertyPath(property: string): WirePath {
	return w.context([
		RESERVED_CASE_ATTRIBUTES.has(property)
			? w.attr(property)
			: w.step(property),
	]);
}

/**
 * The words a case list column's `field` and a sort element's can name three
 * case properties by, the word Nova writes first. HQ's build reads `name`,
 * `date-opened` and `external-id` as the case's own `case_name`,
 * `date_opened` and `external_id` (`detail_screen.py::CASE_PROPERTY_MAP`), so
 * either word of a property reads the same value. HQ's Case List page offers
 * `name` and `date-opened` (`views/modules.py::_setup_case_property_builder`'s
 * defaults) and every new menu's column names the case's name so
 * (`models/modules.py::Module.new_module`), so Nova writes those two words and
 * the property's own name for the external id. The app string ids the build
 * gives a column follow the word it stores
 * (`id_strings.py::detail_column_header_locale`), so where CommCare HQ keeps a
 * column under the other word, a deployment holds that word
 * (`wireIdentity.ts::WireIdentity.columnFieldWord`) and every export to it
 * writes the column so.
 */
const HQ_COLUMN_PROPERTY_WORDS: SourceTable<readonly [string, string]> =
	tableOf({
		case_name: ["name", "case_name"],
		date_opened: ["date-opened", "date_opened"],
		external_id: ["external_id", "external-id"],
	});

/**
 * A property column's `field` as CommCare HQ stores it: the walk's indices as
 * they are, joined by `/`, and the property in HQ's word: `held`, the word
 * the deployment holds for the column on this screen, where it is one of the
 * property's words, else the word Nova writes (`HQ_COLUMN_PROPERTY_WORDS`).
 * `fieldText` is the domain's text (`lib/domain/modules.ts::columnFieldText`).
 */
export function hqColumnFieldText(fieldText: string, held?: string): string {
	const steps = fieldText.split("/");
	const property = steps.pop() as string;
	const words = HQ_COLUMN_PROPERTY_WORDS.get(property);
	const word =
		words === undefined
			? property
			: held !== undefined && words.includes(held)
				? held
				: words[0];
	return [...steps, word].join("/");
}

/**
 * The property a stored column `field`'s last word names and that word, where
 * it is a word of one of the three properties HQ names by two
 * (`HQ_COLUMN_PROPERTY_WORDS`); undefined for every other field.
 */
export function columnFieldWordOf(
	field: string,
): { readonly property: string; readonly word: string } | undefined {
	const word = field.split("/").pop() as string;
	for (const [property, words] of HQ_COLUMN_PROPERTY_WORDS)
		if (words.includes(word)) return { property, word };
	return undefined;
}

/** Whether `word` is the word Nova writes for the property it names, where it names one. */
export function isWrittenColumnFieldWord(word: string): boolean {
	const named = columnFieldWordOf(word);
	return (
		named === undefined ||
		HQ_COLUMN_PROPERTY_WORDS.get(named.property)?.[0] === word
	);
}

/** One word of CommCare HQ's case list field grammar. */
const HQ_FIELD_WORD = "[a-zA-Z][\\w_-]*";

/**
 * CommCare HQ's grammar for a case list `field` it reads as a property name:
 * words that start with a letter, joined by `/`, after any `prefix:` words,
 * with a `#` allowed before the last. HQ's build refuses a sort element whose
 * field does not match (`helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`,
 * `invalid sort field`), and its Case List page will not keep a property
 * column whose field does not (`static/app_manager/js/details/utils.js::isValidPropertyName`).
 */
const HQ_DETAIL_FIELD = new RegExp(
	`^(${HQ_FIELD_WORD}:)*(${HQ_FIELD_WORD}\\/)*#?${HQ_FIELD_WORD}$`,
);

/** Whether CommCare HQ's build and Case List page take `field` as a property name (`HQ_DETAIL_FIELD`). */
export function isHqDetailField(field: string): boolean {
	return HQ_DETAIL_FIELD.test(field);
}

/**
 * A property column's value on a case row: the row's own property, or the
 * property of the case the column's walk reaches, read as CommCare HQ's build
 * reads a `field` of indices and a property
 * (`detail_screen.py::PropertyXpathGenerator.xpath`): each index joined by
 * case id over the detail's worker roster from `current()`, with no case-type test, since HQ's
 * field carries no type, then the property.
 */
export function columnPropertyPath(
	column: ColumnRecordSource & {
		readonly field: string;
		readonly via?: ColumnVia;
	},
	root: InstanceRoot = "casedb",
): WireExpr {
	const base =
		column.readFrom === "worker-record"
			? USERCASE_CASE_SELECTOR
			: column.via
				? buildAncestorJoinNodeset(
						column.via.map(({ identifier }) => ({ identifier })),
						root,
					)
				: column.showOwner === "name"
					? w.current()
					: w.context();
	const value = w.append(base, casePropertyPath(column.field).steps);
	if (column.showOwner !== "name") return value;
	// HQ gives a matching group's name precedence even when it is blank.
	const group = w.instance(groupsInstance(), [
		w.step("groups"),
		w.step("group", [w.eq(w.context([w.attr("id")]), value)]),
	]);
	const worker = (key: string) =>
		w.instance(sessionInstance(), [
			w.step("session"),
			w.step("context"),
			w.step(key),
		]);
	return w.call("if", [
		w.ne(w.call("count", [group]), w.num(0)),
		w.append(group, [w.step("name")]),
		w.call("if", [
			w.eq(worker("userid"), value),
			worker("username"),
			w.str(""),
		]),
	]);
}

/** The existing JavaRosa lowering of XPath's four-character whitespace set. */
export function normalizeSpace(value: WireExpr): WireExpr {
	return w.call("replace", [
		w.call("replace", [value, w.str("[ \\t\\r\\n]+"), w.str(" ")]),
		w.str("^ | $"),
		w.str(""),
	]);
}
