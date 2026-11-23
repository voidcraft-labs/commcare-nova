/**
 * The overlay of a generated app onto the app a target holds: which part of
 * `translations`, `add_ons` and `profile` is Nova's, which is the target's,
 * and the ownership the drift baseline records. Pure; what HQ does with the
 * body is the proof lane's.
 */
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { HqApplication, HqApplicationProfile } from "@/lib/commcare";
import {
	appProfileProperties,
	SEEDED_PROFILE_PROPERTIES,
} from "../appProfileSettings";
import { expandAppShell } from "../expander";
import type { HqAppSource } from "../hq/appSource";
import {
	projectAddOnsForTarget,
	projectApplicationForTarget,
	projectProfileForTarget,
	projectTranslationsForTarget,
	shellOwnership,
} from "../targetOverlay";

const SEVENTEEN = Object.fromEntries(
	appProfileProperties(
		buildDoc({
			appSettings: { showSavedForms: true, showIncompleteForms: false },
		}),
	).map(({ key, value }) => [key, value]),
);

function application(
	overrides: Partial<HqApplication> = {},
	derivedProfile = true,
): HqApplication {
	return {
		doc_type: "Application",
		application_version: "2.0",
		name: "Clinic",
		langs: ["en", "fra"],
		translations: {
			en: { en: "English", fra: "French" },
			fra: {
				"app.display.name": "Clinique",
				"homescreen.title": "Clinique",
				en: "English",
				fra: "French",
			},
		},
		profile: {
			properties: { ...SEVENTEEN },
			...(derivedProfile && {
				custom_properties: { "cc-index-case-search-results": "yes" },
			}),
		},
		add_ons: { display_conditions: true },
		location_fixture_restore: "project_default",
		cloudcare_enabled: true,
		modules: [],
		_attachments: { "form.xml": "<data/>" },
		...overrides,
	};
}

/** Nova created the HQ app: it writes its own language labels and seeds. */
const NOVA_NAMES = { languageNames: "nova" } as const;
const NOVA_SEEDS = { seeds: "nova" } as const;
const NOVA_FILL = { ...NOVA_NAMES, ...NOVA_SEEDS };

function source(overrides: Partial<HqAppSource> = {}): HqAppSource {
	return {
		docType: "Application",
		buildSpecVersion: "2.57.0",
		cloudcareEnabled: true,
		logoRefs: {},
		profile: {},
		langs: ["en", "fra"],
		translations: {},
		addOns: {},
		modules: [],
		raw: {},
		name: null,
		lastModified: null,
		multimediaMap: [],
		buildProfiles: [],
		...overrides,
	};
}

describe("translations", () => {
	it("keeps every target key in every language, an empty one and a language Nova does not hold included", () => {
		const projected = projectTranslationsForTarget(
			application(),
			source({
				langs: ["en", "fra", "hin"],
				translations: {
					en: { "home.start": "Begin", "android.package.name.x": "x" },
					fra: { "home.start": "" },
					hin: { "home.start": "Shuru", hin: "Hindi" },
				},
			}),
			NOVA_NAMES,
		);
		expect(projected).toEqual({
			en: {
				"home.start": "Begin",
				"android.package.name.x": "x",
				en: "English",
				fra: "French",
			},
			fra: {
				"home.start": "",
				"app.display.name": "Clinique",
				"homescreen.title": "Clinique",
				en: "English",
				fra: "French",
			},
			// `hin` left the app: its name goes, its target key stays.
			hin: { "home.start": "Shuru" },
		});
	});

	it("drops every generated key HQ holds but Nova's own app-name keys", () => {
		const projected = projectTranslationsForTarget(
			application(),
			source({
				translations: {
					en: {
						"modules.m0": "Stale menu",
						"forms.m0f0": "Stale form",
						"app.display.name": "Clinic",
						"homescreen.title": "Clinic",
						m0_select_text: "Pick",
					},
				},
			}),
			NOVA_NAMES,
		);
		// English does not localize the name, so neither app-name key stays.
		expect(projected?.en).toEqual({ en: "English", fra: "French" });
		expect(projected?.fra?.["app.display.name"]).toBe("Clinique");
	});

	it("never writes an empty value of Nova's own", () => {
		const projected = projectTranslationsForTarget(
			application({ translations: { en: { en: "", fra: "French" } } }),
			source({ translations: {} }),
			NOVA_NAMES,
		);
		expect(projected).toEqual({ en: { fra: "French" } });
	});

	it("leaves the key out where the result is what the target holds", () => {
		const current = {
			fra: {
				fra: "French",
				en: "English",
				"homescreen.title": "Clinique",
				"app.display.name": "Clinique",
			},
			en: { fra: "French", en: "English", "home.start": "Begin" },
		};
		expect(
			projectTranslationsForTarget(
				application(),
				source({ translations: current }),
				NOVA_NAMES,
			),
		).toBeUndefined();
	});
});

