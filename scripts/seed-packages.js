import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';

/**
 * Seed initial credit packages
 * This script creates the default packages in the database
 */

const packages = [
  {
    name: '1,000 SMS Credits',
    units: 1000,
    priceCents: 2999, // €29.99
    active: true,
    stripePriceIdEur: process.env.STRIPE_PRICE_ID_1000_EUR || null,
    stripePriceIdUsd: process.env.STRIPE_PRICE_ID_1000_USD || null,
  },
  {
    name: '5,000 SMS Credits',
    units: 5000,
    priceCents: 12999, // €129.99
    active: true,
    stripePriceIdEur: process.env.STRIPE_PRICE_ID_5000_EUR || null,
    stripePriceIdUsd: process.env.STRIPE_PRICE_ID_5000_USD || null,
  },
  {
    name: '10,000 SMS Credits',
    units: 10000,
    priceCents: 22999, // €229.99
    active: true,
    stripePriceIdEur: process.env.STRIPE_PRICE_ID_10000_EUR || null,
    stripePriceIdUsd: process.env.STRIPE_PRICE_ID_10000_USD || null,
  },
  {
    name: '25,000 SMS Credits',
    units: 25000,
    priceCents: 49999, // €499.99
    active: true,
    stripePriceIdEur: process.env.STRIPE_PRICE_ID_25000_EUR || null,
    stripePriceIdUsd: process.env.STRIPE_PRICE_ID_25000_USD || null,
  },
];

async function seedPackages() {
  try {
    logger.info('Starting package seeding...');

    for (const pkg of packages) {
      const result = await prisma.package.upsert({
        where: { name: pkg.name },
        update: {
          units: pkg.units,
          priceCents: pkg.priceCents,
          active: pkg.active,
          stripePriceIdEur: pkg.stripePriceIdEur,
          stripePriceIdUsd: pkg.stripePriceIdUsd,
        },
        create: pkg,
      });

      logger.info(
        `Package seeded: ${result.name} (${result.units} credits, €${(result.priceCents / 100).toFixed(2)})`
      );
    }

    logger.info('Package seeding completed successfully');
  } catch (error) {
    logger.error('Failed to seed packages', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedPackages()
    .then(() => {
      logger.info('Seed script completed');
      process.exit(0);
    })
    .catch(error => {
      logger.error('Seed script failed', { error: error.message });
      process.exit(1);
    });
}

export default seedPackages;
