# Astronote Shopify Backend

**Astronote - Shopify SMS Marketing Extension Backend**

Production-ready backend API for Astronote Shopify SMS marketing extension with multi-tenant architecture.

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- PostgreSQL database
- Redis instance
- Shopify Partner account with API credentials
- Stripe account for payment processing
- Mitto account for SMS delivery

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your production configuration

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# Test Redis connection
npm run test:redis

# Setup Shopify access token
npm run setup:shop

# Start server
npm start
```

## 🔧 Environment Variables

**Required:**

- `DATABASE_URL` - PostgreSQL connection string
- `SHOPIFY_API_KEY` - Shopify API key
- `SHOPIFY_API_SECRET` - Shopify API secret
- `STRIPE_SECRET_KEY` - Stripe secret key
- `MITTO_API_KEY` - Mitto SMS API key
- `MITTO_API_BASE` - Mitto API base URL
- `MITTO_TRAFFIC_ACCOUNT_ID` - Mitto traffic account ID
- `REDIS_HOST` - Redis host
- `REDIS_PORT` - Redis port
- `REDIS_USERNAME` - Redis username
- `REDIS_PASSWORD` - Redis password

## 🏗️ Architecture

- **Multi-tenant:** Each Shopify store is a separate tenant with complete data isolation
- **Store Resolution:** Automatic store detection from `X-Shopify-Shop-Domain` header
- **Database:** PostgreSQL with Prisma ORM
- **Caching:** Redis for performance optimization
- **Queue:** BullMQ for background job processing
- **SMS Provider:** Mitto for reliable SMS delivery
- **Payments:** Stripe for credit purchases

## 📡 API Endpoints

All store-scoped endpoints require the `X-Shopify-Shop-Domain` header.

### Core Endpoints

- `GET /` - API status and info
- `GET /health` - Health check
- `GET /health/full` - Comprehensive health check
- `GET /metrics` - Application metrics

### Main Features

- **Dashboard** - Overview and statistics
- **Contacts** - Customer contact management with GDPR-compliant opt-in/opt-out
- **Campaigns** - SMS campaign creation, scheduling, and management
- **Automations** - Automated SMS triggers (welcome, birthday, abandoned cart, order confirmations)
- **Templates** - Pre-built SMS message templates
- **Reports** - Analytics and performance reports
- **Billing** - Credit management and purchase via Stripe
- **Settings** - Store configuration and sender number management

## 🔌 API Testing with Postman

Import the provided Postman collection and environment:

1. Import `Sendly_Backend_API.postman_collection.json`
2. Import `Sendly_Dev_Store.postman_environment.json`
3. Update the `shopify_access_token` in the environment with your store's access token
4. Select the "Sendly Dev Store" environment
5. Start making requests!

**Note:** Most endpoints require the `X-Shopify-Shop-Domain` header, which is automatically included using the `{{shopDomain}}` variable.

## 📦 Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with auto-reload
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint errors automatically
- `npm run format` - Format code with Prettier
- `npm run db:generate` - Generate Prisma client
- `npm run db:migrate` - Run database migrations (production)
- `npm run db:migrate:dev` - Run database migrations (development)
- `npm run db:studio` - Open Prisma Studio
- `npm run db:status` - Check migration status

## 🔐 Security Features

- Environment variable validation on startup
- Rate limiting on all endpoints
- Input validation using express-validator
- Request sanitization
- CORS properly configured
- Security headers via Helmet
- SQL injection protection via Prisma
- XSS protection
- Request size limits

## 🚀 Production Deployment

### Pre-Deployment Checklist

- [ ] All environment variables configured
- [ ] Database migrations applied (`npm run db:migrate`)
- [ ] Redis connection tested (`npm run test:redis`)
- [ ] Health check endpoint verified (`GET /health`)
- [ ] Shopify API credentials configured
- [ ] Stripe webhook endpoints configured
- [ ] Mitto SMS credentials configured

### Render.com (Recommended)

1. Connect your GitHub repository to Render
2. Configure all environment variables in Render dashboard
3. Set build command: `npm install && npm run db:generate`
4. Set start command: `npm start`
5. Deploy automatically on push to `production-ready` branch

The `render.yaml` file contains the deployment configuration.

**Important:** Ensure the following environment variables are set in Render:

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD` - Redis configuration
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` - Shopify credentials
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` - Stripe configuration
- `MITTO_API_KEY`, `MITTO_API_BASE`, `MITTO_TRAFFIC_ACCOUNT_ID` - Mitto SMS configuration
- `HOST` - Backend URL (e.g., `https://astronote-shopify-backend.onrender.com`)
- `ALLOWED_ORIGINS` - Comma-separated list of allowed frontend origins

