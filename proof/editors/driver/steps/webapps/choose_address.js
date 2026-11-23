// The worker chooses the address returned by the real geocoder widget.
(name) => {
	const buttons = document.querySelectorAll(
		"#webforms .mapboxgl-ctrl-geocoder ul.suggestions li a",
	);
	const choice = [...buttons].find((item) =>
		item.textContent.trim().includes(name.split(",")[0]),
	);
	if (!choice) return false;
	// The pinned suggestions control selects on mouseup. Its mousedown
	// keeps the menu open when the text input loses focus.
	choice.dispatchEvent(
		new MouseEvent("mousedown", { bubbles: true, button: 0 }),
	);
	choice.closest(".mapboxgl-ctrl-geocoder").querySelector("input").blur();
	choice.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
	return true;
};
