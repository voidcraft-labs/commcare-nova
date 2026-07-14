/**
 * Unit tests for the pure upload-target resolver. No I/O — this is exactly
 * the kind of decision logic that belongs in a pure function so it can be
 * exhaustively covered without database or HQ mocks.
 *
 * The cases that matter are the failure shapes: `not_authorized` (a deliberate
 * ask for an unreachable space) and `ambiguous` (multi-space key, no request —
 * the silent-wrong-target bug this whole change exists to kill). There is no
 * stored default to fall back on: a multi-space key's target is always an
 * explicit per-upload choice, never remembered.
 */

import { describe, expect, it } from "vitest";
import type { CommCareDomain } from "@/lib/commcare/client";
import { resolveUploadDomain } from "@/lib/db/domainResolution";

const ACME: CommCareDomain = { name: "acme", displayName: "ACME Research" };
const PROD: CommCareDomain = {
	name: "connect-ace-prod",
	displayName: "ACE Prod",
};
const DEMO: CommCareDomain = { name: "demo", displayName: "Demo Space" };

describe("resolveUploadDomain — single reachable space", () => {
	it("returns the sole space with no request (zero friction)", () => {
		const r = resolveUploadDomain({ availableDomains: [ACME] });
		expect(r).toEqual({ ok: true, domain: ACME });
	});
});

describe("resolveUploadDomain — explicit request wins", () => {
	it("returns the requested space when reachable", () => {
		const r = resolveUploadDomain({
			availableDomains: [ACME, PROD, DEMO],
			requested: "connect-ace-prod",
		});
		expect(r).toEqual({ ok: true, domain: PROD });
	});

	it("returns not_authorized (with the reachable set) when the request is unreachable", () => {
		const r = resolveUploadDomain({
			availableDomains: [ACME, PROD],
			requested: "some-other-space",
		});
		expect(r).toEqual({
			ok: false,
			reason: "not_authorized",
			available: [ACME, PROD],
		});
	});

	it("treats a whitespace-only request as no request (does not fail authorization)", () => {
		const r = resolveUploadDomain({
			availableDomains: [ACME],
			requested: "   ",
		});
		expect(r).toEqual({ ok: true, domain: ACME });
	});
});

describe("resolveUploadDomain — ambiguous (the bug this kills)", () => {
	it("returns ambiguous for a multi-space key with no request", () => {
		const r = resolveUploadDomain({ availableDomains: [ACME, PROD, DEMO] });
		expect(r).toEqual({
			ok: false,
			reason: "ambiguous",
			available: [ACME, PROD, DEMO],
		});
	});

	it("never silently defaults to the first space", () => {
		const r = resolveUploadDomain({ availableDomains: [ACME, PROD] });
		expect(r.ok).toBe(false);
	});
});
