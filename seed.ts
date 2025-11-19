import { PrismaClient, Team, GameMode } from '@prisma/client';

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  //
  // --- 1. Create Users (Players) ---
  //
  const players = [
    { username: 'Wheatus', rating: 1800 },
    { username: 'Nirvana', rating: 1750 },
    { username: 'Jimmy Eat World', rating: 1699 },
    { username: 'Lit', rating: 1650 },
    { username: 'Sum 41', rating: 1600 },
    { username: 'blink-182', rating: 1550 },
    { username: 'Weezer', rating: 1500 },
    { username: 'Green Day', rating: 1450 },
    { username: 'Foo Fighters', rating: 1400 },
    { username: 'Red Hot Chili Peppers', rating: 1350 },
    { username: 'Linkin Park', rating: 1300 },
  ];

  // Create all players
  const createdUsers = await Promise.all(
    players.map((p) =>
      prisma.user.create({
        data: {
          email: `${p.username.replace(/\s+/g, '').toLowerCase()}@example.com`,
          username: p.username,
          currentRating: p.rating,
        },
      })
    )
  );

  console.log('✅ Created users');

  //
  // --- 2. Generate 10 rounds of 1v1 game results ---
  //
  // Pair players sequentially: (1 vs 2), (3 vs 4), ...
  const userIds = createdUsers.map((u) => u.id);

  let gameNumber = 1;

  for (let round = 1; round <= 10; round++) {
    console.log(`🎮 Creating games for round ${round}...`);

    for (let i = 0; i < userIds.length - 1; i += 2) {
      const userA = await prisma.user.findUnique({ where: { id: userIds[i] } });
      const userB = await prisma.user.findUnique({ where: { id: userIds[i + 1] } });

      if (!userA || !userB) continue;

      // Pick a random winner
      const teamAWins = Math.random() > 0.5;

      const teamAScore = teamAWins ? 1 : 0;
      const teamBScore = teamAWins ? 0 : 1;

      // Simple rating delta: +10 for winner, -10 for loser
      const winnerDelta = 10;
      const loserDelta = -10;

      const result = await prisma.gameResult.create({
        data: {
          mode: GameMode.ONE_VS_ONE,
          teamAScore,
          teamBScore,
          participants: {
            create: [
              {
                userId: userA.id,
                team: Team.A,
                ratingBefore: userA.currentRating,
                ratingChange: teamAWins ? winnerDelta : loserDelta,
                ratingAfter: userA.currentRating + (teamAWins ? winnerDelta : loserDelta),
              },
              {
                userId: userB.id,
                team: Team.B,
                ratingBefore: userB.currentRating,
                ratingChange: teamAWins ? loserDelta : winnerDelta,
                ratingAfter: userB.currentRating + (teamAWins ? loserDelta : winnerDelta),
              },
            ],
          },
        },
      });

      // Update users' current rating
      await prisma.user.update({
        where: { id: userA.id },
        data: { currentRating: userA.currentRating + (teamAWins ? winnerDelta : loserDelta) },
      });

      await prisma.user.update({
        where: { id: userB.id },
        data: { currentRating: userB.currentRating + (teamAWins ? loserDelta : winnerDelta) },
      });

      console.log(`  ✔️ Game ${gameNumber} created`);
      gameNumber++;
    }
  }

  console.log('🌱 Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })