// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AppSummary, DeletedAppSummary } from "@/lib/db/apps";
import { AppListBody } from "../app-list-body";

const mocks = vi.hoisted(() => ({
	deleteApp: vi.fn(),
	restoreApp: vi.fn(),
}));

vi.mock("../app-actions", () => ({
	deleteApp: mocks.deleteApp,
	restoreApp: mocks.restoreApp,
}));

vi.mock("@/components/ui/AppCard", () => ({
	AppCard: ({
		app,
		onDelete,
		href,
	}: ComponentProps<"button"> & {
		app: AppSummary;
		onDelete?: unknown;
		href?: string;
	}) => (
		<>
			<div data-testid={`href-${app.id}`}>{href ?? "disabled"}</div>
			<button
				type="button"
				aria-label={`Delete ${app.app_name}`}
				hidden={!onDelete}
			/>
		</>
	),
}));

vi.mock("@/components/ui/DeletedAppCard", () => ({
	DeletedAppCard: ({
		app,
		onRestore,
	}: {
		app: DeletedAppSummary;
		onRestore?: unknown;
	}) => (
		<button
			type="button"
			aria-label={`Restore ${app.app_name}`}
			hidden={!onRestore}
		/>
	),
}));

const ACTIVE_APP: AppSummary = {
	id: "active-app",
	project_id: "proj-1",
	app_name: "Active app",
	connect_type: null,
	module_count: 1,
	form_count: 1,
	status: "complete",
	logo: null,
	error_type: null,
	created_at: "2026-07-22T00:00:00.000Z",
	updated_at: "2026-07-22T00:00:00.000Z",
};

const DELETED_APP: DeletedAppSummary = {
	...ACTIVE_APP,
	id: "deleted-app",
	app_name: "Deleted app",
	deleted_at: "2026-07-21T00:00:00.000Z",
	recoverable_until: "2026-08-20T00:00:00.000Z",
};

function renderList(
	canDeleteApp: boolean,
	args: { active?: AppSummary[]; resumableErrorAppIds?: string[] } = {},
) {
	return render(
		<AppListBody
			active={args.active ?? [ACTIVE_APP]}
			deleted={[DELETED_APP]}
			canDeleteApp={canDeleteApp}
			canMoveApp={false}
			moveTargets={[]}
			resumableErrorAppIds={args.resumableErrorAppIds ?? []}
		/>,
	);
}

describe("AppListBody Project capability affordances", () => {
	it("keeps delete and restore controls out of the view-only list", () => {
		renderList(false);

		expect(
			screen.queryByRole("button", { name: "Delete Active app" }),
		).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: /Recently deleted/ }));
		expect(
			screen.queryByRole("button", { name: "Restore Deleted app" }),
		).toBeNull();
	});

	it("provides delete and restore controls to Project admins and owners", () => {
		renderList(true);

		expect(
			screen.getByRole("button", { name: "Delete Active app" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: /Recently deleted/ }));
		expect(
			screen.getByRole("button", { name: "Restore Deleted app" }),
		).toBeTruthy();
	});

	it("links only error apps with server-proven recovery state", () => {
		const resumable = {
			...ACTIVE_APP,
			id: "resumable-error",
			app_name: "Resumable error",
			status: "error" as const,
		};
		const terminal = {
			...ACTIVE_APP,
			id: "terminal-error",
			app_name: "Terminal error",
			status: "error" as const,
		};
		renderList(false, {
			active: [ACTIVE_APP, resumable, terminal],
			resumableErrorAppIds: [resumable.id],
		});

		expect(screen.getByTestId("href-active-app").textContent).toBe(
			"/build/active-app",
		);
		expect(screen.getByTestId("href-resumable-error").textContent).toBe(
			"/build/resumable-error",
		);
		expect(screen.getByTestId("href-terminal-error").textContent).toBe(
			"disabled",
		);
	});
});
