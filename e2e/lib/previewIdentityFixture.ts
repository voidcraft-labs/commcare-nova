/**
 * The document the Preview identity peer (`preview-identity-client.tsx`)
 * runs: every screen of it reads a worker key every device holds, the
 * worker's first name, so a screen that read it before the signed-in
 * member's session resolved would show the refusal a device shows for a
 * worker who lacks the key. Plain TypeScript, so Vitest admits it before any
 * browser mounts it.
 *
 * - "Worker visits": a survey whose question starts on the first name.
 * - "Find patients": a case-first menu that searches first, with a Search
 *   field that starts on the first name.
 * - "Patients nearby": a menu that skips to results, whose Search button
 *   shows only for the worker named `IDENTITY_FIRST_NAME`. On Web Apps that
 *   condition decides whether the menu opens on the worker's list or on the
 *   default search's Results, so no list may show before the worker arrives.
 * - "Patients today": a menu that skips to results with no condition, whose
 *   Results are the default search's, which runs only once the worker
 *   arrives.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, sessionUser, term } from "@/lib/domain/expression";

export const IDENTITY_APP_ID = "native-identity";
/** The worker the peer's session resolves to, and the first name a device
 *  holds for them. */
export const IDENTITY_WORKER = {
	id: "native-worker",
	name: "Native worker",
	email: "native@example.org",
} as const;
export const IDENTITY_FIRST_NAME = "Native";

const firstName = () => term(sessionUser("commcare_first_name"));
const visitForm = (name: string) => ({
	name,
	type: "followup" as const,
	fields: [{ kind: "text" as const, id: "note", label: "Note" }],
});
const nameColumn = (key: string) => ({
	columns: [
		plainColumn(testUuid(key), "case_name", "Name", {
			visibleInList: true,
			visibleInDetail: false,
		}),
	],
});
const searchStartingOnFirstName = (key: string) => [
	simpleSearchInputDef(
		testUuid(key),
		"patient_name",
		"Patient name",
		"text",
		"case_name",
		{ default: firstName() },
	),
];

export function buildIdentityDoc(): BlueprintDoc {
	return buildDoc({
		appId: IDENTITY_APP_ID,
		appName: "Identity",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: testUuid("identity-worker-visits"),
				name: "Worker visits",
				forms: [
					{
						uuid: testUuid("identity-worker-visit"),
						name: "Worker visit",
						type: "survey",
						fields: [
							{
								kind: "text",
								id: "who",
								label: "Who",
								default_value: firstName(),
							},
						],
					},
				],
			},
			{
				uuid: testUuid("identity-find-patients"),
				name: "Find patients",
				caseType: "patient",
				caseListConfig: {
					...nameColumn("identity-find-name"),
					searchInputs: searchStartingOnFirstName("identity-find-input"),
				},
				forms: [visitForm("Visit found patient")],
			},
			{
				uuid: testUuid("identity-patients-nearby"),
				name: "Patients nearby",
				caseType: "patient",
				caseListConfig: {
					...nameColumn("identity-nearby-name"),
					searchInputs: [],
				},
				caseSearchConfig: {
					workflow: "skipToResults",
					searchButtonDisplayCondition: eq(
						firstName(),
						literal(IDENTITY_FIRST_NAME),
					),
				},
				forms: [visitForm("Visit nearby patient")],
			},
			{
				uuid: testUuid("identity-patients-today"),
				name: "Patients today",
				caseType: "patient",
				caseListConfig: {
					...nameColumn("identity-today-name"),
					searchInputs: [],
				},
				caseSearchConfig: { workflow: "skipToResults" },
				forms: [visitForm("Visit patient today")],
			},
		],
	});
}
