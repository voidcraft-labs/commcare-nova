import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	alignedFromSource,
	sourceFromBaseline,
} from "@/lib/deployment/hqChanges/baselineSource";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { servedExport } from "@/lib/deployment/reading/__tests__/novaReading";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { planFieldRemoval } from "@/lib/doc/fieldRemovalMutations";
import { applyMutations } from "@/lib/doc/mutations";
import { sharedFormMutations } from "@/lib/doc/scaffolds";
import { planFormDependentsOnRemove } from "@/lib/doc/sharedFormDependents";
import {
	type BlueprintDoc,
	type FormCaseSelection,
	proseText,
	type Uuid,
} from "@/lib/domain";
import {
	formCaseSelections,
	formEntryRecord,
} from "@/lib/domain/advancedEntryDatums";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { term } from "@/lib/domain/expression/builders";
import { buildEngineInput } from "@/lib/preview/engine/engineInput";
import { sharedVisitEntries } from "../../../proof/targeted/documents/sharedVisitEntries";
import { compileCczParts } from "../compiler";
import { expandDoc } from "../expander";
import {
	entryDatumIds,
	formLinkProjectionContext,
} from "../formLinkProjection";
import { namingFromHqPages } from "../reader/__tests__/hqPageNames";
import { readCases } from "../reader/caseManagement/__tests__/caseReading";
import type { HqAnyForm } from "../types";
import { fieldKindMatchesPropertyType } from "../validator/rules/fieldKindMatchesPropertyType";
import { sharedFormDependencies } from "../validator/rules/sharedForm";
import {
	derivedFormXmlns,
	derivedUniqueId,
	targetWireIdentity,
} from "../wireIdentity";
import {
	advancedFixture,
	HOUSEHOLDS,
	VISITS,
} from "./advancedPlacementFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

function choose(name: string, tag: string): FormCaseSelection {
	return {
		uuid: testUuid(tag),
		tag,
		name,
		caseType: "household",
		source: { kind: "choose", module: HOUSEHOLDS },
	};
}

function sharedEntries() {
	const { doc: original, formUuid: parent } = advancedFixture({
		formType: "followup",
		operations: () => [],
	});
	const morning = testUuid("morning-entry");
	const evening = testUuid("evening-entry");
	const destination = choose("Receiving household", "destination");
	const origin = choose("Referring household", "origin");
	const helper = choose("Household to call", "alternate");
	const doc = produce(original, (d) => {
		d.forms[parent].caseSelections = [origin, destination];
	});
	const create = (name: string, uuid: Uuid) => {
		const result = sharedFormMutations(doc, HOUSEHOLDS, parent, { name, uuid });
		if (!result)
			throw new Error("An ordinary advanced form can be shared in this menu.");
		return result.mutations;
	};
	const entries = produce(doc, (d) => {
		applyMutations(d, [
			...create("Morning visit", morning),
			...create("Evening visit", evening),
			{
				kind: "updateForm",
				uuid: morning,
				patch: {},
				entryChange: {
					operation: "move-choice",
					uuid: destination.uuid,
					after: null,
				},
			},
			{
				kind: "updateForm",
				uuid: morning,
				patch: {},
				entryChange: {
					operation: "add-choice",
					value: helper,
					after: destination.uuid,
				},
			},
			{
				kind: "updateForm",
				uuid: evening,
				patch: {},
				entryChange: { operation: "remove-choice", uuid: origin.uuid },
			},
		]);
	});
	return {
		doc: entries,
		morning,
		evening,
		parent,
		destination,
		origin,
		helper,
	};
}

