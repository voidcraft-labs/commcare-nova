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

	it("preserves multiple paragraphs and lists inside a cell", async () => {
		const zip = new AdmZip(structuredDocx());
		const xml = zip.readAsText("word/document.xml");
		const paragraph =
			"<w:p><w:r><w:t>Required only for children</w:t></w:r></w:p>";
		const bullet =
			'<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First condition</w:t></w:r></w:p>';
		zip.updateFile(
			"word/document.xml",
			Buffer.from(
				xml.replace(
					"<w:t>Question</w:t></w:r></w:p>",
					() => "<w:t>Question</w:t></w:r></w:p>" + paragraph + bullet,
				),
			),
		);
		const result = await docxToMarkdownWithFigures(zip.toBuffer());
		expect(result.markdown).toContain(
			"<p>Question</p><p>Required only for children</p><ul><li>First condition</li></ul>",
		);
		expect(result.markdown).toContain("<table>");
		expect(result.figures).toHaveLength(1);
		expect(result.markdown).toContain('<nova:figure index="1"');
	});

	it("keeps nested table figures and merged-cell structure", async () => {
		const zip = new AdmZip(structuredDocx());
		const xml = zip.readAsText("word/document.xml");
		const start = xml.indexOf("<w:tbl>");
		const end = xml.indexOf("</w:tbl>", start) + "</w:tbl>".length;
		const nested =
			'<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' +
			xml.slice(start, end) +
			"<w:p/></w:tc></w:tr></w:tbl>";
		zip.updateFile(
			"word/document.xml",
			Buffer.from(xml.slice(0, start) + nested + xml.slice(end)),
		);
		const result = await docxToMarkdownWithFigures(zip.toBuffer());
		expect(result.markdown).toContain('<td colspan="2"><table>');
		expect(result.markdown).toContain("<p>Question</p>");
		expect(result.markdown).toContain('<nova:figure index="1"');
		expect(result.figures).toHaveLength(1);
		expect(result.figures[0].bytes.length).toBeGreaterThan(0);
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