describe("translations on an app Nova brought in", () => {
	const TARGET_NAMES = { languageNames: "target" } as const;

	it("carries a language name the target holds and writes none of Nova's labels", () => {
		const projected = projectTranslationsForTarget(
			application(),
			source({
				translations: {
					en: { en: "English, as typed", "home.start": "Begin" },
					fra: { fra: "Français", en: "" },
				},
			}),
			TARGET_NAMES,
		);
		expect(projected).toEqual({
			en: { en: "English, as typed", "home.start": "Begin" },
			fra: {
				fra: "Français",
				en: "",
				"app.display.name": "Clinique",
				"homescreen.title": "Clinique",
			},
		});
	});

	it("leaves a name the target does not hold absent", () => {
		const projected = projectTranslationsForTarget(
			application(),
			source({ translations: { en: { "home.start": "Begin" } } }),
			TARGET_NAMES,
		);
		expect(projected).toEqual({
			en: { "home.start": "Begin" },
			fra: {
				"app.display.name": "Clinique",
				"homescreen.title": "Clinique",
			},
		});
		/* The same read under Nova's labels writes each language's name. */
		expect(
			projectTranslationsForTarget(
				application(),
				source({ translations: { en: { "home.start": "Begin" } } }),
				NOVA_NAMES,
			)?.en,
		).toEqual({ "home.start": "Begin", en: "English", fra: "French" });
	});

	it("leaves the key out where the target already holds every name it keeps", () => {
		const current = {
			en: { en: "Inglés", "home.start": "Begin" },
			fra: {
				"app.display.name": "Clinique",
				"homescreen.title": "Clinique",
			},
		};
		expect(
			projectTranslationsForTarget(
				application(),
				source({ translations: current }),
				TARGET_NAMES,
			),
		).toBeUndefined();
		/* Nova's labels would replace that name. */
		expect(
			projectTranslationsForTarget(
				application(),
				source({ translations: current }),
				NOVA_NAMES,
			)?.en?.en,
		).toBe("English");
	});
});

describe("add-ons", () => {
	it("turns each needed slug on over the target's map, keeping every other slug and never writing false", () => {
		const projected = projectAddOnsForTarget(
			application({ add_ons: { display_conditions: true, subcases: true } }),
			source({
				addOns: {
					display_conditions: false,
					menu_mode: true,
					future_slug: true,
				},
			}),
		);
		expect(projected).toEqual({
			display_conditions: true,
			menu_mode: true,
			future_slug: true,
			subcases: true,
		});
		expect(Object.values(projected ?? {})).not.toContain(false);
	});

	it("keeps a slug a person turned off that the app does not need, and leaves a no-op out", () => {
		expect(
			projectAddOnsForTarget(
				application({ add_ons: { display_conditions: true } }),
				source({ addOns: { display_conditions: true, calc_xpaths: false } }),
			),
		).toBeUndefined();
		expect(
			projectAddOnsForTarget(
				application({ add_ons: undefined }),
				source({ addOns: { menu_mode: false } }),
			),
		).toBeUndefined();
	});
});

