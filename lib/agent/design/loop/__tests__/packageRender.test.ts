import { describe, expect, it } from "vitest";
import {
	applySourceProjection,
	projectPackageOntoMessages,
} from "@/lib/agent/design/loop/packageRender";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";

const THREAD_ID = "00000000-0000-4000-8000-000000000801";

describe("design source message projection", () => {
	it("keeps retry controls in the transcript but omits them from model history", () => {
		const messages: NovaUIMessage[] = [
			{
				id: "request",
				role: "user",
				parts: [{ type: "text", text: "Build a visit tracker" }],
			},
			{
				id: "retry",
				role: "user",
				parts: [{ type: "text", text: "Try again" }],
				metadata: { designBuildRetry: true },
			},
		];
		const pkg = {
			schemaVersion: 1,
			designSessionId: "00000000-0000-4000-8000-000000000800",
			projectId: "project",
			packageDigest: "a".repeat(64),
			request: {
				blocks: [
					{
						ref: {
							kind: "message",
							threadId: THREAD_ID,
							messageId: "request",
							partIndex: 0,
						},
						text: "Build a visit tracker",
						truncated: false,
					},
				],
			},
			claims: [],
			attachments: [],
			images: [],
			platformConstraints: [],
			sources: [],
		} satisfies DesignSourcePackage;

		const projected = applySourceProjection(
			messages,
			projectPackageOntoMessages(pkg, messages),
		);

		expect(messages).toHaveLength(2);
		expect(projected.map((message) => message.id)).toEqual(["request"]);
		expect(JSON.stringify(projected)).not.toContain("Try again");
	});
});
