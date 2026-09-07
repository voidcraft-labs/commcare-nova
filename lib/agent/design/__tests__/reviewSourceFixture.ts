import { seedClaimsFromAnsweredRounds } from "@/lib/agent/design/loop/claimSeeding";
import { buildDesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import {
	SOURCE_DOCUMENT,
	SOURCE_IMAGE,
	SOURCE_PNG,
	SOURCE_PROJECT,
	SOURCE_SESSION,
	SOURCE_THREAD,
	sourceAsset,
	sourceDigest,
	sourceMessage,
	sourceRef,
} from "./sourcePackageFixtures";

/** Actual source producer with controlled authorized extract/image bytes.
 * Review tests own symbol projection, not storage or media-service behavior. */
export async function reviewSourceFixture() {
	const answered: NovaUIMessage = {
		id: "answers",
		role: "assistant",
		parts: [
			{ type: "text", text: "One detail before design." },
			{
				type: "tool-askQuestions",
				toolCallId: "pilot-scope",
				state: "output-available",
				input: {
					header: "Pilot",
					questions: [{ question: "Where will this run?", options: [] }],
				},
				output: { "0": "Three clinics" },
			},
		],
	};
	const messages = [
		sourceMessage("request", "Register patients and record visits.", [
			sourceRef(SOURCE_DOCUMENT),
			sourceRef(SOURCE_IMAGE),
		]),
		answered,
	];
	return buildDesignSourcePackage({
		designSessionId: SOURCE_SESSION,
		projectId: SOURCE_PROJECT,
		threadId: SOURCE_THREAD,
		messages,
		claims: seedClaimsFromAnsweredRounds(SOURCE_THREAD, messages),
		deps: {
			loadAssets: async (ids) => ids.map((id) => sourceAsset(id)),
			readExtract: async () => ({
				text: '## Requirements\nConfirm saved visits.\n<nova:figure index="1"/>',
				truncated: false,
			}),
			loadImage: async () => ({
				mediaType: "image/png",
				dataUrl: `data:image/png;base64,${SOURCE_PNG.toString("base64")}`,
				bytesDigest: sourceDigest(SOURCE_PNG),
			}),
		},
	});
}
