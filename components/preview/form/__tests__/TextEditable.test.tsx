// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CommitOutcome, ProseTemplate } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { TextEditable } from "../TextEditable";

vi.mock("@/lib/session/hooks", () => ({
	usePreviewing: () => false,
	useCanEdit: () => true,
}));

vi.mock("../InlineTextEditor", () => ({
	InlineTextEditor: ({
		onSave,
	}: {
		onSave: (value: ProseTemplate) => CommitOutcome | undefined;
	}) => (
		<button type="button" onClick={() => onSave(proseText("Changed"))}>
			Commit draft
		</button>
	),
}));

describe("TextEditable", () => {
	it("keeps a rejected draft open and explains that it was not saved", () => {
		const onSave = vi.fn(
			(): CommitOutcome => ({
				ok: false,
				messages: ["Keep every protected reference once."],
			}),
		);
		render(
			<TextEditable
				value={proseText("Original")}
				onSave={onSave}
				fieldType="label"
			>
				Original
			</TextEditable>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Original" }));
		fireEvent.click(screen.getByRole("button", { name: "Commit draft" }));

		expect(onSave).toHaveBeenCalledWith(proseText("Changed"));
		expect(screen.getByRole("button", { name: "Commit draft" })).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain(
			"Keep every protected reference once.",
		);
	});
});
