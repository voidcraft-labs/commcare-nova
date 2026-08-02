import type { DocsLayoutProps } from "fumadocs-ui/layouts/docs";
import { Logo } from "@/components/ui/Logo";
import { DOCS_BASE_URL } from "@/lib/docs/source";

/**
 * Props passed to fumadocs's `DocsLayout`. Split out from the layout
 * component so the layout file stays focused on JSX. Only options that
 * differ from the fumadocs defaults appear here.
 */
export const docsLayoutProps = {
	nav: {
		/* The brand mark, not a plain string: the docs site is the same
		 * product, and the header everywhere else carries the logomark and
		 * the two-tone wordmark. `animate={false}` because a breathing mark
		 * in a dense docs rail is noise rather than presence. */
		title: (
			<span className="flex items-center gap-2">
				<Logo size="sm" animate={false} />
				<span className="text-nova-text-secondary">docs</span>
			</span>
		),
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
