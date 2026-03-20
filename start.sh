#!/bin/bash
set -e

echo "Starting application..."
echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"

# Optional: Run Prisma migrations
echo "Running database migrations..."
npx prisma migrate deploy || echo "Migrations already applied or skipped"

# Start the server
echo "Starting server..."
exec npm start
