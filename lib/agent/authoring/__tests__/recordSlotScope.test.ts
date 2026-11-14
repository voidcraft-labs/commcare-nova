/**
 * The record dialect judge prints a slot under the scope its read tool prints
 * it under. The contract: for every record slot of every document the proof
 * lane publishes, the text `queryPrinter` gives under
 * `recordRoundTrip.ts::recordSlotScope` is the text the production read
 * projection (`output.ts::projectAuthoringRead`, over the real tool body)
 * gives for that slot, so the judge's scope is the production scope for each
 * slot kind; and the choices filters of the documents whose fields filter
 * their choices by an answer, the candidate row and a table's columns read
 * back to themselves under that scope. The failures this catches: a judge
 * scope that drops the field's form, its menu, the candidate case type or
 * the choices' table (a filter the production read prints fine then judges
 * as no spelling, and Nova's own export reads to a finding), and a slot kind
 * whose judge scope drifts from its read tool's.
 */
import { expect, it } from "vitest";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { projectAuthoringRead } from "@/lib/agent/authoring/output";
import { getCaseOperationsTool } from "@/lib/agent/tools/case-operations/getCaseOperations";
import { getFieldTool } from "@/lib/agent/tools/getField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import { type BlueprintDoc, blueprintDocSchema, type Uuid } from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import type { CorpusDocument } from "@/proof/corpus/documents";
import { publishFindings } from "@/proof/corpus/editBatches";
import { producerDocuments } from "@/proof/corpus/producers";
import { targetedDocuments } from "@/proof/targeted/index";
import { queryPrinter } from "../printQueryExpression";
import { recordDialectRoundTrip, recordSlotScope } from "../recordRoundTrip";

/** Every slot the record dialect prints, by the slot's name. */
const RECORD_SLOTS = [
	"lookup_options_source",
	"form_display_condition",
	"case_operation_target_expression",
	"case_operation_condition",
	"case_operation_name",
	"case_operation_owner",
	"case_operation_rename",
	"case_operation_write_value",
	"case_operation_write_condition",
	"case_operation_link_target_expression",
	"module_display_condition",
	"case_list_filter",
	"case_list_column_expression",
	"search_button_display_condition",
	"excluded_owner_ids",
	"search_input_default",
	"search_input_predicate",
	"search_input_options",
	"search_input_required_when",
	"search_input_validation_rule",
	"search_input_hidden_value",
] as const;

/** The documents whose fields filter their choices by an answer, the
 *  candidate row or a table's columns. */
const CHOICE_FILTER_DOCUMENTS = [
	"case-choice-attendance",
	"lookup-app",
	"lookup-reversed",
];

/** The stored document as Nova's load boundary hydrates it. */
function hydrated(document: CorpusDocument): BlueprintDoc {
	const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(document.doc));
	ensureReferenceIndex(doc);
	return doc;
}

/** The value at `path` inside `value`. */
function at(value: unknown, path: readonly (string | number)[]): unknown {
	let cursor = value;
	for (const segment of path) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string | number, unknown>)[segment];
	}
	return cursor;
}

/** One document's record slots, each with the text the production read
 *  projection prints for it and the text the judge's scope prints. */