### Manual Deployment

1. Set all required environment variables (see `env.example`)
2. Run `npm run db:generate` to generate Prisma client
3. Run `npm run db:migrate` to apply migrations
4. Test Redis connection: `npm run test:redis`
5. Start server with `npm start`
6. Verify health: `GET /health` and `GET /health/full`

### Database Setup

```bash
# Generate Prisma client
npm run db:generate

# Check migration status
npm run db:status

# Run migrations (production)
npm run db:migrate

# Or push schema to database (dev only)
npm run db:push
```

### Post-Deployment Verification

1. Check server logs for successful startup
2. Verify health endpoint: `GET /health`
3. Test API endpoints with Postman collection
4. Verify scheduled campaigns processor is running (check logs)
5. Test automation triggers are working
6. Verify SMS sending functionality

## 🏪 Shopify Integration

### Store Connection

1. Install the Shopify extension on your store
2. During installation, the app will:
   - Create a Shop record in the database
   - Store the access token securely
   - Initialize default automations and settings
3. All API requests must include the store domain header

### Multi-Store Support

The backend supports multiple Shopify stores:

- Each store has isolated data
- Store context is resolved from the `X-Shopify-Shop-Domain` header
- Automatic store creation on first request

## 💳 Billing System

The app uses a credit-based billing system:

- Credits are purchased via Stripe
- Available packages: 1,000 / 5,000 / 10,000 / 25,000 credits
- Each SMS costs 1 credit
- Automatic credit deduction on SMS send
- Transaction history tracking

## 🤖 Background Jobs

BullMQ handles background processing:

- **SMS Sending Queue** - Processes campaign and automation SMS messages
- **Automation Triggers** - Event-based automation execution (order placed, fulfilled, etc.)
- **Scheduled Campaigns** - Processes campaigns scheduled for future delivery
- **Delivery Status Tracking** - Periodic updates of SMS delivery status from Mitto
- **Birthday Automation Scheduler** - Daily check for customer birthdays (runs at midnight UTC)

## 📊 Monitoring

- **Winston Logging** - Structured logging to console and files (`logs/` directory)
- **Metrics Endpoint** - `GET /metrics` for Prometheus integration
- **Request Performance** - Automatic request timing and logging
- **Error Tracking** - Comprehensive error logging with stack traces
- **Health Checks** - `GET /health` (basic) and `GET /health/full` (comprehensive)

### Log Files

- `logs/app.log` - General application logs
- `logs/error.log` - Error logs only
- `logs/debug.log` - Debug logs (when LOG_LEVEL=debug)

## 🐛 Troubleshooting

### Server won't start

- Check environment variables are set correctly (`npm run` will validate on startup)
- Verify database connection (check `DATABASE_URL` format)
- Ensure Redis is accessible (test with `npm run test:redis`)
- Check logs in `logs/` directory for specific errors
- Verify all required environment variables are present

### SMS not sending

- Verify Mitto API credentials (`MITTO_API_KEY`, `MITTO_TRAFFIC_ACCOUNT_ID`)
- Check sufficient credit balance in database
- Review error logs in `logs/error.log`
- Verify phone number format (must be E.164: `+1234567890`)
- Check queue worker is running (should see logs on startup)

### Automation not triggering

- Verify automation status is `active`
- Check event poller is running (check startup logs)
- Review automation trigger configuration
- Check birthday scheduler is running (runs daily at midnight UTC)
- Verify Shopify webhooks are registered

### Database issues

- Run `npm run db:status` to check migration status
- Run `npm run db:migrate` to apply pending migrations
- Check `DATABASE_URL` format (must include connection pooling for production)
- Verify database is accessible from deployment environment

### Scheduled campaigns not executing

- Verify scheduler is started (check logs for "Scheduled campaigns processor started")
- Check campaign `scheduleAt` is in UTC format
- Verify campaign status is `scheduled`
- Check queue worker is running
- Review scheduler logs for errors

## 📝 License

ISC

## 👤 Author

Konstantinos Pechlivanidis

## 🔗 Links

- Production URL: https://astronote-shopify-backend.onrender.com
- Frontend URL: https://astronote-shopify-frontend.onrender.com
- Repository: https://github.com/Konstantinos-Pechlivanidis/astronote-shopify-backend

---

**Status:** Production Ready ✅
