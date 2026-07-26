import { describe, expect, it } from "vitest";
import {
	projectDataReadForIdentity,
	scopeProjectDataRead,
} from "../projectDataReadIdentity";

describe("projectDataReadForIdentity", () => {
	it("keeps a matching table snapshot available", () => {
		const read = scopeProjectDataRead("project-1 table-a", {
			kind: "data" as const,
			value: { name: "Table A" },
		});

		expect(
			projectDataReadForIdentity({
				read,
				resourceIdentity: "project-1 table-a",
				ready: true,
			}),
		).toEqual({ ...read });
	});

	it("masks table A synchronously when the route already owns table B", () => {
		const read = scopeProjectDataRead("project-1 table-a", {
			kind: "data" as const,
			value: { name: "Table A" },
		});

		expect(
			projectDataReadForIdentity({
				read,
				resourceIdentity: "project-1 table-b",
				ready: true,
			}),
		).toEqual({ kind: "loading" });
	});

	it("masks a stale failure as well as stale data", () => {
		const read = scopeProjectDataRead("project-1 table-a", {
			kind: "failed" as const,
			failure: {
				success: false as const,
				code: "not_found" as const,
				message: "Lookup table not found.",
			},
		});

		expect(
			projectDataReadForIdentity({
				read,
				resourceIdentity: "project-1 table-b",
				ready: true,
			}),
		).toEqual({ kind: "loading" });
	});

	it("returns idle, not loading, when the new identity is not authorized yet", () => {
		const read = scopeProjectDataRead("project-1 table-a", {
			kind: "data" as const,
			value: { name: "Table A" },
		});

		expect(
			projectDataReadForIdentity({
				read,
				resourceIdentity: "project-2 table-a",
				ready: false,
			}),
		).toEqual({ kind: "idle" });
	});
});
