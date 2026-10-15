import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { syntheticModuleUuid } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqApplication } from "@/lib/commcare/types";
import {
	DERIVED_WIRE_IDENTITY,
	derivedFormXmlns,
	derivedUniqueId,
	targetWireIdentity,
} from "@/lib/commcare/wireIdentity";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import type { BlueprintDoc, Form, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import {
	admitNoMatchesDoc,
	HOST_MODULE,
	noMatchesDoc,
	REGISTER_FORM,
} from "./noMatchesWireFixture";

function twoMenus(): BlueprintDoc {
	const doc = buildDoc({
		appId: "wire-identity",
		appName: "Clinic",
		modules: [
			{
				name: "Intake",
				forms: [
					{
						name: "Register",
						type: "survey",
						fields: [{ kind: "text", id: "name", label: proseText("Name") }],
					},
					{
						name: "Notes",
						type: "survey",
						fields: [{ kind: "text", id: "note", label: proseText("Note") }],
					},
				],
			},
			{
				name: "Follow up",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "visit", label: proseText("Visit") }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

/** Every menu's and form's wire ids, keyed by the Nova entity they came from. */
function idsByEntity(doc: BlueprintDoc, hq: HqApplication) {
	const modules = new Map<Uuid, string>();
	const forms = new Map<Uuid, { uniqueId: string; xmlns: string }>();
	doc.moduleOrder.forEach((moduleUuid, mIdx) => {
		const module = hq.modules[mIdx];
		modules.set(moduleUuid, module.unique_id);
		doc.formOrder[moduleUuid].forEach((formUuid, fIdx) => {
			const form = module.forms[fIdx];
			forms.set(formUuid, { uniqueId: form.unique_id, xmlns: form.xmlns });
		});
	});
	return { modules, forms };
}

describe("derived wire identity", () => {
	it("writes HQ's own id shapes from the entity's UUID", () => {
		const uuid = "b039255d-fbee-5f59-ae2c-4b3f1fea7cad" as Uuid;
		expect(derivedUniqueId(uuid)).toBe("b039255dfbee5f59ae2c4b3f1fea7cad");
		expect(derivedUniqueId(uuid)).toMatch(/^[0-9a-f]{32}$/);
		expect(derivedFormXmlns(uuid)).toBe(
			"http://openrosa.org/formdesigner/B039255D-FBEE-5F59-AE2C-4B3F1FEA7CAD",
		);
	});

	it("gives every menu and form the same ids on every export", () => {
		const doc = twoMenus();
		const first = idsByEntity(doc, expandDoc(doc));
		expect(idsByEntity(doc, expandDoc(doc))).toEqual(first);
		for (const [moduleUuid, uniqueId] of first.modules) {
			expect(uniqueId).toBe(derivedUniqueId(moduleUuid));
		}
		for (const [formUuid, ids] of first.forms) {
			expect(ids).toEqual({
				uniqueId: derivedUniqueId(formUuid),
				xmlns: derivedFormXmlns(formUuid),
			});
		}
		// Each form's XForm is stored under its id and carries its `xmlns`.
		const hq = expandDoc(doc);
		for (const form of hq.modules.flatMap((module) => module.forms)) {
			expect(hq._attachments[`${form.unique_id}.xml`]).toContain(
				`xmlns="${form.xmlns}"`,
			);
		}
	});

	it("keeps every id after an edit elsewhere moves the menus and renames the app", () => {
		const doc = twoMenus();
		const before = idsByEntity(doc, expandDoc(doc));
		const [intake, followUp] = doc.moduleOrder;
		const edited: BlueprintDoc = {
			...doc,
			appName: "Clinic visits",
			moduleOrder: [followUp, intake],
			formOrder: {
				...doc.formOrder,
				[intake]: [...doc.formOrder[intake]].reverse(),
			},
		};
		assertAdmittedDoc(edited);
		expect(idsByEntity(edited, expandDoc(edited))).toEqual(before);
	});

	it("gives the hidden menu of a no-matches registration form its form's derived id", () => {
		const doc = noMatchesDoc({ label: "Add a new patient" });
		admitNoMatchesDoc(doc);
		const [host, hidden] = expandDoc(doc).modules;
		expect(host.unique_id).toBe(derivedUniqueId(HOST_MODULE));
		expect(hidden.unique_id).toBe(
			derivedUniqueId(syntheticModuleUuid(REGISTER_FORM)),
		);
		expect(hidden.forms[0].unique_id).toBe(derivedUniqueId(REGISTER_FORM));
		expect(host.case_list_form.form_id).toBe(derivedUniqueId(REGISTER_FORM));
	});
});

describe("targetWireIdentity", () => {
	const moduleUuid = "11111111-1111-4111-8111-111111111111" as Uuid;
	const otherModuleUuid = "22222222-2222-4222-8222-222222222222" as Uuid;
	const formUuid = "33333333-3333-4333-8333-333333333333" as Uuid;
	const idOnlyFormUuid = "44444444-4444-4444-8444-444444444444" as Uuid;
	const plainFormUuid = "55555555-5555-4555-8555-555555555555" as Uuid;
	// The identity reads a form's UUID alone.
	const form = (uuid: Uuid) => ({ uuid }) as Form;

	it("is the derivation when the target holds no other id", () => {
		expect(targetWireIdentity([])).toBe(DERIVED_WIRE_IDENTITY);
	});

	it("prefers a target's row and falls back per entity and per field", () => {
		const identity = targetWireIdentity([
			{
				entityKind: "module",
				novaEntityUuid: moduleUuid,
				uniqueId: "hq-module",
				xmlns: null,
			},
			{
				entityKind: "form",
				novaEntityUuid: formUuid,
				uniqueId: null,
				xmlns: "http://openrosa.org/formdesigner/HQ-FORM",
			},
			{
				entityKind: "form",
				novaEntityUuid: idOnlyFormUuid,
				uniqueId: "hq-form",
				xmlns: null,
			},
		]);
		expect(identity.moduleUniqueId(moduleUuid)).toBe("hq-module");
		expect(identity.moduleUniqueId(otherModuleUuid)).toBe(
			derivedUniqueId(otherModuleUuid),
		);
		// HQ's `xmlns` beside the derived id.
		expect(identity.formUniqueId(formUuid)).toBe(derivedUniqueId(formUuid));
		expect(identity.formXmlns(form(formUuid))).toBe(
			"http://openrosa.org/formdesigner/HQ-FORM",
		);
		// HQ's id beside the derived `xmlns`.
		expect(identity.formUniqueId(idOnlyFormUuid)).toBe("hq-form");
		expect(identity.formXmlns(form(idOnlyFormUuid))).toBe(
			derivedFormXmlns(idOnlyFormUuid),
		);
		// No row at all.
		expect(identity.formUniqueId(plainFormUuid)).toBe(
			derivedUniqueId(plainFormUuid),
		);
		expect(identity.formXmlns(form(plainFormUuid))).toBe(
			derivedFormXmlns(plainFormUuid),
		);
		// A module row never names a form, nor a form row a module.
		expect(identity.formUniqueId(moduleUuid)).toBe(derivedUniqueId(moduleUuid));
		expect(identity.moduleUniqueId(idOnlyFormUuid)).toBe(
			derivedUniqueId(idOnlyFormUuid),
		);
	});

	it("writes a target's ids into the export it is given to", () => {
		const doc = twoMenus();
		const [intake] = doc.moduleOrder;
		const [register] = doc.formOrder[intake];
		const hq = expandDoc(doc, {
			identity: targetWireIdentity([
				{
					entityKind: "module",
					novaEntityUuid: intake,
					uniqueId: "a".repeat(32),
					xmlns: null,
				},
				{
					entityKind: "form",
					novaEntityUuid: register,
					uniqueId: "b".repeat(32),
					xmlns: "http://openrosa.org/formdesigner/HQ-REGISTER",
				},
			]),
		});
		expect(hq.modules[0].unique_id).toBe("a".repeat(32));
		expect(hq.modules[0].forms[0]).toMatchObject({
			unique_id: "b".repeat(32),
			xmlns: "http://openrosa.org/formdesigner/HQ-REGISTER",
		});
		expect(hq._attachments[`${"b".repeat(32)}.xml`]).toContain(
			'xmlns="http://openrosa.org/formdesigner/HQ-REGISTER"',
		);
		expect(hq.modules[1].unique_id).toBe(derivedUniqueId(doc.moduleOrder[1]));
	});
});