describe("profile", () => {
	it("sets, reorders and clears the required apps beside the target's other features", () => {
		const current = {
			features: {
				credentials: "L1",
				dependencies: ["org.rdtoolkit", "com.simprints.id"],
			},
		};
		const changed = application({
			profile: {
				features: { dependencies: ["com.simprints.id", "org.rdtoolkit"] },
			},
		});
		expect(
			projectProfileForTarget(changed, current, "unverified", NOVA_SEEDS)
				?.features,
		).toEqual({
			credentials: "L1",
			dependencies: ["com.simprints.id", "org.rdtoolkit"],
		});
		expect(
			projectProfileForTarget(application(), current, "missing", NOVA_SEEDS)
				?.features,
		).toEqual({ credentials: "L1" });
	});
	it("keeps a seeded setting the target holds, seeds one HQ's build writes nothing for, and always writes Nova's two", () => {
		const current: HqApplicationProfile = {
			properties: {
				"cc-autoup-freq": "freq-daily",
				"cc-fuzzy-search-enabled": null,
				"cc-enable-tts": "",
				"cc-content-valid": false,
				"cc-days-form-retain": 0,
				"cc-resize-images": ["half"],
				"cc-show-saved": "no",
				"cc-show-incomplete": "yes",
				"foreign-setting": { value: [1, "two"] },
			},
		};
		const projected = projectProfileForTarget(
			application(),
			current,
			"available",
			NOVA_SEEDS,
		);
		expect(projected?.properties).toEqual({
			...SEVENTEEN,
			"cc-autoup-freq": "freq-daily",
			"cc-show-saved": "yes",
			"cc-show-incomplete": "no",
			"foreign-setting": { value: [1, "two"] },
		});
		for (const { key } of SEEDED_PROFILE_PROPERTIES) {
			if (key === "cc-autoup-freq") continue;
			expect(projected?.properties?.[key]).toBe(SEVENTEEN[key]);
		}
	});

	it("on an app Nova brought in, seeds no setting the target holds no value for and still writes Nova's two", () => {
		const current: HqApplicationProfile = {
			properties: {
				"cc-autoup-freq": "freq-daily",
				"cc-fuzzy-search-enabled": null,
				"cc-enable-tts": "",
				"cc-content-valid": false,
				"cc-days-form-retain": 0,
				"cc-show-saved": "no",
			},
		};
		const projected = projectProfileForTarget(
			application(),
			current,
			"available",
			{ seeds: "target" },
		);
		/* Every seeded key stays as the target holds it: absent, or a value
		 * HQ's build writes nothing for. */
		expect(projected?.properties).toEqual({
			"cc-autoup-freq": "freq-daily",
			"cc-fuzzy-search-enabled": null,
			"cc-enable-tts": "",
			"cc-content-valid": false,
			"cc-days-form-retain": 0,
			"cc-show-saved": "yes",
			"cc-show-incomplete": "no",
		});
		/* The same read under Nova's seeds writes each seed it holds none for. */
		const seeded = projectProfileForTarget(
			application(),
			current,
			"available",
			NOVA_SEEDS,
		)?.properties;
		for (const { key } of SEEDED_PROFILE_PROPERTIES) {
			if (key === "cc-autoup-freq") continue;
			expect(seeded?.[key], key).toBe(SEVENTEEN[key]);
		}
	});

	it("on an app Nova brought in, sends no profile where the target holds Nova's two", () => {
		expect(
			projectProfileForTarget(
				application(),
				{ properties: { "cc-show-saved": "yes", "cc-show-incomplete": "no" } },
				"not-needed",
				{ seeds: "target" },
			),
		).toBeUndefined();
	});

	it("keeps every other section and leaves a no-op out", () => {
		const current: HqApplicationProfile = {
			features: { users: { value: true } },
			properties: { ...SEVENTEEN, "cc-autoup-freq": "freq-daily" },
			custom_properties: {
				foreign: "kept",
				"cc-index-case-search-results": "yes",
			},
		};
		expect(
			projectProfileForTarget(application(), current, "available", NOVA_SEEDS),
		).toBeUndefined();
		const changed = projectProfileForTarget(
			application(),
			{ ...current, properties: { ...SEVENTEEN, "cc-show-saved": "no" } },
			"available",
			NOVA_SEEDS,
		);
		expect(changed?.features).toEqual({ users: { value: true } });
		expect(changed?.custom_properties).toEqual(current.custom_properties);
	});

	it("sets, removes or keeps the derived custom property by the target's Search advisory", () => {
		const current: HqApplicationProfile = {
			properties: { ...SEVENTEEN },
			custom_properties: {
				foreign: "kept",
				foreignNull: null,
				"cc-index-case-search-results": "no",
			},
		};
		expect(
			projectProfileForTarget(application(), current, "available", NOVA_SEEDS)
				?.custom_properties,
		).toEqual({
			foreign: "kept",
			foreignNull: null,
			"cc-index-case-search-results": "yes",
		});
		for (const state of ["missing", "not-needed"] as const)
			expect(
				projectProfileForTarget(application(), current, state, NOVA_SEEDS)
					?.custom_properties,
			).toEqual({ foreign: "kept", foreignNull: null });
		// Unverified projects the settings and leaves the bag as it is.
		const unverified = projectProfileForTarget(
			application(),
			{ ...current, properties: {} },
			"unverified",
			NOVA_SEEDS,
		);
		expect(unverified?.properties).toEqual(SEVENTEEN);
		expect(unverified?.custom_properties).toEqual(current.custom_properties);
	});

	it("never takes a generated custom property outside Nova's own keys", () => {
		const generated = application();
		const custom = generated.profile?.custom_properties;
		if (custom === undefined) throw new Error("Expected a derived property.");
		custom.foreign = "must-not-overwrite";
		expect(
			projectProfileForTarget(
				generated,
				{
					properties: { ...SEVENTEEN },
					custom_properties: { foreign: "target" },
				},
				"available",
				NOVA_SEEDS,
			)?.custom_properties,
		).toEqual({ foreign: "target", "cc-index-case-search-results": "yes" });
	});
});

