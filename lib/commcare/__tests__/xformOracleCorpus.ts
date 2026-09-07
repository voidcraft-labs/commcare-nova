/** Wire corruption corpus. The native Core reader independently checks parser outcomes.
 * These are intentionally external wire inputs, not reachable authored-app claims.
 */
import type { ValidationErrorCode } from "../validator/errors";

const data =
	'<instance><data xmlns="http://openrosa.org/formdesigner/nova-oracle" name="Oracle" version="1"><q/><other/></data></instance>';
const bind = '<bind nodeset="/data/q" type="string"/>';
const input = '<input ref="/data/q"><label>Q</label></input>';
const text = '<text id="q-label"><value>Q</value></text>';
const translation = `<translation lang="en" default="">${text}</translation>`;
const itext = `<itext>${translation}</itext>`;
const localized =
	'<input ref="/data/q"><label ref="jr:itext(\'q-label\')"/></input>';
export function wireForm(model = data + bind, body = input): string {
	return `<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa"><h:head><h:title>Oracle</h:title><model>${model}</model></h:head><h:body>${body}</h:body></h:html>`;
}
export interface XformOracleCase {
	name: string;
	xml: string;
	codes: ValidationErrorCode[];
	nativeAccepts: boolean;
	category?: "nova-contract" | "strict-xml";
	manifest?: readonly string[];
}
const fixture = (
	name: string,
	xml: string,
	codes: ValidationErrorCode[] = [],
	nativeAccepts = codes.length === 0,
	category?: XformOracleCase["category"],
): XformOracleCase => ({ name, xml, codes, nativeAccepts, category });
const repData =
	'<instance><data xmlns="http://openrosa.org/formdesigner/nova-repeat" version="1"><rep jr:template=""><a/></rep><other/></data></instance>';
const repBind = '<bind nodeset="/data/rep/a"/>';
const repeat =
	'<repeat nodeset="/data/rep"><input ref="/data/rep/a"><label>A</label></input></repeat>';
const withOutput = (output: string) =>
	wireForm(
		data +
			bind +
			`<itext><translation lang="en" default=""><text id="q-label"><value>Q ${output}</value></text></translation></itext>`,
		localized,
	);
