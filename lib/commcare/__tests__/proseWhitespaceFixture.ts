// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Native constraint markers must remain literal test data.
/** Admitted prose whose adjacent references need separators in native Core. */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	makeTranslationUnitId,
	type ProseTemplate,
	proseText,
	translationUnitsById,
} from "@/lib/domain";
import { runValidation } from "../validator/runner";

const MEALS = testUuid("prose-meals");
const ADDRESS = testUuid("prose-address");
const CONTEXT = testUuid("prose-delivery-context");
const LITERAL_CHECKED = testUuid("prose-literal-checked");
const REFERENCE_CHECKED = testUuid("prose-reference-checked");

function separated(separator: string, prefix = ""): ProseTemplate {
	return {
		parts: [
			...(prefix ? [{ kind: "text" as const, text: prefix }] : []),
			{ kind: "field-ref", uuid: MEALS },
			{ kind: "text", text: separator },
			{ kind: "field-ref", uuid: ADDRESS },
		],
	};
}

export function proseWhitespaceFixture() {
	const doc = buildDoc({
		appName: "Café 雪 😀",
		modules: [
			{
				name: "Surveys",
				forms: [
					{
						name: "Interview",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText("é é العربية 汉字 😀 \u007f\u0085\u009f"),
								default_value: xp("'A\tB\nC\rD'"),
							}),
							f({
								kind: "int",
								uuid: MEALS,
								id: "meals",
								label: "Meals",
								default_value: xp("3"),
							}),
							f({
								kind: "text",
								uuid: ADDRESS,
								id: "address",
								label: "Address",
								default_value: xp("'14 Example Lane'"),
							}),
							f({
								kind: "label",
								uuid: CONTEXT,
								id: "delivery_context",
								label: separated("\n\n", "Meals: "),
							}),
							f({ kind: "label", id: "space", label: separated(" ") }),
							f({
								kind: "label",
								id: "xml_whitespace",
								label: separated("\t \r\n"),
							}),
							f({
								kind: "label",
								id: "unicode_spacing",
								label: separated("\u00a0\u2003\u2028"),
							}),
							f({
								kind: "label",
								id: "mixed_nbsp",
								label: proseText('It\'s "early"\u00a0today'),
							}),
							f({
								kind: "label",
								id: "consumer_spacing",
								label: separated(
									"\t\n\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000",
								),
							}),
							f({
								kind: "label",
								id: "edge_whitespace",
								label: {
									parts: [
										{ kind: "text", text: " \t" },
										...separated("\n ").parts,
										{ kind: "text", text: "\t " },
									],
								},
							}),
							f({
								kind: "label",
								id: "escaped_markup",
								label: proseText(
									"Literal &lt;output value=\"'x'\"/&gt; &amp; #form/meals",
								),
							}),
							f({
								kind: "text",
								id: "checked",
								label: "Entry",
								hint: separated("\n\n"),
								help: separated(" "),
								validate: xp(". = 'ok'"),
								validate_msg: separated("\t"),
							}),
							f({
								kind: "int",
								uuid: LITERAL_CHECKED,
								id: "literal_checked",
								label: "Literal constraint",
								default_value: xp("4"),
								validate: xp(". < 10"),
								validate_msg: proseText(
									'Literal ${0} / ${00}; It\'s "early"\u00a0today',
								),
							}),
							f({
								kind: "int",
								uuid: REFERENCE_CHECKED,
								id: "reference_checked",
								label: "Referenced constraint",
								default_value: xp("4"),
								validate: xp(". < 10"),
								validate_msg: {
									parts: [
										{ kind: "text", text: "Literal ${0} / ${00}: " },
										{ kind: "field-ref", uuid: ADDRESS },
										{ kind: "text", text: " | Self: " },
										{ kind: "field-ref", uuid: REFERENCE_CHECKED },
									],
								},
							}),
							f({
								kind: "single_select",
								id: "choose",
								label: "Choose",
								options: [
									{ value: "one", label: separated("\n\n") },
									{ value: "two", label: "Another choice" },
								],
							}),
						],
					},
				],
			},
		],
	});
	const unitId = makeTranslationUnitId("field", CONTEXT, "label");
	const unit = translationUnitsById(doc).get(unitId);
	if (!unit) throw new Error("Missing delivery-context translation unit.");
	const literalUnitId = makeTranslationUnitId(
		"field",
		LITERAL_CHECKED,
		"validate_msg",
	);
	const referenceUnitId = makeTranslationUnitId(
		"field",
		REFERENCE_CHECKED,
		"validate_msg",
	);
	const literalUnit = translationUnitsById(doc).get(literalUnitId);
	const referenceUnit = translationUnitsById(doc).get(referenceUnitId);
	if (!literalUnit || !referenceUnit)
		throw new Error("Missing constraint translation unit.");
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		translations: {
			spa: {
				[literalUnitId]: {
					value: proseText("Español ${00} / ${0}"),
					sourceFingerprint: literalUnit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
				[referenceUnitId]: {
					value: {
						parts: [
							{ kind: "field-ref", uuid: REFERENCE_CHECKED },
							{ kind: "text", text: " Español ${00} / ${0}: " },
							{ kind: "field-ref", uuid: ADDRESS },
						],
					},
					sourceFingerprint: referenceUnit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
				[unitId]: {
					value: separated("\n\n", "Comidas: "),
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length > 0) throw new Error(JSON.stringify(findings));
	return doc;
}
