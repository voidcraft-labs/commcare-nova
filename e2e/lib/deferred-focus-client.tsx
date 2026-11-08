import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useClearedSlotFocus } from "@/lib/ui/hooks/useClearedSlotFocus";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";
import { useRemovedRowFocus } from "@/lib/ui/hooks/useRemovedRowFocus";

function Handoffs() {
	const deferFocus = useDeferredFocus();
	const [rows, setRows] = useState(["First", "Second"]);
	const rowFocus = useRemovedRowFocus(rows.length);
	const [slot, setSlot] = useState<string | undefined>("Value");
	const clearedFocus = useClearedSlotFocus(slot);
	return (
		<section>
			<button
				type="button"
				onClick={() =>
					deferFocus(() =>
						document.querySelector<HTMLInputElement>("#target")?.focus(),
					)
				}
			>
				Schedule focus
			</button>
			<button
				type="button"
				onClick={() =>
					deferFocus(() =>
						document.querySelector<HTMLInputElement>("#newest")?.focus(),
					)
				}
			>
				Replace focus
			</button>
			{rows.map((row, index) => (
				<button
					key={row}
					type="button"
					ref={rowFocus.register(index)}
					onClick={() => {
						rowFocus.onRemoved(index);
						setRows(rows.filter((value) => value !== row));
					}}
				>
					Remove {row}
				</button>
			))}
			<button ref={rowFocus.addRef} type="button">
				Add row
			</button>
			{slot === undefined ? (
				<button ref={clearedFocus.addRef} type="button">
					Add slot
				</button>
			) : (
				<button
					type="button"
					onClick={() => {
						clearedFocus.onCleared();
						setSlot(undefined);
					}}
				>
					Clear slot
				</button>
			)}
		</section>
	);
}
function App() {
	const [mounted, setMounted] = useState(true);
	return (
		<>
			<input id="target" aria-label="Target" />
			<input id="newest" aria-label="Newest" />
			<input aria-label="Other" />
			<button type="button" onClick={() => setMounted(false)}>
				Unmount
			</button>
			{mounted && <Handoffs />}
		</>
	);
}
const root = document.getElementById("root");
if (root === null) throw new Error("Missing peer root");
createRoot(root).render(<App />);
