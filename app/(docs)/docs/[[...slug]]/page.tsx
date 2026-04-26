/**
 * Catch-all docs page. Resolves the requested slug against the fumadocs
 * loader; a miss surfaces as a 404, themed by `not-found.tsx` next door.
 *
 * `<MDX components={getMDXComponents()} />` is required: the explicit
 * prop, not `providerImportSource` context, is what fumadocs's runtime
 * renderer reads.
 */
import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { source } from "@/lib/docs/source";
import { getMDXComponents } from "@/mdx-components";

type PageProps = {
	params: Promise<{
		slug?: string[];
	}>;
};

export function generateStaticParams() {
	return source.generateParams("slug");
}

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

	return (
		<DocsPage toc={page.data.toc}>
			<DocsTitle>{page.data.title}</DocsTitle>
			<DocsDescription>{page.data.description}</DocsDescription>
			<DocsBody>
				<MDX components={getMDXComponents()} />
			</DocsBody>
		</DocsPage>
	);
}
