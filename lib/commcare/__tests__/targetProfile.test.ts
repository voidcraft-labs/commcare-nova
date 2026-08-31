import { describe, expect, it } from "vitest";
import type { HqApplication } from "@/lib/commcare";
import {
	projectNewAppProfileForTarget,
	projectUpdatedAppProfileForTarget,
} from "../targetProfile";

function application(withDerivedProfile = true): HqApplication {
	return {
		doc_type: "Application",
		application_version: "2.0",
		name: "Search app",
		langs: ["en"],
		build_spec: {
			doc_type: "BuildSpec",
			version: "2.54.0",
			build_number: null,
		},
		multimedia_map: {},
		translations: {},
		auto_gps_capture: false,
		...(withDerivedProfile && {
			profile: {
				custom_properties: { "cc-index-case-search-results": "yes" },
			},
		}),
		add_ons: {},
		modules: [],
		_attachments: { "form.xml": "<data />" },
	};
}

describe("target profile projection", () => {
	it("keeps the derived property for a supported new app", () => {
		const input = application();
		expect(projectNewAppProfileForTarget(input, true)).toEqual({
			application: input,
			profileChanged: false,
		});
	});

	it("omits the advisory property for an unsupported new app", () => {
		const projected = projectNewAppProfileForTarget(application(), false);
		expect(projected.application.profile).toBeUndefined();
		expect(Object.keys(projected.application).at(-1)).toBe("_attachments");
	});

	it("keeps unrelated generated profile state for an unsupported new app", () => {
		const input = application();
		if (!input.profile?.custom_properties) {
			throw new Error("Expected generated profile properties");
		}
		input.profile.features = { foreign: { active: true } };
		input.profile.custom_properties.foreign = "generated";

		const projected = projectNewAppProfileForTarget(input, false);
		expect(projected.application.profile).toEqual({
			features: { foreign: { active: true } },
			custom_properties: { foreign: "generated" },
		});
		expect(Object.keys(projected.application).at(-1)).toBe("_attachments");
	});

	it("overlays only Nova's key onto the complete update profile", () => {
		const projected = projectUpdatedAppProfileForTarget(
			application(),
			{
				features: { foreign: { active: true } },
				properties: { foreign: { value: "standing" } },
				custom_properties: {
					foreign: "kept",
					foreignNumber: 7,
					foreignBoolean: false,
					foreignNull: null,
					"cc-index-case-search-results": "no",
				},
			},
			true,
		);

		expect(projected.profileChanged).toBe(true);
		expect(projected.application.profile).toEqual({
			features: { foreign: { active: true } },
			properties: { foreign: { value: "standing" } },
			custom_properties: {
				foreign: "kept",
				foreignNumber: 7,
				foreignBoolean: false,
				foreignNull: null,
				"cc-index-case-search-results": "yes",
			},
		});
		expect(Object.keys(projected.application).at(-1)).toBe("_attachments");
	});

	it("ignores generated custom properties outside Nova's ownership allowlist", () => {
		const generated = application();
		if (!generated.profile?.custom_properties) {
			throw new Error("Expected generated profile properties");
		}
		generated.profile.custom_properties.foreign = "must-not-overwrite";
		const projected = projectUpdatedAppProfileForTarget(
			generated,
			{
				custom_properties: {
					foreign: "target-owned",
					"cc-index-case-search-results": "no",
				},
			},
			true,
		);

		expect(projected.application.profile?.custom_properties).toEqual({
			foreign: "target-owned",
			"cc-index-case-search-results": "yes",
		});
	});

	it("removes a stale Nova key while preserving foreign properties", () => {
		const projected = projectUpdatedAppProfileForTarget(
			application(false),
			{
				custom_properties: {
					foreign: "kept",
					foreignNumber: 7,
					foreignBoolean: false,
					foreignNull: null,
					"cc-index-case-search-results": "yes",
				},
			},
			false,
		);

		expect(projected.profileChanged).toBe(true);
		expect(projected.application.profile).toEqual({
			custom_properties: {
				foreign: "kept",
				foreignNumber: 7,
				foreignBoolean: false,
				foreignNull: null,
			},
		});
	});

	it("omits the full profile when Nova's owned state is already current", () => {
		const projected = projectUpdatedAppProfileForTarget(
			application(),
			{
				properties: { foreign: { value: "standing" } },
				custom_properties: {
					foreign: "kept",
					"cc-index-case-search-results": "yes",
				},
			},
			true,
		);

		expect(projected).toMatchObject({ profileChanged: false });
		expect(projected.application.profile).toBeUndefined();
	});
});
