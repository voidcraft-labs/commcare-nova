/**
 * Catch-all docs page. Resolves the requested slug against the fumadocs
 * loader; a miss surfaces as a 404, themed by `not-found.tsx` next door.
 *
 * `<MDX components={getMDXComponents()} />` is required: the explicit
 * prop, not `providerImportSource` context, is what fumadocs's runtime
 * renderer reads.
 *
 * `dynamic = "force-dynamic"` is load-bearing, not a perf default we
 * forgot to remove. The proxy stamps a per-request `'strict-dynamic'`
 * nonce CSP onto every HTML response (see `proxy.ts`), and Next.js can
 * only attach that nonce to the inline RSC payload chunks
 * (`self.__next_f.push(...)`) it emits when a page renders at request
 * time — SSG bakes them at build time, with no request and no nonce, so
 * the browser then blocks them and React never hydrates. The cost of
 * dynamic rendering here is trivial: pure MDX → HTML, no DB, no session
 * lookup; the docs layout deliberately doesn't read the session for
 * exactly this reason.
 */
import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { source } from "@/lib/docs/source";
import { getMDXComponents } from "@/mdx-components";

/* See top-of-file comment — required so the proxy's per-request nonce
 * lands on Next's inline RSC chunks. Removing this re-breaks the docs
 * site under the strict CSP. */
export const dynamic = "force-dynamic";

type PageProps = {
	params: Promise<{
		slug?: string[];
	}>;
};

export async function generateMetadata({
	params,
}: PageProps): Promise<Metadata> {
	const { slug } = await params;
	const page = source.getPage(slug);

	if (!page) {
		return {};
	}

	return {
		title: page.data.title,
		description: page.data.description,
	};
}

export default async function Page({ params }: PageProps) {
	const { slug } = await params;
	const page = source.getPage(slug);

	if (!page) {
		notFound();
	}

	const MDX = page.data.body;

	/* `createRelativeLink` rewrites href values that point at sibling
	 * `.mdx` files into the correct routed URL for the current page.
	 * Required because the docs site mounts at `/docs` in dev and `/`
	 * (the docs subdomain root) in prod — hardcoded absolute hrefs would
	 * break in dev. Authors write `[Link](./other.mdx)`; this resolves
	 * it through the same loader fumadocs uses for sidebar/nav links.
	 * Server-component-only API. */
	return (
		<DocsPage toc={page.data.toc}>
			<DocsTitle>{page.data.title}</DocsTitle>
			<DocsDescription>{page.data.description}</DocsDescription>
			<DocsBody>
				<MDX
					components={getMDXComponents({
						a: createRelativeLink(source, page),
					})}
				/>
			</DocsBody>
		</DocsPage>
	);
}
