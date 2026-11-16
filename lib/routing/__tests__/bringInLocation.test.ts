/**
 * The bring-in address. The plausible failure: an address that makes the page
 * post a read for text the read route would refuse, or an app's key that does
 * not survive its own address.
 */
import { describe, expect, it } from "vitest";
import {
	type BringInLocation,
	bringInHref,
	bringInLocation,
} from "../bringInLocation";

const KEY = {
	projectId: "0196f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f",
	server: "india",
	domain: "maternal-health",
	remoteAppId: "3f1c9a7e2b4d4e8f9a0b1c2d3e4f5a6b",
} as const;

function searchOf(location: BringInLocation): string {
	const href = bringInHref(location);
	const query = href.indexOf("?");
	return query === -1 ? "" : href.slice(query);
}

function appSearch(
	values: Partial<Record<"project" | "server" | "space" | "app", string>>,
): string {
	const params = new URLSearchParams({ hq: "app" });
	for (const [name, value] of Object.entries(values)) params.set(name, value);
	return `?${params.toString()}`;
}

describe("bringInLocation and bringInHref", () => {
	it("are inverses over none, choose and an app's key", () => {
		const locations: readonly BringInLocation[] = [
			{ kind: "none" },
			{ kind: "choose" },
			{ kind: "app", key: KEY },
		];
		for (const location of locations) {
			expect(bringInLocation(searchOf(location))).toEqual(location);
		}
	});

	it("writes the three addresses on /build/new, an app's values in their order", () => {
		expect(bringInHref({ kind: "none" })).toBe("/build/new");
		expect(bringInHref({ kind: "choose" })).toBe("/build/new?hq=choose");
		expect(bringInHref({ kind: "app", key: KEY })).toBe(
			"/build/new?hq=app&project=0196f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f&server=india&space=maternal-health&app=3f1c9a7e2b4d4e8f9a0b1c2d3e4f5a6b",
		);
	});

	it("keeps an app's values exactly through URL encoding", () => {
		const key = { ...KEY, projectId: "project with spaces & signs=1" };
		expect(bringInLocation(searchOf({ kind: "app", key }))).toEqual({
			kind: "app",
			key,
		});
	});

	it("reads an app's address with no leading question mark too", () => {
		expect(
			bringInLocation(searchOf({ kind: "app", key: KEY }).slice(1)),
		).toEqual({ kind: "app", key: KEY });
	});

	it("reads an app's address that misses any one value as none", () => {
		const full = {
			project: KEY.projectId,
			server: KEY.server,
			space: KEY.domain,
			app: KEY.remoteAppId,
		};
		for (const missing of Object.keys(full)) {
			const rest = Object.fromEntries(
				Object.entries(full).filter(([name]) => name !== missing),
			);
			expect(bringInLocation(appSearch(rest))).toEqual({ kind: "none" });
		}
	});

	it("reads a server that is none of the three as none", () => {
		expect(
			bringInLocation(
				appSearch({
					project: KEY.projectId,
					server: "staging",
					space: KEY.domain,
					app: KEY.remoteAppId,
				}),
			),
		).toEqual({ kind: "none" });
	});

	it("reads an app id outside its pattern as none", () => {
		for (const app of ["", "a/b", "a b", "../x", "x".repeat(256)]) {
			expect(
				bringInLocation(
					appSearch({
						project: KEY.projectId,
						server: KEY.server,
						space: KEY.domain,
						app,
					}),
				),
			).toEqual({ kind: "none" });
		}
	});

	it("reads an empty Project, and a project space of no or more than 255 characters, as none", () => {
		const base = {
			project: KEY.projectId,
			server: KEY.server,
			space: KEY.domain,
			app: KEY.remoteAppId,
		};
		for (const values of [
			{ ...base, project: "" },
			{ ...base, space: "" },
			{ ...base, space: "s".repeat(256) },
		]) {
			expect(bringInLocation(appSearch(values))).toEqual({ kind: "none" });
		}
		expect(
			bringInLocation(appSearch({ ...base, space: "s".repeat(255) })),
		).toEqual({ kind: "app", key: { ...KEY, domain: "s".repeat(255) } });
	});

	it("reads any other hq value, and no hq at all, as none", () => {
		for (const search of [
			"",
			"?",
			"?hq=nonsense",
			"?hq=CHOOSE",
			"?hq=",
			"?design=0196f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f",
		]) {
			expect(bringInLocation(search)).toEqual({ kind: "none" });
		}
	});
});
