import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MediaPickerDialog } from "@/components/builder/media/MediaPickerDialog";
import { Button } from "@/components/shadcn/button";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

/** One Project file manager over audio, the picker a person uploads an M4A or
 * an Opus file through, mounted with no app routing or persistence. */
const session = createBuilderSessionStore({
	appId: "media-transport-app",
	projectId: "media-transport-project",
	role: "editor",
	canEdit: true,
});

function Controls() {
	const [open, setOpen] = useState(false);
	return (
		<BuilderSessionContext value={session}>
			<Button onClick={() => setOpen(true)}>Audio files</Button>
			<MediaPickerDialog
				open={open}
				onOpenChange={setOpen}
				kinds={["audio"]}
				appId="media-transport-app"
				canManageFiles
			/>
		</BuilderSessionContext>
	);
}

const element = document.getElementById("root");
if (!element) throw new Error("Missing media transport root");
const root = createRoot(element);
root.render(
	<BlueprintDocProvider appId="media-transport-app">
		<Controls />
	</BlueprintDocProvider>,
);
window.mediaTransportAudit = { dispose: () => root.unmount() };

declare global {
	interface Window {
		mediaTransportAudit: { dispose: () => void };
	}
}
