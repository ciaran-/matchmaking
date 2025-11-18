import { createServerFn } from '@tanstack/react-start';

export const getLeaguePlaces = createServerFn({
	method: 'GET',
}).handler(async () => [
	{ id: 1, record: [10, 0], user: 'Wheatus', rating: 1800 },
	{ id: 2, record: [9, 1], user: 'Nirvana', rating: 1750 },
	{ id: 3, record: [8, 2], user: 'Jimmy Eat World', rating: 1699 },
	{ id: 4, record: [7, 3], user: 'Lit', rating: 1650 },
	{ id: 5, record: [6, 4], user: 'Sum 41', rating: 1600 },
	{ id: 6, record: [5, 5], user: 'blink-182', rating: 1550 },
	{ id: 7, record: [4, 6], user: 'Weezer', rating: 1500 },
	{ id: 8, record: [3, 7], user: 'Green Day', rating: 1450 },
	{ id: 9, record: [2, 8], user: 'Foo Fighters', rating: 1400 },
	{ id: 10, record: [1, 9], user: 'Red Hot Chili Peppers', rating: 1350 },
	{ id: 11, record: [0, 10], user: 'Linkin Park', rating: 1300 },
]);
