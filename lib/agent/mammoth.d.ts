// lib/agent/mammoth.d.ts
//
// Ambient type declaration for `mammoth` (the docx → markdown/html converter).
// The package ships no bundled types and there is no `@types/mammoth` on the
// registry, so without this `import mammoth from "mammoth"` resolves to `any`,
// which both fails strict mode and violates the no-`any` rule.
//
// We declare ONLY the narrow surface `attachments.ts` consumes — the single
// `convertToMarkdown` entry point and its result shape — rather than the full
// API. A tighter declaration is the better guard: it matches exactly what we
// call and lets the compiler reject a typo or a misremembered signature
// against the real runtime contract verified in attachments.test.ts.

declare module "mammoth" {
	/** A messages-and-value result. `value` is the converted output (markdown
	 *  here); `messages` carries non-fatal conversion warnings we don't surface. */
	interface ConversionResult {
		value: string;
		messages: Array<{ type: string; message: string }>;
	}

	/** Input is a single source. We always pass a Node `Buffer` (the decoded
	 *  docx bytes), the shape mammoth accepts server-side. */
	interface ConvertInput {
		buffer: Buffer;
	}

	/** Convert a docx document to markdown, mapping Word styles to clean
	 *  markdown structure. Async — mammoth unzips and walks the document. */
	export function convertToMarkdown(
		input: ConvertInput,
	): Promise<ConversionResult>;

	const mammoth: {
		convertToMarkdown: typeof convertToMarkdown;
	};
	export default mammoth;
}
