# Stage 1: Build
FROM node:22-slim AS builder

# Install OpenSSL and CA certificates required by Prisma
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy configuration and dependency files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

# Install all dependencies (including devDeps for build)
RUN npm ci

# Generate Prisma Client 
# Note: Ensure your schema.prisma 'output' matches where your code imports it
RUN npx prisma generate

# Build TypeScript to JavaScript
RUN npm run build

# Stage 2: Run
FROM node:22-slim AS runner

# Required for Prisma to interact with PostgreSQL in production
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set environment to production
ENV NODE_ENV=production
ENV PORT=8080

# Copy node_modules from builder (includes Prisma engines)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/prisma ./prisma
# Copy the start script and ensure it has execution permissions
COPY --from=builder /app/start.sh ./
RUN chmod +x start.sh

# App Runner listens on this port
EXPOSE 8080

# Health check to prevent App Runner from timing out during deployment
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use the shell script to run migrations BEFORE starting the server
CMD ["./start.sh"]
