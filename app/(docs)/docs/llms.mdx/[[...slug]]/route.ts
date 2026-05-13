/**
 * Per-page Markdown route — the LLM-readable counterpart to every
 * page rendered by `app/(docs)/docs/[[...slug]]/page.tsx`.
 *
 * Why a sibling tree rather than `<page>.mdx`: Next.js' file-system
 * router can't match a `.mdx` suffix on a dynamic segment without a
 * parallel `next.config` rewrite. A dedicated `/llms.mdx/...` tree
 * ships the same capability with one fewer moving piece.
 *
 * Wire path on each environment:
 *   - prod: `https://docs.commcare.app/llms.mdx/<slug>` — the docs
 *     subdomain proxy rewrites it to the internal `/docs/llms.mdx/<slug>`
 *     route the file lives at (see `proxy.ts`).
 *   - dev:  `http://localhost:3000/docs/llms.mdx/<slug>` — the dev
 *     `/docs` bypass in `proxy.ts` lets it through unrewritten.
 *
 * `revalidate = false` + `generateStaticParams` make every page's
 * Markdown a build-time-cached static artifact, since processed
 * page bodies only change on a fresh build.
 */

import { notFound } from "next/navigation";
import { getLLMText } from "@/lib/docs/llm";
import { source } from "@/lib/docs/source";

export const revalidate = false;

type RouteContext = { params: Promise<{ slug?: string[] }> };

export async function GET(_req: Request, { params }: RouteContext) {
	const { slug } = await params;
	const page = source.getPage(slug);
	if (!page) notFound();

	return new Response(await getLLMText(page), {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
		},
	});
}

export function generateStaticParams() {
	return source.generateParams();
}
