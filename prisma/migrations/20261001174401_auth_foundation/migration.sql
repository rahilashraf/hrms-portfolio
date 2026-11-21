-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED', 'LOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AccountTokenType" AS ENUM ('INVITATION', 'EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateTable
CREATE TABLE "Person" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "passwordChangedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "previousTokenValidUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AccountTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_personId_key" ON "User"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_revokedAt_expiresAt_idx" ON "AuthSession"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountToken_userId_type_expiresAt_idx" ON "AccountToken"("userId", "type", "expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_occurredAt_idx" ON "AuditLog"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_occurredAt_idx" ON "AuditLog"("entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
