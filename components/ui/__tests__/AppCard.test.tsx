// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCard } from "../AppCard";

describe("AppCard recovery links", () => {
	it("keeps an error app reachable when the caller provides its recovery URL", () => {
		render(
			<AppCard
				app={{
					id: "failed-app",
					app_name: "Recovered workflow",
					connect_type: null,
					module_count: 1,
					form_count: 1,
					status: "error",
					updated_at: "2026-08-08T00:00:00.000Z",
					logo: null,
				}}
				index={0}
				href="/build/failed-app"
			/>,
		);
		expect(
			screen
				.getByRole("link", { name: "Open Recovered workflow" })
				.getAttribute("href"),
		).toBe("/build/failed-app");
	});
});
