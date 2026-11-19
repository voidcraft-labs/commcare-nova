/**
 * Who may say CommCare HQ answered about an app.
 *
 * Nova's view of which Nova app holds an HQ app is released only on HQ's own
 * answer in the same request (`HqAppsSeen`). A value written by hand, from
 * Nova's stored list of project spaces or a caller's id, fails to compile
 * where the claims are read; Biome's `noRestrictedImports` holds who may make
 * one (the app list and the app's own read).
 */
import { expect, it } from "vitest";
import type { readHqAppClaims } from "@/lib/deployment/store";
import { seenByHq } from "../hq/appsSeen";

type Seen = Parameters<typeof readHqAppClaims>[0]["seen"];

it("can't be written by hand where the claims are read", () => {
	const forged = {
		server: "india",
		domain: "clinic",
		remoteAppIds: ["0123456789abcdef0123456789abcdef"],
	} as const;
	// @ts-expect-error: only CommCare HQ's answer makes the value the claims read.
	const seen: Seen = forged;
	expect(seen.remoteAppIds).toEqual(forged.remoteAppIds);
});

it("names each app HQ answered about once", () => {
	const seen: Seen = seenByHq("india", "clinic", ["a", "b", "a"]);
	expect(seen).toEqual({
		server: "india",
		domain: "clinic",
		remoteAppIds: ["a", "b"],
	});
});
