import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { db: PrismaClient };
const isDevWithoutDatabaseUrl =
  process.env.NODE_ENV === "development" && !process.env.DATABASE_URL;

const prismaClient =
  !isDevWithoutDatabaseUrl &&
  (globalForPrisma.db ||
    new PrismaClient({
      log: ["error", "warn"], // optional: add "query" for debugging
    }));

if (process.env.NODE_ENV !== "production" && prismaClient) {
  globalForPrisma.db = prismaClient;
}

const devFallbackDb = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "Prisma database access is disabled in development because DATABASE_URL is missing.",
      );
    },
  },
) as PrismaClient;

// TEMPORARY DEVELOPMENT FALLBACK:
// In local development only, when DATABASE_URL is missing, expose a safe stub so
// API modules can load without crashing. Production behavior is unchanged.
export const db = prismaClient || devFallbackDb;
