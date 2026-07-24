// lib/projects/__tests__/invitePolicy.test.ts
//
// The invite domain-gate policy. Enforced server-side by the org plugin's
// `beforeCreateInvitation` hook (`lib/auth.ts`); this covers the pure
// predicate it calls.

import { describe, expect, it } from "vitest";
import {
	INVITE_ALLOWED_DOMAINS,
	isInvitableEmail,
	isPersonalProjectMetadata,
	PERSONAL_PROJECT_NOT_SHAREABLE_ERROR,
} from "../invitePolicy";

describe("isInvitableEmail", () => {
	it("accepts the allowed dimagi domains, case-insensitively", () => {
		expect(isInvitableEmail("alice@dimagi.com")).toBe(true);
		expect(isInvitableEmail("Bob@Dimagi.com")).toBe(true);
		expect(isInvitableEmail("carol@dimagi-ai.com")).toBe(true);
		expect(isInvitableEmail("DAVE@DIMAGI-AI.COM")).toBe(true);
		expect(isInvitableEmail("erin@dimagi-associate.com")).toBe(true);
	});

	it("rejects any other domain — including look-alikes (no subdomain widening)", () => {
		expect(isInvitableEmail("eve@gmail.com")).toBe(false);
		// A subdomain or suffix that merely CONTAINS an allowed domain is not it.
		expect(isInvitableEmail("mallory@evil-dimagi.com")).toBe(false);
		expect(isInvitableEmail("trent@dimagi.com.evil.com")).toBe(false);
		expect(isInvitableEmail("user@sub.dimagi.com")).toBe(false);
	});

	it("rejects a malformed address with no @", () => {
		expect(isInvitableEmail("not-an-email")).toBe(false);
		expect(isInvitableEmail("")).toBe(false);
	});

	it("matches the domain after the LAST @ (defends a quoted local-part)", () => {
		// The local part may legally contain an @ when quoted; the domain is
		// what follows the final @.
		expect(isInvitableEmail('"weird@local"@dimagi.com')).toBe(true);
		expect(isInvitableEmail('"x@dimagi.com"@gmail.com')).toBe(false);
	});

	it("exposes the allow-list as the single source the hook reads", () => {
		expect(INVITE_ALLOWED_DOMAINS).toContain("dimagi.com");
		expect(INVITE_ALLOWED_DOMAINS).toContain("dimagi-ai.com");
		expect(INVITE_ALLOWED_DOMAINS).toContain("dimagi-associate.com");
	});
});

describe("isPersonalProjectMetadata", () => {
	it("recognizes the personal flag whether metadata is a parsed object or a JSON string", () => {
		// Better Auth hands hooks the parsed object; the raw column is a string.
		expect(isPersonalProjectMetadata({ personal: true })).toBe(true);
		expect(isPersonalProjectMetadata('{"personal":true}')).toBe(true);
	});

	it("treats a non-personal, missing, or malformed metadata as not personal", () => {
		expect(isPersonalProjectMetadata({ personal: false })).toBe(false);
		expect(isPersonalProjectMetadata({})).toBe(false);
		expect(isPersonalProjectMetadata('{"personal":"true"}')).toBe(false); // string, not boolean
		expect(isPersonalProjectMetadata(null)).toBe(false);
		expect(isPersonalProjectMetadata(undefined)).toBe(false);
		expect(isPersonalProjectMetadata("not json")).toBe(false);
		expect(isPersonalProjectMetadata("")).toBe(false);
	});
});

describe("PERSONAL_PROJECT_NOT_SHAREABLE_ERROR", () => {
	it("points to an available collaboration path without promising app moves", () => {
		expect(PERSONAL_PROJECT_NOT_SHAREABLE_ERROR).toBeTruthy();
		expect(PERSONAL_PROJECT_NOT_SHAREABLE_ERROR).toContain("shared Project");
		expect(PERSONAL_PROJECT_NOT_SHAREABLE_ERROR.toLowerCase()).not.toContain(
			"move",
		);
	});
});
