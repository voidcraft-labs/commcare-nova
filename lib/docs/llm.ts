import { DOCS_BASE_URL } from "./source";

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
