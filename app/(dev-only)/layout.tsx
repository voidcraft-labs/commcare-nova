import { notFound } from "next/navigation";

/**
 * Route group layout that gates dev-only pages behind NODE_ENV.
 *
 * Pages under (dev-only)/ remain accessible at their normal URLs in
 * development (e.g. /error-test, /signal-test, /xpath-test) but return
 * 404 in production builds. The route group parentheses ensure this
 * directory doesn't create a URL segment.
 */
export default function DevOnlyLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	if (process.env.NODE_ENV === "production") notFound();
	return <>{children}</>;
}
