# Stage 1: Build
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y openssl

WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies including devDeps for build
RUN npm ci

# Generate Prisma client BEFORE building code
RUN npx prisma generate

COPY . .
RUN npm run build

# Stage 2: Run
FROM node:22-slim AS runner

# Essential for Prisma to run on slim images
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production dependencies and the generated client
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Use node directly to run the compiled JS in dist
CMD ["node", "dist/server.js"]
