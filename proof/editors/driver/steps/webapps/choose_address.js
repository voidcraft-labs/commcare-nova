// The worker chooses the address returned by the real geocoder widget.
(choice) => {
	const name = typeof choice === "string" ? choice : choice.name;
	const scope = typeof choice === "string" ? "#webforms" : "#menu-region";
	const buttons = document.querySelectorAll(
		`${scope} .mapboxgl-ctrl-geocoder ul.suggestions li a`,
	);
	const suggestion = [...buttons].find((item) =>
		item.textContent.trim().includes(name.split(",")[0]),
	);
	if (!suggestion) return false;
	// The pinned suggestions control selects on mouseup. Its mousedown
	// keeps the menu open when the text input loses focus.
	suggestion.dispatchEvent(
		new MouseEvent("mousedown", { bubbles: true, button: 0 }),
	);
	suggestion.closest(".mapboxgl-ctrl-geocoder").querySelector("input").blur();
	suggestion.dispatchEvent(
		new MouseEvent("mouseup", { bubbles: true, button: 0 }),
	);
	return true;
};
