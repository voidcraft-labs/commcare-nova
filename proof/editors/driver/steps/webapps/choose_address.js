// The worker chooses the address returned by the real geocoder widget.
(name) => {
	const buttons = document.querySelectorAll(
		"#webforms .mapboxgl-ctrl-geocoder ul.suggestions li a",
	);
	const choice = [...buttons].find((item) =>
		item.textContent.trim().includes(name.split(",")[0]),
	);
	if (!choice) return false;
	choice.click();
	return true;
};
