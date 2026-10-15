/** Pure: the origin and project space an attachment link is built from. */

import { describe, expect, it } from "vitest";
import { attachmentUrlTarget } from "../attachmentTarget";

describe("attachmentUrlTarget", () => {
	it("resolves each server id to its own origin", () => {
		expect(
			attachmentUrlTarget({ server: "production", domain: "acme" }),
		).toEqual({ origin: "https://www.commcarehq.org", domain: "acme" });
		expect(attachmentUrlTarget({ server: "india", domain: "acme" })).toEqual({
			origin: "https://india.commcarehq.org",
			domain: "acme",
		});
		expect(attachmentUrlTarget({ server: "eu", domain: "acme" })).toEqual({
			origin: "https://eu.commcarehq.org",
			domain: "acme",
		});
	});
});
