import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { textContent } from "domutils";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	collectTranslationUnits,
	proseText,
} from "@/lib/domain";

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

const corpus = z
	.array(
		z
			.object({
				name: z.string(),
				xml: z.string(),
				accepted: z.boolean(),
				policyOnly: z.boolean().optional(),
			})
			.strict(),
	)
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../../../scripts/fixtures/xml/well-formedness.json",
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
						patch: { default_value: xp(`'Value ${character}'`) },
					},
				]) {
					const verdict = gate(doc, [mutation], LOOKUP_CONTEXT_UNAVAILABLE);
					expect(verdict.ok).toBe(false);
					if (verdict.ok) throw new Error("Unsupported text committed");
					expect(verdict.findings.map((finding) => finding.code)).toContain(
						"APP_TEXT_UNREPRESENTABLE",
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
		field.default_value = xp("'A\tB\nC\rD'");
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(
			evaluateCommit({
				nextDoc: doc,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}),
		).toEqual({ ok: true });
		const hq = expandDoc(doc);
		const archive = new AdmZip(compileCcz(hq, doc.appName, doc));
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
		expect(() => compileCcz(hq, "Bad \u0001 name", doc)).toThrow("U+0001");
	});
});
