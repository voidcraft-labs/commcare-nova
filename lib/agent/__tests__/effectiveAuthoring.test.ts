import { expect, it } from "vitest";
import { evaluateForm } from "@/lib/preview/engine/evaluateForm";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import { previewAsMe, previewAsPersona } from "@/lib/preview/engine/identity";
import { appOverview } from "../appOverview";
import { makeAuthoringHarness } from "./authoringHarness";

it("reads implicit lifecycle metadata and explains the starting values the production engine uses", async () => {
	const h = makeAuthoringHarness();
	expect(
		await h.call("createModule", {
			name: "Equipment",
			case_type: "equipment",
			forms: [
				{
					name: "Inspect",
					type: "followup",
					fields: [
						{
							kind: "text",
							id: "condition",
							label: "Condition",
							default_value: "'new'",
							caseWrite: { caseType: "equipment", property: "condition" },
						},
						{
							kind: "text",
							id: "note",
							label: "Note",
							default_value: "'Check the label'",
						},
						{ kind: "hidden", id: "once", default_value: "'entry value'" },
						{
							kind: "hidden",
							id: "computed",
							calculate: "concat(#form/condition, '!')",
						},
						{
							kind: "hidden",
							id: "saved",
							default_value: "'fallback'",
							caseWrite: { caseType: "equipment", property: "saved" },
						},
					],
				},
			],
		}),
	).toMatchObject({ ok: true });
	expect(
		await h.call("getCaseProperty", {
			caseType: "equipment",
			property: "date_opened",
		}),
	).toMatchObject({
		builtIn: true,
		property: { name: "date_opened", data_type: "datetime" },
	});
	expect(
		await h.call("getCaseProperty", {
			caseType: "missing",
			property: "date_opened",
		}),
	).toHaveProperty("error");
	expect(
		await h.call("getForm", { moduleUuid: "Equipment", formUuid: "Inspect" }),
	).toMatchObject({
		form: {
			fields: [
				{
					id: "condition",
					initialValue: {
						source: "selected-record",
						property: "condition",
						configuredDefaultIsOverridden: true,
					},
				},
				{ id: "note", initialValue: { source: "configured-default" } },
				{ id: "once", initialValue: { source: "configured-default" } },
				{ id: "computed", initialValue: { source: "calculation" } },
				{
					id: "saved",
					initialValue: { source: "selected-record", property: "saved" },
				},
			],
		},
		answerWrites: [
			{
				caseType: "equipment",
				action: "update",
				answers: [
					{ path: "condition", property: "condition" },
					{ path: "saved", property: "saved" },
				],
			},
		],
	});
	const doc = h.currentDoc();
	const form = Object.values(doc.forms).find((f) => f.name === "Inspect");
	const identity = previewAsMe({ id: "reviewer" }, doc);
	if (!form || !identity) throw new Error("Incomplete fixture");
	const examples: Record<string, string>[] = [
		{ condition: "worn", saved: "earlier" },
		{},
	];
	for (const properties of examples) {
		const result = await evaluateForm(
			doc,
			{ formUuid: form.uuid, answers: [], caseIds: ["drill"] },
			{
				identity,
				cases: evaluationScenarioCases(doc, identity.ownerId, {
					records: [{ id: "drill", caseType: "equipment", properties }],
				}),
				lookup: {
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				},
			},
		);
		expect(result.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "condition",
					value: properties.condition ?? "",
				}),
				expect.objectContaining({ path: "note", value: "Check the label" }),
				expect.objectContaining({ path: "once", value: "entry value" }),
				expect.objectContaining({
					path: "computed",
					value: `${properties.condition ?? ""}!`,
				}),
				expect.objectContaining({
					path: "saved",
					value: properties.saved ?? "",
				}),
			]),
		);
	}
});

it("makes missing role identities visible and reports inherited worker values without granting authority", async () => {
	const h = makeAuthoringHarness();
	expect(
		await h.call("addUserProperties", {
			properties: [{ slug: "role_code", label: "Role", required: true }],
		}),
	).toMatchObject({ ok: true });
	expect(
		await h.call("addUserTypes", {
			userTypes: [
				{
					name: "Inspector",
					values: [{ userPropertyUuid: "role_code", value: "inspector" }],
				},
			],
		}),
	).toMatchObject({ ok: true });
	expect(
		appOverview(h.currentDoc()).previewReadiness.rolesWithoutPersonas,
	).toEqual([expect.objectContaining({ name: "Inspector" })]);
	expect(
		await h.call("addPersonas", {
			personas: [{ name: "Inspection worker", userTypeUuid: "Inspector" }],
		}),
	).toMatchObject({ ok: true });
	expect(await h.call("getUsers", {})).toMatchObject({
		previewReadiness: {
			rolesWithoutPersonas: [],
			asMember: { missingRequiredInformation: ["role_code"] },
			personas: [
				{
					name: "Inspection worker",
					effectiveValues: [{ name: "role_code", value: "inspector" }],
					missingRequiredInformation: [],
					assignedLocationUuids: [],
				},
			],
		},
	});
	const doc = h.currentDoc();
	const persona = Object.values(doc.personas ?? {})[0];
	const identity = previewAsPersona({ id: "real-member" }, persona, doc);
	expect(identity).toMatchObject({
		actorUserId: "real-member",
		ownerId: persona.uuid,
		session: { user: { role_code: "inspector" } },
	});
	expect(previewAsMe({ id: "real-member" }, doc)?.session.user.role_code).toBe(
		"",
	);
});

it("authors a business stage without letting an ordinary answer overwrite case closure", async () => {
	const h = makeAuthoringHarness();
	const module = (property: string) => ({
		name: "Requests",
		case_type: "request",
		forms: [
			{
				name: "Review",
				type: "followup",
				fields: [
					{
						kind: "text",
						id: "stage",
						label: "Review stage",
						caseWrite: { caseType: "request", property },
					},
				],
			},
		],
	});
	const before = h.currentDoc();
	expect(await h.call("createModule", module("status"))).toHaveProperty(
		"error",
	);
	expect(h.currentDoc()).toEqual(before);
	expect(await h.call("createModule", module("current_status"))).toMatchObject({
		ok: true,
	});
	expect(
		await h.call("getCaseProperty", {
			caseType: "request",
			property: "current_status",
		}),
	).toMatchObject({
		property: { name: "current_status", data_type: "text" },
	});
	expect(
		await h.call("getCaseProperty", {
			caseType: "request",
			property: "status",
		}),
	).toMatchObject({
		builtIn: true,
		property: { name: "status", data_type: "text" },
	});
	expect(appOverview(h.currentDoc()).caseTypes).toEqual([
		{ name: "request", properties: [{ name: "current_status", type: "text" }] },
	]);
});
