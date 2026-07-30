import { describe, expect, it } from "vitest";
import {
	MUTATION_CLEAR_SLOT_MANIFEST,
	MUTATION_WIRE_REGISTRY,
} from "@/lib/doc/mutationWireRegistry";
import { fieldKinds } from "@/lib/domain";

function wireSnapshotLines(): string[] {
	return MUTATION_WIRE_REGISTRY.map(
		(entry) =>
			`${entry.mutationLeaf} ${entry.jsonPointer} ${entry.role} ${entry.presence} ${entry.nullable ? "nullable" : "non-null"} ${entry.defaulted ? "defaulted" : "no-default"} ${entry.schemaKind}`,
	);
}

function clearSnapshotLines(): string[] {
	return MUTATION_CLEAR_SLOT_MANIFEST.map(
		(entry) =>
			`${entry.mutationLeaf} ${entry.jsonPointer} null=${entry.nullMeaning} omission=${entry.omissionMeaning} own-undefined=${entry.ownUndefined}`,
	);
}

describe("generated mutation-wire registry", () => {
	it("pins every schema-derived semantic leaf", () => {
		expect(wireSnapshotLines()).toMatchSnapshot();
	});

	it("expands every updateField target kind", () => {
		const found = new Set(
			MUTATION_WIRE_REGISTRY.map(
				(entry) =>
					entry.mutationLeaf.match(/^updateField\[targetKind=([^\]]+)\]/u)?.[1],
			).filter((kind): kind is string => kind !== undefined),
		);
		expect([...found].toSorted()).toEqual([...fieldKinds].toSorted());
	});

	it("expands the complete case-operation mutation vocabulary", () => {
		const roots = new Set(
			MUTATION_WIRE_REGISTRY.filter((entry) =>
				entry.mutationLeaf.startsWith("updateForm.caseOperation"),
			).map((entry) => entry.mutationLeaf.split("].")[0]),
		);
		expect([...roots].toSorted()).toEqual(
			[
				"updateForm.caseOperationChange[operation=add",
				"updateForm.caseOperationChange[operation=remove",
				"updateForm.caseOperationPatch[operation=add-link",
				"updateForm.caseOperationPatch[operation=add-write",
				"updateForm.caseOperationPatch[operation=move",
				"updateForm.caseOperationPatch[operation=move-link",
				"updateForm.caseOperationPatch[operation=move-write",
				"updateForm.caseOperationPatch[operation=remove-link",
				"updateForm.caseOperationPatch[operation=remove-write",
				"updateForm.caseOperationPatch[targetAction=close,operation=update",
				"updateForm.caseOperationPatch[targetAction=create,operation=update",
				"updateForm.caseOperationPatch[targetAction=update,operation=update",
				"updateForm.caseOperationPatch[operation=update-link",
				"updateForm.caseOperationPatch[operation=update-write",
			].toSorted(),
		);
	});

	it("expands every Search operation and its ensure owner", () => {
		const operations = MUTATION_WIRE_REGISTRY.filter((entry) =>
			entry.mutationLeaf.startsWith(
				"updateModule.caseSearchConfigOperation[value=",
			),
		).map((entry) => entry.mutationLeaf.match(/\[value=([^\]]+)\]/u)?.[1]);
		expect(operations.toSorted()).toEqual(
			[
				"cleanup-after-final-input",
				"disable-if-unused",
				"enable",
				"remove-if-no-authored-settings",
				"set-owner-only",
			].toSorted(),
		);
		expect(
			MUTATION_WIRE_REGISTRY.some(
				(entry) => entry.mutationLeaf === "updateModule.ensureCaseListConfig",
			),
		).toBe(true);
	});

	it("expands all four updateColumn payload owners", () => {
		const payloadPointers = new Set(
			MUTATION_WIRE_REGISTRY.filter((entry) =>
				entry.mutationLeaf.startsWith("updateColumn"),
			)
				.filter((entry) =>
					["/column", "/sortPatch", "/tilePatch", "/visibilityPatch"].includes(
						entry.jsonPointer,
					),
				)
				.map((entry) => entry.jsonPointer),
		);
		expect([...payloadPointers].toSorted()).toEqual([
			"/column",
			"/sortPatch",
			"/tilePatch",
			"/visibilityPatch",
		]);
	});

	it("expands inline and lookup select sources at every direct owner", () => {
		for (const owner of [
			"convertField.optionsSource",
			"updateField[targetKind=multi_select].patch.optionsSource",
			"updateField[targetKind=single_select].patch.optionsSource",
		]) {
			const variants = MUTATION_WIRE_REGISTRY.filter((entry) =>
				entry.mutationLeaf.startsWith(`${owner}[source=`),
			).map((entry) => entry.mutationLeaf.match(/\[source=([^\]]+)\]/u)?.[1]);
			expect(variants.toSorted(), owner).toEqual(["inline", "lookup"]);
		}
	});

	it("pins explicit patch owners and never treats own undefined as intent", () => {
		const topLevelPatchOwnerEntries = MUTATION_WIRE_REGISTRY.filter(
			(entry) =>
				entry.role === "explicit-patch-owner" && entry.jsonPointer === "/patch",
		);
		expect(
			topLevelPatchOwnerEntries.map((entry) => entry.mutationLeaf),
		).toEqual(
			expect.arrayContaining([
				"setCaseListMeta.patch",
				"updateForm.patch",
				"updateModule.patch",
				"updatePersona.patch",
				"updateUserProperty.patch",
				"updateUserType.patch",
			]),
		);
		for (const entry of topLevelPatchOwnerEntries) {
			expect(entry.presence, entry.mutationLeaf).toBe("required");
			expect(entry.defaulted, entry.mutationLeaf).toBe(false);
		}
		expect(MUTATION_WIRE_REGISTRY.filter((entry) => entry.defaulted)).toEqual(
			[],
		);
		for (const entry of MUTATION_CLEAR_SLOT_MANIFEST) {
			expect(entry.ownUndefined).toBe("invalid");
		}
	});
});

describe("generated mutation clear-slot manifest", () => {
	it("pins every nullable leaf and its exact null/omission semantics", () => {
		expect(clearSnapshotLines()).toMatchSnapshot();
	});

	it("distinguishes clear, stored null, and placement", () => {
		expect(
			MUTATION_CLEAR_SLOT_MANIFEST.find(
				(entry) =>
					entry.mutationLeaf === "setConnectType.connectType" &&
					entry.jsonPointer === "/connectType",
			),
		).toMatchObject({
			nullMeaning: "stored-null",
			omissionMeaning: "invalid",
		});
		expect(
			MUTATION_CLEAR_SLOT_MANIFEST.find(
				(entry) =>
					entry.mutationLeaf === "updateField[targetKind=text].patch.required",
			),
		).toMatchObject({
			nullMeaning: "clear",
			omissionMeaning: "no-intent",
		});
		expect(
			MUTATION_CLEAR_SLOT_MANIFEST.find(
				(entry) =>
					entry.mutationLeaf === "addModule.after" &&
					entry.jsonPointer === "/after",
			),
		).toMatchObject({
			nullMeaning: "first-position",
			omissionMeaning: "append",
		});
	});

	it("never classifies required select or repeat structure as clearable", () => {
		expect(
			MUTATION_CLEAR_SLOT_MANIFEST.filter(
				(entry) =>
					entry.jsonPointer === "/patch/optionsSource" ||
					entry.jsonPointer === "/patch/repeat_mode",
			),
		).toEqual([]);
	});
});
