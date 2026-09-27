import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PendingChatWork } from "@/components/chat/PendingChatWork";

let revision = 1;
const listeners = new Set<() => void>();
const revisions = {
	canonicalRevision: () => revision,
	subscribeCanonicalRevision(listener: () => void) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
};
function App() {
	const [status, setStatus] = useState<"ready" | "streaming">("ready");
	const [visible, setVisible] = useState(true);
	const [sent, setSent] = useState<string[]>([]);
	return (
		<main style={{ maxWidth: 400 }}>
			<button
				type="button"
				onClick={() => {
					revision++;
					for (const listener of listeners) listener();
				}}
			>
				Receive saved revision
			</button>
			<button
				type="button"
				onClick={() => setStatus(status === "ready" ? "streaming" : "ready")}
			>
				{status === "ready" ? "Start run" : "Finish run"}
			</button>
			<button type="button" onClick={() => setVisible(!visible)}>
				Switch conversation
			</button>
			{visible && (
				<PendingChatWork
					appId="test-app"
					threadId="11111111-1111-4111-8111-111111111111"
					status={status}
					revisions={revisions}
					onContinue={(text) => setSent((prior) => [...prior, text])}
				/>
			)}
			<output aria-label="Sent requests">{sent.join("\n")}</output>
		</main>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App />);
