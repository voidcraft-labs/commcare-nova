"use client";

/**
 * Global client-side error reporter — captures unhandled errors and
 * rejected promises from the browser and sends them to the server
 * logging endpoint for GCP Cloud Logging ingestion.
 *
 * Mounted once in the root layout. Renders nothing — pure side effect
 * component that attaches global event listeners on mount and cleans
 * them up on unmount.
 *
 * Capture points:
 * - `window 'error'` — uncaught synchronous JS errors (throws, reference errors)
 * - `window 'unhandledrejection'` — unhandled async promise rejections
 *
 * React error boundaries are wired separately via `reportBoundaryError()`
 * in their respective error.tsx files.
 */

import { useEffect } from "react";
import { reportClientError } from "@/lib/clientErrorReporter";

export function ErrorReporter() {
	useEffect(() => {
		/**
		 * Global error handler — fires on uncaught synchronous JS errors.
		 * The ErrorEvent includes the error object with its stack trace.
		 *
		 * Filters out browser-synthesized warnings that surface as ErrorEvents
		 * but aren't real exceptions — most notably "ResizeObserver loop
		 * completed with undelivered notifications." Chromium dispatches those
		 * with no underlying Error object and no filename, unlike real thrown
		 * errors which always carry an Error instance. Same heuristic Sentry
		 * and similar reporters use.
		 *
		 * Caveat: cross-origin scripts loaded without `crossorigin="anonymous"`
		 * also have their error info stripped to this shape by CORS, so those
		 * would be dropped too. We don't currently load any, and if we do the
		 * correct fix is the script tag, not the reporter.
		 */
		function handleError(event: ErrorEvent) {
			const isSynthesizedWarning = !event.error && !event.filename;
			if (isSynthesizedWarning) return;

			reportClientError({
				message: event.message || "Unknown error",
				stack: event.error?.stack,
				source: "window.onerror",
				url: window.location.href,
			});
		}

		/**
		 * Unhandled promise rejection handler — fires when a promise rejects
		 * without a .catch(). The PromiseRejectionEvent includes the rejection
		 * reason, which may or may not be an Error object.
		 */
		function handleRejection(event: PromiseRejectionEvent) {
			const reason = event.reason;
			const message =
				reason instanceof Error
					? reason.message
					: typeof reason === "string"
						? reason
						: "Unhandled promise rejection";
			const stack = reason instanceof Error ? reason.stack : undefined;

			reportClientError({
				message,
				stack,
				source: "unhandledrejection",
				url: window.location.href,
			});
		}

		window.addEventListener("error", handleError);
		window.addEventListener("unhandledrejection", handleRejection);

		return () => {
			window.removeEventListener("error", handleError);
			window.removeEventListener("unhandledrejection", handleRejection);
		};
	}, []);

	/* Pure side effect — no UI output. */
	return null;
}
