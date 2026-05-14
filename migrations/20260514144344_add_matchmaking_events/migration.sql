-- CreateEnum
CREATE TYPE "MatchmakingSearchEventType" AS ENUM ('STARTED', 'MATCHED', 'CANCELLED', 'ABANDONED', 'DECLINED', 'EXPIRED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "PendingGameEventType" AS ENUM ('PROPOSED', 'CONFIRMED_BY', 'BOTH_CONFIRMED', 'DECLINED', 'EXPIRED', 'PLAYED');

-- CreateTable
CREATE TABLE "MatchmakingSearchEvent" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "MatchmakingSearchEventType" NOT NULL,
    "rating" INTEGER,
    "matchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchmakingSearchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingGameEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "type" "PendingGameEventType" NOT NULL,
    "playerAId" TEXT,
    "playerBId" TEXT,
    "playerARating" INTEGER,
    "playerBRating" INTEGER,
    "searchAAttemptId" TEXT,
    "searchBAttemptId" TEXT,
    "actingPlayerId" TEXT,
    "gameResultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingGameEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchmakingSearchEvent_attemptId_createdAt_idx" ON "MatchmakingSearchEvent"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "MatchmakingSearchEvent_userId_createdAt_idx" ON "MatchmakingSearchEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MatchmakingSearchEvent_type_createdAt_idx" ON "MatchmakingSearchEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "PendingGameEvent_matchId_createdAt_idx" ON "PendingGameEvent"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "PendingGameEvent_type_createdAt_idx" ON "PendingGameEvent"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "MatchmakingSearchEvent" ADD CONSTRAINT "MatchmakingSearchEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
