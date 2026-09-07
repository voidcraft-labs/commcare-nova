/** Schema- and whole-gate-admitted worker property identities for native wire proof. */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { eq, literal, sessionUserProperty } from "@/lib/domain/predicate";
import { runValidation } from "../validator/runner";
export const WORKER_PROPERTY = testUuid("worker-property-supervisor");
export const workerSlugs = [
	"is_supervisor",
	"district-code",
	"supervision_status",
] as const;
export function workerWireFixture(
	slug: (typeof workerSlugs)[number] = "is_supervisor",
) {
	const doc = buildDoc({
		appName: "Worker reference wire",
		modules: [
			{
				name: "Supervisors",
				displayCondition: eq(
					sessionUserProperty(WORKER_PROPERTY),
					literal("n"),
				),
				forms: [
					{
						name: "Check",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "supervisor_note",
								label: "Supervisor note",
							}),
						],
					},
				],
			},
		],
	});
	doc.userProperties = {
		[WORKER_PROPERTY]: {
			uuid: WORKER_PROPERTY,
			slug,
			label: "Worker property",
		},
	};
	doc.userPropertyOrder = [WORKER_PROPERTY];
	const moduleUuid = doc.moduleOrder[0],
		formUuid = doc.formOrder[moduleUuid][0],
		fieldUuid = doc.fieldOrder[formUuid][0];
	const field = doc.fields[fieldUuid];
	if (field.kind !== "text") throw new Error("Expected text question");
	field.relevant = parseXPathForForm(doc, formUuid, `#user/${slug} = 'n'`);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return { doc, moduleUuid, formUuid, fieldUuid };
}
