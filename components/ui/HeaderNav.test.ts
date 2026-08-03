import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "./HeaderNav";

/** Which section the nav lights up for a pathname, or null for none. */
function activeSection(pathname: string): string | null {
	return NAV_ITEMS.find((item) => item.owns(pathname))?.label ?? null;
}

describe("header nav ownership", () => {
	it("keeps the builder under Apps rather than leaving it with no ancestor", () => {
		/* `/build/new` is the one builder screen the nav is still on: no app
		 * exists yet, so the band has not changed hands. It is where "New app"
		 * took the user, so Apps is where they came from and where they go
		 * back to. */
		expect(activeSection("/build/new")).toBe("Apps");
		expect(activeSection("/build/9f1c-app/module/form")).toBe("Apps");
	});

	it("owns the app list exactly, never every page under it", () => {
		expect(activeSection("/")).toBe("Apps");
		expect(activeSection("/settings")).toBeNull();
		expect(activeSection("/consent")).toBeNull();
	});

	it("gives Admin its own subtree", () => {
		expect(activeSection("/admin")).toBe("Admin");
		expect(activeSection("/admin/users/42")).toBe("Admin");
	});
});
