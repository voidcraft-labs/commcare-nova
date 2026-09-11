import type { UIMessage } from "ai";
import { expect, it } from "vitest";
import {
	did,
	fixtureValue,
	makeNestedMenuContract,
} from "@/lib/agent/design/__tests__/fixtures";
import {
	normalizeStoredDesignArtifactWorkspaceOperation,
	replayDesignWorkspace,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	inferDesignStepTurn,
	planWorkspacePlacementMigration,
} from "../designContinuationMigration";

it.each([false, true])(
	"preserves saved sibling order with partial forward references: %s",
	(partial) => {
		const source = makeNestedMenuContract();
		const parent = fixtureValue(source.moduleCompositions[0], "parent");
		const originalChild = {
			...fixtureValue(source.moduleCompositions[1], "child"),
			parentModuleCompositionId: undefined,
		};
		const sibling = { ...originalChild, id: did(999) };
		const orphans = partial
			? [
					{
						...originalChild,
						id: did(998),
						parentModuleCompositionId: did(997),
					},
				]
			: [];
		const operations = [
			normalizeStoredDesignArtifactWorkspaceOperation({
				storageVersion: 2,
				operation: {
					kind: "revision",
					collections: [
						{
							collection: "moduleCompositions",
							upserts: [
								{ ...originalChild, parentModuleCompositionId: parent.id },
							],
							removeIds: [],
						},
					],
				},
			}),
			normalizeStoredDesignArtifactWorkspaceOperation({
				storageVersion: 2,
				operation: {
					kind: "revision",
					collections: [
						{
							collection: "moduleCompositions",
							upserts: [originalChild],
							removeIds: [],
						},
					],
				},
			}),
		];
		const args = {
			kind: "revision" as const,
			baseContract: {
				moduleCompositions: [parent, originalChild, sibling, ...orphans],
			},
			operations,
		};
		expect(
			(replayDesignWorkspace(args).moduleCompositions as { id: string }[]).map(
				(menu) => menu.id,
			),
		).toEqual([
			parent.id,
			sibling.id,
			originalChild.id,
			...orphans.map((menu) => menu.id),
		]);
		const migration = planWorkspacePlacementMigration(args);
		expect(migration.length).toBeGreaterThan(0);
		const migrated = { ...args, operations: [...operations, ...migration] };
		expect(
			(
				replayDesignWorkspace(migrated).moduleCompositions as { id: string }[]
			).map((menu) => menu.id),
		).toEqual([
			parent.id,
			originalChild.id,
			sibling.id,
			...orphans.map((menu) => menu.id),
		]);
		expect(planWorkspacePlacementMigration(migrated)).toEqual([]);
	},
);

it("never attributes pre-answer or removed-assistant starts to a later logical input", () => {
	const digest = "a".repeat(64);
	const step = {
		context_id: "context",
		step_key: "step",
		event_digest: digest,
		request_digest: digest,
		created_at: new Date("2026-09-01"),
		created_by_run_id: "run",
		completedResponseDigest: digest,
	};
	const response = {
		context_id: "context",
		append_key: `design-response:assistant:author:step:${digest}`,
		item_digest: digest,
		message: {},
		created_at: new Date("2026-09-02"),
		ordinal: 1,
	};
	const user: UIMessage = {
		id: "user",
		role: "user",
		parts: [{ type: "text", text: "Build an app" }],
	};
	const answer = { toolCallId: "question", output: { answer: "yes" } };
	const assistant: UIMessage = {
		id: "assistant",
		role: "assistant",
		parts: [
			{
				type: "tool-askQuestions",
				state: "output-available",
				input: {},
				...answer,
			},
		],
	};
	expect(inferDesignStepTurn(step, [response], [[user, assistant]])).toBeNull();
	expect(inferDesignStepTurn(step, [response], [[user]])).toBeNull();
	const answerTurn = `assistant:answer:${canonicalJsonDigest(answer)}`;
	expect(
		inferDesignStepTurn(
			step,
			[
				{
					...response,
					append_key: `design-response:${answerTurn}:author:step:${digest}`,
				},
			],
			[[user, assistant]],
		),
	).toBe(answerTurn);
	expect(
		inferDesignStepTurn(
			step,
			[
				response,
				{
					...response,
					append_key: "ui-turn:user",
					created_at: new Date("2026-08-31"),
					ordinal: 0,
				},
			],
			[[user, assistant]],
		),
	).toBe("user");
	expect(
		inferDesignStepTurn(
			step,
			[response],
			[
				[
					user,
					{ ...assistant, parts: [{ type: "text", text: "Earlier work" }] },
				],
			],
		),
	).toBe("user");
});
