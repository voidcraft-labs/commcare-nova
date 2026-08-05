// lib/agent/mammoth.d.ts
//
// Ambient type declaration for `mammoth` (the docx → markdown/html converter).
// The package ships no bundled types and there is no `@types/mammoth` on the
// registry, so without this `import mammoth from "mammoth"` resolves to `any`,
// which both fails strict mode and violates the no-`any` rule.
//
// We declare ONLY the narrow surface our docx→markdown helper
// (`documentExtraction.ts::docxToMarkdownWithFigures`) consumes: the
// `convertToMarkdown` entry point, the `convertImage` option, and the
// `images.imgElement` converter factory with the image object it hands our
// handler. A tighter declaration is the better guard: it matches exactly what
// we call and lets the compiler reject a typo or a misremembered signature
// against the real runtime contract.

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

	/** One embedded image, as mammoth hands it to a custom image converter:
	 *  the archive-declared content type, the author-supplied alt text (when
	 *  any), and lazy byte readers. Only the members our figure collector
	 *  consumes are declared. Exported so `documentExtraction.ts` can alias it
	 *  type-only (erased at compile time, so importing the alias never loads
	 *  mammoth or bluebird). */
	export interface MammothImage {
		contentType?: string;
		altText?: string;
		readAsBuffer(): Promise<Buffer>;
	}

	/** The `<img>` attributes a custom converter returns. mammoth merges them
	 *  over `{ alt: image.altText }`, so returning an explicit `alt` overrides
	 *  the document's own alt text; the markdown writer then emits
	 *  `![alt](src)`. */
	interface ImgAttributes {
		src: string;
		alt?: string;
	}

	/** Opaque converter accepted by `ConvertOptions.convertImage`. Construct
	 *  only via `images.imgElement`; never call it directly. */
	interface ImageConverter {
		readonly __mammothImageConverter: unknown;
	}

	/** Conversion options. `convertImage` overrides the default converter
	 *  (which inlines every image as a base64 `data:` URI — the exact behavior
	 *  the figure collector exists to replace). */
	interface ConvertOptions {
		convertImage?: ImageConverter;
	}

	/** Convert a docx document to markdown, mapping Word styles to clean
	 *  markdown structure. Async — mammoth unzips and walks the document. */
	export function convertToMarkdown(
		input: ConvertInput,
		options?: ConvertOptions,
	): Promise<ConversionResult>;

	const mammoth: {
		convertToMarkdown: typeof convertToMarkdown;
		images: {
			/** Wrap a per-image handler into the converter shape
			 *  `ConvertOptions.convertImage` accepts. The handler runs once per
			 *  embedded image, in document order. */
			imgElement(
				handler: (
					image: MammothImage,
				) => ImgAttributes | Promise<ImgAttributes>,
			): ImageConverter;
		};
	};
	export default mammoth;
}
