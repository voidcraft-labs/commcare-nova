/**
 * LLM-facing surface of the docs site — the helpers that back the
 * `/llms.txt` index and per-page `/llms.mdx/<slug>` Markdown routes.
 *
 * Both depend on `includeProcessedMarkdown: true` in
 * `source.config.ts`: that flag is what gives `page.data.getText`
 * its `"processed"` arm (JSX stripped to plain Markdown). Without
 * it, both helpers compile but fail at request time.
 */

import { DOCS_BASE_URL, type source } from "./source";

/**
 * The fumadocs page type. `$inferPage` is the canonical way to pull
 * the page shape out of a configured loader without re-stating the
 * generics (which would drift from the actual collection config).
 */
type DocsPage = (typeof source)["$inferPage"];

/**
 * Render a page as a self-contained Markdown blob for LLM consumption.
 * The canonical URL is embedded in the H1 so the blob stays
 * self-locating once it leaves our origin (a model holding it in
 * context still knows where it came from).
 */
export async function getLLMText(page: DocsPage): Promise<string> {
	const processed = await page.data.getText("processed");
	return `# ${page.data.title} (${page.url})\n\n${processed}`;
}

/**
 * Resolve the URL of the per-page Markdown route for a given slug.
 *
 * The route file lives at `app/(docs)/docs/llms.mdx/[[...slug]]`. The
 * dev/prod split mirrors `DOCS_BASE_URL`: in prod the docs site is
 * mounted at the subdomain root, so the URL is `/llms.mdx/...`; in
 * dev there is no docs subdomain so it surfaces under the `/docs/`
 * prefix.
 *
 * Empty/undefined slug resolves to bare `/llms.mdx` — targets the
 * docs index page if one exists, otherwise 404s.
 */
export function llmMarkdownUrl(slug: readonly string[] | undefined): string {
	const path = (slug ?? []).filter(Boolean).join("/");
	const trail = path ? `/${path}` : "";
	const prefix = DOCS_BASE_URL === "/" ? "" : DOCS_BASE_URL;
	return `${prefix}/llms.mdx${trail}`;
}
