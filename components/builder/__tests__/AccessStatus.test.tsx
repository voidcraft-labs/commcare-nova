// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vitest";
import {
	BuilderAccessBoundary,
	BuilderAccessGate,
	BuilderAccessStatus,
} from "@/components/builder/AccessStatus";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

describe("builder access status", () => {
	it("announces and labels a viewer without treating it as an error", () => {
		const store = createBuilderSessionStore({
			projectId: "project-1",
			role: "viewer",
			canEdit: false,
		});
		render(
			<BuilderSessionContext value={store}>
				<BuilderAccessStatus />
			</BuilderSessionContext>,
		);

		expect(screen.getByText("View only")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain(
			"View-only access",
		);

		act(() => {
			store
				.getState()
				.applyAccessSnapshot(
					{ projectId: "project-1", role: "viewer", canEdit: false },
					{ hasWaitingChanges: true },
				);
		});
		expect(screen.getByText("View only · Changes kept")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain(
			"Your changes are kept in this tab",
		);
	});

	it("masks unresolved scope and distinguishes an upgrade from access loss", () => {
		const store = createBuilderSessionStore({
			projectId: "project-1",
			role: "editor",
			canEdit: true,
		});
		const view = render(
			<BuilderSessionContext value={store}>
				<BuilderAccessBoundary />
			</BuilderSessionContext>,
		);

		act(() => {
			store.getState().beginAccessRefresh();
		});
		expect(
			screen.getByRole("heading", { name: "Refreshing app" }),
		).toBeTruthy();
		expect(
			screen.getByText(/waiting to save are still kept/i).closest("[hidden]"),
		).toBeNull();

		act(() => {
			store.getState().requireClientUpgrade();
		});
		expect(
			screen.getByRole("heading", { name: "Nova needs to refresh" }),
		).toBeTruthy();
		const refresh = screen.getByRole("button", { name: "Refresh Nova" });
		expect(refresh.closest("[hidden]")).toBeNull();
		expect(refresh.classList.contains("h-11")).toBe(true);

		view.unmount();
	});

	it("keeps local UI mounted through reversible refreshes and unmounts it on confirmed loss", () => {
		const store = createBuilderSessionStore({
			projectId: "project-1",
			role: "editor",
			canEdit: true,
		});
		let unmounts = 0;
		function LocalDraft() {
			useEffect(
				() => () => {
					unmounts += 1;
				},
				[],
			);
			return <input aria-label="Local draft" defaultValue="kept" />;
		}

		const view = render(
			<BuilderSessionContext value={store}>
				<BuilderAccessGate>
					<LocalDraft />
				</BuilderAccessGate>
			</BuilderSessionContext>,
		);
		const draft = screen.getByLabelText("Local draft");

		act(() => {
			store.getState().beginAccessRefresh();
		});
		expect(draft.isConnected).toBe(true);
		expect(draft.closest("[inert]")).not.toBeNull();
		expect(unmounts).toBe(0);
		expect(
			screen.getByRole("heading", { name: "Refreshing app" }),
		).toBeTruthy();

		act(() => {
			store.getState().markAccessReconnecting();
		});
		expect(draft.isConnected).toBe(true);
		expect(unmounts).toBe(0);

		act(() => {
			store.getState().revokeAccess();
		});
		expect(screen.queryByLabelText("Local draft")).toBeNull();
		expect(unmounts).toBe(1);
		expect(
			screen.getByRole("heading", {
				name: "This app is no longer available",
			}),
		).toBeTruthy();

		view.unmount();
	});

	it("permanently quarantines a body portal from the source Project generation", () => {
		const store = createBuilderSessionStore({
			projectId: "project-1",
			role: "editor",
			canEdit: true,
		});
		const portalRoot = document.createElement("div");
		document.body.append(portalRoot);

		function SourcePortal() {
			return createPortal(
				<button type="button">Source Project action</button>,
				portalRoot,
			);
		}

		const view = render(
			<div data-nova-app-shell>
				<BuilderSessionContext value={store}>
					<BuilderAccessGate>
						<SourcePortal />
					</BuilderAccessGate>
				</BuilderSessionContext>
			</div>,
		);

		act(() => {
			store.getState().beginAccessRefresh();
		});
		expect(portalRoot.hasAttribute("data-nova-access-quarantined")).toBe(true);
		expect(portalRoot.hidden).toBe(true);
		expect(portalRoot).toHaveProperty("inert", true);
		expect(portalRoot.style.getPropertyValue("display")).toBe("none");
		expect(portalRoot.style.getPropertyPriority("display")).toBe("important");

		act(() => {
			store.getState().applyAccessSnapshot({
				projectId: "project-2",
				role: "editor",
				canEdit: true,
			});
			/* Simulate a retained controlled portal trying to reopen its original
			 * root after the destination Project becomes authorized. */
			portalRoot.hidden = false;
		});
		expect(portalRoot.hidden).toBe(false);
		expect(portalRoot.hasAttribute("data-nova-access-quarantined")).toBe(true);
		expect(portalRoot.style.getPropertyValue("display")).toBe("none");
		expect(portalRoot.style.getPropertyPriority("display")).toBe("important");

		view.unmount();
		portalRoot.remove();
	});
});
