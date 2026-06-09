"use client";

import NextError from "next/error";
import { useEffect } from "react";
import { reportClientError } from "@/lib/clientErrorReporter";

/**
 * Root error boundary — fires only when the root layout itself crashes,
 * above every route-level boundary. Reports through the shared client
 * funnel (Sentry + Cloud Logging) like every other boundary.
 */
export default function GlobalError({
	error,
}: {
	error: Error & { digest?: string };
}) {
	useEffect(() => {
		reportClientError(
			{
				message: error.message || "Unknown rendering error",
				stack: error.stack,
				source: "error-boundary",
				url: window.location.href,
			},
			error,
		);
	}, [error]);

	return (
		<html lang="en">
			<body>
				{/* `NextError` is the default Next.js error page component. Its type
        definition requires a `statusCode` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
				<NextError statusCode={0} />
			</body>
		</html>
	);
}
