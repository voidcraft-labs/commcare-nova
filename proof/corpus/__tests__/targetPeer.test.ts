/**
 * The capture's peer applies a person's app settings save as HQ's app
 * settings page's save applies it (`proof/observe/hqside.py`): the page
 * posts the custom properties it lists with every save
 * (`views/apps.py::get_app_view_context`' `customProperties`,
 * `commcare_settings.js`' `serialize`, which drops one with an empty key or
 * value), and `views/settings.py::edit_commcare_profile` resets
 * `custom_properties` to `{}` where the project space holds
 * `CUSTOM_PROPERTIES` and stores the posted ones;
 * `views/settings.py::edit_commcare_settings` then runs
 * `views/apps.py::edit_app_attr` with `all`, which stores each attribute the
 * save names. The HQ side holds the peer's source to HQ's own read before it
 * applies an import, so a peer that cleared the custom properties a page's
 * save keeps would read Nova's own `cc-index-case-search-results` as moved,
 * and one that kept the empty one the page drops would answer Nova's next
 * publish with a source HQ no longer holds. The paired case: a project space
 * without the flag keeps them all.
 */

import { describe, expect, it } from "vitest";
import type { HqSideSaves } from "../documents";
import { type PeerHolding, TargetPeer } from "../targetPeer";

const HELD_CUSTOM = {
	"cc-index-case-search-results": "yes",
	"cc-custom": "kept",
	"cc-blank": "",
};

function peerHolding(
	flags: readonly string[],
	profile: Record<string, unknown>,
): TargetPeer {
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
			profile,
		},
		version: 1,
		mediaFiles: undefined,
		tables: [],
		minted: 0,
	};
	peer.restore(holding);
	return peer;
}

function saved(
	flags: readonly string[],
	saves: HqSideSaves,
	profile: Record<string, unknown> = {
		properties: { "cc-autoup-freq": "freq-never" },
		features: {},
		custom_properties: HELD_CUSTOM,
	},
) {
	const peer = peerHolding(flags, profile);
	peer.applyHqSide(saves);
	return peer.snapshot().source;
}

const ATTRIBUTES: HqSideSaves = {
	republish: "proceeds",
	appAttributes: { auto_gps_capture: true, secure_submissions: true },
};

describe("a person's app settings save on the capture's peer", () => {
	it("stores each attribute and keeps every custom property the page posts where the project space holds CUSTOM_PROPERTIES", () => {
		expect(saved(["CUSTOM_PROPERTIES"], ATTRIBUTES)).toEqual({
			doc_type: "Application",
			secure_submissions: true,
			auto_gps_capture: true,
			profile: {
				properties: { "cc-autoup-freq": "freq-never" },
				features: {},
				custom_properties: {
					"cc-index-case-search-results": "yes",
					"cc-custom": "kept",
				},
			},
		});
	});

	it("stores each attribute and keeps the custom properties as they are where it does not", () => {
		expect(saved([], ATTRIBUTES)).toEqual({
			doc_type: "Application",
			secure_submissions: true,
			auto_gps_capture: true,
			profile: {
				properties: { "cc-autoup-freq": "freq-never" },
				features: {},
				custom_properties: HELD_CUSTOM,
			},
		});
	});

	it("gives a profile without custom properties the empty map the page's save posts under CUSTOM_PROPERTIES", () => {
		const source = saved(["CUSTOM_PROPERTIES"], ATTRIBUTES, {
			properties: {},
			features: {},
		});
		expect(source?.profile).toEqual({
			properties: {},
			features: {},
			custom_properties: {},
		});
	});

	it("keeps the posted custom properties on a save of a setting or a feature too", () => {
		const properties = saved(["CUSTOM_PROPERTIES"], {
			republish: "proceeds",
			profileProperties: { "cc-autoup-freq": "freq-daily" },
		});
		const features = saved(["CUSTOM_PROPERTIES"], {
			republish: "proceeds",
			profileFeatures: { credentials: "3MON_ACTIVE" },
		});
		const kept = {
			"cc-index-case-search-results": "yes",
			"cc-custom": "kept",
		};
		expect(properties?.profile).toEqual({
			properties: { "cc-autoup-freq": "freq-daily" },
			features: {},
			custom_properties: kept,
		});
		expect(features?.profile).toEqual({
			properties: { "cc-autoup-freq": "freq-never" },
			features: { credentials: "3MON_ACTIVE" },
			custom_properties: kept,
		});
	});
});
