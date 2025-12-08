import prisma from '../services/prisma.js';
import 'dotenv/config';

/**
 * Update Shop Access Token
 *
 * This script updates the Shopify access token in the database.
 * Run this after getting the full access token from Debug Information.
 *
 * Usage:
 *   node scripts/update-shop-access-token.js
 */

async function updateAccessToken() {
  try {
    const shopDomain =
      process.env.SHOPIFY_SHOP_DOMAIN || 'sms-blossom-dev.myshopify.com';
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!accessToken) {
      console.error(
        '❌ ERROR: SHOPIFY_ACCESS_TOKEN not found in environment variables'
      );
      console.log('\n📋 Steps to fix:');
      console.log('1. Get full access token from Shopify Debug Information');
      console.log('2. Add to .env file:');
      console.log('   SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxx');
      console.log('3. Run this script again');
      process.exit(1);
    }

    if (accessToken === 'pending' || accessToken.length < 20) {
      console.error('❌ ERROR: Invalid access token');
      console.log('Access token must be the full token from Debug Information');
      console.log('It should start with "shpat_" and be ~50+ characters');
      process.exit(1);
    }

    console.log('🔍 Checking if shop exists...');
    console.log(`Shop Domain: ${shopDomain}`);

    // Check if shop exists
    let shop = await prisma.shop.findUnique({
      where: { shopDomain },
    });

    if (!shop) {
      console.log('📝 Shop not found. Creating new shop record...');
      shop = await prisma.shop.create({
        data: {
          shopDomain,
          accessToken,
          credits: 100, // Initial credits for testing
          isActive: true,
        },
      });
      console.log('✅ Shop created successfully!');
    } else {
      console.log('📝 Shop found. Updating access token...');
      shop = await prisma.shop.update({
        where: { shopDomain },
        data: {
          accessToken,
          isActive: true,
        },
      });
      console.log('✅ Access token updated successfully!');
    }

    console.log('\n📊 Shop Details:');
    console.log('- ID:', shop.id);
    console.log('- Domain:', shop.shopDomain);
    console.log(
      '- Access Token:',
      `${shop.accessToken.substring(0, 10)}...${shop.accessToken.slice(-4)}`
    );
    console.log('- Credits:', shop.credits);
    console.log('- Active:', shop.isActive);

    console.log('\n✨ Done! You can now use the Shopify API endpoints.');
    console.log('\n🧪 Test with:');
    console.log('  curl http://localhost:3000/discounts \\');
    console.log(`    -H "X-Shopify-Shop-Domain: ${shopDomain}"`);
  } catch (error) {
    console.error('❌ Error updating access token:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

updateAccessToken();
