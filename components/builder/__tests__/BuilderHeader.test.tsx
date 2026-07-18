// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	compact: true,
	ultraCompact: false,
	undo: vi.fn(),
	redo: vi.fn(),
}));

vi.mock("@/components/builder/ExportPanel", () => ({
	ExportPanel: () => <button type="button">Export</button>,
}));
vi.mock("@/components/builder/PresenceRoster", () => ({
	PresenceRoster: ({ compact }: { compact?: boolean }) => (
		<button type="button" data-compact={compact || undefined}>
			5 collaborators here
		</button>
	),
}));
vi.mock("@/components/builder/PreviewToggle", () => ({
	PreviewToggle: () => <button type="button">Preview</button>,
}));
vi.mock("@/components/builder/SaveIndicator", () => ({
	SaveIndicator: ({ compact }: { compact?: boolean }) => (
		<span data-testid="save-status" data-compact={compact || undefined} />
	),
}));
vi.mock("@/components/ui/AccountMenu", () => ({
	AccountMenu: () => <button type="button">Account menu</button>,
}));
vi.mock("@/components/ui/ImpersonationBanner", () => ({
	ImpersonationBanner: () => null,
}));
vi.mock("@/components/ui/Logo", () => ({
	Logo: ({ markOnly }: { markOnly?: boolean }) => (
		<span data-testid="logo" data-mark-only={markOnly || undefined}>
			commcare nova
		</span>
	),
}));
vi.mock("@/lib/doc/hooks/useDocHasData", () => ({
	useDocHasData: () => true,
}));
vi.mock("@/lib/doc/hooks/useUndoRedo", () => ({
	useCanRedo: () => true,
	useCanUndo: () => true,
}));
vi.mock("@/lib/routing/builderActions", () => ({
	useUndoRedo: () => ({ undo: mocks.undo, redo: mocks.redo }),
}));
vi.mock("@/lib/session/hooks", () => ({
	useBuilderIsReady: () => true,
	useCanEdit: () => true,
}));
vi.mock("@/lib/ui/hooks/useIsBreakpoint", () => ({
	useIsBreakpoint: (_mode: string, breakpoint: number) =>
		breakpoint === 1100
			? mocks.compact
			: breakpoint === 560
				? mocks.ultraCompact
				: false,
}));

import { BuilderHeader } from "@/components/builder/BuilderHeader";

describe("BuilderHeader responsive actions", () => {
	beforeEach(() => {
		mocks.compact = true;
		mocks.ultraCompact = false;
	});

	it("keeps the centered preview and every header function reachable with compact peers", () => {
		render(
			<BuilderHeader
				commcareConfigured={false}
				commcareAvailableDomains={[]}
				onSetPreviewing={() => {}}
				impersonating={null}
			/>,
		);

		const home = screen.getByRole("link", { name: "Back to applications" });
		expect(home.className).toContain("min-h-11");
		expect(home.className).toContain("min-w-11");
		expect(
			screen.getByRole("button", { name: "5 collaborators here" }).dataset
				.compact,
		).toBe("true");
		expect(screen.getByTestId("save-status").dataset.compact).toBe("true");
		const history = screen.getByRole("button", { name: "Edit history" });
		expect(history.className).toContain("size-11");
		expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Redo" })).toBeNull();
		expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
	});

	it("moves document actions to a second row and keeps only the mark beside Preview on very narrow screens", () => {
		mocks.ultraCompact = true;
		const { container } = render(
			<BuilderHeader
				commcareConfigured={false}
				commcareAvailableDomains={[]}
				onSetPreviewing={() => {}}
				impersonating={null}
			/>,
		);

		expect(container.querySelector("header")?.dataset.headerLayout).toBe(
			"ultra-compact",
		);
		expect(container.querySelector("header")?.className).toContain(
			"grid-rows-[60px_auto]",
		);
		expect(screen.getByTestId("logo").dataset.markOnly).toBe("true");
		const actions = container.querySelector<HTMLElement>(
			"[data-header-document-actions]",
		);
		expect(actions?.className).toContain("row-start-2");
		expect(actions?.className).toContain("border-t");
		expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Edit history" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
	});
});