describe("two entries opening the same questions", () => {
	it("installs one resource for three distinct commands, each with its own physical session steps", () => {
		const fixture = sharedVisitEntries();
		const doc = hydratePersistedBlueprint(fixture.doc);
		const hq = expandDoc(doc);
		const pkg = compileCczParts(hq, doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
		});
		expect(
			Object.keys(pkg.files).filter((path) => path.startsWith("modules-0/")),
		).toEqual(["modules-0/forms-0.xml"]);
		const suite = readXmlEvidence(pkg.files["suite.xml"]);
		const commands = xmlChildren(suite, "entry").filter((entry) =>
			xmlChildren(entry, "command")[0]?.attributes.id.startsWith("m0-f"),
		);
		expect(
			commands.map((entry) => onlyXml(xmlChildren(entry, "form")).text),
		).toEqual(Array(3).fill(hq.modules[0].forms[0].xmlns));
		expect(
			commands.map((entry) => [
				onlyXml(xmlChildren(entry, "command")).attributes.id,
				xmlChildren(onlyXml(xmlChildren(entry, "session")), "datum").map(
					(row) => row.attributes.id,
				),
			]),
		).toEqual([
			["m0-f0", ["case_id_referrer", "case_id_patient"]],
			["m0-f1", ["case_id_patient", "case_id_contact", "case_id_referrer"]],
			["m0-f2", ["case_id_patient"]],
		]);
	});

	it("keeps each entry's order, copies no content and uses the target's real parent id and namespace", () => {
		const { doc, parent, morning, evening, origin, destination, helper } =
			sharedEntries();
		expect(formCaseSelections(doc, morning).map((r) => r.uuid)).toEqual([
			destination.uuid,
			helper.uuid,
			origin.uuid,
		]);
		expect(formCaseSelections(doc, evening).map((r) => r.uuid)).toEqual([
			destination.uuid,
		]);
		const atOrigin = targetWireIdentity([
			{
				entityKind: "form",
				novaEntityUuid: parent,
				uniqueId: "origin-parent",
				xmlns: "urn:adopted-parent",
			},
			{
				entityKind: "form",
				novaEntityUuid: morning,
				uniqueId: "origin-morning",
				xmlns: null,
			},
			{
				entityKind: "form",
				novaEntityUuid: evening,
				uniqueId: "origin-evening",
				xmlns: null,
			},
		]);
		for (const identity of [atOrigin, targetWireIdentity([])]) {
			const source = expandDoc(doc, { identity });
			const forms = source.modules.flatMap<HqAnyForm>((m) => m.forms);
			const xmlns =
				identity === atOrigin ? "urn:adopted-parent" : derivedFormXmlns(parent);
			const parentId = identity.formUniqueId(parent);
			expect(forms.find((f) => f.unique_id === parentId)).toMatchObject({
				doc_type: "AdvancedForm",
				xmlns,
			});
			expect(source._attachments[`${parentId}.xml`]).toContain(xmlns);
			for (const uuid of [morning, evening]) {
				const id = identity.formUniqueId(uuid);
				const shell = forms.find((f) => f.unique_id === id);
				expect(shell).toMatchObject({
					doc_type: "ShadowForm",
					shadow_parent_form_id: parentId,
				});
				expect(shell).toHaveProperty("xmlns", null);
				expect(source._attachments).not.toHaveProperty(`${id}.xml`);
				expect(buildEngineInput(doc, uuid, null)).toMatchObject({
					entryUuid: uuid,
					formUuid: parent,
					form: doc.forms[parent],
				});
			}
		}
		expect(sharedFormMutations(doc, VISITS, parent)).toBeUndefined();
		expect(sharedFormMutations(doc, HOUSEHOLDS, morning)).toBeUndefined();
	});

	it("keeps the entry’s own choices and formulas when it starts opening another form", () => {
		const { doc, morning, helper } = sharedEntries();
		const other = Object.values(doc.forms).find(
			(form) => form.name === "Visit",
		);
		if (!other)
			throw new Error("Expected the other ordinary form in this menu.");
		const local = testUuid("local-code");
		const remote = testUuid("original-code");
		const suffix = testUuid("original-suffix");
		const text = (value: string) => term({ kind: "literal", value });
		const input = produce(doc, (draft) => {
			draft.forms[morning].computedDatums = [
				{ uuid: local, key: "visit_code", value: text("local value") },
			];
			draft.forms[other.uuid].computedDatums = [
				{ uuid: remote, key: "visit_code", value: text("another value") },
				{
					uuid: suffix,
					key: "suffix",
					value: term({
						kind: "session-datum",
						datum: { kind: "entry-value", datum: remote },
					}),
				},
			];
		});
		const change = () =>
			produce(input, (draft) => {
				applyMutations(draft, [
					{
						kind: "updateForm",
						uuid: morning,
						patch: {},
						entryChange: {
							operation: "change-shared-form",
							parentFormUuid: other.uuid,
						},
					},
				]);
			});
		const edited = change();
		expect(change().forms[morning]).toEqual(edited.forms[morning]);
		const entry = edited.forms[morning];
		expect(entry.shadowOf?.form).toBe(other.uuid);
		expect(entry.shadowOf?.selections.at(-1)).toMatchObject({
			kind: "add",
			uuid: helper.uuid,
		});
		expect(entry.computedDatums).toMatchObject([
			{ uuid: local, key: "visit_code", value: text("local value") },
			{
				key: "suffix",
				value: term({
					kind: "session-datum",
					datum: { kind: "entry-value", datum: local },
				}),
			},
		]);
		expect(entry.computedDatums?.[1].uuid).not.toBe(suffix);
	});

	it("allows omission until the content requires the choice, then names the dependent entry", () => {
		const { doc, morning, evening, parent, origin } = sharedEntries();
		const needs = (d: BlueprintDoc, id: Uuid) =>
			sharedFormDependencies(
				d,
				d.forms[id],
				HOUSEHOLDS,
				formLinkProjectionContext(d),
			);
		expect(needs(doc, evening)).toEqual([]);
		const usesOrigin = produce(doc, (d) => {
			const field = d.fields[d.fieldOrder[parent][0]];
			if (field.kind !== "text")
				throw new Error("Expected the shared name question.");
			field.relevant = term({
				kind: "session-datum",
				datum: { kind: "form-selection", selection: origin.uuid },
			});
		});
		expect(needs(usesOrigin, morning)).toEqual([]);
		expect(needs(usesOrigin, evening).join(" ")).toContain("Evening visit");
		const repaired = produce(usesOrigin, (d) => {
			applyMutations(d, [
				{
					kind: "updateForm",
					uuid: evening,
					patch: {},
					entryChange: {
						operation: "restore-shared-choice",
						uuid: origin.uuid,
						after: null,
					},
				},
			]);
		});
		expect(needs(repaired, evening)).toEqual([]);
	});

	it("needs the choice a parent's starting value reads, as its own entry does", () => {
		const { doc, morning, evening, parent, origin } = sharedEntries();
		const needs = (d: BlueprintDoc, id: Uuid) =>
			sharedFormDependencies(
				d,
				d.forms[id],
				HOUSEHOLDS,
				formLinkProjectionContext(d),
			);
		const fills = produce(doc, (d) => {
			d.forms[parent].openingAssignments = [
				{
					uuid: testUuid("origin-name"),
					field: d.fieldOrder[parent][0],
					source: { kind: "selection", selection: origin.uuid },
					property: "case_name",
				},
			];
		});
		// Morning keeps the referring household; evening left it out.
		expect(needs(fills, morning)).toEqual([]);
		expect(needs(fills, evening).join(" ")).toContain("Evening visit");
	});

	it("restores each sibling’s original deployment id from a baseline with scrubbed source ids", () => {
		const { doc, parent, morning, evening } = sharedEntries();
		const identity = targetWireIdentity([
			{
				entityKind: "form",
				novaEntityUuid: parent,
				uniqueId: "held-parent",
				xmlns: "urn:held-form",
			},
			{
				entityKind: "form",
				novaEntityUuid: morning,
				uniqueId: "held-morning",
				xmlns: null,
			},
			{
				entityKind: "form",
				novaEntityUuid: evening,
				uniqueId: "held-evening",
				xmlns: null,
			},
		]);
		const base = normalizeHqAppSource(servedExport(doc, { identity }).body);
		if ("malformed" in base) throw new Error(base.malformed);
		const aligned = alignedFromSource(sourceFromBaseline(base.normalized), {
			doc,
			identity,
		});
		const rows = aligned
			.flatMap((menu) => (menu.kind === "aligned" ? menu.forms : []))
			.filter((row) => row.source.docType === "ShadowForm");
		expect(rows.map((row) => row.source.readUniqueId)).toEqual([
			"m0.f2",
			"m0.f3",
		]);
		expect(rows.map((row) => [row.uniqueId, row.xmlns])).toEqual([
			["held-morning", "urn:held-form"],
			["held-evening", "urn:held-form"],
		]);
	});

	it("saves the parent’s answer into the replacement record type and names each affected entry on removal", () => {
		const { doc, parent, morning, evening, destination } = sharedEntries();
		const age = doc.fieldOrder[parent].find(
			(uuid) => doc.fields[uuid].id === "age",
		);
		if (!age) throw new Error("Expected an integer question.");
		const configured = produce(doc, (draft) => {
			applyMutations(draft, [
				{
					kind: "updateForm",
					uuid: parent,
					patch: {},
					caseOperationChange: {
						operation: "add",
						value: {
							uuid: testUuid("write-age"),
							id: "save",
							action: "own",
							writes: [
								{
									property: "age_at_visit",
									value: term({ kind: "field", uuid: age }),
								},
							],
						},
					},
				},
				{
					kind: "updateForm",
					uuid: morning,
					patch: {},
					entryChange: {
						operation: "edit-choice",
						uuid: destination.uuid,
						patch: {
							source: { kind: "choose", module: VISITS },
							caseType: "visit",
						},
					},
				},
			]);
		});
		expect(formEntryRecord(configured, morning)).toMatchObject({
			caseType: "visit",
			contentCaseType: "household",
			requiresCase: true,
		});
		expect(formEntryRecord(configured, evening)).toMatchObject({
			caseType: "household",
			requiresCase: true,
		});
		const holding = effectiveCaseTypes(configured).filter((type) =>
			["visit", "household"].includes(type.name),
		);
		for (const type of holding)
			expect(
				type.properties.find((p) => p.name === "age_at_visit"),
			).toMatchObject({ data_type: "int" });
		const incompatible = produce(configured, (draft) => {
			draft.caseTypes
				?.find((type) => type.name === "visit")
				?.properties.push({
					name: "age_at_visit",
					label: proseText("Visit age"),
					data_type: "time",
				});
		});
		expect(
			fieldKindMatchesPropertyType(incompatible)
				.map((f) => f.message)
				.join(" "),
		).toContain("Morning visit");
		const formRemoval = planFormDependentsOnRemove(configured, {
			kind: "form",
			formUuid: parent,
		});
		const fieldRemoval = planFieldRemoval(configured, age);
		if (formRemoval.kind !== "blocked" || fieldRemoval.ok)
			throw new Error("The shared write needs its question.");
		for (const name of ["Morning visit", "Evening visit"]) {
			expect(formRemoval.userMessage).toContain(name);
			expect(fieldRemoval.message).toContain(name);
		}
	});

	it("binds a calculated extra choice to the preceding replacement and ignores entry-owned case writes", async () => {
		const { doc, morning, destination, helper } = sharedEntries();
		const configured = produce(doc, (draft) => {
			applyMutations(draft, [
				{
					kind: "updateForm",
					uuid: morning,
					patch: {},
					entryChange: {
						operation: "edit-choice",
						uuid: helper.uuid,
						patch: {
							source: {
								kind: "expression",
								value: term({
									kind: "session-datum",
									datum: {
										kind: "form-selection",
										selection: destination.uuid,
									},
								}),
							},
						},
					},
				},
			]);
		});
		const { whole } = await namingFromHqPages(readCases)(configured, {
			edit(app) {
				const extra = app.modules
					.flatMap((m) => m.forms)
					.find((f) => f.unique_id === derivedUniqueId(morning))
					?.extra_actions as {
					load_update_cases: Record<string, unknown>[];
					open_cases: unknown[];
				};
				const row = extra.load_update_cases.find(
					(row) => row.case_tag === "alternate",
				);
				if (!row) throw new Error("Expected the entry’s additional choice.");
				row.case_properties = { ignored: { question_path: "/data/age" } };
				row.preload = { "/data/age": "ignored" };
				extra.open_cases = [{ case_tag: "unused", case_type: "household" }];
			},
		});
		expect(
			whole?.kind,
			JSON.stringify(
				whole?.kind === "account"
					? [whole.findings, whole.defects]
					: whole?.kind,
			),
		).toBe("read");
		if (whole?.kind !== "read") return;
		const held = whole.draft.doc;
		const parent = Object.values(held.forms).find(
			(form) => form.name === "Under test",
		);
		const entry = Object.values(held.forms).find(
			(form) => form.name === "Morning visit",
		);
		if (!parent || !entry)
			throw new Error("Both entry and parent should be readable.");
		const selected = formCaseSelections(held, parent.uuid).find(
			(row) => row.tag === "destination",
		);
		if (!selected) throw new Error("Expected the parent’s destination choice.");
		expect(
			formCaseSelections(held, entry.uuid).find(
				(row) => row.tag === "alternate",
			)?.source,
		).toEqual({
			kind: "expression",
			value: term({
				kind: "session-datum",
				datum: { kind: "form-selection", selection: selected.uuid },
			}),
		});
		expect(entry.caseOperations).toBeUndefined();
	});

	it("keeps distinct entries of a single parent while refusing unrelated ordinary forms that share a namespace", async () => {
		const { doc } = sharedEntries();
		const { ctx, findings } = await namingFromHqPages(readCases)(doc, {
			edit(app) {
				app.modules[2].forms[0].xmlns = app.modules[1].forms[0].xmlns;
			},
		});
		expect(
			findings
				.filter(
					(row) =>
						row.code ===
						"forms-and-case-writes/two-non-shadow-forms-sharing-an-xmlns",
				)
				.map((row) => row.place),
		).toMatchObject([
			{ menu: 1, form: 0 },
			{ menu: 2, form: 0 },
		]);
		const forms = ctx.draft.modules[0].forms;
		const parent = forms.find((form) => form.form.name === "Under test");
		expect(parent).toBeDefined();
		const shadows = forms.filter((form) => form.docType === "ShadowForm");
		expect(shadows.map((form) => form.form.shadowOf?.form)).toEqual([
			parent?.uuid,
			parent?.uuid,
		]);
		expect(new Set(shadows.map((form) => form.uuid)).size).toBe(2);
	});

	it("accounts separately for a missing shared parent and an entry’s retiring stock setting", async () => {
		const { doc, morning, evening } = sharedEntries();
		const reading = await namingFromHqPages(readCases)(doc, {
			edit(app) {
				const forms = app.modules.flatMap((menu) => menu.forms);
				const stock = forms.find(
					(form) => form.unique_id === derivedUniqueId(morning),
				);
				const dangling = forms.find(
					(form) => form.unique_id === derivedUniqueId(evening),
				);
				if (!stock || !dangling) throw new Error("Expected both entry shells.");
				const extra = stock.extra_actions as {
					load_update_cases: { show_product_stock: boolean }[];
				};
				extra.load_update_cases[0].show_product_stock = true;
				dangling.shadow_parent_form_id = "missing-parent";
			},
		});
		const findings =
			reading.whole?.kind === "account" ? reading.whole.findings : [];
		expect(
			findings.filter((finding) =>
				finding.code.includes("shadow-parent-form-id-missing-or-dangling"),
			),
		).toMatchObject([{ place: { name: "Evening visit" } }]);
		expect(
			findings.filter((finding) =>
				finding.code.includes(
					"extra-actions-load-update-cases-show-product-stock",
				),
			),
		).toMatchObject([{ place: { name: "Morning visit" } }]);
	});

	it("reads both entries back to the same parent with different ordered supplies", async () => {
		const { doc } = sharedEntries();
		const read = (await namingFromHqPages(readCases)(doc)).whole;
		expect(
			read?.kind,
			JSON.stringify(
				read?.kind === "account" ? [read.findings, read.defects] : read?.kind,
			),
		).toBe("read");
		if (read?.kind !== "read") return;
		const held = read.draft.doc;
		const byName = (name: string) => {
			const form = Object.values(held.forms).find((f) => f.name === name);
			if (!form) throw new Error(`The read needs ${name}.`);
			return form;
		};
		const parent = byName("Under test");
		for (const [name, tags] of [
			["Morning visit", ["destination", "alternate", "origin"]],
			["Evening visit", ["destination"]],
		] as const) {
			const entry = byName(name);
			expect(entry.shadowOf?.form).toBe(parent.uuid);
			const menu = held.moduleOrder.find((uuid) =>
				held.formOrder[uuid]?.includes(entry.uuid),
			);
			if (!menu) throw new Error("The entry needs its menu.");
			expect(
				entryDatumIds(
					held,
					formLinkProjectionContext(held),
					menu,
					entry.uuid,
				).map((d) => d.id),
			).toEqual(tags.map((tag) => `case_id_${tag}`));
			expect(held.fieldOrder[entry.uuid] ?? []).toEqual([]);
		}
	});
});
