/**
 * Project role → app-capability matrix. Locks the authorization semantics the
 * resolver (`lib/db/appAccess.ts`) depends on: viewer read-only, editor edits,
 * admin/owner full, the Better-Auth default `member` aliased to read-only, and
 * an unknown role granting nothing. Pure (no DB) — exercises the AC roles
 * directly via `roleAllowsApp`.
 */

import { describe, expect, it } from "vitest";
import { roleAllowsApp } from "../projectRoles";

describe("roleAllowsApp", () => {
	it("viewer is read-only", () => {
		expect(roleAllowsApp("viewer", "view")).toBe(true);
		expect(roleAllowsApp("viewer", "edit")).toBe(false);
		expect(roleAllowsApp("viewer", "delete")).toBe(false);
	});

	it("editor can view + edit but not delete", () => {
		expect(roleAllowsApp("editor", "view")).toBe(true);
		expect(roleAllowsApp("editor", "edit")).toBe(true);
		expect(roleAllowsApp("editor", "delete")).toBe(false);
	});

	it("admin and owner have full app capability", () => {
		for (const role of ["admin", "owner"]) {
			expect(roleAllowsApp(role, "view")).toBe(true);
			expect(roleAllowsApp(role, "edit")).toBe(true);
			expect(roleAllowsApp(role, "delete")).toBe(true);
		}
	});

	it("the Better-Auth default 'member' role is read-only (safety net)", () => {
		expect(roleAllowsApp("member", "view")).toBe(true);
		expect(roleAllowsApp("member", "edit")).toBe(false);
	});

	it("an unknown role grants nothing", () => {
		expect(roleAllowsApp("bogus", "view")).toBe(false);
		expect(roleAllowsApp("", "view")).toBe(false);
	});

	it("comma-joined roles take the most-permissive grant", () => {
		expect(roleAllowsApp("viewer,editor", "edit")).toBe(true);
		expect(roleAllowsApp("viewer,bogus", "edit")).toBe(false);
	});
});
