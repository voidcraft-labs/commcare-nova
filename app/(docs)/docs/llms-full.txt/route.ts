/**
 * `llms-full.txt`: every docs page as Markdown in one file, for a model
 * that wants the whole manual in context rather than following the
 * `llms.txt` index page by page.
 *
 * Wire path on each environment:
 *   - prod: `https://docs.commcare.app/llms-full.txt`, the docs subdomain
 *     proxy rewrites it to the internal `/docs/llms-full.txt` route the
 *     file lives at (see `proxy.ts`).
 *   - dev:  `http://localhost:3000/docs/llms-full.txt`, the dev `/docs`
 *     bypass in `proxy.ts` lets it through unrewritten.
 *
 * `revalidate = false` makes the response a fully-cached static
 * artifact: the contents only change on a fresh build.
 */

import { docsLlms } from "@/lib/docs/source";

export const revalidate = false;

export async function GET(): Promise<Response> {
	return new Response(await docsLlms.full(), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}
