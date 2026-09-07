/** External wire counterexamples, independently consumed by Core's SuiteParser.
 * Static join and Nova emission findings are explicitly distinct from rejection.
 */
import type { ValidationErrorCode } from "../validator/errors";

export const suiteWire = (body = "", version = "1") =>
	`<suite version="${version}">${body}</suite>`;
export const entryWire = (body = "", id = "c") =>
	`<entry><command id="${id}"><text>Entry</text></command>${body}</entry>`;
export const detailWire = (body = "", id = "d") =>
	`<detail id="${id}"><title><text>Cases</text></title>${body}</detail>`;
export const fieldWire = (body = "") =>
	`<field><header><text>Name</text></header><template><text><xpath function="name"/></text></template>${body}</field>`;
const session = (body: string) => entryWire(`<session>${body}</session>`);
const datum = (attrs: string) => `<datum id="case_id" ${attrs}/>`;
const stack = (body: string) => entryWire(`<stack>${body}</stack>`);
const query = (
	body = "",
	attrs = 'url="https://example.org/search" storage-instance="results"',
) => session(`<query ${attrs}>${body}</query>`);
const post = (body = "", attrs = 'url="https://example.org/claim"') =>
	entryWire(`<post ${attrs}>${body}</post>`);
const cases = '<instance id="casedb" src="jr://instance/casedb"/>';
const selected = datum(
	'nodeset="instance(\'casedb\')/casedb/case" value="./@case_id" detail-select="d"',
);
export const cleanSuiteWire = suiteWire(
	detailWire(fieldWire()) +
		entryWire(cases + `<session>${selected}</session>`) +
		'<menu id="m"><text>Patients</text><command id="c"/></menu>',
);
export interface SuiteOracleCase {
	name: string;
	xml: string;
	codes: readonly ValidationErrorCode[];
	nativeAccepts: boolean;
	category?: "static-join" | "nova-contract";
}
function fixture(
	name: string,
	body: string,
	codes: readonly ValidationErrorCode[] = [],
	nativeAccepts = codes.length === 0,
	category?: SuiteOracleCase["category"],
): SuiteOracleCase {
	return { name, xml: suiteWire(body), codes, nativeAccepts, category };
}
const raw = (
	name: string,
	xml: string,
	codes: readonly ValidationErrorCode[] = [],
	nativeAccepts = codes.length === 0,
): SuiteOracleCase => ({ name, xml, codes, nativeAccepts });
export const suiteOracleCases: readonly SuiteOracleCase[] = [
	raw("suite-clean", cleanSuiteWire),
	raw("suite-empty", suiteWire()),
	raw("suite-wrong-root", "<other/>", ["SUITE_NO_SUITE_ELEMENT"]),
	raw("suite-nested-root", `<wrapper>${suiteWire()}</wrapper>`, [
		"SUITE_NO_SUITE_ELEMENT",
	]),
	...["1.5", "", "2147483648", "-2147483649", " 1 "].map((value) =>
		raw(
			`suite-version-${encodeURIComponent(value) || "empty"}`,
			suiteWire("", value),
			["SUITE_VERSION_NOT_INTEGER"],
		),
	),
	...["+1", "2147483647", "-2147483648"].map((value) =>
		raw(`suite-version-${value}`, suiteWire("", value)),
	),
	raw("suite-version-absent", "<suite/>", ["SUITE_VERSION_NOT_INTEGER"]),
	fixture("datum-no-nodeset", session(datum('value="./@id"')), [
		"SUITE_DATUM_NO_NODESET",
	]),
	fixture("datum-optional-value", session(datum('nodeset="/x"'))),
	fixture(
		"datum-nonpath-nodeset",
		session(datum('nodeset="1 + 1" value="./@id"')),
		["SUITE_DATUM_NON_PATH_NODESET"],
	),
	fixture("datum-empty-nodeset", session(datum('nodeset="" value="./@id"')), [
		"SUITE_DATUM_NON_PATH_NODESET",
	]),
	fixture(
		"datum-nonpath-value",
		session(datum('nodeset="/x" value="count(/x)"')),
		["SUITE_DATUM_NON_PATH_VALUE"],
		true,
		"nova-contract",
	),
	fixture(
		"datum-empty-value",
		session(datum('nodeset="/x" value=""')),
		["SUITE_DATUM_NON_PATH_VALUE"],
		true,
		"nova-contract",
	),
	fixture("datum-computed", session(datum('function="uuid()"'))),
	fixture(
		"datum-computed-invalid",
		session(datum('function="1 +"')),
		["SUITE_INVALID_XPATH"],
		true,
		"nova-contract",
	),
	fixture(
		"stack-datum-computed",
		stack("<push><datum id=\"case_id\" value=\"concat('a', 'b')\"/></push>"),
	),
	fixture(
		"stack-datum-no-value",
		stack('<push><datum id="case_id"/></push>'),
		["SUITE_DATUM_NO_VALUE"],
		true,
		"nova-contract",
	),
	fixture(
		"stack-datum-empty-value",
		stack('<push><datum id="case_id" value=""/></push>'),
		["SUITE_DATUM_NON_PATH_VALUE"],
	),
	fixture(
		"stack-datum-invalid-value",
		stack('<push><datum id="case_id" value="1 +"/></push>'),
		["SUITE_DATUM_NON_PATH_VALUE"],
	),
	fixture("stack-unknown-operation", stack("<pop/>"), ["SUITE_STACK_BAD_OP"]),
	fixture("stack-invalid-condition", stack('<clear if="1 +"/>'), [
		"SUITE_INVALID_XPATH",
	]),
	fixture("stack-empty-condition", stack('<clear if=""/>'), [
		"SUITE_INVALID_XPATH",
	]),
	fixture("detail-no-title", '<detail id="d"/>', ["SUITE_DETAIL_NO_TITLE"]),
	fixture(
		"detail-title-not-first",
		'<detail id="d">' +
			fieldWire() +
			"<title><text>Cases</text></title></detail>",
		["SUITE_DETAIL_NO_TITLE"],
	),
	fixture(
		"field-no-header",
		detailWire("<field><template><text>Name</text></template></field>"),
		["SUITE_FIELD_NO_HEADER"],
	),
	fixture(
		"field-no-template",
		detailWire("<field><header><text>Name</text></header></field>"),
		["SUITE_FIELD_NO_TEMPLATE"],
	),
	fixture(
		"detail-invalid-expression",
		detailWire(fieldWire().replace('function="name"', 'function="1 +"')),
		["SUITE_INVALID_XPATH"],
	),
	fixture(
		"detail-empty-expression",
		detailWire(fieldWire().replace('function="name"', 'function=""')),
		["SUITE_INVALID_XPATH"],
	),
	fixture(
		"detail-group-valid",
		detailWire('<group function="index/parent" header-rows="+1"/>'),
	),
	fixture(
		"detail-group-overflow",
		detailWire('<group function="index/parent" header-rows="2147483648"/>'),
		["SUITE_DETAIL_GROUP_INVALID"],
	),
	fixture("detail-group-no-function", detailWire("<group/>"), [
		"SUITE_DETAIL_GROUP_INVALID",
	]),
	fixture(
		"detail-style-no-grid",
		detailWire(fieldWire().replace("<header>", "<style/><header>")),
		["SUITE_FIELD_STYLE_INVALID"],
	),
	fixture(
		"detail-grid-overflow",
		detailWire(
			fieldWire().replace(
				"<header>",
				'<style><grid grid-x="2147483648" grid-y="0" grid-width="1" grid-height="1"/></style><header>',
			),
		),
		["SUITE_FIELD_STYLE_INVALID"],
	),
	fixture(
		"detail-grid-valid",
		detailWire(
			fieldWire().replace(
				"<header>",
				'<style><grid grid-x="+1" grid-y="0" grid-width="1" grid-height="1"/></style><header>',
			),
		),
	),
	fixture("entry-no-display", '<entry><command id="c"/></entry>', [
		"SUITE_ENTRY_NO_DISPLAY",
	]),
	fixture(
		"remote-no-post",
		'<remote-request><command id="c"><text>Claim</text></command></remote-request>',
		["SUITE_REMOTE_REQUEST_NO_POST"],
	),
	fixture("post-no-url", post('<data key="id" ref="\'x\'"/>', ""), [
		"SUITE_POST_NO_URL",
	]),
	fixture(
		"post-invalid-relevance",
		post("", 'url="https://example.org/claim" relevant="1 +"'),
		["SUITE_INVALID_XPATH"],
	),
	fixture(
		"post-empty-relevance",
		post("", 'url="https://example.org/claim" relevant=""'),
		["SUITE_INVALID_XPATH"],
	),
	fixture("query-no-url", query("", 'storage-instance="results"'), [
		"SUITE_QUERY_NO_URL",
	]),
	fixture("query-no-storage", query("", 'url="https://example.org/search"'), [
		"SUITE_QUERY_NO_STORAGE_INSTANCE",
	]),
	fixture(
		"query-invalid-url",
		query("", 'url="not-a-url" storage-instance="results"'),
		["SUITE_QUERY_NO_URL"],
	),
	fixture("query-data-no-ref", query('<data key="q"/>'), ["SUITE_DATA_NO_REF"]),
	fixture(
		"query-data-scalar",
		query("<data key=\"q\" ref=\"concat('a', 'b')\"/>"),
	),
	fixture(
		"query-data-list",
		query('<data key="q" nodeset="/items/item" ref="./@id"/>'),
	),
	fixture(
		"query-data-nonpath-ref",
		query('<data key="q" nodeset="/items/item" ref="count(.)"/>'),
		["SUITE_DATA_NON_PATH_REF"],
	),
	fixture("query-data-empty-ref", query('<data key="q" ref=""/>'), [
		"SUITE_INVALID_XPATH",
	]),
	fixture(
		"query-data-empty-nodeset",
		query('<data key="q" ref="./@id" nodeset=""/>'),
		["SUITE_NON_PATH_XPATH"],
	),
	fixture(
		"query-data-empty-exclude",
		query('<data key="q" ref="\'x\'" exclude=""/>'),
		["SUITE_INVALID_XPATH"],
	),
	fixture(
		"query-prompt-no-key",
		query("<prompt><label><text>Name</text></label></prompt>"),
		["SUITE_PROMPT_NO_KEY"],
	),
	fixture(
		"query-prompt-duplicate",
		query(
			'<prompt key="q"><label><text>One</text></label></prompt><prompt key="q"><label><text>Two</text></label></prompt>',
		),
		["SUITE_PROMPT_DUPLICATE_KEY"],
		true,
		"nova-contract",
	),
	fixture(
		"query-prompt-empty-default",
		query(
			'<prompt key="q" default=""><label><text>Name</text></label></prompt>',
		),
		["SUITE_INVALID_XPATH"],
	),
	fixture(
		"stack-query-valid",
		stack(
			'<push><query id="results" value="https://example.org/search"/></push>',
		),
	),
	fixture(
		"stack-query-invalid-url",
		stack('<push><query id="results" value="not-a-url"/></push>'),
		["SUITE_STACK_QUERY_INVALID"],
	),
	fixture(
		"stack-query-no-id",
		stack('<push><query value="https://example.org/search"/></push>'),
		["SUITE_STACK_QUERY_INVALID"],
		true,
		"nova-contract",
	),
	fixture(
		"duplicate-command",
		entryWire() + entryWire(),
		["SUITE_DUPLICATE_COMMAND"],
		true,
		"nova-contract",
	),
	fixture(
		"duplicate-detail",
		detailWire() + detailWire(),
		["SUITE_DUPLICATE_DETAIL"],
		true,
		"nova-contract",
	),
	fixture(
		"menu-missing-command",
		entryWire() + '<menu id="m"><text>Menu</text><command id="ghost"/></menu>',
		["SUITE_MENU_COMMAND_UNRESOLVED"],
		true,
		"static-join",
	),
	fixture(
		"menu-dangling-root",
		'<menu id="m" root="absent"><text>Menu</text></menu>',
		["SUITE_MENU_ROOT_UNRESOLVED"],
		true,
		"static-join",
	),
	fixture(
		"menu-root-valid",
		'<menu id="m"><text>Root</text></menu><menu id="child" root="m"><text>Child</text></menu>',
	),
	fixture(
		"detail-select-missing",
		session(datum('nodeset="/x" value="./@id" detail-select="absent"')),
		["SUITE_DETAIL_SELECT_UNRESOLVED"],
		true,
		"static-join",
	),
	fixture(
		"detail-confirm-missing",
		session(datum('nodeset="/x" value="./@id" detail-confirm="absent"')),
		["SUITE_DETAIL_CONFIRM_UNRESOLVED"],
		true,
		"static-join",
	),
	fixture(
		"fixture-valid",
		'<fixture id="table"><items><item id="1"/></items></fixture>',
	),
	fixture(
		"fixture-data-markup-names",
		'<fixture id="table"><data><datum/><detail/><query/><prompt/><locale/><fixture/><entry/><bind/><instance/></data></fixture>',
	),
	fixture("fixture-no-id", "<fixture><items/></fixture>", [
		"SUITE_FIXTURE_INVALID",
	]),
	fixture(
		"fixture-user-scope",
		'<fixture id="table" user_id="u"><items/></fixture>',
		["SUITE_FIXTURE_INVALID"],
		true,
		"nova-contract",
	),
	fixture(
		"fixture-missing-delivery",
		entryWire('<instance id="table" src="jr://fixture/table"/>'),
		["SUITE_FIXTURE_INVALID"],
		true,
		"static-join",
	),
	fixture(
		"locale-missing",
		'<menu id="m"><text><locale id="missing"/></text></menu>',
		["SUITE_MISSING_LOCALE"],
		true,
		"static-join",
	),
	fixture(
		"locale-case-is-not-built-in",
		detailWire().replace(
			"<text>Cases</text>",
			'<text><locale id="cchq.case"/></text>',
		),
		["SUITE_MISSING_LOCALE"],
		true,
		"static-join",
	),
	...[
		{ attr: 'order="x"', code: "SUITE_SORT_BAD_ORDER" },
		{ attr: 'order="2147483648"', code: "SUITE_SORT_BAD_ORDER" },
		{ attr: 'direction="up"', code: "SUITE_SORT_BAD_DIRECTION" },
		{ attr: 'type="banana"', code: "SUITE_SORT_BAD_TYPE" },
		{ attr: 'blanks="middle"', code: "SUITE_SORT_BAD_BLANKS" },
	].map(({ attr, code }, i) =>
		fixture(
			`sort-fallback-${i}`,
			detailWire(
				fieldWire(`<sort ${attr}><text><xpath function="name"/></text></sort>`),
			),
			[code as ValidationErrorCode],
			true,
			"nova-contract",
		),
	),
	fixture(
		"sort-valid",
		detailWire(
			fieldWire(
				'<sort order="+1" direction="ascending" type="string" blanks="last"><text><xpath function="name"/></text></sort>',
			),
		),
	),
];
