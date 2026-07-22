// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "@/lib/projects/membership";
import { AppHeader } from "./AppHeader";

vi.mock("@/components/ui/AccountMenu", () => ({
	AccountMenu: () => {
		const [filesOpen, setFilesOpen] = useState(false);
		return (
			<>
				<button type="button" onClick={() => setFilesOpen(true)}>
					Open files
				</button>
				{filesOpen ? (
					<div role="dialog" aria-label="Files">
						Files
					</div>
				) : null}
			</>
		);
	},
}));

vi.mock("@/components/ui/HeaderNav", () => ({
	HeaderNavLinks: () => null,
}));
vi.mock("@/components/ui/HelpMenu", () => ({ HelpMenu: () => null }));
vi.mock("@/components/ui/ImpersonationBanner", () => ({
	ImpersonationBanner: () => null,
}));
vi.mock("@/components/ui/Logo", () => ({ Logo: () => <span>Nova</span> }));
vi.mock("@/components/ui/ProjectSwitcher", () => ({
	ProjectSwitcher: () => null,
}));

const PROJECTS: ProjectSummary[] = [
	{
		id: "project-a",
		name: "Project A",
		slug: "project-a",
		role: "editor",
		personal: false,
	},
	{
		id: "project-b",
		name: "Project B",
		slug: "project-b",
		role: "editor",
		personal: false,
	},
];

describe("AppHeader Project scope", () => {
	it("closes and resets Files when the active Project changes", () => {
		const props = {
			isAdmin: false,
			isAuthenticated: true,
			impersonating: null,
			projects: PROJECTS,
		};
		const view = render(<AppHeader {...props} activeProjectId="project-a" />);

		fireEvent.click(screen.getByRole("button", { name: "Open files" }));
		expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();

		view.rerender(<AppHeader {...props} activeProjectId="project-b" />);

		expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
	});
});
