import { llms, loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

/**
 * Base path fumadocs uses to generate sidebar/nav hrefs. In prod the
 * docs site is mounted at the subdomain root (`/`), so links read like
 * `/claude-code/quickstart` and the proxy rewrites them onto the
 * internal `/docs/[[...slug]]` route. In dev there's no docs subdomain,
 * so links have to point at the internal `/docs/...` path directly —
 * otherwise every sidebar click 404s on `localhost:3000`.
 *
 * Exported so `layoutProps.tsx` can reuse it for the nav home link
 * without re-deriving the env check.
 */
export const DOCS_BASE_URL =
	process.env.NODE_ENV === "development" ? "/docs" : "/";

export const source = loader({
	baseUrl: DOCS_BASE_URL,
	source: docs.toFumadocsSource(),
});

/**
 * The LLM-facing renderings of the docs: the `llms.txt` index, each page as
 * Markdown, and every page in one file. A page's canonical URL sits in its H1 so
 * the text stays self-locating once it leaves our origin.
 *
 * `getText("processed")` (JSX stripped to plain Markdown) exists only because
 * `source.config.ts` sets `includeProcessedMarkdown: true`; without it this
 * compiles and fails at request time.
 */
export const docsLlms = llms(source, {
	renderPage: async (page) =>
		`# ${page.data.title} (${page.url})\n\n${await page.data.getText("processed")}`,
});
