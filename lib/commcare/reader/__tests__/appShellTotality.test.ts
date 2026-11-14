/**
 * Totality of the application walker: CommCare HQ's own apps, each with one
 * key HQ never wrote planted at the root, in `profile.properties` and in an
 * app language's `translations`. Each planted key is claimed under the entry
 * that covers keys of its kind, and none reaches the account unclaimed.
 *
 * It would catch an unknown key admitted with no claim, and a key claimed
 * under the wrong undeclared entry: a read-only member of `Application`
 * named at the root read as inert, or an inert name read as refused.
 */

import { describe, expect, it } from "vitest";
import { readApplication } from "../appShell";
import { readStructure } from "../structure";
import {
	closeAfterStructure,
	entriesAt,
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

const A = "application-and-settings";
const SOURCES = [
	"shell/app-source",
	"shell/app-source-after-app-settings-save",
	"hq-built/app-source",
	"navigation-base/app-source-after-ui-translations-save",
];

/** `body` with one key planted at the root, one in `profile.properties`, one in `translations.en`. */
function planted(
	body: Readonly<Record<string, unknown>>,
	root: string,
): Record<string, unknown> {
	const profile = (body.profile ?? {}) as { properties?: object };
	const translations = (body.translations ?? {}) as Record<string, object>;
	return {
		...body,
		[root]: "planted",
		profile: {
			...profile,
			properties: { ...profile.properties, "planted-property": "on" },
		},
		translations: {
			...translations,
			en: { ...translations.en, "planted.string": "Planted" },
		},
	};
}

async function readPlanted(body: Readonly<Record<string, unknown>>) {
	const ctx = readContext(readerInput(await sourceFromBody(body)));
	readApplication(ctx);
	readStructure(ctx);
	return closeAfterStructure(ctx);
}

describe("readApplication with a key HQ never wrote", () => {
	it.each(SOURCES)(
		"claims each planted key of %s under the entry for its kind",
		async (file) => {
			const closed = await readPlanted(
				planted(retainedSourceBody(file), "planted_key"),
			);
			expect(entriesAt(closed, "/planted_key")).toEqual([
				`${A}/any-other-unknown-top-level-key-that-names-no-application`,
			]);
			expect(entriesAt(closed, "/profile/properties/planted-property")).toEqual(
				[`${A}/any-other-profile-properties-features-key-not-in-the-yaml`],
			);
			expect(entriesAt(closed, "/translations/en/planted.string")).toEqual([
				`${A}/translations-key-no-runtime-reads`,
			]);
			expect(
				closed.findings.filter(
					(finding) =>
						finding.place.kind === "app" ||
						finding.place.kind === "app-settings" ||
						finding.place.kind === "languages",
				),
			).toEqual([]);
		},
	);

	it("refuses a root key naming a read-only member of Application, and keeps HQ's dynamic keys inert", async () => {
		const body = retainedSourceBody("shell/app-source");
		const closed = await readPlanted({
			...planted(body, "build_version"),
			user_registration: { doc_type: "UserRegistration" },
		});
		expect(entriesAt(closed, "/build_version")).toEqual([
			`${A}/an-unknown-top-level-key-naming-an-application-read-only`,
		]);
		expect(entriesAt(closed, "/user_registration")).toEqual([
			`${A}/dynamic-keys-anonymous-cloudcare-enabled-anonymous-cloudcare`,
		]);
		expect(closed.findings).toMatchObject([
			{
				code: `${A}/an-unknown-top-level-key-naming-an-application-read-only`,
				place: { kind: "app" },
				detail: { name: "build_version" },
			},
		]);
	});
});