describe("the whole body and its ownership", () => {
	it("projects the three keys, keeps everything else and `_attachments` last, and changes neither input", () => {
		const input = application();
		const current = source({
			addOns: { menu_mode: true },
			translations: { en: { "home.start": "Begin" } },
			profile: { properties: { "cc-autoup-freq": "freq-daily" } },
		});
		const before = structuredClone({ input, current });
		const { application: body } = projectApplicationForTarget(
			input,
			current,
			"available",
			NOVA_FILL,
		);
		expect({ input, current }).toEqual(before);
		expect(Object.keys(body).at(-1)).toBe("_attachments");
		expect(body.add_ons).toEqual({ menu_mode: true, display_conditions: true });
		expect(body.translations?.en?.["home.start"]).toBe("Begin");
		expect(body.profile?.properties?.["cc-autoup-freq"]).toBe("freq-daily");
		const { translations, add_ons, profile, ...rest } = body;
		const { translations: _t, add_ons: _a, profile: _p, ...inputRest } = input;
		expect(rest).toEqual(inputRest);
		expect([translations, add_ons, profile]).not.toContain(undefined);
	});

	it("leaves out each key that equals the target's", () => {
		const input = application();
		const { application: first } = projectApplicationForTarget(
			input,
			source(),
			"available",
			NOVA_FILL,
		);
		const current = source({
			translations: first.translations ?? {},
			addOns: first.add_ons ?? {},
			profile: first.profile ?? {},
		});
		const { application: again } = projectApplicationForTarget(
			input,
			current,
			"available",
			NOVA_FILL,
		);
		for (const key of ["translations", "add_ons", "profile"])
			expect(Object.hasOwn(again, key)).toBe(false);
	});

	it("hands each option to its key: names to translations, seeds to the profile", () => {
		const current = source({
			translations: { en: { en: "Inglés" } },
			profile: { properties: {} },
		});
		const { application: body } = projectApplicationForTarget(
			application(),
			current,
			"not-needed",
			{ languageNames: "target", seeds: "nova" },
		);
		expect(body.translations?.en?.en).toBe("Inglés");
		expect(body.profile?.properties?.["cc-autoup-freq"]).toBe("freq-never");
		const { application: other } = projectApplicationForTarget(
			application(),
			current,
			"not-needed",
			{ languageNames: "nova", seeds: "target" },
		);
		expect(other.translations?.en?.en).toBe("English");
		expect(
			Object.hasOwn(other.profile?.properties ?? {}, "cc-autoup-freq"),
		).toBe(false);
	});

	it("records what Nova set: the needed add-ons, its two settings and the derived key it sets", () => {
		const { ownership } = projectApplicationForTarget(
			application({ add_ons: { subcases: true, display_conditions: true } }),
			source({ addOns: { menu_mode: true, calc_xpaths: true } }),
			"available",
			NOVA_FILL,
		);
		expect(ownership).toEqual({
			addOns: ["display_conditions", "subcases"],
			profileProperties: ["cc-show-saved", "cc-show-incomplete"],
			profileCustomProperties: ["cc-index-case-search-results"],
			profileFeatures: ["dependencies"],
			autoGpsCapture: false,
		});
		for (const state of ["missing", "not-needed", "unverified"] as const)
			expect(
				projectApplicationForTarget(application(), source(), state, NOVA_FILL)
					.ownership.profileCustomProperties,
			).toEqual([]);
		expect(
			projectApplicationForTarget(
				application({ auto_gps_capture: true }),
				source(),
				"available",
				NOVA_FILL,
			).ownership.autoGpsCapture,
		).toBe(true);
	});

	it("names no add-on and no profile key for the shell, and owns its Auto Capture Location", () => {
		// Every shell writes `auto_gps_capture`, false included, so a later
		// publish that clears the switch is compared on the key it wrote.
		const shell = expandAppShell(buildDoc({ appName: "Visits" }));
		expect(shell.auto_gps_capture).toBe(false);
		expect(shellOwnership(shell)).toEqual({
			addOns: [],
			profileProperties: [],
			profileCustomProperties: [],
			autoGpsCapture: true,
		});
		expect(shellOwnership({}).autoGpsCapture).toBe(false);
	});
});
