# Stage 1: Build
FROM node:22-slim AS builder

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y openssl

WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

COPY . .
RUN npm run build

# Stage 2: Run
FROM node:22-slim AS runner

RUN apt-get update && apt-get install -y openssl
WORKDIR /app

# Copy only what's needed to run
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Command to run the server
CMD ["npm", "start"]
