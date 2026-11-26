import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { servedExport } from "@/lib/deployment/reading/__tests__/novaReading";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	applyOriginalSelectionTags,
	readOriginalSelectionTags,
} from "../formOpeningSelectionMigration";

function sourceSnapshot() {
	const published = buildDoc({
		appId: "visit-app",
		caseTypes: [{ name: "person", properties: [] }],
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ id: "note", kind: "text", label: "Note" })],
					},
				],
			},
		],
	});
	const menu = published.moduleOrder[0];
	published.modules[menu].heldKind = "advanced";
	const form = published.formOrder[menu][0];
	const body = servedExport(published).body;
	const normalized = normalizeHqAppSource(body);
	if ("malformed" in normalized) throw new Error(normalized.malformed);
	const scope = {
		appId: published.appId,
		projectId: "clinic",
		deploymentId: "field-team",
		originalRevision: 4,
		snapshotDigest: canonicalJsonDigest(toPersistableDoc(published)),
		sourceDigest: normalized.digest,
	};
	return { published, source: normalized.normalized, scope, menu, form };
}

describe("recording the opening choices that existed on a deployment before this release", () => {
	it("keeps the published no-write choice by identity and leaves an unpublished sibling alone", () => {
		const { published, source, scope, menu, form } = sourceSnapshot();
		const [selection] = formCaseSelections(published, form);
		const facts = readOriginalSelectionTags(
			scope,
			published,
			source,
			DERIVED_WIRE_IDENTITY,
		);
		expect(facts.choices).toEqual([
			{ form, selection: selection.uuid, tag: selection.tag },
		]);
		const sibling = testUuid("new-unpublished-form");
		const head = {
			...published,
			forms: {
				...published.forms,
				[sibling]: {
					...published.forms[form],
					uuid: sibling,
					id: "later_visit",
					name: "Later visit",
				},
			},
			formOrder: {
				...published.formOrder,
				[menu]: [sibling, form],
			},
		};
		const converted = applyOriginalSelectionTags(
			head,
			{ ...scope, originalRevision: 6 },
			[facts],
		);
		expect(converted.forms[form].heldSelectionTags).toEqual({
			[selection.uuid]: selection.tag,
		});
		expect(converted.forms[sibling].heldSelectionTags).toBeUndefined();
		expect(applyOriginalSelectionTags(converted, scope, [facts])).toBe(
			converted,
		);
		expect(servedExport(converted).body).toEqual(servedExport(head).body);
	});

	it("refuses a changed source, a changed revision, another Project and disagreeing deployments", () => {
		const { published, source, scope, form } = sourceSnapshot();
		const read = () =>
			readOriginalSelectionTags(
				scope,
				published,
				source,
				DERIVED_WIRE_IDENTITY,
			);
		expect(() =>
			readOriginalSelectionTags(
				{ ...scope, sourceDigest: "different" },
				published,
				source,
				DERIVED_WIRE_IDENTITY,
			),
		).toThrow("source changed");
		expect(() =>
			readOriginalSelectionTags(
				scope,
				{ ...published, appName: "Changed" },
				source,
				DERIVED_WIRE_IDENTITY,
			),
		).toThrow("snapshot");
		const facts = read();
		expect(() =>
			applyOriginalSelectionTags(published, { ...scope, projectId: "other" }, [
				facts,
			]),
		).toThrow("Project");
		expect(() =>
			applyOriginalSelectionTags(
				published,
				{ ...scope, originalRevision: scope.originalRevision - 1 },
				[facts],
			),
		).toThrow("revision");
		expect(() =>
			applyOriginalSelectionTags(published, scope, [
				facts,
				{
					...facts,
					deploymentId: "another-target",
					choices: [{ ...facts.choices[0], form, tag: "other" }],
				},
			]),
		).toThrow("Two deployments");
	});
});
