#!/bin/bash
set -e

echo "🚀 Starting application..."
echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"

# Validate environment variables
if [ -z "$DATABASE_URL" ]; then
  echo "❌ ERROR: DATABASE_URL environment variable not set"
  exit 1
fi

echo "✅ Environment variables validated"

# Optional: Run Prisma migrations
echo "Running database migrations..."
npx prisma migrate deploy || echo "ℹ️  Migrations already applied or skipped"

# Start the server
echo "Starting server..."
exec npm start
