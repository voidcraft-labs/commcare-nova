/**
 * A project space whose stored text would set another string than its key
 * names, if Nova's archive wrote it as CommCare HQ stores it: keys Core reads
 * as another key or as none (a space before the key, `=`, `#` or a line
 * break in it) and texts that hold a carriage return, which ends a line on a
 * device, or a line break followed by a line that would define a string.
 *
 * `keptArchive.test.ts` reads the archive compiled for it with the TypeScript
 * port of Core's locale reader, and the proof lane's native producer
 * (`proof/native/producers/emit-localization-evidence.ts`) writes the same
 * archive's tables for `LocalizationRuntimeTest`, which reads them with
 * Core's own `LocalizationUtils.parseLocaleInput`.
 */

import type { BlueprintDoc } from "@/lib/domain";
import { usercaseWriteFixture } from "./usercaseWriteFixture";

/** A survey that writes the worker's record, in English and French. */
export function bilingualSurveyDoc(): BlueprintDoc {
	const doc = usercaseWriteFixture("survey");
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fra" },
		translations: {},
	};
	return doc;
}

/** When the project space's source was read. */
export const SMUGGLING_READ = {
	observedAt: "2026-11-01T00:00:00.000Z",
	novaOwnsAutoGpsCapture: false,
	adopted: true,
} as const;

/** The project space's source, as a stored baseline holds it. */
export const SMUGGLING_SOURCE = {
	langs: ["en", "fra"],
	profile: {
		properties: {
			"cc-autosync-freq": `freq${String.fromCharCode(0x01)}daily`,
		},
		features: { credentials: `3MON${String.fromCharCode(0x02)}` },
	},
	translations: {
		en: {
			" modules.m0": "Smuggled menu",
			"\tforms.m0f0": "Smuggled form",
			"x=y\nmodules.m0": "Smuggled menu",
			"a#b": "Smuggled",
			"home.start": "Begin\rforms.m0f0=Smuggled form",
			"home.sync": "Sync now",
			"home.logout": "x=y\nmodules.m0",
		},
		fra: {
			" modules.m0": "Menu passé",
			fra: "Français\rmodules.m0=Menu passé",
			"home.sync": "Envoyer #1",
		},
	},
};
