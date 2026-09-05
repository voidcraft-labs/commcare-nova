import { describe, expect, it } from "vitest";
import type { DesignArtifactWriteAuthority } from "@/lib/agent/design/artifactStore";
import {
	type AppDesignContract,
	appDesignContractBaseSchema,
} from "@/lib/agent/design/contract";
import { sealArtifactEnvelope } from "@/lib/agent/design/envelope";
import { computeLookupChoiceProjectionAttestation } from "@/lib/agent/design/lookupChoiceAttestation";
import {
	assertDesignLookupMaterializationCurrentInTransaction,
	ensureAcceptedLookupMaterialization,
} from "@/lib/agent/design/lookupMaterialization";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { releaseDesignLookupProtectionsInTransaction } from "@/lib/db/designLookupMaterializations";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { getAllLookupDefinitions, getLookupTable } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	did,
	ids,
	makeContract,
	makeLookupContract,
	messageRef,
} from "./fixtures";

const h = setupAppStateTestDb("design_lookup_materialization_");

const RUN_ID = "run-design-lookup";
const ACTOR = "lookup-designer";
const PROJECT = "project-design-lookup";
const NONCE = "00000000-0000-4000-8000-000000009701";

const scope: LookupScope = {
	projectId: PROJECT,
	actorId: ACTOR,
	role: "owner",
};

function authority(): DesignArtifactWriteAuthority {
	return {
		actorUserId: ACTOR,
		runId: RUN_ID,
		holderNonce: NONCE,
		expectedProjectId: PROJECT,
	};
}

function designedLookupContract(): AppDesignContract {
	return makeLookupContract();
}

async function seedAcceptedRevision(
	contract: AppDesignContract = designedLookupContract(),
	storedPayload: unknown = contract,
): Promise<{
	designSessionId: string;
	designRevisionId: string;
	designRevisionDigest: string;
}> {
	const designSessionId = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN_ID,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
	});
	const packageDigest = "a".repeat(64);
	const draftEnvelope = sealArtifactEnvelope({
		artifactType: "design-contract" as const,
		artifactSchemaVersion: contract.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId,
		revision: 1,
		parentArtifactId: null,
		sourcePackageDigest: packageDigest,
		inputArtifactDigests: [],
		promptVersion: "design-test-v2",
		producer: {
			provider: "openai",
			modelId: "design-test",
			finishReason: "stop",
		},
		createdAt: new Date().toISOString(),
		payload: storedPayload,
	});
	const acceptedEnvelope = sealArtifactEnvelope({
		artifactType: "design-contract" as const,
		artifactSchemaVersion: contract.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId,
		revision: 2,
		parentArtifactId: draftEnvelope.artifactId,
		sourcePackageDigest: packageDigest,
		inputArtifactDigests: [draftEnvelope.artifactDigest],
		promptVersion: "design-test-v2",
		producer: {
			provider: "openai",
			modelId: "design-test",
			finishReason: "stop",
		},
		createdAt: new Date().toISOString(),
		payload: storedPayload,
	});
	await h
		.db()
		.insertInto("design_source_packages")
		.values({
			id: crypto.randomUUID(),
			design_session_id: designSessionId,
			project_id: PROJECT,
			package_digest: packageDigest,
			created_by_run_id: RUN_ID,
			payload: JSON.stringify({
				schemaVersion: 1,
				designSessionId,
				projectId: PROJECT,
				packageDigest,
				claims: [],
				sources: [messageRef()],
				requestBlockCount: 1,
				attachmentCount: 0,
				imageCount: 0,
				projectedBytes: 32,
				extensionProof: {
					foundationDigest: "1".repeat(64),
					requestBlockDigests: ["2".repeat(64)],
					claimDigests: [],
					attachmentDigests: [],
					imageDigests: [],
					sourceIndexDigests: ["3".repeat(64)],
				},
			}),
		})
		.execute();
	await h
		.db()
		.insertInto("design_revisions")
		.values({
			id: draftEnvelope.artifactId,
			design_session_id: designSessionId,
			revision: 1,
			parent_revision_id: null,
			lifecycle: "draft",
			artifact_digest: draftEnvelope.artifactDigest,
			contract_digest: canonicalJsonDigest(storedPayload),
			source_package_digest: packageDigest,
			producer_model: "design-test",
			prompt_version: "design-test-v2",
			created_by_run_id: RUN_ID,
			envelope: JSON.stringify(draftEnvelope),
		})
		.execute();
	await h
		.db()
		.insertInto("design_revisions")
		.values({
			id: acceptedEnvelope.artifactId,
			design_session_id: designSessionId,
			revision: 2,
			parent_revision_id: draftEnvelope.artifactId,
			lifecycle: "accepted",
			artifact_digest: acceptedEnvelope.artifactDigest,
			contract_digest: canonicalJsonDigest(storedPayload),
			source_package_digest: packageDigest,
			producer_model: "design-test",
			prompt_version: "design-test-v2",
			created_by_run_id: RUN_ID,
			envelope: JSON.stringify(acceptedEnvelope),
		})
		.execute();
	return {
		designSessionId,
		designRevisionId: acceptedEnvelope.artifactId,
		designRevisionDigest: acceptedEnvelope.artifactDigest,
	};
}

