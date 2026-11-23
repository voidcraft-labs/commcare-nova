// A worker's visible cells and their actual CSS grid positions on the case
// detail or above a form. Scoped to the active surface to distinguish two
// tiles showing the same case with different fields and geometry.
({ surface }) => {
	const container = document.querySelector(
		surface === "form"
			? "#persistent-case-tile"
			: "#case-detail-modal.show .js-detail-content",
	);
	if (!container) return null;
	return {
		expands: !!container.querySelector(".persistent-sticky.formplayer-request"),
		// A zero-width field (a hidden sort field riding the tile) holds its
		// value in a `d-none` wrapper (`tile_item.html`): no worker sees it.
		cells: [...container.querySelectorAll(".box")]
			.filter((cell) => !cell.querySelector(":scope > .d-none"))
			.map((cell) => ({
				// biome-ignore lint/performance/useDomNodeTextContent: a worker reads the rendered text, which hides what CSS hides.
				value: cell.innerText,
				position: getComputedStyle(cell).gridArea,
			})),
	};
};
