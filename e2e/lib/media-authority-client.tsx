import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	MediaPickerDialog,
	type MediaPickerSelection,
} from "@/components/builder/media/MediaPickerDialog";
import { ChatInput } from "@/components/chat/ChatInput";
import { Button } from "@/components/shadcn/button";
import type { AttachmentRef } from "@/lib/chat/attachmentRefs";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const session = createBuilderSessionStore({
	appId: "media-authority-app",
	projectId: "media-authority-project",
	role: "editor",
	canEdit: true,
});
const selections: MediaPickerSelection[] = [];
const messages: { text: string; attachments?: AttachmentRef[] }[] = [];

function Controls() {
	const [managerOpen, setManagerOpen] = useState(false);
	const [blueprintOpen, setBlueprintOpen] = useState(false);
	return (
		<BuilderSessionContext value={session}>
			<Button onClick={() => setManagerOpen(true)}>Project files</Button>
			<Button onClick={() => setBlueprintOpen(true)}>App image</Button>
			<ChatInput onSend={(message) => messages.push(message)} />
			<MediaPickerDialog
				open={managerOpen}
				onOpenChange={setManagerOpen}
				kinds={["image", "pdf"]}
				appId="media-authority-app"
				// A standalone permission can never override the live builder role.
				canManageFiles
			/>
			<MediaPickerDialog
				open={blueprintOpen}
				onOpenChange={setBlueprintOpen}
				kinds={["image"]}
				appId="media-authority-app"
				selectionAuthority="blueprint"
				onPick={(selection) => selections.push(selection)}
			/>
		</BuilderSessionContext>
	);
}

const element = document.getElementById("root");
if (!element) throw new Error("Missing media authority root");
const root = createRoot(element);
root.render(
	<BlueprintDocProvider appId="media-authority-app">
		<Controls />
	</BlueprintDocProvider>,
);
window.mediaAuthorityAudit = {
	lock: () => session.getState().markBuildUnfinished(),
	finish: () => session.getState().markBuildFinished(),
	refresh: () => session.getState().beginAccessRefresh(),
	reconnecting: () => session.getState().markAccessReconnecting(),
	revoke: () => session.getState().revokeAccess(),
	access: (canEdit: boolean, projectId = "media-authority-project") =>
		session.getState().applyAccessSnapshot({
			projectId,
			role: canEdit ? "editor" : "viewer",
			canEdit,
		}),
	selections: () => selections,
	messages: () => messages,
	dispose: () => root.unmount(),
};

declare global {
	interface Window {
		mediaAuthorityAudit: {
			lock: () => void;
			finish: () => void;
			refresh: () => void;
			reconnecting: () => void;
			revoke: () => void;
			access: (canEdit: boolean, projectId?: string) => void;
			selections: () => MediaPickerSelection[];
			messages: () => typeof messages;
			dispose: () => void;
		};
	}
}
