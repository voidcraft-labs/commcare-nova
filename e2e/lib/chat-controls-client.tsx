import { useState } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { AskQuestionsCard } from "@/components/chat/AskQuestionsCard";
import { ChatInput } from "@/components/chat/ChatInput";
import { PersistentChatComposer } from "@/components/chat/chatComposer";
import { DesignProgressDetails } from "@/components/chat/DesignProgressPanel";
import { ToolRunSummary } from "@/components/chat/ToolRunSummary";
import { FieldPicker } from "@/components/ui/FieldPicker";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { AttachmentRef } from "@/lib/chat/attachmentRefs";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/chat/limits";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { blueprintDocSchema, proseText } from "@/lib/domain";
import type { DesignProgressView } from "@/lib/session/designProgressStore";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const FORM = testUuid("native-chat-form"),
	FIELD = testUuid("native-chat-field");
const doc = buildDoc({
	modules: [
		{
			name: "Visits",
			forms: [
				{
					uuid: FORM,
					name: "Intake",
					type: "survey",
					fields: [
						f({
							uuid: FIELD,
							id: "notes",
							kind: "text",
							label: proseText("Visit notes"),
						}),
					],
				},
			],
		},
	],
});
blueprintDocSchema.parse(toPersistableDoc(doc));
const verdict = mutationCommitVerdict(
	doc,
	[{ kind: "setAppName", name: "Native chat controls" }],
	LOOKUP_CONTEXT_UNAVAILABLE,
);
if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
const session = createBuilderSessionStore({
	appId: "native-chat-app",
	projectId: "native-chat-project",
	role: "editor",
	canEdit: true,
});
const sent: { text: string; attachments?: AttachmentRef[] }[] = [];
const answers: unknown[] = [];
const changes: string[] = [];
let refreshOnSubmit = false;
const handleSubmitCapture = () => {
	if (!refreshOnSubmit) return;
	refreshOnSubmit = false;
	session.getState().beginAccessRefresh();
};
document.addEventListener("submit", handleSubmitCapture, true);
const progress: DesignProgressView = {
	active: true,
	designSessionId: testUuid("native-design-session"),
	stage: "building",
	stageLabel: "Building your app",
	working: true,
	pulseStep: null,
	outline: {
		objective: "Track follow-up visits",
		actors: ["Clinic nurses"],
		tasks: ["Register a client"],
		records: [],
		lists: [],
		assumptions: [],
		blockingQuestions: [],
		outOfScope: [],
		reviewed: true,
	},
	plannedSliceNames: ["Registration", "Follow-up"],
	sliceProgress: null,
	currentSliceName: "Registration",
	committedSliceNames: [],
	materialized: false,
	failure: null,
};
function Controls() {
	const [hidden, setHidden] = useState(false),
		[renamed, setRenamed] = useState(false),
		[streaming, setStreaming] = useState(true),
		[materialized, setMaterialized] = useState(false);
	return (
		<BuilderSessionContext.Provider value={session}>
			<BlueprintDocProvider initialDoc={doc}>
				<section aria-label="Progress disclosure">
					<DesignProgressDetails
						view={
							materialized
								? {
										...progress,
										materialized: true,
										committedSliceNames: ["Registration"],
										currentSliceName: "Follow-up",
									}
								: progress
						}
					/>
					<button type="button" onClick={() => setMaterialized(true)}>
						App materializes
					</button>
				</section>
				<section aria-label="Tool changes">
					<ToolRunSummary
						parts={[
							{
								type: "tool-addFields",
								toolCallId: "native-add",
								state: "input-available",
								input: {},
							},
							{
								type: "tool-completeBuild",
								toolCallId: "native-historical-completion",
								state: "output-available",
								input: {},
								output: {
									success: false,
									errors: [
										"A field needs a label.",
										"A form needs a question.",
									],
								},
							},
						]}
					/>
				</section>
				<section aria-label="Questions">
					<AskQuestionsCard
						toolCallId="native-round"
						input={{
							header: "Visit details",
							questions: [
								{ question: "Visit type?", options: [{ label: "Clinic" }] },
							],
						}}
						state="input-available"
						addToolOutput={(answer) => answers.push(answer)}
					/>
				</section>
				<section aria-label="Field picker" style={{ marginTop: 20 }}>
					<FieldPicker
						source={{
							...doc,
							fields: {
								...doc.fields,
								[FIELD]: {
									...doc.fields[FIELD],
									id: renamed ? "renamed_notes" : "notes",
								},
							},
						}}
						parentUuid={FORM}
						value={FIELD}
						onChange={(id) => changes.push(id)}
						label="Closing answer"
					/>
					<button type="button" onClick={() => setRenamed(true)}>
						Peer renames selected field
					</button>
				</section>
				<section aria-label="Reasoning" style={{ marginTop: 20 }}>
					<Reasoning isStreaming={streaming}>
						<ReasoningTrigger />
						<ReasoningContent>Check the visit workflow.</ReasoningContent>
					</Reasoning>
					<button type="button" onClick={() => setStreaming(false)}>
						Finish streaming
					</button>
				</section>
				<button type="button" onClick={() => setHidden((value) => !value)}>
					{hidden ? "Restore composer" : "Hide composer"}
				</button>
				<section aria-label="Composer" style={{ marginTop: 20 }}>
					<PersistentChatComposer hidden={hidden}>
						<ChatInput onSend={(message) => sent.push(message)} />
					</PersistentChatComposer>
				</section>
			</BlueprintDocProvider>
		</BuilderSessionContext.Provider>
	);
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing native root");
const root = createRoot(element);
root.render(<Controls />);
window.chatControlsAudit = {
	sent: () => sent,
	answers: () => answers,
	changes: () => changes,
	fieldId: FIELD,
	messageLimit: MAX_CHAT_MESSAGE_CHARS,
	armAccessRefreshOnSubmit: () => {
		refreshOnSubmit = true;
	},
	accessPhase: () => session.getState().accessPhase,
	restoreAccess: () =>
		session.getState().applyAccessSnapshot({
			projectId: "native-chat-project",
			role: "editor",
			canEdit: true,
		}),
	dispose: () => {
		document.removeEventListener("submit", handleSubmitCapture, true);
		root.unmount();
	},
};
declare global {
	interface Window {
		chatControlsAudit: {
			sent: () => typeof sent;
			answers: () => unknown[];
			changes: () => string[];
			fieldId: string;
			messageLimit: number;
			armAccessRefreshOnSubmit: () => void;
			accessPhase: () => string;
			restoreAccess: () => void;
			dispose: () => void;
		};
	}
}
