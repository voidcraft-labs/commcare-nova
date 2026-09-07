import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { AppSummary } from "@/lib/db/apps";
import { AppListBody } from "../app-list-body";

// Server Actions are never invoked during this static markup projection.
// Native authenticated app journeys own delete, restore, tabs and role controls.
vi.mock("../app-actions", () => ({
	deleteApp: vi.fn(),
	restoreApp: vi.fn(),
	moveApp: vi.fn(),
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

it("renders actual card links only for normal apps and server-authorized recovery", () => {
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
	const html = renderToStaticMarkup(
		<AppListBody
			active={[ACTIVE_APP, resumable, terminal]}
			deleted={[]}
			canDeleteApp={false}
			canMoveApp={false}
			moveTargets={[]}
			resumableErrorAppIds={[resumable.id]}
		/>,
	);
	expect(html).toContain('href="/build/active-app"');
	expect(html).toContain('href="/build/resumable-error"');
	expect(html).not.toContain('href="/build/terminal-error"');
	expect(html).toContain("Terminal error");
});
