import type { ColumnVia } from "@/lib/domain/modules";
import { RESERVED_CASE_ATTRIBUTES } from "../casePropertyWire";
import { w } from "../xpath/wire/builders";
import { buildAncestorJoinNodeset } from "../xpath/wire/rowScope";
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
 * CommCare HQ's words for two case properties in a case list column's `field`
 * and a sort element's: `name` for the case's name and `date-opened` for the
 * date it was opened. HQ's Case List page offers both under these words
 * (`views/modules.py::_setup_case_property_builder`'s defaults), every new
 * menu's column names the case's name so (`models/modules.py::Module.new_module`),
 * and HQ's build reads each as the case's own value
 * (`detail_screen.py::CASE_PROPERTY_MAP`), so either word reads the same
 * value. The app string ids the build gives a column follow the stored word
 * (`id_strings.py::detail_column_header_locale`), so Nova writes HQ's word and
 * an app made in CommCare HQ keeps its ids.
 */
const HQ_COLUMN_PROPERTY_WORDS: Readonly<Record<string, string>> = {
	case_name: "name",
	date_opened: "date-opened",
};

/**
 * A property column's `field` as CommCare HQ stores it: the walk's indices as
 * they are, joined by `/`, and the property in HQ's word
 * (`HQ_COLUMN_PROPERTY_WORDS`). `fieldText` is the domain's text
 * (`lib/domain/modules.ts::columnFieldText`).
 */
export function hqColumnFieldText(fieldText: string): string {
	const steps = fieldText.split("/");
	const property = steps.pop() as string;
	return [...steps, HQ_COLUMN_PROPERTY_WORDS[property] ?? property].join("/");
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
 * case id over `casedb` from `current()`, with no case-type test, since HQ's
 * field carries no type, then the property.
 */
export function columnPropertyPath(column: {
	readonly field: string;
	readonly via?: ColumnVia;
}): WirePath {
	if (column.via === undefined) return casePropertyPath(column.field);
	return w.append(
		buildAncestorJoinNodeset(
			column.via.map((step) => ({ identifier: step.identifier })),
			"casedb",
		),
		casePropertyPath(column.field).steps,
	);
}

/** The existing JavaRosa lowering of XPath's four-character whitespace set. */
export function normalizeSpace(value: WireExpr): WireExpr {
	return w.call("replace", [
		w.call("replace", [value, w.str("[ \\t\\r\\n]+"), w.str(" ")]),
		w.str("^ | $"),
		w.str(""),
	]);
}
