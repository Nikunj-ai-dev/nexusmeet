// src/server.ts
import 'dotenv/config';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import cookie from '@fastify/cookie';


declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
const requiredEnvVars = ['DATABASE_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Exiting...');
  process.exit(1);
}

// ==========================================
// SAFE PRISMA INITIALIZATION
// ==========================================
let prisma: PrismaClient | null = null;

const initializePrisma = async (): Promise<boolean> => {
  try {
    prisma = new PrismaClient();
    
    // Test connection
    await prisma.$queryRaw`SELECT 1`;
    logger.info('✅ Database connected successfully');
    return true;
  } catch (error) {
    logger.error(`❌ Database connection failed: ${error}`);
    return false;
  }
};

// ... rest of your code

// Update the start function:
const start = async () => {
  try {
    // 1. Initialize database first
    logger.info('Initializing database...');
    const dbConnected = await initializePrisma();
    
    if (!dbConnected) {
      logger.error('❌ Failed to connect to database. Exiting...');
      process.exit(1);
    }

    // 2. Initialize Redis (non-blocking)
    logger.info('Initializing Redis connection...');
    await initializeRedis();

    if (redisConnected) {
      logger.info('✅ Redis connection established');
    } else {
      logger.warn('⚠️  Redis not available - operating in memory mode');
    }

    // 3. Initialize Socket.IO after Redis
    initializeSocketIO();

    // 4. Start Fastify server
    const port = parseInt(process.env.PORT || '8080', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    logger.info(`🚀 Server running on http://0.0.0.0:${port}`);
  } catch (err) {
    logger.error('Fatal error during startup:', err);
    process.exit(1);
  }
};
// ==========================================
// 1. INITIALIZATION & CONFIG
// ==========================================
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const prisma = new PrismaClient();

// Initialize Redis with error handling
let pubClient: Redis;
let subClient: Redis;
let stateClient: Redis;
let redisConnected = false;

const initializeRedis = async (): Promise<boolean> => {
  try {
    const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
    
    pubClient = new Redis(REDIS_URL, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        logger.warn(`Redis reconnecting attempt ${times}, retrying in ${delay}ms`);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      enableOfflineQueue: false,
    });
    
    subClient = pubClient.duplicate();
    stateClient = pubClient.duplicate();

    // Handle connection events
    pubClient.on('error', (err) => {
      logger.warn(`Redis connection error: ${err.message}`);
      redisConnected = false;
    });

    pubClient.on('connect', () => {
      logger.info('Redis connected successfully');
      redisConnected = true;
    });

    pubClient.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
    });

    // Wait for initial connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.warn('Redis connection timeout - continuing without Redis');
        resolve();
      }, 5000);

      pubClient.on('ready', () => {
        clearTimeout(timeout);
        redisConnected = true;
        resolve();
      });

      pubClient.on('error', (err) => {
        clearTimeout(timeout);
        logger.warn(`Redis initial connection failed: ${err.message}`);
        resolve(); // Continue without Redis
      });
    });

    return redisConnected;
  } catch (error) {
    logger.error(`Failed to initialize Redis: ${error}`);
    return false;
  }
};

const fastify = Fastify({ logger: false });

fastify.register(cookie, {
  secret: 'some-secret',
});

// ==========================================
// 2. MIDDLEWARES & PLUGINS
// ==========================================
fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || "https://nexusmeet-1--nikunja512.replit.app",
  credentials: true
});

fastify.register(helmet);
fastify.register(jwt, { secret: process.env.JWT_SECRET || 'super-secret-fallback-do-not-use' });
fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });

// Decorate request to extract user from JWT
fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// ==========================================
// 3. WEBSOCKET & WEBRTC SIGNALING (SOCKET.IO)
// ==========================================
let io: SocketIOServer;

