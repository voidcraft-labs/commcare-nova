/**
 * Two apps, each published to its own project space, for the journey that
 * shows Preview playing what a project space keeps in CommCare HQ.
 *
 * Both apps are the same: a case list of patients and an intake form with one
 * required question. What differs is the project space. Each deployment holds
 * a `push` baseline, CommCare HQ's own read of the app right after a publish,
 * and the first's holds fuzzy search in case lists and the asterisk on
 * required questions on (`yes`), where its twin holds both at Nova's own `no`.
 * Preview, the stream and the Publishing card all read those two facts from
 * the baseline, so the fixture writes the baseline and nothing else of
 * CommCare HQ.
 */

import { gzipSync } from "node:zlib";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import type { AppBaselineWrite } from "@/lib/deployment/types";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const KEPT_BASELINE_SEED = {
	/** The app whose project space keeps both settings on. */
	kept: { appName: "Smoke — Kept settings", domain: "kept-settings" },
	/** Its twin, whose project space keeps both at a new app's values. */
	twin: { appName: "Smoke — Kept defaults", domain: "kept-defaults" },
	caseType: "patient",
	patients: {
		moduleUuid: testUuid("kept-baseline-patients"),
		moduleName: "Patients",
		columnUuid: testUuid("kept-baseline-name-column"),
		formName: "Visit",
	},
	intake: {
		moduleUuid: testUuid("kept-baseline-intake"),
		moduleName: "Intake",
		formUuid: testUuid("kept-baseline-intake-form"),
		formName: "Intake",
		questionLabel: "Blood pressure",
	},
	/** The case the near miss finds. */
	match: "Ada Smith",
	/** A case nothing typed here matches. */
	other: "Ben Okafor",
	/** One letter from "Smith": a fuzzy match at distance 1, and no exact one. */
	nearMiss: "Smyth",
	/** When CommCare HQ was read, as the baseline stores it. */
	observedAt: "2026-11-10T09:00:00.000Z",
	/** Nova's own settings, as a publish's ownership descriptor names them. */
	ownedProfileProperties: ["cc-show-saved", "cc-show-incomplete"],
} as const;

/** One of the two apps, under its name. */
export function buildKeptBaselineBlueprint(
	appId: string,
	appName: string,
): BlueprintDoc {
	const { patients, intake } = KEPT_BASELINE_SEED;
	return buildDoc({
		appId,
		appName,
		caseTypes: [{ name: KEPT_BASELINE_SEED.caseType, properties: [] }],
		modules: [
			{
				uuid: patients.moduleUuid,
				name: patients.moduleName,
				caseType: KEPT_BASELINE_SEED.caseType,
				caseListConfig: {
					/* The name orders the list, so it keeps the sort key fuzzy
					 * search reads. */
					columns: [
						plainColumn(patients.columnUuid, "case_name", "Patient", {
							visibleInList: true,
							visibleInDetail: true,
							sort: { direction: "asc", priority: 0 },
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: patients.formName,
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
			{
				uuid: intake.moduleUuid,
				name: intake.moduleName,
				forms: [
					{
						uuid: intake.formUuid,
						name: intake.formName,
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "blood_pressure",
								label: proseText(intake.questionLabel),
								required: "true()",
							}),
						],
					},
				],
			},
		],
	});
}

/** The `push` baseline of a project space holding both settings at `value`. */
export function keptBaselineWrite(
	remoteAppId: string,
	value: "yes" | "no",
): AppBaselineWrite {
	const read = normalizeHqAppSource({
		doc_type: "Application",
		name: "Patients",
		langs: ["en"],
		translations: { en: { en: "English" } },
		profile: {
			properties: {
				"cc-fuzzy-search-enabled": value,
				"cc-label-required-questions-with-asterisk": value,
			},
		},
		modules: [],
		_attachments: {},
	});
	if ("malformed" in read)
		throw new Error(
			`The kept-settings fixture's CommCare HQ read did not normalize: ${read.malformed}`,
		);
	return {
		origin: "push",
		remoteAppId,
		sourceGzip: gzipSync(Buffer.from(read.text, "utf8")),
		sourceBytes: read.bytes,
		sourceDigest: read.digest,
		ownership: {
			addOns: [],
			profileProperties: [...KEPT_BASELINE_SEED.ownedProfileProperties],
			profileCustomProperties: [],
			autoGpsCapture: false,
		},
		observedAt: KEPT_BASELINE_SEED.observedAt,
		discard: null,
	};
}

/** Where the journey opens each screen of one app. */
export function keptBaselineRoutes(appId: string) {
	const base = `/build/${appId}`;
	return {
		patients: buildUrl(base, {
			kind: "module",
			moduleUuid: KEPT_BASELINE_SEED.patients.moduleUuid,
		}),
		intake: buildUrl(base, {
			kind: "form",
			moduleUuid: KEPT_BASELINE_SEED.intake.moduleUuid,
			formUuid: KEPT_BASELINE_SEED.intake.formUuid,
		}),
		publishing: buildUrl(base, { kind: "app-setup", section: "publishing" }),
	};
}