async function printsOf(document: CorpusDocument, doc: BlueprintDoc) {
	const tables = document.lookup?.definitions ?? [];
	const lookup = new Map(tables.map((table) => [table.id, table]));
	const types = new Map(
		tables.map((table) => [
			table.id,
			new Map(table.columns.map((column) => [column.id, column.dataType])),
		]),
	);
	const h = makeToolWorkspaceHarness(doc);
	const reads = new Map<string, unknown>();
	const read = async (
		toolName: string,
		tool: Parameters<typeof h.runTool>[0],
		input: Record<string, Uuid>,
	) => {
		const key = `${toolName} ${JSON.stringify(input)}`;
		if (!reads.has(key)) {
			const result = (await h.runTool(tool, input)) as { data: unknown };
			reads.set(
				key,
				projectAuthoringRead({ toolName, data: result.data, doc, tables }),
			);
		}
		return reads.get(key);
	};
	/** The text the read tool that shows `ref` prints for it. */
	const productionPrint = async (
		ref: SlotContextRef,
		path: readonly (string | number)[],
	): Promise<unknown> => {
		if (ref.entity === "field") {
			const formUuid = findContainingForm(doc, ref.uuid) as Uuid;
			const moduleUuid = moduleUuidOfForm(doc, formUuid) as Uuid;
			const authored = await read("getField", getFieldTool, {
				moduleUuid,
				formUuid,
				fieldUuid: ref.uuid,
			});
			return at(authored, ["field", ...path]);
		}
		if (ref.entity === "form") {
			const moduleUuid = moduleUuidOfForm(doc, ref.uuid) as Uuid;
			const address = { moduleUuid, formUuid: ref.uuid };
			if (path[0] === "caseOperations")
				return at(
					await read("getCaseOperations", getCaseOperationsTool, address),
					["operations", ...path.slice(1)],
				);
			return at(await read("getForm", getFormTool, address), ["form", ...path]);
		}
		const authored = await read("getModule", getModuleTool, {
			moduleUuid: ref.uuid,
		});
		const [root, ...rest] = path;
		return root === "displayCondition"
			? at(authored, ["display_condition"])
			: root === "caseListConfig"
				? at(authored, ["case_list_config", ...rest])
				: at(authored, ["case_search_config", ...rest]);
	};
	const owners: ExpressionCarrierRef[] = [
		...doc.moduleOrder.map((uuid) => ({ entity: "module" as const, uuid })),
		...Object.keys(doc.forms).map((uuid) => ({
			entity: "form" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(doc.fields).map((uuid) => ({
			entity: "field" as const,
			uuid: uuid as Uuid,
		})),
	];
	const prints: {
		ref: SlotContextRef;
		expression: Expression;
		production: unknown;
		judge: string;
	}[] = [];
	for (const owner of owners)
		for (const { ref, expression, path } of expressionSlotValues(doc, owner)) {
			const context = slotContext(doc, ref, types);
			if (context?.ruleSet !== "record") continue;
			const scope = recordSlotScope(doc, ref, lookup);
			if (scope === undefined)
				throw new Error(`The judge has no scope for ${ref.slot}.`);
			const printer = queryPrinter(scope);
			prints.push({
				ref,
				expression,
				production: await productionPrint(ref, path),
				judge:
					context.profile.expectation.kind === "condition"
						? printer.predicate(expression)
						: printer.value(expression),
			});
		}
	return { prints, lookup };
}

/** The documents the proof lane publishes, as the read-back bar reads them. */
function publishedDocuments() {
	return [...targetedDocuments(), ...producerDocuments()].flatMap(
		(document) => {
			const doc = hydrated(document);
			return publishFindings(doc, document.lookup).length > 0
				? []
				: [{ document, doc }];
		},
	);
}

it("prints every record slot of the published documents as its read tool prints it", {
	// About two hundred documents, each read once per owner.
	timeout: 300_000,
}, async () => {
	const seen = new Set<string>();
	const differing: string[] = [];
	for (const { document, doc } of publishedDocuments()) {
		const { prints } = await printsOf(document, doc);
		for (const { ref, production, judge } of prints) {
			seen.add(ref.slot);
			if (production !== judge)
				differing.push(
					`${document.id} ${ref.slot}: read ${JSON.stringify(production)}, judge ${JSON.stringify(judge)}`,
				);
		}
	}
	expect(differing).toEqual([]);
	expect(
		RECORD_SLOTS.filter((slot) => !seen.has(slot)),
		"record slots no published document holds",
	).toEqual([]);
});

it("judges each choices filter of the documents that filter choices as the production read prints it", async () => {
	const documents = publishedDocuments().filter(({ document }) =>
		CHOICE_FILTER_DOCUMENTS.includes(document.id),
	);
	expect(documents.map(({ document }) => document.id).sort()).toEqual(
		[...CHOICE_FILTER_DOCUMENTS].sort(),
	);
	for (const { document, doc } of documents) {
		const { prints, lookup } = await printsOf(document, doc);
		const filters = prints.filter(
			({ ref }) => ref.slot === "lookup_options_source",
		);
		expect(filters.length, document.id).toBeGreaterThan(0);
		for (const { ref, expression, production, judge } of filters) {
			expect(judge, document.id).toBe(production);
			expect(
				recordDialectRoundTrip(doc, ref, expression, lookup),
				`${document.id}: ${judge}`,
			).toBeUndefined();
		}
	}
});