const initializeSocketIO = () => {
  io = new SocketIOServer(fastify.server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    adapter: redisConnected ? createAdapter(pubClient, subClient) : undefined
  });

  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;

      if (!cookieHeader) {
        return next(new Error("No cookie"));
      }

      const token = cookieHeader
        .split("; ")
        .find(row => row.startsWith("token="))
        ?.split("=")[1];

      if (!token) {
        return next(new Error("No token"));
      }

      const decoded = fastify.jwt.verify<{ id: string }>(token);
      socket.data.userId = decoded.id;

      next();
    } catch (err) {
      next(new Error("Authentication error"));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (User: ${socket.data.userId})`);

    socket.on('join-meeting', async ({ joinToken, micState, camState }) => {
      try {
        const meeting = await prisma.meeting.findUnique({ where: { join_token: joinToken } });
        if (!meeting || meeting.status === 'ended') throw new Error('Meeting unavailable');

        const roomId = meeting.id;
        socket.join(roomId);
        socket.data.roomId = roomId;

        // Track participant in Postgres
        const participant = await prisma.meetingParticipant.create({
          data: { meeting_id: roomId, user_id: socket.data.userId, mic_state: micState, cam_state: camState }
        });

        // Track presence in Redis if connected
        if (redisConnected && stateClient) {
          await stateClient.sadd(`meeting:${roomId}:participants`, socket.data.userId).catch((err) => {
            logger.warn(`Failed to track participant in Redis: ${err.message}`);
          });
        }

        // Notify others in room
        socket.to(roomId).emit('user-joined', { userId: socket.data.userId, socketId: socket.id });
        logger.info(`User ${socket.data.userId} joined meeting ${roomId}`);
      } catch (error) {
        logger.error(`Join meeting error: ${error}`);
        socket.emit('error', { message: 'Failed to join meeting' });
      }
    });

    // WebRTC Signaling
    socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
      socket.to(targetSocketId).emit('webrtc-offer', { senderSocketId: socket.id, offer });
    });

    socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
      socket.to(targetSocketId).emit('webrtc-answer', { senderSocketId: socket.id, answer });
    });

    socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
      socket.to(targetSocketId).emit('webrtc-ice-candidate', { senderSocketId: socket.id, candidate });
    });

    // Chat implementation
    socket.on('send-message', async ({ content }) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;

      try {
        const message = await prisma.chatMessage.create({
          data: { meeting_id: roomId, sender_id: socket.data.userId, content }
        });

        io.to(roomId).emit('chat-message', message);
      } catch (error) {
        logger.error(`Send message error: ${error}`);
      }
    });

    socket.on('disconnect', async () => {
      const roomId = socket.data.roomId;
      if (roomId) {
        // Remove from Redis if connected
        if (redisConnected && stateClient) {
          await stateClient.srem(`meeting:${roomId}:participants`, socket.data.userId).catch((err) => {
            logger.warn(`Failed to remove participant from Redis: ${err.message}`);
          });
        }

        socket.to(roomId).emit('user-left', { userId: socket.data.userId, socketId: socket.id });

        // Update DB leaving time
        try {
          await prisma.meetingParticipant.updateMany({
            where: { meeting_id: roomId, user_id: socket.data.userId, leave_time: null },
            data: { leave_time: new Date() }
          });
        } catch (error) {
          logger.error(`Update participant leave time error: ${error}`);
        }
      }
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });
};

// ==========================================
// 4. REST API ROUTES (CONTROLLERS)
// ==========================================

// --- Auth Routes ---
const registerSchema = z.object({ 
  email: z.string().email(), 
  password: z.string().min(6), 
  org_id: z.string().uuid().optional() 
});

fastify.post('/auth/register', async (request, reply) => {
  try {
    const { email, password, org_id } = registerSchema.parse(request.body);

    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return reply.status(400).send({ error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    let finalOrgId = org_id;
    if (!finalOrgId) {
      const org = await prisma.organization.create({
        data: { name: 'Personal Workspace' }
      });
      finalOrgId = org.id;
    }

    const user = await prisma.user.create({
      data: {
        email,
        password_hash,
        org_id: finalOrgId
      }
    });

    const token = fastify.jwt.sign({ id: user.id });

    return reply
      .setCookie("token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
      })
      .send({
        user: { id: user.id, email: user.email }
      });
  } catch (error) {
    logger.error(`Register error: ${error}`);
    return reply.code(500).send({ error: 'Registration failed' });
  }
});

const loginSchema = z.object({ 
  email: z.string().email(), 
  password: z.string() 
});

fastify.post('/auth/login', async (request, reply) => {
  try {
    const { email, password } = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = fastify.jwt.sign({ id: user.id });

    return reply
      .setCookie("token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
      })
      .send({
        user: { id: user.id, email: user.email }
      });
  } catch (error) {
    logger.error(`Login error: ${error}`);
    return reply.code(500).send({ error: 'Login failed' });
  }
});

// --- Meeting Routes ---
const createMeetingSchema = z.object({ 
  title: z.string(), 
  type: z.string(), 
  start_time: z.string().datetime(), 
  max_participants: z.number().optional() 
});

fastify.post('/meetings', { preValidation: [fastify.authenticate] }, async (request, reply) => {
  try {
    const user = request.user as { id: string };
    const data = createMeetingSchema.parse(request.body);

    const host = await prisma.user.findUnique({ where: { id: user.id } });
    if (!host || !host.org_id) return reply.code(400).send({ error: 'User must belong to an organization' });

    const meeting = await prisma.meeting.create({
      data: { ...data, host_id: user.id, org_id: host.org_id, start_time: new Date(data.start_time) }
    });
    return meeting;
  } catch (error) {
    logger.error(`Create meeting error: ${error}`);
    return reply.code(500).send({ error: 'Failed to create meeting' });
  }
});

fastify.post('/meetings/:id/end', { preValidation: [fastify.authenticate] }, async (request, reply) => {
  try {
    const user = request.user as { id: string };
    const { id } = request.params as { id: string };

    const meeting = await prisma.meeting.findUnique({ where: { id } });
    if (!meeting) return reply.code(404).send({ error: 'Meeting not found' });
    if (meeting.host_id !== user.id) return reply.code(403).send({ error: 'Only host can end meeting' });

    const updated = await prisma.meeting.update({
      where: { id },
      data: { status: 'ended', end_time: new Date() }
    });

    // Kick everyone out via WebSockets
    if (io) {
      io.to(id).emit('meeting-ended');
      io.in(id).disconnectSockets();
    }

    return updated;
  } catch (error) {
    logger.error(`End meeting error: ${error}`);
    return reply.code(500).send({ error: 'Failed to end meeting' });
  }
});

// Health check
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date() }));

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'Validation Error', details: error.errors });
  }
  logger.error(error);
  reply.code(error.statusCode || 500).send({ error: error.message || 'Internal Server Error' });
});

// ==========================================
// 5. BOOTSTRAP
// ==========================================
const start = async () => {
  try {
    // Initialize Redis (non-blocking - continues even if Redis fails)
    logger.info('Initializing Redis connection...');
    await initializeRedis();

    if (redisConnected) {
      logger.info('Redis connection established');
    } else {
      logger.warn('Redis not available - Socket.IO will operate without Redis adapter');
    }

    // Initialize Socket.IO after Redis setup
    initializeSocketIO();

    // Start Fastify server
    const port = parseInt(process.env.PORT || '8080', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    logger.info(`🚀 Server running on http://0.0.0.0:${port}`);
  } catch (err) {
    logger.error('Fatal error during startup:', err);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down gracefully...');
  try {
    await fastify.close();
    await prisma.$disconnect();
    
    if (pubClient) pubClient.quit();
    if (subClient) subClient.quit();
    if (stateClient) stateClient.quit();
    
    logger.info('Server shut down successfully');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  process.exit(1);
});

start();
