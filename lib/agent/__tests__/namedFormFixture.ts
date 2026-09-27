import { produce } from "immer";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	caseListModuleMutations,
	formScaffoldMutations,
	surveyModuleMutations,
} from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { FormType, Uuid } from "@/lib/domain";
import { makeCanonicalGenesisDoc } from "./fixtures";

/** Named canonical forms for tests of field authoring and reads. Construction
 * itself is tested through the durable workspace. These use the same valid
 * starter shapes as Builder and contain no old composite tool grammar. */
export function namedFormFixture(
	modules: Array<{
		name: string;
		caseType?: string;
		forms: Array<{ name: string; type: FormType }>;
	}>,
) {
	const base = makeCanonicalGenesisDoc();
	let doc = base;
	const mutations: Mutation[] = [];
	const apply = (batch: Mutation[]) => {
		mutations.push(...batch);
		doc = produce(doc, (draft) => {
			applyMutations(draft, batch);
		});
	};
	for (const module of modules) {
		const scaffold: {
			mutations: Mutation[];
			moduleUuid: Uuid;
			formUuid?: Uuid;
		} = module.caseType
			? caseListModuleMutations(doc, {
					name: module.name,
					caseType: module.caseType,
				})
			: surveyModuleMutations(doc, { name: module.name });
		apply(scaffold.mutations);
		for (const [index, form] of module.forms.entries()) {
			let formUuid: Uuid;
			if (!module.caseType && index === 0 && scaffold.formUuid !== undefined) {
				formUuid = scaffold.formUuid;
			} else {
				const created = formScaffoldMutations(
					doc,
					scaffold.moduleUuid,
					form.type,
				);
				if (!created) throw new Error("The fixture module was not created.");
				apply(created.mutations);
				formUuid = created.formUuid;
			}
			apply([
				{ kind: "renameForm", uuid: formUuid, newId: form.name },
				{
					kind: "updateField",
					uuid: doc.fieldOrder[formUuid][0],
					targetKind: "text",
					patch: { id: "fixture_placeholder" },
				},
			]);
		}
	}
	const admitted = mutationCommitVerdict(
		base,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!admitted.ok)
		throw new Error(
			`Invalid named form fixture: ${JSON.stringify(admitted.findings)}`,
		);
	return admitted.nextDoc;
}
