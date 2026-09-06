import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkerCredentials } from "@/components/builder/WorkerCredentials";
import {
	foldProvisioningOutcome,
	type HeldProvisioningOutcome,
} from "@/lib/deployment/workerProvisionPlan";

const candidate = {
	personaUuid: "amina",
	personaName: "Amina",
	username: "amina@clinic.commcarehq.org",
	password: "us-first",
};
function initial(password: string) {
	return foldProvisioningOutcome(undefined, {
		workers: [],
		refusal: null,
		unconfirmed: [{ ...candidate, password }],
	});
}
function App() {
	const [outcomes, setOutcomes] = useState<
		Record<string, HeldProvisioningOutcome>
	>({ US: initial("us-first"), India: initial("india-only") });
	const [visible, setVisible] = useState(true);
	return (
		<>
			<button type="button" onClick={() => setVisible(!visible)}>
				{visible ? "Hide panels" : "Show panels"}
			</button>
			<button
				type="button"
				onClick={() =>
					setOutcomes((held) => ({
						...held,
						US: foldProvisioningOutcome(held.US, {
							workers: [],
							refusal: null,
							unconfirmed: [{ ...candidate, password: "us-second" }],
						}),
					}))
				}
			>
				Add uncertain US retry
			</button>
			{visible &&
				Object.entries(outcomes).map(([target, outcome]) => (
					<section aria-label={target} key={target}>
						<h2>{target}</h2>
						<WorkerCredentials
							workers={outcome.workers}
							unconfirmed={Object.entries(outcome.unconfirmed)}
							onDismiss={(key) =>
								setOutcomes((held) => {
									const { [key]: _removed, ...unconfirmed } =
										held[target].unconfirmed;
									return {
										...held,
										[target]: { ...held[target], unconfirmed },
									};
								})
							}
						/>
					</section>
				))}
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
createRoot(root).render(<App />);
