import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
	dir: "content/docs",
	docs: {
		/* `includeProcessedMarkdown` runs the `remarkLLMs` plugin against
		 * each page during the MDX postprocess phase and exposes the
		 * stringified result via `page.data.getText("processed")`. The
		 * "processed" snapshot has JSX components stripped down to plain
		 * Markdown — exactly what the `/llms.mdx/[[...slug]]` route and
		 * the `MarkdownCopyButton` need to hand off to an LLM. Without
		 * this flag, `getText("processed")` would not exist on the page
		 * data type and the LLM-facing routes would have no usable
		 * source content. */
		postprocess: {
			includeProcessedMarkdown: true,
		},
	},
});

export default defineConfig({
	mdxOptions: {
		providerImportSource: "@/mdx-components",
	},
});
