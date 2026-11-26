/**
 * Contract: the column card's From menu (`columnSources`) offers only links a case list column
 * can walk through. A case index name may hold a dot or start with an underscore, and a link
 * may be called user, but HQ's column field takes none of those (the gate refuses such a column
 * with `index-name` or `worker`). The plausible failure: a declared link offered as a source the
 * commit gate then refuses with a reason the author can't act on.
 */
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { columnSources } from "../columnSources";

const home: CaseType = { name: "home", properties: [] };
const visit: CaseType = {
	name: "visit",
	properties: [],
	relations: ["site.link", "_site", "user", "site-link"].map((identifier) => ({
		identifier,
		targetType: "home",
		relationship: "child" as const,
	})),
};

describe("the cases a column can read from", () => {
	it("offers a declared link only where a case list column can walk through it", () => {
		expect(
			columnSources("visit", [visit, home], undefined).map(
				(source) => source.key,
			),
			// The worker source is the worker's own record, not a link.
		).toEqual(["self", "link-site-link", "worker"]);
	});
});
