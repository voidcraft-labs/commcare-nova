/**
 * Nova's own `here()` in a case list, read back from Nova's own export: an
 * app that runs only on Android, whose list shows one calculated column of
 * the worker's location and sorts by a second one.
 *
 * Contract: the whole reading of the export holds the document after the
 * reader's canonical choices, with no finding and no defect, and offers the
 * Android declaration; both column slots read back to the tree the document
 * stores; and the reading claims `here()` under the entry that holds it in a
 * calculated column or a sort. The platform gate is part of the contract:
 * the same columns in an app that runs on Web Apps are refused by the
 * publish findings, so no such document reaches CommCare HQ to be read.
 *
 * Plausible failures: the `here` arm read as an unknown function or under
 * another entry (a finding on Nova's own export), the sort's print of
 * `here()` left unclaimed, the column read to another tree, the reading
 * proposing only a declaration that runs on Web Apps, and a publish that
 * lets the column through for an app that runs on Web Apps.
 */
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	calculatedColumn,
	NEW_APP_SETTINGS,
	type Platform,
	proseText,
} from "@/lib/domain";
import { publishFindings } from "@/proof/corpus/editBatches";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";
import { judgeReadBack, readEmission } from "./readBackCorpus";

const HERE_ENTRY =
	"expressions-and-data/here-in-a-case-list-calculated-column-or-sort";
const MODULE = testUuid("here-column-module");
const SHOWN = testUuid("here-column-shown");
const SORTED = testUuid("here-column-sorted");

/** The list of patients with a column of `here()` and a second sorted by it. */
function patients(runsOnlyOn: Platform | undefined): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.columns = [
		...config.columns,
		calculatedColumn(SHOWN, "Where you are", { kind: "here" }),
		calculatedColumn(
			SORTED,
			"Nearest",
			{ kind: "here" },
			{ sort: { direction: "asc", priority: 0 } },
		),
	];
	config.listColumnOrder = config.columns.map((column) => column.uuid);
	config.detailColumnOrder = config.columns.map((column) => column.uuid);
	return buildDoc({
		appName: "Here",
		appSettings: {
			...NEW_APP_SETTINGS,
			...(runsOnlyOn === undefined ? {} : { runsOnlyOn }),
		},
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
}

/** The document as the reader returns its pair's member. */
function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** The persisted document as JSON, without what no export carries: the app's
 *  id, and the platform declaration, which a reading proposes among choices. */
function comparable(doc: BlueprintDoc): Record<string, unknown> {
	const plain = JSON.parse(JSON.stringify(toPersistableDoc(doc))) as Record<
		string,
		unknown
	>;
	delete plain.appId;
	delete (plain.appSettings as { runsOnlyOn?: unknown }).runsOnlyOn;
	return plain;
}

describe("here() in a case list of an app that runs only on Android", () => {
	it("passes the publish findings", () => {
		expect(publishFindings(patients("android"), undefined)).toEqual([]);
	});

	it("reads back whole, with no finding, claiming here() under its own entry", async () => {
		const doc = patients("android");
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
				recordDialect: recordDialectRoundTrip,
			}),
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The export read to an account: ${JSON.stringify(outcome.findings.slice(0, 3))}`,
			);
		expect(comparable(outcome.draft.doc)).toEqual(comparable(canonical(doc)));
		const { declaration } = outcome.draft;
		expect(declaration.kind).toBe("choices");
		if (declaration.kind === "choices")
			expect(
				declaration.choices.some((choice) => choice.runsOnlyOn === "android"),
			).toBe(true);
		// One claim for each column: the sort reads the second column's value
		// through the sort row HQ joins to it.
		expect(outcome.claims.counts[HERE_ENTRY] ?? 0).toBeGreaterThanOrEqual(2);
	});

	it("reads each column's slot to the tree the document stores", async () => {
		const doc = patients("android");
		const reading = await readEmission(doc, recordDialectRoundTrip);
		expect(reading.closed.findings).toEqual([]);
		expect(reading.closed.defects).toEqual([]);
		const judged = judgeReadBack(doc, reading);
		for (const column of [SHOWN, SORTED]) {
			const slot = judged.find(
				({ stored }) =>
					stored.ref.entity === "module" &&
					stored.ref.uuid === MODULE &&
					stored.ref.slot === "case_list_column_expression" &&
					isDeepStrictEqual(stored.ref.member, { columnUuid: column }),
			);
			expect(slot?.verdict, column).toEqual({ kind: "same" });
		}
		expect(reading.closed.claims.counts[HERE_ENTRY] ?? 0).toBeGreaterThan(0);
	});
});

describe("here() in a case list of an app that runs on Web Apps", () => {
	it("is refused by the publish findings at each column, for both declarations that hold Web Apps", () => {
		for (const runsOnlyOn of [undefined, "web-apps"] as const) {
			const refused = publishFindings(patients(runsOnlyOn), undefined).filter(
				(finding) =>
					finding.details?.checkReason === "platform-unavailable" &&
					finding.details?.feature === "case-list-here",
			);
			expect(
				refused.map((finding) => finding.details?.columnUuid).sort(),
				runsOnlyOn ?? "both",
			).toEqual([SHOWN, SORTED].sort());
		}
	});
});
