import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import { CHANGE_SET_HANDLE_PATTERN } from "@/lib/agent/change-set/schemas";
import type { ChangeSetMutationWorkspace } from "@/lib/agent/change-set/workspace";
import {
	candidateWireToolSchema,
	createCandidateAgent,
	projectCandidateText,
} from "@/lib/agent/design/candidateAgent";
import { CANDIDATE_AUTHOR_SYSTEM } from "@/lib/agent/design/candidatePrompt";

type JsonNode = Record<string, unknown>;

function collectionItem(schema: JsonNode, collection: string): JsonNode {
	const properties = schema.properties as JsonNode | undefined;
	const array = properties?.[collection] as JsonNode | undefined;
	const item = array?.items;
	if (item === undefined || item === null || typeof item !== "object") {
		throw new Error(`Missing ${collection} item schema.`);
	}
	return item as JsonNode;
}

function containsHandleArm(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsHandleArm);
	if (value === null || typeof value !== "object") return false;
	const record = value as JsonNode;
	const properties = record.properties as JsonNode | undefined;
	const handle = properties?.handle as JsonNode | undefined;
	if (handle?.pattern === CHANGE_SET_HANDLE_PATTERN.source) return true;
	return Object.values(record).some(containsHandleArm);
}

function identitySlots(
	value: unknown,
	property: string,
): Array<{ required: readonly unknown[]; schema: unknown }> {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => identitySlots(entry, property));
	}
	if (value === null || typeof value !== "object") return [];
	const record = value as JsonNode;
	const properties = record.properties as JsonNode | undefined;
	const here =
		properties !== undefined && property in properties
			? [
					{
						required: Array.isArray(record.required) ? record.required : [],
						schema: properties[property],
					},
				]
			: [];
	return [
		...here,
		...Object.values(record).flatMap((entry) => identitySlots(entry, property)),
	];
}

function fakeWorkspace(): ChangeSetMutationWorkspace {
	return {
		currentExecutionCheckpoint: () => ({ intentCoverage: [], handles: [] }),
	} as unknown as ChangeSetMutationWorkspace;
}

describe("reviewed Blueprint candidate agent", () => {
	it("mounts ordinary high-level tools without the granular staging protocol", () => {
		const agent = createCandidateAgent({
			model: {} as LanguageModel,
			workspace: fakeWorkspace(),
			instructions: "Build the app.",
			designSessionId: "00000000-0000-4000-8000-000000000001",
			sourcePackageDigest: "a".repeat(64),
			authority: {
				actorUserId: "user",
				runId: "run",
				holderNonce: "nonce",
				expectedProjectId: "project",
			},
			promptCacheKey: "candidate-test",
			allowQuestions: true,
			freshStateMessage: async () => ({ role: "user", content: "state" }),
			onCheckpoint: () => {},
		});
		const names = Object.keys(agent.tools);
		for (const name of [
			"createModule",
			"createForm",
			"generateSchema",
			"addUserProperties",
			"addLocationProperties",
		]) {
			expect(names).toContain(name);
		}
		expect(names).toContain("askQuestions");
		expect(names).toContain("finishCandidate");
		expect(names).not.toContain("stageModule");
		expect(names).not.toContain("stageForm");
		expect(names).not.toContain("stageBatch");
		expect(names).not.toContain("commitChangeSet");
	});

	it("does not let a correction phase ask a new user question", () => {
		const agent = createCandidateAgent({
			model: {} as LanguageModel,
			workspace: fakeWorkspace(),
			instructions: "Correct the app.",
			designSessionId: "00000000-0000-4000-8000-000000000001",
			sourcePackageDigest: "a".repeat(64),
			authority: {
				actorUserId: "user",
				runId: "run",
				holderNonce: "nonce",
				expectedProjectId: "project",
			},
			promptCacheKey: "candidate-test",
			allowQuestions: false,
			freshStateMessage: async () => ({ role: "user", content: "state" }),
			onCheckpoint: () => {},
		});
		expect(Object.keys(agent.tools)).not.toContain("askQuestions");
	});

	it("requires a handle-backed identity on every server-minted bulk item", () => {
		for (const [name, collection, identity] of [
			["addUserProperties", "properties", "userPropertyUuid"],
			["addUserTypes", "userTypes", "userTypeUuid"],
			["addPersonas", "personas", "personaUuid"],
			["addLocationProperties", "properties", "locationPropertyUuid"],
		] as const) {
			const entry = CHANGE_SET_TOOL_REGISTRY.get(name);
			if (entry === undefined) throw new Error(`Missing ${name}.`);
			const item = collectionItem(
				candidateWireToolSchema(name, entry.tool.inputSchema) as JsonNode,
				collection,
			);
			expect(item.required).toContain(identity);
			expect(
				containsHandleArm(
					(item.properties as JsonNode | undefined)?.[identity],
				),
			).toBe(true);
		}
	});

	it("requires handles for every nested structural identity it creates", () => {
		for (const [name, identities] of [
			[
				"createModule",
				["moduleUuid", "formUuid", "fieldUuid", "optionUuid", "columnUuid"],
			],
			["createForm", ["formUuid", "fieldUuid", "optionUuid"]],
			["addFields", ["fieldUuid", "optionUuid"]],
			["addCaseListColumns", ["columnUuid"]],
			["addSearchInputs", ["searchInputUuid"]],
			["addCaseOperations", ["operationUuid"]],
			["addOrganizationLevels", ["uuid"]],
			["addAutomations", ["uuid"]],
		] as const) {
			const entry = CHANGE_SET_TOOL_REGISTRY.get(name);
			if (entry === undefined) throw new Error(`Missing ${name}.`);
			const schema = candidateWireToolSchema(
				name,
				entry.tool.inputSchema,
			) as JsonNode;
			for (const identity of identities) {
				const slots = identitySlots(schema, identity);
				expect(slots.length, `${name}.${identity}`).toBeGreaterThan(0);
				for (const slot of slots) {
					expect(slot.required, `${name}.${identity}`).toContain(identity);
					expect(containsHandleArm(slot.schema), `${name}.${identity}`).toBe(
						true,
					);
				}
			}
		}
	});

	it("projects durable handles instead of raw authored UUIDs", () => {
		const uuid = "11111111-1111-4111-8111-111111111111";
		const workspace = {
			currentExecutionCheckpoint: () => ({
				intentCoverage: [],
				handles: [{ handle: "@registration", uuid, entityKind: "form" }],
			}),
		} as unknown as ChangeSetMutationWorkspace;
		expect(projectCandidateText(`Form [uuid ${uuid}]`, workspace)).toBe(
			"Form [uuid @registration]",
		);
	});

	it("states the one-app and media capability boundaries", () => {
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"One build creates exactly one app in the current Project",
		);
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"You cannot create image, audio, video, document, or other media bytes",
		);
		expect(CANDIDATE_AUTHOR_SYSTEM).toContain(
			"Never invent, type, or copy a canonical UUID",
		);
		expect(CANDIDATE_AUTHOR_SYSTEM).not.toContain("canonical survey starter");
		expect(CANDIDATE_AUTHOR_SYSTEM).not.toContain("create_app");
	});
});
