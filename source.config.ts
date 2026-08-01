import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import {
	NOVA_CODE_THEME_DARK,
	NOVA_CODE_THEME_LIGHT,
} from "./lib/docs/shikiTheme";

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
		/* fumadocs defaults to GitHub Light/Dark, which puts blues on JSON
		 * keys and a salmon on shell keywords. Nova publishes its own code
		 * palette and no borrowed blues, so both slots take it; the app is
		 * dark-only, so there is no light mode to serve. */
		rehypeCodeOptions: {
			themes: { light: NOVA_CODE_THEME_LIGHT, dark: NOVA_CODE_THEME_DARK },
		},
	},
});
