// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { reportClientError } from "@/lib/clientErrorReporter";

vi.mock("@/lib/clientErrorReporter", () => ({
	reportClientError: vi.fn(),
}));

function Broken(): never {
	throw new Error("broken child");
}

describe("ErrorBoundary", () => {
	it("recovers its child tree when the owning screen changes", () => {
		const { rerender } = render(
			<ErrorBoundary resetKey="form-a">
				<Broken />
			</ErrorBoundary>,
		);

		expect(screen.getByText("Something went wrong.")).toBeDefined();
		expect(reportClientError).toHaveBeenCalledTimes(1);

		rerender(
			<ErrorBoundary resetKey="form-b">
				<p>Form B is ready</p>
			</ErrorBoundary>,
		);

		expect(screen.getByText("Form B is ready")).toBeDefined();
	});
});
