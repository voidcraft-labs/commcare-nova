// lib/preview/engine/__tests__/identity.test.ts
//
// The ResolvedPreviewIdentity contract: the sole provider's derivation
// and refusal arms, the sparse (never blank-coerced) user-data map, the
// anonymous projection, and the material-equality comparator that keeps
// re-derived identities from rebuilding evaluation state.

import { describe, expect, it } from "vitest";
import {
	previewAsMe,
	previewSessionValues,
	samePreviewIdentity,
} from "../identity";

const FULL_USER = {
	id: "worker-42",
	name: "Amina Diallo",
	email: "amina@example.org",
};

describe("previewAsMe", () => {
	it("projects the signed-in user into the session vocabulary", () => {
		const identity = previewAsMe(FULL_USER);
		expect(identity).not.toBeNull();
		expect(identity?.ownerId).toBe("worker-42");
		expect(identity?.session.context).toEqual({
			userid: "worker-42",
			username: "amina@example.org",
			deviceid: "nova-preview",
			appversion: "preview",
		});
		expect(identity?.session.user).toEqual({
			userid: "worker-42",
			username: "amina@example.org",
			email: "amina@example.org",
			name: "Amina Diallo",
			first_name: "Amina",
			last_name: "Diallo",
		});
	});

	it("keeps user-data keys ABSENT when the worker has no value", () => {
		const identity = previewAsMe({ id: "worker-1" });
		// No email/name: the keys must not exist — never coerced to "".
		expect(identity?.session.user).toEqual({
			userid: "worker-1",
			username: "worker-1",
		});
		expect("email" in (identity?.session.user ?? {})).toBe(false);
		expect("first_name" in (identity?.session.user ?? {})).toBe(false);
	});

	it("prefers email over name over id for the username", () => {
		expect(
			previewAsMe({ id: "u1", name: "Only Name" })?.session.context.username,
		).toBe("Only Name");
		expect(previewAsMe({ id: "u1" })?.session.context.username).toBe("u1");
	});

	it("refuses a missing user or an unpersisted (blank) id", () => {
		expect(previewAsMe(null)).toBeNull();
		expect(previewAsMe(undefined)).toBeNull();
		expect(previewAsMe({ id: "" })).toBeNull();
		expect(previewAsMe({ id: "   ", name: "Ghost" })).toBeNull();
	});
});

describe("previewSessionValues", () => {
	it("projects an identity to its session values", () => {
		const identity = previewAsMe(FULL_USER);
		expect(previewSessionValues(identity)).toBe(identity?.session);
	});

	it("yields the anonymous projection without an identity", () => {
		const anonymous = previewSessionValues(null);
		expect(anonymous.context).toEqual({
			deviceid: "nova-preview",
			appversion: "preview",
		});
		expect(anonymous.user).toEqual({});
	});
});

describe("samePreviewIdentity", () => {
	it("treats a re-derived identity from the same user as identical", () => {
		expect(
			samePreviewIdentity(
				previewAsMe(FULL_USER),
				previewAsMe({ ...FULL_USER }),
			),
		).toBe(true);
	});

	it("distinguishes a different worker or changed profile", () => {
		expect(
			samePreviewIdentity(
				previewAsMe(FULL_USER),
				previewAsMe({ ...FULL_USER, id: "worker-43" }),
			),
		).toBe(false);
		expect(
			samePreviewIdentity(
				previewAsMe(FULL_USER),
				previewAsMe({ ...FULL_USER, name: "Amina D." }),
			),
		).toBe(false);
	});

	it("treats null as equal only to null", () => {
		expect(samePreviewIdentity(null, null)).toBe(true);
		expect(samePreviewIdentity(previewAsMe(FULL_USER), null)).toBe(false);
		expect(samePreviewIdentity(null, previewAsMe(FULL_USER))).toBe(false);
	});
});
