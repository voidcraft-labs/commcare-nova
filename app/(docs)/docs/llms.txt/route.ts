/**
 * `llms.txt` index — the LLM-discovery convention defined by the
 * llmstxt.org proposal. AI tools fetch `<origin>/llms.txt` to find
 * per-page Markdown URLs without having to scrape rendered HTML.
 *
 * `fumadocs-core/source` ships an `llms()` helper that walks the
 * configured page tree and emits the index in canonical shape; the
 * route just exposes the bytes at the path the convention expects.
 *
 * Wire path on each environment:
 *   - prod: `https://docs.commcare.app/llms.txt` — the docs subdomain
 *     proxy rewrites it to the internal `/docs/llms.txt` route the
 *     file lives at (see `proxy.ts`).
 *   - dev:  `http://localhost:3000/docs/llms.txt` — the dev `/docs`
 *     bypass in `proxy.ts` lets it through unrewritten.
 *
 * `revalidate = false` makes the response a fully-cached static
 * artifact — the contents only change on a fresh build.
 */

import { llms } from "fumadocs-core/source";
import { source } from "@/lib/docs/source";

export const revalidate = false;

export function GET(): Response {
	return new Response(llms(source).index(), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}
