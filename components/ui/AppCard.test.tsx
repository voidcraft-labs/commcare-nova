// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	activateWithEnter,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import { CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE } from "@/lib/projects/moveTargets";
import { AppCard } from "./AppCard";

vi.mock("@/components/shadcn/tooltip", () => ({
	SimpleTooltip: ({ children }: { children: ReactNode }) => children,
}));

const app = {
	id: "app-1",
	app_name: "Household visits",
	connect_type: null,
	module_count: 1,
	form_count: 2,
	status: "complete" as const,
	updated_at: "2026-07-22T00:00:00.000Z",
	logo: null,
};

describe("AppCard Project-placement information", () => {
	it("uses an enabled 48px keyboard trigger and explains where shared data stays", async () => {
		render(
			<AppCard app={app} index={0} href="/build/app-1" showProjectMoveInfo />,
		);

		const trigger = screen.getByRole("button", {
			name: "About moving Household visits",
		});
		const appLink = screen.getByRole("link", {
			name: "Open Household visits",
		});
		expect(trigger.className).toContain("size-12");
		expect(trigger.className).toContain("focus-visible:ring-3");
		expect(trigger.hasAttribute("disabled")).toBe(false);
		expect(trigger.closest("a")).toBeNull();
		expect(appLink.contains(trigger)).toBe(false);

		activateWithEnter(trigger);
		await settleBaseUiTransitions();
		const title = await screen.findByRole("heading", {
			name: "Moving between Projects",
		});
		expect(document.activeElement).toBe(title);
		expect(
			screen.getByText(CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE),
		).toBeTruthy();

		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		await settleBaseUiTransitions();
		expect(document.activeElement).toBe(trigger);
		expect(
			screen.queryByText(CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE),
		).toBeNull();
	});

	it("includes the app name in each placement control's accessible name", () => {
		render(
			<AppCard
				app={{ ...app, app_name: "Maternal care" }}
				index={0}
				href="/build/app-1"
				showProjectMoveInfo
			/>,
		);

		expect(
			screen.getByRole("button", { name: "About moving Maternal care" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "About moving this app" }),
		).toBeNull();
	});

	it("does not show placement controls to roles that cannot manage apps", () => {
		render(<AppCard app={app} index={0} href="/build/app-1" />);

		expect(
			screen.queryByRole("button", {
				name: "About moving Household visits",
			}),
		).toBeNull();
	});

	it("discloses truncated names and keeps destructive targets at least 44px", () => {
		render(
			<AppCard app={app} index={0} href="/build/app-1" onDelete={vi.fn()} />,
		);

		expect(
			screen.getByRole("heading", { name: app.app_name }).getAttribute("title"),
		).toBe(app.app_name);
		const deleteButton = screen.getByRole("button", { name: "Delete app" });
		expect(deleteButton.className).toContain("size-11");

		fireEvent.click(deleteButton);
		expect(screen.getByRole("button", { name: "Cancel" }).className).toContain(
			"min-h-11",
		);
		expect(
			screen.getByRole("button", { name: "Confirm delete" }).className,
		).toContain("min-h-11");
	});
});
