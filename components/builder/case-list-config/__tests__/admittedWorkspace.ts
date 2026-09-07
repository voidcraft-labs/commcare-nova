import { expect } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc, CaseListConfig, CaseType } from "@/lib/domain";

export function admittedWorkspace(
	caseTypes: CaseType[],
	config: CaseListConfig = caseListConfig([
		{ field: "case_name", header: "Name" },
	]),
	caseType = caseTypes[0]?.name ?? "patient",
) {
	const doc = buildDoc({
		caseTypes,
		modules: [
			{ name: "Clients", caseType, caseListOnly: true, caseListConfig: config },
		],
	});
	assertAdmittedDoc(doc);
	const moduleUuid = doc.moduleOrder[0];
	const saved = doc.modules[moduleUuid].caseListConfig;
	if (!saved) throw new Error("missing case list fixture");
	return { doc, moduleUuid, config: saved };
}
export function commitWorkspace(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	assertAdmittedDoc(doc);
	const wire = mutations.map((m) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(m))),
	);
	const verdict = mutationCommitVerdict(doc, wire, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(verdict, JSON.stringify(verdict)).toMatchObject({ ok: true });
	if (!verdict.ok) throw new Error(JSON.stringify(verdict));
	return verdict.nextDoc;
}
