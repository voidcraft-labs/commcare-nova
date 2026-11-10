import { docxToMarkdownWithFigures, xlsxToMarkdown } from "./officeConversion";
import { OFFICE_LIMITS } from "./officeLimits";

const chunks: Buffer[] = [];
let size = 0;
try {
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > OFFICE_LIMITS.inputBytes)
			throw new Error(
				"The document is too large to read. You can split it into smaller files.",
			);
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	const kind = process.argv[2];
	if (kind !== "docx" && kind !== "xlsx")
		throw new Error("Unknown Office format");
	const result =
		kind === "docx"
			? await docxToMarkdownWithFigures(bytes)
			: { markdown: xlsxToMarkdown(bytes), figures: [], warnings: [] };
	if (Buffer.byteLength(result.markdown) > OFFICE_LIMITS.textBytes)
		throw new Error(
			"The document contains too much text to read at once. You can split it into smaller files.",
		);
	const output = JSON.stringify({
		...result,
		figures: result.figures.map((figure) => ({
			...figure,
			bytes: figure.bytes.toString("base64"),
		})),
		peakRssKb: process.resourceUsage().maxRSS,
	});
	if (Buffer.byteLength(output) > OFFICE_LIMITS.resultBytes)
		throw new Error(
			"The document contains too much content to read at once. You can split it into smaller files.",
		);
	process.stdout.write(output);
} catch {
	// Parser errors can include original document content. Keep them in the child;
	// the host supplies a bounded, actionable failure and never bills a model call.
	process.exitCode = 1;
}
