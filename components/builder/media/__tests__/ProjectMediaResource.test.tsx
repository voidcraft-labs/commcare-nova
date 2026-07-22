// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ProjectMediaAudio,
	ProjectMediaImage,
} from "@/components/builder/media/ProjectMediaResource";
import {
	ReconcilerContext,
	type ReconcilerContextValue,
} from "@/lib/collab/context";
import { createProjectScopeResetRegistry } from "@/lib/collab/projectScopeReset";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

afterEach(() => vi.restoreAllMocks());

describe("Project media resources", () => {
	it("retires source pixels and playback synchronously, then remounts a freshly authorized URL", () => {
		const pause = vi
			.spyOn(HTMLMediaElement.prototype, "pause")
			.mockImplementation(() => undefined);
		const load = vi
			.spyOn(HTMLMediaElement.prototype, "load")
			.mockImplementation(() => undefined);
		const store = createBuilderSessionStore({
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const registry = createProjectScopeResetRegistry();
		const reconciler = {
			subscribeProjectScopeReset: registry.subscribe,
			isProjectScopeCurrent: registry.isCurrent,
		} as ReconcilerContextValue;

		render(
			<BuilderSessionContext value={store}>
				<ReconcilerContext value={reconciler}>
					<ProjectMediaImage assetId="source-image" alt="Source image" />
					<ProjectMediaAudio
						assetId="source-audio"
						aria-label="Source audio"
						controls
					/>
				</ReconcilerContext>
			</BuilderSessionContext>,
		);
		const sourceImage = screen.getByRole("img", { name: "Source image" });
		const sourceAudio = screen.getByLabelText("Source audio");
		expect(sourceImage.getAttribute("src")).toBe(
			"/api/media/source-image?scope=0",
		);
		expect(sourceAudio.getAttribute("src")).toBe(
			"/api/media/source-audio?scope=0",
		);

		act(() => {
			const epoch = store.getState().beginAccessRefresh();
			registry.reset(epoch);
			/* These assertions run inside the reset stack, before React commits the
			 * unresolved-access render. No decoded source or player survives it. */
			expect(sourceImage.hasAttribute("src")).toBe(false);
			expect(sourceAudio.hasAttribute("src")).toBe(false);
			expect(pause).toHaveBeenCalledOnce();
			expect(load).toHaveBeenCalledOnce();
		});
		expect(screen.queryByRole("img", { name: "Source image" })).toBeNull();
		expect(screen.queryByLabelText("Source audio")).toBeNull();

		act(() => {
			store.getState().applyAccessSnapshot({
				projectId: "project-destination",
				role: "editor",
				canEdit: true,
			});
		});
		const destinationImage = screen.getByRole("img", {
			name: "Source image",
		});
		const destinationAudio = screen.getByLabelText("Source audio");
		expect(destinationImage).not.toBe(sourceImage);
		expect(destinationAudio).not.toBe(sourceAudio);
		expect(destinationImage.getAttribute("src")).toBe(
			"/api/media/source-image?scope=1",
		);
		expect(destinationAudio.getAttribute("src")).toBe(
			"/api/media/source-audio?scope=1",
		);
	});
});
