import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/shadcn/button";
import { AppHeader } from "@/components/ui/AppHeader";

function HeaderFit() {
	const [wide, setWide] = useState(false);
	const [banner, setBanner] = useState(false);
	const [clicks, setClicks] = useState(0);
	return (
		<>
			<AppHeader
				homeLabel="Home"
				markOnly
				center={
					<Button
						style={{ width: wide ? 580 : 260 }}
						onClick={() => setClicks((value) => value + 1)}
					>
						Worker controls
					</Button>
				}
				actions={
					<Button
						style={{ width: 180 }}
						onClick={() => setClicks((value) => value + 1)}
					>
						Document controls
					</Button>
				}
				account={
					<Button
						size="icon"
						aria-label="Account"
						onClick={() => setClicks((value) => value + 1)}
					>
						A
					</Button>
				}
				banner={
					banner ? (
						<Button style={{ width: 360 }}>
							Switch back from impersonation
						</Button>
					) : null
				}
			/>
			<Button onClick={() => setWide((value) => !value)}>
				Change worker control width
			</Button>
			<Button onClick={() => setBanner((value) => !value)}>
				Toggle impersonation banner
			</Button>
			<output aria-label="Control clicks">{clicks}</output>
		</>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<HeaderFit />);
