/**
 * MDX component map for the docs site.
 *
 * `getMDXComponents` is what `<MDX components={...} />` consumes inside
 * `app/(docs)/docs/[[...slug]]/page.tsx`. The fumadocs defaults cover
 * Markdown primitives (headings, code blocks, tables); the additions
 * below are the styled components the MDX content actually references.
 *
 * `useMDXComponents` is also exported for the `providerImportSource`
 * flow (see `source.config.ts`) so MDX rendered without an explicit
 * `components` prop still gets the same map via context.
 */
import { Callout } from "fumadocs-ui/components/callout";
import { Step, Steps } from "fumadocs-ui/components/steps";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
	return {
		...defaultMdxComponents,
		Callout,
		Steps,
		Step,
		...components,
	};
}

export const useMDXComponents = getMDXComponents;
