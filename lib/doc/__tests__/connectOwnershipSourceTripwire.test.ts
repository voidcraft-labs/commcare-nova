import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";

type Assert<T extends true> = T;
type AddFormInput = Parameters<BlueprintMutations["addForm"]>[1];
type GenericFormPatch = Parameters<BlueprintMutations["updateForm"]>[1];
type _AddFormOmitsConnect = Assert<
	"connect" extends keyof AddFormInput ? false : true
>;
type _UpdateFormOmitsConnect = Assert<
	"connect" extends keyof GenericFormPatch ? false : true
>;

const compileTimeOwnership: [_AddFormOmitsConnect, _UpdateFormOmitsConnect] = [
	true,
	true,
];

describe("Connect authoring ownership source tripwire", () => {
	it("keeps generic builder form inputs structurally unable to carry Connect", () => {
		expect(compileTimeOwnership).toEqual([true, true]);
	});

	it("keeps the internal add-form mutation helper free of a hidden Connect writer", () => {
		const source = readFileSync("lib/agent/blueprintHelpers.ts", "utf8");
		const newFormInput = source.slice(
			source.indexOf("export interface NewFormInput"),
			source.indexOf("/** Build an `addForm` mutation"),
		);
		const addFormBuilder = source.slice(
			source.indexOf("export function addFormMutations"),
			source.indexOf("/** Remove a form"),
		);
		const genericUpdateBuilder = source.slice(
			source.indexOf("export function updateFormMutations"),
			source.indexOf("export function refineFormConnectMutations"),
		);

		expect(newFormInput).not.toMatch(/\bconnect\s*\??:/);
		expect(addFormBuilder).not.toContain("input.connect");
		expect(genericUpdateBuilder).not.toMatch(/\bconnect\s*\??:/);
		expect(genericUpdateBuilder).not.toContain("patch.connect");
		expect(source).toContain("export function refineFormConnectMutations");
	});

	it("keeps session/editor restores exact and routes existing-participant edits through the named refinement API", () => {
		for (const relative of [
			"components/builder/detail/formSettings/ConnectSection.tsx",
			"components/builder/detail/formSettings/LearnConfig.tsx",
			"components/builder/detail/formSettings/DeliverConfig.tsx",
			"lib/doc/connectConfig.ts",
		]) {
			expect(readFileSync(relative, "utf8"), relative).not.toContain(
				"dedupeRestoredConnectIds",
			);
		}
		const section = readFileSync(
			"components/builder/detail/formSettings/ConnectSection.tsx",
			"utf8",
		);
		expect(section).toContain("inline.refineFormConnect");
		expect(section).not.toMatch(/inline\.updateForm[\s\S]{0,160}\bconnect\s*:/);
	});
});
