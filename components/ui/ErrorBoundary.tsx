"use client";
import React from "react";
import { reportClientError } from "@/lib/clientErrorReporter";

interface ErrorBoundaryProps {
	fallback?: React.ReactNode;
	/** Changing this value retires a caught child-tree failure. Use a stable
	 * screen/location identity so navigation can recover without reloading the
	 * whole app. */
	resetKey?: string;
	children: React.ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error?: Error;
}

/**
 * Catches render errors in children and displays a fallback instead of
 * crashing the whole tree. Reports the error through the shared client
 * error funnel so component-level crashes reach Sentry and Cloud Logging.
 */
export class ErrorBoundary extends React.Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error) {
		reportClientError(
			{
				message: error.message || "Component rendering error",
				stack: error.stack,
				source: "error-boundary",
				url: typeof window !== "undefined" ? window.location.href : "",
			},
			error,
		);
	}

	componentDidUpdate(previous: ErrorBoundaryProps) {
		if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
			this.setState({ hasError: false, error: undefined });
		}
	}

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) return this.props.fallback;
			return (
				<div className="flex items-center justify-center p-6 text-sm text-nova-text-muted">
					Something went wrong.
				</div>
			);
		}
		return this.props.children;
	}
}
