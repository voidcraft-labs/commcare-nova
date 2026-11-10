import AdmZip from "adm-zip";

/** A small real OOXML package consumed by the installed Mammoth adapter. */
export function docxDocument(
	images: { bytes: Buffer; alt?: string }[] = [],
): Buffer {
	const zip = new AdmZip();
	const xml = (value: string) =>
		value
			.replaceAll("&", "&amp;")
			.replaceAll('"', "&quot;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;");
	zip.addFile(
		"[Content_Types].xml",
		Buffer.from(
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		),
	);
	zip.addFile(
		"_rels/.rels",
		Buffer.from(
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		),
	);
	zip.addFile(
		"word/styles.xml",
		Buffer.from(
			`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
		),
	);
	zip.addFile(
		"word/_rels/document.xml.rels",
		Buffer.from(
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${images.map((_, i) => `<Relationship Id="image${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i}.png"/>`).join("")}</Relationships>`,
		),
	);
	const drawings = images
		.map((image, i) => {
			zip.addFile(`word/media/image${i}.png`, image.bytes);
			return `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="${i + 1}" name="Figure ${i + 1}" descr="${xml(image.alt ?? "")}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image${i}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:t>${i === 0 ? "middle" : "tail"}</w:t></w:r></w:p>`;
		})
		.join("");
	zip.addFile(
		"word/document.xml",
		Buffer.from(
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Doc heading</w:t></w:r></w:p><w:p><w:r><w:t>body</w:t></w:r></w:p>${drawings}</w:body></w:document>`,
		),
	);
	return zip.toBuffer();
}

/** Synthetic requirements layout: a headerless Word table, nested bullets,
 * Unicode, a hyperlink and a figure inside a table cell. */
export function structuredDocx(): Buffer {
	const zip = new AdmZip(
		docxDocument([
			{
				bytes: Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
					"base64",
				),
				alt: 'Flow $& [yes] <next> & "done"',
			},
		]),
	);
	const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
	const list = (text: string, level: number) =>
		`<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
	const original = zip.readAsText("word/document.xml");
	const drawing = original.slice(
		original.indexOf("<w:p><w:r><w:drawing>"),
		original.indexOf("</w:drawing></w:r></w:p>") +
			"</w:drawing></w:r></w:p>".length,
	);
	const extra = `<w:tbl><w:tr><w:tc>${p("Question")}</w:tc><w:tc>${p("Réponse | 日本語")}</w:tc></w:tr><w:tr><w:tc>${p("Diagram")}</w:tc><w:tc>${drawing}</w:tc></w:tr></w:tbl>${list("Parent", 0)}${list("Child", 1)}<w:p><w:hyperlink r:id="link1"><w:r><w:t>Guide</w:t></w:r></w:hyperlink></w:p>`;
	zip.updateFile(
		"word/document.xml",
		Buffer.from(
			original
				.replace(drawing, "")
				.replace("</w:body>", () => `${extra}</w:body>`),
		),
	);
	const relationships = zip
		.readAsText("word/_rels/document.xml.rels")
		.replace(
			"</Relationships>",
			'<Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="link1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/guide?q=a&amp;b=c#part" TargetMode="External"/></Relationships>',
		);
	zip.updateFile("word/_rels/document.xml.rels", Buffer.from(relationships));
	zip.addFile(
		"word/numbering.xml",
		Buffer.from(
			'<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
		),
	);
	return zip.toBuffer();
}
