/**
 * The corpus's workforce documents: producer documents that also hold the
 * worker, organization and automation entities no producer document holds.
 *
 * The edit-batch generator removes only what a document holds
 * (`./editKinds.ts`), and no producer document holds a role, a persona, a
 * place property, an automation or a worker property nothing reads. So
 * without these documents the fixed floor admits no batch of
 * `removeUserProperty`, `removeUserType`, `removePersona`,
 * `removeLocationProperty` or `removeAutomation`, and proofs 1 and 5 never
 * see those edits. Each workforce document is one producer document with
 * those entities added through Nova's production planners and its commit
 * gate, so it is admitted exactly as an editor's document would be.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	addLocationPropertyMutations,
	addOrganizationLevelMutations,
} from "@/lib/doc/organizationMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	addPersonaMutations,
	addUserPropertyMutations,
	addUserTypeMutations,
} from "@/lib/doc/userMutations";
import {
	automationMessageText,
	type BlueprintDoc,
	blueprintDocSchema,
} from "@/lib/domain";
import {
	type CorpusDocument,
	lookupContextOf,
	storedDocument,
} from "./documents";
import type { EditCorpusDocument } from "./editBatches";

/**
 * The producer documents the workforce documents are built over: each has a
 * module with a case type and an authored property for the automations to
 * name. A document carries one edit batch, so there is one per removal kind
 * only the workforce entities give an admissible target (five), and one to
 * spare.
 */
export const WORKFORCE_BASES = [
	"tile-plain",
	"tile-persistent",
	"case-list-local",
	"case-list-inline",
	"case-operation-sequence",
	"case-operation-conditional",
] as const;

/** The corpus id of the workforce document built over `base`. */
export function workforceDocumentId(base: string): string {
	return `workforce-${base}`;
}

/**
 * `base` holding, besides what it held, worker information nothing reads,
 * two roles (one held by a persona), two personas, two organization levels
 * with a place property, an alert and a case-update rule, and a second
 * language that is neither the source nor the default. Its identities
 * follow from the base's id alone, and the batch that adds them is admitted
 * by Nova's commit gate under the base's lookup data.
 */
export function workforceDocument(base: EditCorpusDocument): BlueprintDoc {
	const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(base.doc));
	const caseType = doc.moduleOrder
		.map((uuid) => doc.modules[uuid]?.caseType)
		.find((type) => type !== undefined);
	const property = doc.caseTypes
		?.find((ct) => ct.name === caseType)
		?.properties.find((p) => p.name !== "case_name");
	if (caseType === undefined || property === undefined) {
		throw new Error(
			`The workforce base ${base.id} has no module with a case type and an authored property for its automations to name; build the workforce document over another base.`,
		);
	}
	const id = (name: string) => testUuid(`workforce-${base.id}-${name}`);
	const role = id("role-supervisor");
	const region = id("level-region");
	const batch: Mutation[] = [
		...addUserPropertyMutations(doc, id("info-district"), {
			slug: "district_code",
			label: "District code",
		}),
		...addUserTypeMutations(doc, role, { name: "Supervisor" }),
		...addUserTypeMutations(doc, id("role-trainee"), { name: "Trainee" }),
		...addPersonaMutations(doc, id("persona-asha"), {
			name: "Asha",
			userTypeUuid: role,
		}),
		...addPersonaMutations(doc, id("persona-ben"), { name: "Ben" }),
		...addOrganizationLevelMutations(doc, region, {
			code: "region",
			name: "Region",
			caseFlow: { workers: "none", ownsCases: false },
			addressBook: { reach: "whole-organization" },
		}),
		...addOrganizationLevelMutations(doc, id("level-district"), {
			code: "district",
			name: "District",
			parentLevelUuid: region,
			caseFlow: { workers: "none", ownsCases: false },
			addressBook: { reach: "whole-organization" },
		}),
		...addLocationPropertyMutations(doc, id("place-info-code"), {
			slug: "facility_code",
			label: "Facility code",
		}),
		{
			kind: "addAutomation",
			after: null,
			automation: {
				uuid: id("alert"),
				kind: "conditional-alert",
				name: "Visit reminder",
				caseType,
				criteriaOperator: "all",
				criteria: [],
				setupOnlyCriteria: [],
				recipients: [{ uuid: id("alert-recipient"), kind: "owner" }],
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: id("alert-event"),
							minutesToWait: 5,
							content: {
								kind: "sms",
								message: automationMessageText("A visit is due."),
							},
						},
					],
				},
				includeDescendantLocations: false,
				locationLevelUuids: [],
				userDataFilters: [],
				useUserCaseForFilter: false,
			},
		},
		{
			kind: "addAutomation",
			after: id("alert"),
			automation: {
				uuid: id("rule"),
				kind: "case-update",
				name: "Resolve stale records",
				caseType,
				criteriaOperator: "all",
				criteria: [
					{
						uuid: id("rule-criterion"),
						kind: "match-property",
						scope: "case",
						property: property.name,
						matchType: "equal",
						value: "stale",
					},
				],
				setupOnlyCriteria: [],
				updates: [
					{
						uuid: id("rule-update"),
						target: { scope: "case", property: property.name },
						value: { kind: "literal", value: "resolved" },
					},
				],
				closeCase: false,
			},
		},
		{ kind: "addLanguage", language: { language: "fra" } },
	];
	const verdict = mutationCommitVerdict(
		doc,
		batch,
		lookupContextOf(base.lookup),
	);
	if (!verdict.ok) {
		throw new Error(
			`Nova's commit gate refused the workforce entities on ${base.id} (${verdict.findings.map((f) => f.code).join(", ")}), so its workforce document would not be one an editor could make.`,
		);
	}
	return verdict.nextDoc;
}

/**
 * The workforce document over each of `WORKFORCE_BASES`, taken from the
 * producers' documents. Each keeps its base's lookup data and uploaded
 * media, which it references as its base does.
 */
export function workforceDocuments(
	producers: readonly CorpusDocument[],
): CorpusDocument[] {
	const byId = new Map(producers.map((document) => [document.id, document]));
	return WORKFORCE_BASES.map((baseId) => {
		const base = byId.get(baseId);
		if (base === undefined) {
			throw new Error(
				`The workforce documents are built over the producer document ${baseId}, which the producers no longer emit; name another base in WORKFORCE_BASES.`,
			);
		}
		return {
			id: workforceDocumentId(baseId),
			source: { kind: "workforce", base: baseId },
			doc: storedDocument(workforceDocument(base)),
			...(base.lookup !== undefined && { lookup: base.lookup }),
			...(base.media !== undefined && { media: base.media }),
		};
	});
}
