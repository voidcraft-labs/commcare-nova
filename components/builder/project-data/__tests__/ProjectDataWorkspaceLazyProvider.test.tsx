// @vitest-environment happy-dom

import { render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	type ProjectDataWorkspaceControllerBridgeProps,
	ProjectDataWorkspaceProvider,
	useProjectDataWorkspace,
} from "../ProjectDataWorkspaceLazyProvider";
import type { ProjectDataWorkspace } from "../ProjectDataWorkspaceProvider";

let routeKind = "home";
let tableId: LookupTableId | undefined;

vi.mock("@/lib/routing/hooks", () => ({
	useLocationKind: () => routeKind,
	useSelectedProjectDataTableId: () => tableId,
}));

afterEach(() => {
	routeKind = "home";
	tableId = undefined;
});

const workspace = {
	active: true,
	tableId: "table-1" as LookupTableId,
} as ProjectDataWorkspace;

let controllerMounts = 0;
let controllerUnmounts = 0;

function Controller({
	projectDataRoute,
	workspaceStore,
}: ProjectDataWorkspaceControllerBridgeProps) {
	useLayoutEffect(() => {
		controllerMounts += 1;
		return () => {
			controllerUnmounts += 1;
		};
	}, []);
	useLayoutEffect(() => {
		workspaceStore.publish(workspace);
		return () => workspaceStore.publish(null);
	}, [workspaceStore]);
	return <output>{projectDataRoute ? "active" : "retained"}</output>;
}

function Consumer() {
	const value = useProjectDataWorkspace();
	return <span>{value?.tableId ?? "no workspace"}</span>;
}

function StableChild() {
	const mounts = useRef(0);
	mounts.current += 1;
	return <span data-testid="child-renders">{mounts.current}</span>;
}

describe("ProjectDataWorkspaceProvider", () => {
	it("loads on the first Project data route and retains the controller without remounting children", async () => {
		controllerMounts = 0;
		controllerUnmounts = 0;
		const view = render(
			<ProjectDataWorkspaceProvider controllerComponent={Controller}>
				<StableChild />
				<Consumer />
			</ProjectDataWorkspaceProvider>,
		);

		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByText("no workspace")).toBeTruthy();
		expect(controllerMounts).toBe(0);

		routeKind = "project-data";
		tableId = "table-1" as LookupTableId;
		view.rerender(
			<ProjectDataWorkspaceProvider controllerComponent={Controller}>
				<StableChild />
				<Consumer />
			</ProjectDataWorkspaceProvider>,
		);

		await waitFor(() => expect(screen.getByText("table-1")).toBeTruthy());
		expect(screen.getByText("active")).toBeTruthy();
		expect(controllerMounts).toBe(1);
		expect(controllerUnmounts).toBe(0);

		routeKind = "home";
		tableId = undefined;
		view.rerender(
			<ProjectDataWorkspaceProvider controllerComponent={Controller}>
				<StableChild />
				<Consumer />
			</ProjectDataWorkspaceProvider>,
		);

		expect(screen.getByText("retained")).toBeTruthy();
		expect(screen.getByText("table-1")).toBeTruthy();
		expect(controllerMounts).toBe(1);
		expect(controllerUnmounts).toBe(0);
		expect(screen.getByTestId("child-renders").textContent).toBe("3");
	});
});
