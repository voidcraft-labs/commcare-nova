import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { textContent } from "domutils";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	blueprintDocSchema,
	collectTranslationUnits,
	type ProseTemplate,
	proseText,
} from "@/lib/domain";
import { and, literal, term } from "@/lib/domain/expression/builders";
import {
	resolveLabel,
	resolveLabelAsync,
} from "@/lib/preview/engine/labelRefs";
import {
	proseTemplateToTiptapContent,
	tiptapContentToProseTemplate,
} from "@/lib/tiptap/proseTemplateCodec";

import { profileReferencesBuildSuite } from "../buildProfile";
import { compileCcz } from "../compiler";
import { el, text } from "../elementBuilders";
import { endpointSuiteSignature } from "../entryPointSignature";
import { expandDoc } from "../expander";
import { serializeXml } from "../serializeXml";
import { evaluateCommit } from "../validator/gate";
import { validateMediaSuite } from "../validator/mediaSuiteOracle";
import { runValidation } from "../validator/runner";
import { validateSuite } from "../validator/suiteOracle";
import { validateXForm } from "../validator/xformOracle";
import { parseXForm } from "../xform/domSplice";
import { parseXml, xmlParseIssue } from "../xmlParse";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return [
		...(node.name === name ? [node] : []),
		...node.children.flatMap((child) => descendants(child, name)),
	];
}

const corpus = z
	.array(
		z.strictObject({
			name: z.string(),
			xml: z.string(),
			accepted: z.boolean(),
			policyOnly: z.boolean().optional(),
		}),
	)
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../../../proof/native/xml/well-formedness.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);

function authoredDoc() {
	return buildDoc({
		appName: "Survey",
		modules: [
			{
				name: "Surveys",
				forms: [
					{
						name: "Interview",
						type: "survey",
						fields: [
							f({ kind: "text", id: "answer", label: proseText("Answer") }),
						],
					},
				],
			},
		],
	});
}

