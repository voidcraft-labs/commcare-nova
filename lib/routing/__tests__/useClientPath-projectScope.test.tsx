// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	activateBuilderHistoryScope,
	deactivateBuilderHistoryScope,
	pushBuilderHistory,
	useBuilderPathSegments,
} from "@/lib/routing/useClientPath";

afterEach(() => {
	for (const scopeId of ["history-test", "runtime-b", "runtime-a-new"]) {
		deactivateBuilderHistoryScope(scopeId);
	}
});

describe("Project-scoped builder history", () => {
	it("preserves and stamps a freshly loaded direct case deep link", () => {
		window.history.replaceState(
			null,
			"",
			"/build/app-1/module-1/cases/current-case",
		);
		activateBuilderHistoryScope("history-test", "app-1", 0);
		expect(window.location.pathname).toBe(
			"/build/app-1/module-1/cases/current-case",
		);
		expect(window.history.state).toMatchObject({
			__novaProjectScope: { scopeId: "history-test", appId: "app-1", epoch: 0 },
		});
	});

	it("scrubs current and back-forward source case ids before path subscribers see them", () => {
		window.history.replaceState(null, "", "/build/app-1/module-1/results");
		const view = renderHook(() => useBuilderPathSegments());
		activateBuilderHistoryScope("history-test", "app-1", 0);
		pushBuilderHistory("/build/app-1/module-1/cases/source-case");
		expect(view.result.current).toEqual(["module-1", "cases", "source-case"]);

		act(() => activateBuilderHistoryScope("history-test", "app-1", 1));
		expect(window.location.pathname).toBe("/build/app-1/module-1/results");
		expect(view.result.current).toEqual(["module-1", "results"]);

		/* Model Back restoring an older stamped entry. The pop listener scrubs
		 * synchronously, before notifying useSyncExternalStore subscribers. */
		window.history.pushState(
			{
				__novaProjectScope: {
					scopeId: "history-test",
					appId: "app-1",
					epoch: 0,
				},
			},
			"",
			"/build/app-1/module-1/cases/source-case",
		);
		act(() => window.dispatchEvent(new PopStateEvent("popstate")));
		expect(window.location.pathname).toBe("/build/app-1/module-1/results");
		expect(view.result.current).toEqual(["module-1", "results"]);
	});

	it("lets Back enter another app before its new runtime claims the entry", () => {
		window.history.replaceState(null, "", "/build/app-b/module-b/results");
		const view = renderHook(() => useBuilderPathSegments());
		activateBuilderHistoryScope("runtime-b", "app-b", 3);

		window.history.pushState(
			{
				__novaProjectScope: {
					scopeId: "runtime-a-old",
					appId: "app-a",
					epoch: 8,
				},
			},
			"",
			"/build/app-a/module-a/cases/case-a",
		);
		act(() => window.dispatchEvent(new PopStateEvent("popstate")));

		/* App B's still-mounted listener must not scrub app A's valid case id or
		 * overwrite A's stamp while the route transition remounts the builder. */
		expect(window.location.pathname).toBe("/build/app-a/module-a/cases/case-a");
		expect(view.result.current).toEqual(["module-a", "cases", "case-a"]);
		expect(window.history.state).toMatchObject({
			__novaProjectScope: { appId: "app-a", scopeId: "runtime-a-old" },
		});

		/* The freshly authorized app-A runtime preserves the deep link and
		 * restamps it; it does not interpret an older runtime id as stale. */
		act(() => activateBuilderHistoryScope("runtime-a-new", "app-a", 0));
		expect(window.location.pathname).toBe("/build/app-a/module-a/cases/case-a");
		expect(window.history.state).toMatchObject({
			__novaProjectScope: {
				appId: "app-a",
				scopeId: "runtime-a-new",
				epoch: 0,
			},
		});
	});
});
