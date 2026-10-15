/**
 * Which members' stored keys a deployment's reads try, and in what order,
 * from Nova's rows alone.
 */

import { describe, expect, it } from "vitest";
import {
	type CredentialDeployment,
	credentialOrder,
	type MemberCredential,
} from "../credentials";

const deployment: CredentialDeployment = {
	createdBy: "creator",
	server: "production",
	domain: "field-ops",
};

function member(
	userId: string,
	joined: string,
	patch: Partial<MemberCredential> = {},
): MemberCredential {
	return {
		userId,
		joinedAt: new Date(joined),
		hasStoredKey: true,
		server: "production",
		approvedDomains: ["field-ops"],
		...patch,
	};
}

describe("the credential order", () => {
	it("tries the creator first, then the members in the order they joined", () => {
		expect(
			credentialOrder(deployment, [
				member("zed", "2026-01-01T00:00:00Z"),
				member("creator", "2026-03-01T00:00:00Z"),
				member("bea", "2026-02-01T00:00:00Z"),
				member("amy", "2026-02-01T00:00:00Z"),
			]),
		).toEqual(["creator", "zed", "amy", "bea"]);
	});

	it("skips the creator once they have left the Project", () => {
		expect(
			credentialOrder(deployment, [member("other", "2026-01-01T00:00:00Z")]),
		).toEqual(["other"]);
	});

	it("skips a member with no stored key, another server or without the domain", () => {
		expect(
			credentialOrder(deployment, [
				member("creator", "2026-01-01T00:00:00Z", { hasStoredKey: false }),
				member("india", "2026-01-02T00:00:00Z", { server: "india" }),
				member("unknown-server", "2026-01-03T00:00:00Z", { server: "staging" }),
				member("no-server", "2026-01-04T00:00:00Z", { server: null }),
				member("other-domain", "2026-01-05T00:00:00Z", {
					approvedDomains: ["field-ops-2"],
				}),
			]),
		).toEqual([]);
	});
});
