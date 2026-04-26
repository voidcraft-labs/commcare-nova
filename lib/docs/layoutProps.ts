import type { DocsLayoutProps } from "fumadocs-ui/layouts/docs";
import { DOCS_BASE_URL } from "@/lib/docs/source";

/**
 * Props passed to fumadocs's `DocsLayout`. Split out from the layout
 * component so the layout file stays focused on JSX. Only options that
 * differ from the fumadocs defaults appear here.
 */
export const docsLayoutProps = {
	nav: {
		title: "CommCare Nova Docs",
		/* Anchored to the same root fumadocs uses for page-tree hrefs so
		 * the nav "home" link resolves to the correct URL in both prod
		 * (`/`) and dev (`/docs`). */
		url: DOCS_BASE_URL,
	},
	/* Nova is dark-only across the rest of the app, so the docs site
	 * doesn't expose a theme picker. Hardcoding `<html class="dark">`
	 * in the root layout keeps the visual; this option just hides the
	 * unused toggle from the sidebar. */
	themeSwitch: {
		enabled: false,
	},
	sidebar: {
		defaultOpenLevel: 1,
	},
} satisfies Omit<DocsLayoutProps, "tree" | "children">;