export const xformOracleCases: readonly XformOracleCase[] = [
	fixture("basic", wireForm()),
	fixture(
		"root-attribute-bind",
		wireForm(data + '<bind nodeset="/data/@version"/>'),
	),
	fixture(
		"wrong-root-bind",
		wireForm(data + bind + '<bind nodeset="/wrong/q"/>'),
		["XFORM_DANGLING_BIND"],
		true,
		"nova-contract",
	),
	fixture(
		"wrong-root-control",
		wireForm(data + bind, input.replace("/data/q", "/wrong/q")),
		["XFORM_DANGLING_REF"],
		true,
		"nova-contract",
	),
	fixture(
		"prefix-collision-control",
		wireForm(data + bind, input.replace("/data/q", "/database/q")),
		["XFORM_DANGLING_REF"],
		true,
		"nova-contract",
	),
	fixture("localized", wireForm(data + bind + itext, localized)),
	fixture(
		"encoded-text",
		wireForm(
			data + bind,
			'<input ref="/data/q"><label>Tom &amp; Jerry &lt;2kg 雪</label></input>',
		),
	),
	fixture("missing-instance", wireForm(bind), ["XFORM_NO_INSTANCE"]),
	fixture("empty-instance", wireForm("<instance/>" + bind), [
		"XFORM_NO_INSTANCE",
	]),
	fixture("bind-without-nodeset", wireForm(data + '<bind type="string"/>'), [
		"XFORM_BIND_NO_NODESET",
	]),
	fixture("nonpath-bind", wireForm(data + '<bind nodeset="count(/data/q)"/>'), [
		"XFORM_NON_PATH_NODESET",
	]),
	fixture(
		"dangling-bind",
		wireForm(data + bind + '<bind nodeset="/data/absent"/>'),
		["XFORM_DANGLING_BIND"],
		true,
		"nova-contract",
	),
	...["calculate", "relevant", "readonly", "required", "constraint"].map(
		(attr) =>
			fixture(
				`invalid-${attr}`,
				wireForm(data + `<bind nodeset="/data/q" ${attr}="1 +"/>`),
				["XFORM_INVALID_BIND_EXPRESSION"],
			),
	),
	...["calculate", "relevant", "readonly", "required", "constraint"].map(
		(attr) =>
			fixture(
				`empty-${attr}`,
				wireForm(data + `<bind nodeset="/data/q" ${attr}=""/>`),
				["XFORM_INVALID_BIND_EXPRESSION"],
			),
	),
	fixture(
		"valid-relevant",
		wireForm(data + '<bind nodeset="/data/q" relevant="/data/other &gt; 5"/>'),
	),
	fixture(
		"external-bind-invalid-expression",
		wireForm(
			data +
				bind +
				'<instance id="external"><items xmlns=""><item/></items></instance><bind nodeset="instance(\'external\')/items/item" calculate="1 +"/>',
		),
		["XFORM_INVALID_BIND_EXPRESSION"],
	),
	fixture(
		"ref-without-target",
		wireForm(data + bind, "<input><label>Q</label></input>"),
		["XFORM_CONTROL_NO_REF"],
	),
	fixture(
		"nonpath-control",
		wireForm(
			data + bind,
			'<input ref="count(/data/q)"><label>Q</label></input>',
		),
		["XFORM_NON_PATH_CONTROL_REF"],
	),
	fixture(
		"dangling-control",
		wireForm(data + bind, '<input ref="/data/absent"><label>Q</label></input>'),
		["XFORM_DANGLING_REF"],
	),
	fixture(
		"unbound-group",
		wireForm(data + bind, `<group><label>Layout</label>${input}</group>`),
	),
	fixture(
		"select-valid",
		wireForm(
			data + bind,
			'<select1 ref="/data/q"><label>Q</label><item><label>A</label><value>a</value></item></select1>',
		),
	),
	fixture(
		"select-empty",
		wireForm(data + bind, '<select1 ref="/data/q"><label>Q</label></select1>'),
		["XFORM_SELECT_NO_ITEMS"],
	),
	fixture(
		"item-without-value",
		wireForm(
			data + bind,
			'<select1 ref="/data/q"><label>Q</label><item><label>A</label></item></select1>',
		),
		["XFORM_ITEM_INCOMPLETE"],
	),
	fixture(
		"item-without-label",
		wireForm(
			data + bind,
			'<select1 ref="/data/q"><label>Q</label><item><value>a</value></item></select1>',
		),
		["XFORM_ITEM_INCOMPLETE"],
	),
	fixture(
		"duplicate-itext",
		wireForm(
			data +
				bind +
				`<itext><translation lang="en" default="">${text}${text}</translation></itext>`,
			localized,
		),
		["XFORM_DUPLICATE_ITEXT"],
	),
	fixture(
		"default-form-collision",
		wireForm(
			data +
				bind +
				`<itext><translation lang="en" default=""><text id="q-label"><value>Q</value><value form="">Again</value></text></translation></itext>`,
			localized,
		),
		["XFORM_DUPLICATE_ITEXT"],
	),
	fixture(
		"itext-markdown",
		wireForm(
			data +
				bind +
				`<itext><translation lang="en" default=""><text id="q-label"><value>Q</value><value form="markdown">**Q**</value></text></translation></itext>`,
			localized,
		),
	),
	fixture(
		"text-without-id",
		wireForm(
			data +
				bind +
				`<itext><translation lang="en" default=""><text><value>Q</value></text></translation></itext>`,
		),
		["XFORM_TEXT_NO_ID"],
	),
	fixture(
		"text-bad-child",
		wireForm(
			data +
				bind +
				`<itext><translation lang="en" default=""><text id="q-label"><note>Q</note></text></translation></itext>`,
			localized,
		),
		["XFORM_TEXT_BAD_CHILD"],
	),
	fixture("itext-no-translation", wireForm(data + bind + "<itext/>"), [
		"XFORM_TRANSLATION_NONE",
	]),
	fixture(
		"translation-no-lang",
		wireForm(
			data +
				bind +
				`<itext><translation default="">${text}</translation></itext>`,
			localized,
		),
		["XFORM_TRANSLATION_NO_LANG"],
	),
	fixture(
		"translation-duplicate-lang",
		wireForm(
			data +
				bind +
				`<itext>${translation}<translation lang="en">${text}</translation></itext>`,
			localized,
		),
		["XFORM_TRANSLATION_DUPLICATE_LANG"],
	),
	fixture(
		"translation-two-defaults",
		wireForm(
			data +
				bind +
				`<itext>${translation}<translation lang="es" default="">${text}</translation></itext>`,
			localized,
		),
		["XFORM_TRANSLATION_MULTIPLE_DEFAULT"],
	),
	fixture(
		"translation-implicit-default",
		wireForm(
			data +
				bind +
				`<itext><translation lang="en">${text}</translation></itext>`,
			localized,
		),
		["XFORM_TRANSLATION_NO_DEFAULT"],
		true,
		"nova-contract",
	),
	fixture(
		"translation-incomplete",
		wireForm(
			data +
				bind +
				`<itext>${translation}<translation lang="es">${text}<text id="extra"><value>Extra</value></text></translation></itext>`,
			localized,
		),
		["XFORM_TRANSLATION_INCOMPLETE"],
		true,
		"nova-contract",
	),
	fixture(
		"translation-complete",
		wireForm(
			data +
				bind +
				`<itext>${translation}<translation lang="es">${text}</translation></itext>`,
			localized,
		),
	),
	fixture(
		"itext-missing-label",
		wireForm(data + bind + itext, localized.replace("q-label", "missing")),
		["XFORM_MISSING_ITEXT"],
	),
	fixture(
		"itext-missing-constraint",
		wireForm(
			data +
				'<bind nodeset="/data/q" constraint=". != \'\'" jr:constraintMsg="jr:itext(\'missing\')"/>' +
				itext,
			localized,
		),
		["XFORM_MISSING_ITEXT"],
		true,
		"nova-contract",
	),
	fixture(
		"setvalue-valid",
		wireForm(
			data +
				bind +
				'<setvalue event="xforms-ready" ref="/data/q" value="\'x\'"/>',
		),
	),
	fixture(
		"setvalue-no-target",
		wireForm(data + bind + '<setvalue event="xforms-ready" value="\'x\'"/>'),
		["XFORM_SETVALUE_NO_TARGET"],
	),
	fixture(
		"setvalue-nonpath",
		wireForm(
			data +
				bind +
				'<setvalue event="xforms-ready" ref="count(/data/q)" value="\'x\'"/>',
		),
		["XFORM_INVALID_SETVALUE"],
	),
	fixture(
		"setvalue-invalid-value",
		wireForm(
			data +
				bind +
				'<setvalue event="xforms-ready" ref="/data/q" value="1 +"/>',
		),
		["XFORM_INVALID_SETVALUE"],
	),
	fixture(
		"setvalue-invalid-event",
		wireForm(
			data + bind + '<setvalue event="on-load" ref="/data/q" value="\'x\'"/>',
		),
		["XFORM_INVALID_ACTION_EVENT"],
	),
	fixture(
		"setvalue-dangling",
		wireForm(
			data +
				bind +
				'<setvalue event="xforms-ready" ref="/data/missing" value="\'x\'"/>',
		),
		["XFORM_DANGLING_REF"],
	),
	fixture("output-valid", withOutput('<output value="/data/other"/>')),
	fixture(
		"output-ref-precedence",
		withOutput('<output ref="/data/other" value="1 +"/>'),
	),
	fixture("output-empty-value", withOutput('<output value=""/>'), [
		"XFORM_INVALID_OUTPUT",
	]),
	fixture(
		"setvalue-empty-value",
		wireForm(
			data + bind + '<setvalue event="xforms-ready" ref="/data/q" value=""/>',
		),
		["XFORM_INVALID_SETVALUE"],
	),
	fixture("output-no-expression", withOutput("<output/>"), [
		"XFORM_INVALID_OUTPUT",
	]),
	fixture("output-invalid-value", withOutput('<output value="1 +"/>'), [
		"XFORM_INVALID_OUTPUT",
	]),
	fixture("output-invalid-ref", withOutput('<output ref="1 +"/>'), [
		"XFORM_INVALID_OUTPUT",
	]),
	fixture("repeat-valid", wireForm(repData + repBind, repeat)),
	fixture(
		"repeat-wrapper",
		wireForm(
			repData + repBind,
			`<group ref="/data/rep"><label>Repeat</label>${repeat}</group>`,
		),
	),
	fixture(
		"repeat-unbound-wrapper",
		wireForm(
			repData + repBind,
			`<group><label>Repeat</label>${repeat}</group>`,
		),
	),
	fixture(
		"repeat-outside",
		wireForm(
			repData + repBind,
			repeat.replace('ref="/data/rep/a"', 'ref="/data/other"'),
		),
		["XFORM_REPEAT_MEMBER_SCOPE"],
	),
	fixture(
		"repeat-same-node",
		wireForm(
			repData + repBind,
			`<repeat nodeset="/data/rep">${repeat}</repeat>`,
		),
		["XFORM_REPEAT_MEMBER_SCOPE"],
	),
	fixture(
		"repeat-root",
		wireForm(data + bind, `<repeat nodeset="/data">${input}</repeat>`),
		["XFORM_REPEAT_BINDS_ROOT"],
	),
	fixture(
		"duplicate-template",
		wireForm(
			repData.replace("<other/>", '<rep jr:template=""><a/></rep>') + repBind,
			repeat,
		),
		["XFORM_DUPLICATE_TEMPLATE"],
	),
	fixture(
		"repeat-skipped-ancestor",
		wireForm(
			'<instance><data xmlns="http://openrosa.org/formdesigner/nova-repeat"><outer jr:template=""><inner jr:template=""><leaf/></inner></outer></data></instance><bind nodeset="/data/outer/inner/leaf"/>',
			'<repeat nodeset="/data/outer"><input ref="/data/outer/inner/leaf"><label>L</label></input></repeat>',
		),
		["XFORM_REPEAT_MEMBER_SCOPE"],
	),
];