async function materialize(
	lineage: Awaited<ReturnType<typeof seedAcceptedRevision>>,
	contract = designedLookupContract(),
) {
	return ensureAcceptedLookupMaterialization({
		...lineage,
		contract,
		authority: authority(),
	});
}

async function seedSuccessorAcceptedRevision(
	prior: Awaited<ReturnType<typeof seedAcceptedRevision>>,
	contract: AppDesignContract,
) {
	const previous = await h
		.db()
		.selectFrom("design_revisions")
		.select("revision")
		.where("design_session_id", "=", prior.designSessionId)
		.orderBy("revision", "desc")
		.executeTakeFirstOrThrow();
	const revision = Number(previous.revision) + 1;
	const envelope = sealArtifactEnvelope({
		artifactType: "design-contract" as const,
		artifactSchemaVersion: contract.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId: prior.designSessionId,
		revision,
		parentArtifactId: prior.designRevisionId,
		sourcePackageDigest: "a".repeat(64),
		inputArtifactDigests: [prior.designRevisionDigest],
		promptVersion: "design-test-v2",
		producer: {
			provider: "openai" as const,
			modelId: "design-test",
			finishReason: "stop",
		},
		createdAt: new Date().toISOString(),
		payload: contract,
	});
	await h
		.db()
		.insertInto("design_revisions")
		.values({
			id: envelope.artifactId,
			design_session_id: prior.designSessionId,
			revision,
			parent_revision_id: prior.designRevisionId,
			lifecycle: "accepted",
			artifact_digest: envelope.artifactDigest,
			contract_digest: canonicalJsonDigest(contract),
			source_package_digest: "a".repeat(64),
			producer_model: "design-test",
			prompt_version: "design-test-v2",
			created_by_run_id: RUN_ID,
			envelope: JSON.stringify(envelope),
		})
		.execute();
	return {
		designSessionId: prior.designSessionId,
		designRevisionId: envelope.artifactId,
		designRevisionDigest: envelope.artifactDigest,
	};
}

