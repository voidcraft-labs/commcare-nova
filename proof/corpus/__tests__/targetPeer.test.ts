/**
 * The capture's peer applies a person's app attribute save as HQ's app
 * settings page's save applies it (`proof/observe/hqside.py::app_attributes`):
 * `views/settings.py::edit_commcare_settings` runs `edit_commcare_profile`,
 * which resets `custom_properties` to `{}` where the project space holds
 * `CUSTOM_PROPERTIES`, then `views/apps.py::edit_app_attr` with `all`, which
 * stores each attribute the save names. The HQ side holds the peer's source
 * to HQ's own read before it applies an import, so a peer that kept the
 * custom properties HQ cleared would answer Nova's next publish with a source
 * HQ no longer holds. The paired case: a project space without the flag keeps
 * them.
 */

import { describe, expect, it } from "vitest";
import { type PeerHolding, TargetPeer } from "../targetPeer";

function peerHolding(flags: readonly string[]): TargetPeer {
	const peer = new TargetPeer({
		credentials: {
			username: "account",
			apiKey: "fixture-key",
			server: "production",
		},
		domain: "nova-proof",
		flags: new Set(flags),
		caseSearchEnabled: false,
		appId: "app",
		commcareVersion: "2.57.0",
		cloudcareGranted: false,
	});
	const holding: PeerHolding = {
		source: {
			doc_type: "Application",
			secure_submissions: false,
			auto_gps_capture: false,
			profile: {
				properties: { "cc-autoup-freq": "freq-never" },
				features: {},
				custom_properties: { "cc-custom": "kept" },
			},
		},
		version: 1,
		mediaFiles: undefined,
		tables: [],
		minted: 0,
	};
	peer.restore(holding);
	return peer;
}

function savedAttributes(flags: readonly string[]) {
	const peer = peerHolding(flags);
	peer.applyHqSide({
		republish: "proceeds",
		appAttributes: { auto_gps_capture: true, secure_submissions: true },
	});
	return peer.snapshot().source;
}

describe("a person's app attribute save on the capture's peer", () => {
	it("stores each attribute and clears the custom properties where the project space holds CUSTOM_PROPERTIES", () => {
		expect(savedAttributes(["CUSTOM_PROPERTIES"])).toEqual({
			doc_type: "Application",
			secure_submissions: true,
			auto_gps_capture: true,
			profile: {
				properties: { "cc-autoup-freq": "freq-never" },
				features: {},
				custom_properties: {},
			},
		});
	});

	it("stores each attribute and keeps the custom properties where it does not", () => {
		expect(savedAttributes([])).toEqual({
			doc_type: "Application",
			secure_submissions: true,
			auto_gps_capture: true,
			profile: {
				properties: { "cc-autoup-freq": "freq-never" },
				features: {},
				custom_properties: { "cc-custom": "kept" },
			},
		});
	});
});
