// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthoredDragPreviewLabel } from "../canvas/canvasChrome";

describe("case workspace drag preview chrome", () => {
	it("bounds authored labels without truncating their content", () => {
		const label =
			"PreferredClientNameWithoutNaturalBreaksFromTheMostRecentHouseholdVisit";
		render(<AuthoredDragPreviewLabel>{label}</AuthoredDragPreviewLabel>);

		const previewLabel = screen.getByText(label);
		expect(previewLabel.className).toContain("max-w-60");
		expect(previewLabel.className).toContain("whitespace-normal");
		expect(previewLabel.className).toContain("break-words");
		expect(previewLabel.className).toContain("[overflow-wrap:anywhere]");
		expect(previewLabel.className).not.toContain("truncate");
	});
});