describe("accepted design lookup materialization", () => {
	it("normalizes a digest-verified historical list selection before materializing", async () => {
		const contract = designedLookupContract();
		const stored = structuredClone(contract) as unknown as Record<
			string,
			unknown
		>;
		const list = (stored.lists as Array<Record<string, unknown>>)[0];
		if (list === undefined) throw new Error("Expected a list fixture.");
		const module = (
			stored.moduleCompositions as Array<Record<string, unknown>>
		)[0];
		if (module === undefined) throw new Error("Expected a module fixture.");
		const selection = module.selection as { readonly workflowIds: string[] };
		delete module.selection;
		list.selectionWorkflowId = selection.workflowIds[0];

		const lineage = await seedAcceptedRevision(contract, stored);
		const receipt = await materialize(lineage, contract);

		expect(receipt).not.toBeNull();
		expect((await getAllLookupDefinitions(scope)).definitions).toHaveLength(1);
	});

	it("refuses Project-data evidence outside the accepted source package", async () => {
		const contract = designedLookupContract();
		const table = contract.lookupTables[0];
		if (table?.kind !== "create") throw new Error("Expected a create intent.");
		table.rowEvidence.sourceRefs = [messageRef(7)];
		const lineage = await seedAcceptedRevision(contract);
		await expect(materialize(lineage, contract)).rejects.toThrow(
			"cites evidence outside the accepted design's source package",
		);
		expect((await getAllLookupDefinitions(scope)).definitions).toEqual([]);
	});

	it("refuses a different caller contract under the same accepted lineage", async () => {
		const acceptedContract = designedLookupContract();
		const lineage = await seedAcceptedRevision(acceptedContract);
		const differentContract = structuredClone(acceptedContract);
		const table = differentContract.lookupTables[0];
		if (table?.kind !== "create") throw new Error("Expected a create intent.");
		table.name = "Unreviewed replacement";

		await expect(materialize(lineage, differentContract)).rejects.toThrow(
			"exact persisted accepted Design Contract",
		);
		expect((await getAllLookupDefinitions(scope)).definitions).toEqual([]);
	});

	it("atomically mints stable UUIDs and converges after a lost response", async () => {
		const lineage = await seedAcceptedRevision();
		const first = await materialize(lineage);
		if (first === null) throw new Error("Expected a lookup receipt.");
		expect(first.payload.projectRevision).toBe("1");
		expect(first.payload.bindings.map(({ kind }) => kind)).toEqual([
			"lookup-table",
			"lookup-column",
			"lookup-column",
			"lookup-row",
			"lookup-row",
		]);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select(({ fn }) => fn.countAll<string>().as("n"))
				.where("materialization_id", "=", first.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ n: "3" });

		const recovered = await materialize(lineage);
		expect(recovered?.id).toBe(first.id);
		expect(recovered?.resultDigest).toBe(first.resultDigest);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select(({ fn }) => fn.countAll<string>().as("n"))
				.where("materialization_id", "=", first.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ n: "3" });
		expect((await getAllLookupDefinitions(scope)).projectRevision).toBe("1");
	});

	it("releases only superseded revision protections, including a no-lookup successor", async () => {
		const firstLineage = await seedAcceptedRevision();
		const first = await materialize(firstLineage);
		if (first === null) throw new Error("Expected the first lookup receipt.");

		const successorContract = designedLookupContract();
		const successorTable = successorContract.lookupTables[0];
		if (successorTable?.kind !== "create")
			throw new Error("Expected a successor create intent.");
		successorTable.name = "Second risk levels";
		successorTable.tag = "risk_levels_2";
		const secondLineage = await seedSuccessorAcceptedRevision(
			firstLineage,
			successorContract,
		);
		const second = await materialize(secondLineage, successorContract);
		if (second === null) throw new Error("Expected the second lookup receipt.");
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select("materialization_id")
				.where("materialization_id", "in", [first.id, second.id])
				.orderBy("materialization_id")
				.execute(),
		).toEqual([
			expect.objectContaining({ materialization_id: second.id }),
			expect.objectContaining({ materialization_id: second.id }),
			expect.objectContaining({ materialization_id: second.id }),
		]);

		const noLookupContract = appDesignContractBaseSchema.parse(makeContract());
		const thirdLineage = await seedSuccessorAcceptedRevision(
			secondLineage,
			noLookupContract,
		);
		expect(await materialize(thirdLineage, noLookupContract)).toBeNull();
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select("id")
				.where(
					"materialization_id",
					"in",
					h
						.db()
						.selectFrom("design_lookup_materializations")
						.select("id")
						.where("design_session_id", "=", firstLineage.designSessionId),
				)
				.execute(),
		).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_materializations")
				.select(({ fn }) => fn.countAll<string>().as("n"))
				.where("design_session_id", "=", firstLineage.designSessionId)
				.executeTakeFirstOrThrow(),
		).toEqual({ n: "2" });
	});

	it("refuses receipt reuse after the reviewed table state drifts", async () => {
		const lineage = await seedAcceptedRevision();
		const receipt = await materialize(lineage);
		if (receipt === null) throw new Error("Expected a lookup receipt.");
		const tableBinding = receipt.payload.bindings.find(
			(binding) => binding.kind === "lookup-table",
		);
		const rowBinding = receipt.payload.bindings.find(
			(binding) => binding.kind === "lookup-row",
		);
		const valueBinding = receipt.payload.bindings.find(
			(binding) =>
				binding.kind === "lookup-column" &&
				binding.designId === ids.lookupRiskValue,
		);
		if (
			tableBinding?.kind !== "lookup-table" ||
			rowBinding?.kind !== "lookup-row" ||
			valueBinding?.kind !== "lookup-column"
		) {
			throw new Error("Materialization omitted an expected identity.");
		}
		const snapshot = await getLookupTable(scope, tableBinding.lookupId);
		await h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(tx, scope, {
					updateTables: [
						{
							tableId: tableBinding.lookupId,
							expectedTableRevision: snapshot.tableRevision,
							rowOperations: [
								{
									kind: "update",
									rowId: rowBinding.lookupId,
									cells: [
										{
											columnId: valueBinding.lookupId,
											value: "changed",
										},
									],
								},
							],
						},
					],
				}),
			);

		await expect(materialize(lineage)).rejects.toThrow(
			"Project data changed after this design was accepted",
		);
	});

	it("hands temporary protections off only after exact genesis revalidation", async () => {
		const lineage = await seedAcceptedRevision();
		const receipt = await materialize(lineage);
		if (receipt === null) throw new Error("Expected a lookup receipt.");
		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				await assertDesignLookupMaterializationCurrentInTransaction(tx, {
					designSessionId: lineage.designSessionId,
					designRevisionId: lineage.designRevisionId,
					designRevisionDigest: lineage.designRevisionDigest,
					projectId: PROJECT,
				});
				await releaseDesignLookupProtectionsInTransaction(
					tx,
					lineage.designSessionId,
				);
			});
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select("id")
				.where("materialization_id", "=", receipt.id)
				.execute(),
		).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_materializations")
				.select("id")
				.where("id", "=", receipt.id)
				.executeTakeFirst(),
		).toEqual({ id: receipt.id });
	});

	it("rolls back every proposed table when an existing-table revision conflicts", async () => {
		const existing = await h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(tx, scope, {
					createTables: [
						{
							key: "existing",
							name: "Existing",
							tag: "existing",
							columns: [
								{
									key: "value",
									wireName: "value",
									label: "Value",
									dataType: "text",
								},
							],
							rows: [],
						},
					],
				}),
			);
		const contract = designedLookupContract();
		const existingColumnId = existing.tables[0]?.columnIds[0]?.id;
		const workflow = contract.workflows[0];
		if (existingColumnId === undefined || workflow === undefined) {
			throw new Error("Existing lookup fixture is incomplete.");
		}
		workflow.inputs.push({
			handle: "existing_category",
			name: "Existing category",
			purpose: "Exercise an accepted change to a table used by this app.",
			dataShape: "single-choice",
			choiceSource: {
				kind: "existing-project-lookup",
				tableId: existing.tables[0].tableId,
				valueColumnId: existingColumnId,
				labelColumnId: existingColumnId,
				inspection: computeLookupChoiceProjectionAttestation({
					tableRevision: "0" as never,
					tableName: "Existing",
					valueColumnLabel: "Value",
					labelColumnLabel: "Value",
					rows: [],
				}),
			},
		});
		const form = contract.formCompositions.find(
			(composition) => composition.workflowId === workflow.id,
		);
		if (form?.layout.kind !== "sectioned") {
			throw new Error("Registration form fixture is incomplete.");
		}
		form.layout.sections[0]?.items.push({
			kind: "input",
			id: did(197),
			inputHandle: "existing_category",
			labelMarkdown: "Existing category",
		});
		contract.lookupTables.push({
			kind: "modify-existing",
			id: did(196),
			tableId: existing.tables[0].tableId,
			expectedTableRevision: "0" as never,
			purpose: "Apply an explicitly requested shared label correction.",
			authorization: {
				kind: "direct-user-request",
				sourceRefs: [messageRef()],
				impactSummary: "Rename the existing shared table.",
			},
			operations: [{ kind: "update-table", name: "Renamed" }],
		});
		const lineage = await seedAcceptedRevision(contract);

		await expect(materialize(lineage, contract)).rejects.toMatchObject({
			code: "conflict",
		});
		const catalog = await getAllLookupDefinitions(scope);
		expect(catalog.projectRevision).toBe("1");
		expect(catalog.definitions.map(({ tag }) => tag)).toEqual(["existing"]);
	});
});
