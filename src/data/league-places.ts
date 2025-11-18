import { createServerFn } from "@tanstack/react-start";

export const getLeaguePlaces = createServerFn({
	method: "GET",
}).handler(async () => [
	{ id: 1, record: [10, 0], user: "Wheatus" },
	{ id: 2, record: [9, 1], user: "Nirvana" },
	{ id: 3, record: [8, 2], user: "Jimmy Eat World" },
	{ id: 4, record: [7, 3], user: "Lit" },
	{ id: 5, record: [6, 4], user: "Sum 41" },
	{ id: 6, record: [5, 5], user: "blink-182" },
	{ id: 7, record: [4, 6], user: "Weezer" },
	{ id: 8, record: [3, 7], user: "Green Day" },
	{ id: 9, record: [2, 8], user: "Foo Fighters" },
	{ id: 10, record: [1, 9], user: "Red Hot Chili Peppers" },
	{ id: 11, record: [0, 10], user: "Linkin Park" },
]);
