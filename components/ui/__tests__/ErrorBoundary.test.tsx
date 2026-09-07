// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { reportClientError } from "@/lib/clientErrorReporter";

vi.mock("@/lib/clientErrorReporter", () => ({
	reportClientError: vi.fn(),
}));

const renderError = new Error("broken child");
function Broken(): never {
	throw renderError;
}

describe("ErrorBoundary", () => {
	it("recovers its child tree when the owning screen changes", () => {
		const { rerender } = render(
			<ErrorBoundary resetKey="form-a">
				<Broken />
			</ErrorBoundary>,
		);

		expect(screen.getByText("Something went wrong.")).toBeDefined();
		expect(reportClientError).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				message: "broken child",
				source: "error-boundary",
			}),
			renderError,
		);
		rerender(
			<ErrorBoundary resetKey="form-a">
				<p>Same screen would retry</p>
			</ErrorBoundary>,
		);
		expect(screen.queryByText("Same screen would retry")).toBeNull();

		rerender(
			<ErrorBoundary resetKey="form-b">
				<p>Form B is ready</p>
			</ErrorBoundary>,
		);

		expect(screen.getByText("Form B is ready")).toBeDefined();
	});
});
