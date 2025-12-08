import { PrismaClient } from '@prisma/client';

// Configure Prisma with connection pooling for production
const prismaOptions = {
  log:
    process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  errorFormat: 'pretty',
};

// Add connection pool configuration for production (Render.com, etc.)
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('pooler')) {
  // If using a connection pooler, configure accordingly
  prismaOptions.datasources = {
    db: {
      url: process.env.DATABASE_URL,
    },
  };
}

const prisma = global.__prisma || new PrismaClient(prismaOptions);

if (!global.__prisma) {
  global.__prisma = prisma;

  // Handle graceful shutdown
  process.on('beforeExit', async () => {
    await prisma.$disconnect();
  });
}

export default prisma;