describe("XML admission and consumer boundaries", () => {
	it.each(corpus)("$name", ({ xml, accepted }) => {
		expect(xmlParseIssue(xml) === undefined).toBe(accepted);
	});

	it("preserves XML attribute whitespace, carriage returns and C1 references without HTML substitution", () => {
		const raw = "A\tB\nC\rD \u0085\u009f & < > &#0;";
		const element = el("root", { value: raw }, [
			text(raw),
			el("empty", {}, []),
		]);
		const encoded = serializeXml(element);
		expect(encoded).toBe(
			'<root value="A&#x9;B&#xa;C&#xd;D &#x85;&#x9f; &amp; &lt; &gt; &amp;#0;">A\tB\nC&#xd;D &#x85;&#x9f; &amp; &lt; &gt; &amp;#0;<empty/></root>',
		);
		const roots = parseXml(encoded).children.filter(isTag);
		expect(roots).toHaveLength(1);
		expect(roots[0].attribs).toEqual({ value: raw });
		expect(textContent(roots[0])).toBe(raw);
		expect(serializeXml(parseXml(encoded))).toBe(encoded);
		expect(element.attribs).toEqual({ value: raw });
	});

	it.each([
		"&#x1;",
		"&#xB;",
		"&#xFFFF;",
		"&#0;",
		"&#xD800;",
		"&#x110000;",
		"&#65;",
		"&amp;",
		"&amp;lt;",
	])(
		"keeps entity-looking prose literal from admission through both exports: %s",
		(spelling) => {
			const doc = authoredDoc();
			const field = Object.values(doc.fields)[0];
			for (const gate of [
				mutationCommitVerdict,
				mutationCommitVerdictWithPrevalidation,
			]) {
				const verdict = gate(
					doc,
					[
						{
							kind: "updateField",
							uuid: field.uuid,
							targetKind: "text",
							patch: {
								label: proseText(`Answer ${spelling}`),
								plainLabel: true,
							},
						},
					],
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(verdict.ok).toBe(true);
				if (!verdict.ok) throw new Error("Prose was refused");
				const admitted = verdict.nextDoc;
				blueprintDocSchema.parse(toPersistableDoc(admitted));
				expect(runValidation(admitted, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
				const hq = expandDoc(admitted);
				const archive = new AdmZip(
					compileCcz(hq, admitted.appName, admitted, {
						runtimeTarget: TEST_RUNTIME_TARGET,
					}),
				);
				for (const xml of [
					Object.values(hq._attachments)[0],
					archive.readAsText("modules-0/forms-0.xml"),
				]) {
					if (typeof xml !== "string") throw new Error("Missing form");
					const root = readXmlEvidence(xml);
					const values = descendants(root, "text").find(
						(node) => node.attributes.id === "answer-label",
					)?.children;
					expect(values?.map((value) => value.text)).toEqual([
						`Answer ${spelling}`,
					]);
				}
			}
		},
	);

	it("preserves prose across translated slots, typed references, Preview and editor round trips", async () => {
		const doc = authoredDoc();
		const answer = Object.values(doc.fields)[0];
		if (answer.kind !== "text") throw new Error("Wrong fixture kind");
		const literalText =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Core alert markers are literal prose.
			"**Café 雪 😀** &amp; &amp;lt; &#65; &#x1; &#xB; &#xFFFF; &#x80; &#x9; &#36;{0} ${0} <output/> #form/answer: ";
		const template: ProseTemplate = {
			parts: [
				{ kind: "text", text: literalText },
				{ kind: "field-ref", uuid: answer.uuid },
			],
		};
		answer.label = template;
		answer.hint = template;
		answer.help = template;
		answer.validate = and();
		answer.validate_msg = template;
		const choice = f({
			kind: "single_select",
			id: "choice",
			label: "Choose",
			options: [
				{ value: "one", label: template },
				{ value: "two", label: "Other" },
			],
		});
		// The fixture builder supplies the form membership for the extra choice.
		const complete = buildDoc({
			appName: "Prose",
			modules: [
				{
					name: "Surveys",
					forms: [
						{ name: "Interview", type: "survey", fields: [answer, choice] },
					],
				},
			],
		});
		const units = collectTranslationUnits(complete).filter(
			(unit) =>
				unit.valueKind === "prose" &&
				typeof unit.source !== "string" &&
				unit.source.parts.some((part) => part.kind === "field-ref"),
		);
		complete.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: {
				spa: Object.fromEntries(
					units.map((unit) => [
						unit.id,
						{
							value: {
								parts: [
									{ kind: "text", text: `Español ${literalText}` },
									{ kind: "field-ref", uuid: answer.uuid },
								],
							},
							sourceFingerprint: unit.sourceFingerprint,
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
						},
					]),
				),
			},
		};
		blueprintDocSchema.parse(toPersistableDoc(complete));
		expect(runValidation(complete, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(
			tiptapContentToProseTemplate(proseTemplateToTiptapContent(template)),
		).toEqual(template);
		expect(resolveLabel(template, () => "value &amp;")).toBe(
			`${literalText}value &amp;`,
		);
		expect(await resolveLabelAsync(template, async () => "value &amp;")).toBe(
			`${literalText}value &amp;`,
		);
		const hq = expandDoc(complete);
		const archive = new AdmZip(
			compileCcz(hq, complete.appName, complete, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		for (const xml of [
			Object.values(hq._attachments)[0],
			archive.readAsText("modules-0/forms-0.xml"),
		]) {
			if (typeof xml !== "string") throw new Error("Missing form");
			for (const translation of descendants(
				readXmlEvidence(xml),
				"translation",
			)) {
				const expected = `${translation.attributes.lang === "es" ? "Español " : ""}${literalText}`;
				for (const id of [
					"answer-label",
					"answer-hint",
					"answer-help",
					"answer-constraintMsg",
					"choice-opt0-label",
				]) {
					const entry = translation.children.find(
						(node) => node.attributes.id === id,
					);
					if (!entry) throw new Error(`Missing ${id}`);
					const values = entry.children.filter(
						(value) =>
							!value.attributes.form || value.attributes.form === "markdown",
					);
					expect(values).toHaveLength(2);
					for (const value of values) {
						expect(value.text).toBe(expected);
						expect(value.children.map((node) => node.attributes.value)).toEqual(
							["/data/answer"],
						);
					}
					if (id === "answer-constraintMsg") {
						const piece = entry.children.find(
							(value) => value.attributes.form === "__nova_piece_0",
						);
						expect(JSON.parse(piece?.text ?? "null")).toEqual({ v: expected });
					}
				}
			}
		}
	});

	it.each([
		"\u0000",
		"\u0001",
		"\u000b",
		"\ud800",
		"\udc00",
		"\ufffe",
		"\uffff",
	])(
		"refuses unsupported text through both shared mutation gates: %j",
		(character) => {
			const doc = authoredDoc();
			blueprintDocSchema.parse(toPersistableDoc(doc));
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const field = Object.values(doc.fields)[0];
			for (const gate of [
				mutationCommitVerdict,
				mutationCommitVerdictWithPrevalidation,
			]) {
				for (const mutation of [
					{ kind: "setAppName", name: `Survey ${character}` },
					{
						kind: "updateField",
						uuid: field.uuid,
						targetKind: "text",
						patch: { label: proseText(`Answer ${character}`) },
					},
					{
						kind: "updateField",
						uuid: field.uuid,
						targetKind: "text",
						patch: { default_value: term(literal(`Value ${character}`)) },
					},
				]) {
					const verdict = gate(doc, [mutation], LOOKUP_CONTEXT_UNAVAILABLE);
					expect(verdict.ok).toBe(false);
					if (verdict.ok) throw new Error("Unsupported text committed");
					const finding = verdict.findings.find(
						(finding) => finding.code === "APP_TEXT_UNREPRESENTABLE",
					);
					if (!finding) throw new Error("Missing text finding");
					const label =
						mutation.kind === "setAppName"
							? "The app name"
							: `The question "${field.id}"`;
					expect(userFacingError(finding)).toBe(
						`${label} contains a character Nova can't preserve. You can remove ${finding.details?.character} or retype the affected text.`,
					);
				}
			}
			expect(doc.appName).toBe("Survey");
			if (field.kind !== "text") throw new Error("Wrong fixture kind");
			expect(field.label).toEqual(proseText("Answer"));
		},
	);

	it("refuses a stale translated value before it can become active", () => {
		const doc = authoredDoc();
		const unit = collectTranslationUnits(doc).find(
			(unit) => unit.role === "app-name",
		);
		if (!unit) throw new Error("Missing app-name translation unit");
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: {
				spa: {
					[unit.id]: {
						value: "Encuesta \u0001",
						sourceFingerprint: "stale",
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			},
		};
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((finding) => ({
				code: finding.code,
				details: finding.details,
			})),
		).toEqual([
			{
				code: "APP_TEXT_UNREPRESENTABLE",
				details: {
					path: `localization.translations.spa.${unit.id}.value`,
					character: "U+0001",
					label: "The translated text",
				},
			},
		]);
	});

	it("accepts multilingual Unicode and keeps author-only purpose notes outside the wire restriction", () => {
		const doc = authoredDoc();
		doc.appName = "Café 雪 😀";
		doc.modules[doc.moduleOrder[0]].purpose = "Internal \u0001 note";
		const field = Object.values(doc.fields)[0];
		if (field.kind !== "text") throw new Error("Wrong fixture kind");
		field.label = proseText("é é العربية 汉字 😀 \u007f\u0085\u009f");
		field.default_value = term(literal("A\tB\nC\rD"));
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(
			evaluateCommit({
				nextDoc: doc,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}),
		).toEqual({ ok: true });
		const hq = expandDoc(doc);
		const archive = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		for (const entry of archive
			.getEntries()
			.filter((entry) => /\.(xml|ccpr)$/.test(entry.entryName))) {
			expect(xmlParseIssue(entry.getData().toString("utf8"))).toBeUndefined();
		}
	});

	it.each(["&#0;", "&#xFFFF;", "&#xD800;", "\u0001", "<q:bad/>"])(
		"refuses malformed bytes at each parse boundary before DOM recovery: %s",
		(fragment) => {
			const xml = `<root>${fragment}</root>`;
			expect(validateXForm(xml, "Form", "Module").map((e) => e.code)).toEqual([
				"XFORM_PARSE_ERROR",
			]);
			expect(validateSuite(xml, new Set()).map((e) => e.code)).toEqual([
				"SUITE_PARSE_ERROR",
			]);
			expect(validateMediaSuite(xml).map((e) => e.code)).toEqual([
				"MEDIA_SUITE_PARSE_ERROR",
			]);
			expect(() => parseXForm(xml)).toThrow("Malformed XML");
			const profile = `<profile>${fragment}<suite><resource id="suite"><location authority="remote">https://www.commcarehq.org/a/demo/apps/download/build/suite.xml</location></resource></suite></profile>`;
			expect(
				profileReferencesBuildSuite(profile, {
					server: "production",
					domain: "demo",
					buildId: "build",
				}),
			).toBe(false);
			expect(
				endpointSuiteSignature(
					`<suite>${fragment}<endpoint id="open"/></suite>`,
					"open",
				),
			).toBeUndefined();
		},
	);

	it("checks the generated profile even when the form text is valid", () => {
		const doc = authoredDoc();
		const hq = expandDoc(doc);
		expect(() =>
			compileCcz(hq, "Bad \u0001 name", doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).toThrow("U+0001");
	});
});
