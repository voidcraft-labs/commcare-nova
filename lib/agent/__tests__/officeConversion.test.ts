import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { docxToMarkdownWithFigures } from "../officeConversion";
import { docxDocument, structuredDocx } from "./fixtures/officeDocuments";

describe("supported DOCX conversion", () => {
	it("preserves table cells, nested lists, Unicode, URLs and figure alt text", async () => {
		const result = await docxToMarkdownWithFigures(structuredDocx());
		expect(result.markdown).toMatch(/\| Question\s+\| Réponse \\\| 日本語/);
		expect(result.markdown).toMatch(/\* Parent\n\s+\* Child/);
		expect(result.markdown).toContain(
			"[Guide](https://example.com/guide?q=a\\&b=c#part)",
		);
		expect(result.markdown).toContain(
			'<nova:figure index="1" alt="Flow $&amp; [yes] &lt;next&gt; &amp; &quot;done&quot;"/>',
		);
		expect(result.figures).toHaveLength(1);
		expect(result.figures[0].bytes.length).toBeGreaterThan(0);
		expect(result.figures[0].altText).toBe('Flow $& [yes] <next> & "done"');
	});

	it("reports unsupported source content as a conversion limitation", async () => {
		const zip = new AdmZip(docxDocument());
		zip.updateFile(
			"word/document.xml",
			Buffer.from(
				zip
					.readAsText("word/document.xml")
					.replace(
						"</w:body>",
						"<w:unsupportedNovaExample>unread</w:unsupportedNovaExample></w:body>",
					),
			),
		);
		const result = await docxToMarkdownWithFigures(zip.toBuffer());
		expect(
			result.warnings.some((warning) =>
				warning.includes("unsupportedNovaExample"),
			),
		).toBe(true);
		expect(result.markdown).toContain("body");
	});

	it("refuses broken document references instead of returning apparently complete text", async () => {
		const zip = new AdmZip(docxDocument());
		zip.updateFile(
			"word/document.xml",
			Buffer.from(
				zip
					.readAsText("word/document.xml")
					.replace(
						"</w:body>",
						'<w:p><w:r><w:footnoteReference w:id="999"/></w:r></w:p></w:body>',
					),
			),
		);
		await expect(docxToMarkdownWithFigures(zip.toBuffer())).rejects.toThrow();
	});
});
