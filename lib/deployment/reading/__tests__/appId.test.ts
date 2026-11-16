import { describe, expect, it } from "vitest";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";
import { BROUGHT_IN_APP_NAMESPACE, broughtInAppId } from "../appId";
import type { ReadingKey } from "../types";

const USER = "user-ada";
const KEY: ReadingKey = {
	projectId: "project-clinic",
	server: "production",
	domain: "clinic-space",
	remoteAppId: "a1b2c3d4e5f6",
};
const READING = "01937c5e-7d1a-7c3b-8a4f-2b6c9d0e1f23";

describe("broughtInAppId", () => {
	it("is stable for equal inputs and a canonical UUID", () => {
		const id = broughtInAppId(USER, KEY, READING);
		expect(broughtInAppId(USER, { ...KEY }, READING)).toBe(id);
		expect(id).toMatch(CANONICAL_UUID_PATTERN);
		expect(id).not.toBe(BROUGHT_IN_APP_NAMESPACE);
	});

	it("differs when any one of its six inputs does", () => {
		const id = broughtInAppId(USER, KEY, READING);
		const others = [
			broughtInAppId("user-grace", KEY, READING),
			broughtInAppId(USER, { ...KEY, projectId: "project-farm" }, READING),
			broughtInAppId(USER, { ...KEY, server: "india" }, READING),
			broughtInAppId(USER, { ...KEY, domain: "farm-space" }, READING),
			broughtInAppId(USER, { ...KEY, remoteAppId: "f6e5d4c3b2a1" }, READING),
			broughtInAppId(USER, KEY, "01937c5e-7d1a-7c3b-8a4f-2b6c9d0e1f24"),
		];
		for (const other of others) expect(other).not.toBe(id);
		expect(new Set(others).size).toBe(others.length);
	});

	it("keeps its inputs apart where plain concatenation would join them", () => {
		expect(broughtInAppId("a", { ...KEY, projectId: "b,c" }, READING)).not.toBe(
			broughtInAppId("a,b", { ...KEY, projectId: "c" }, READING),
		);
	});
});
