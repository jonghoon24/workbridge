import { PrismaClient } from '@prisma/client';

declare global {
  // Reused across dev hot reloads so we don't exhaust the connection pool.
  var prisma: PrismaClient | undefined;
}

const prisma = globalThis.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

export default prisma;
