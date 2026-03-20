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

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ==========================================
// 1. INITIALIZATION & CONFIG
// ==========================================
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const prisma = new PrismaClient();
const fastify = Fastify({ logger: false });

// Redis - Configured to not crash the app if unreachable
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisOptions = {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    if (times > 3) return null; // Stop retrying after 3 attempts
    return Math.min(times * 50, 2000);
  }
};

const pubClient = new Redis(REDIS_URL, redisOptions);
const subClient = pubClient.duplicate();
const stateClient = pubClient.duplicate();

let redisConnected = false;
pubClient.on('ready', () => { redisConnected = true; logger.info('✅ Redis Connected'); });
pubClient.on('error', (err) => { logger.warn(`⚠️ Redis warning: ${err.message}`); });

// ==========================================
// 2. MIDDLEWARES & PLUGINS
// ==========================================
fastify.register(cors, { origin: '*' });
fastify.register(helmet);
fastify.register(jwt, { secret: process.env.JWT_SECRET || 'super-secret-fallback-do-not-use' });
fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });

fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// ==========================================
// 3. REST API ROUTES (CONTROLLERS)
// ==========================================
const registerSchema = z.object({ 
  email: z.string().email(), 
  password: z.string().min(6), 
  org_id: z.string().uuid().optional() 
});

fastify.post('/auth/register', async (request, reply) => {
  const { email, password, org_id } = registerSchema.parse(request.body);

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) return reply.status(400).send({ error: "Email already registered" });

  const password_hash = await bcrypt.hash(password, 10);

  let finalOrgId = org_id;
  if (!finalOrgId) {
    const org = await prisma.organization.create({ data: { name: 'Personal Workspace' } });
    finalOrgId = org.id;
  }

  const user = await prisma.user.create({
    data: { email, password_hash, org_id: finalOrgId }
  });

  const token = fastify.jwt.sign({ id: user.id });
  return { token, user: { id: user.id, email: user.email } };
});

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

fastify.post('/auth/login', async (request, reply) => {
  const { email, password } = loginSchema.parse(request.body);
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const token = fastify.jwt.sign({ id: user.id });
  return { token, user: { id: user.id, email: user.email } };
});

const createMeetingSchema = z.object({ 
  title: z.string(), 
  type: z.string(), 
  start_time: z.string().datetime(), 
  max_participants: z.number().optional() 
});

fastify.post('/meetings', { preValidation: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as { id: string };
  const data = createMeetingSchema.parse(request.body);

  const host = await prisma.user.findUnique({ where: { id: user.id } });
  if (!host || !host.org_id) return reply.code(400).send({ error: 'User must belong to an organization' });

  const meeting = await prisma.meeting.create({
    data: { ...data, host_id: user.id, org_id: host.org_id, start_time: new Date(data.start_time) }
  });
  return meeting;
});

fastify.post('/meetings/:id/end', { preValidation: [fastify.authenticate] }, async (request, reply) => {
  const user = request.user as { id: string };
  const { id } = request.params as { id: string };

  const meeting = await prisma.meeting.findUnique({ where: { id } });
  if (!meeting) return reply.code(404).send({ error: 'Meeting not found' });
  if (meeting.host_id !== user.id) return reply.code(403).send({ error: 'Only host can end meeting' });

  const updated = await prisma.meeting.update({
    where: { id },
    data: { status: 'ended', end_time: new Date() }
  });

  if (io) {
    io.to(id).emit('meeting-ended');
    io.in(id).disconnectSockets();
  }
  return updated;
});

// App Runner CRITICAL Route
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date() }));

fastify.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'Validation Error', details: error.errors });
  }
  logger.error(error);
  reply.code(error.statusCode || 500).send({ error: error.message || 'Internal Server Error' });
});

// ==========================================
// 4. WEBSOCKET & WEBRTC SIGNALING
// ==========================================
let io: SocketIOServer;

const setupSocket = () => {
  io = new SocketIOServer(fastify.server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // Only use Redis adapter if connected, fallback to memory
    adapter: redisConnected ? createAdapter(pubClient, subClient) : undefined
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error: No token'));
    try {
      const decoded = fastify.jwt.verify<{ id: string }>(token);
      socket.data.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    socket.on('join-meeting', async ({ joinToken, micState, camState }) => {
      try {
        const meeting = await prisma.meeting.findUnique({ where: { join_token: joinToken } });
        if (!meeting || meeting.status === 'ended') throw new Error('Meeting unavailable');

        const roomId = meeting.id;
        socket.join(roomId);
        socket.data.roomId = roomId;

        await prisma.meetingParticipant.create({
          data: { meeting_id: roomId, user_id: socket.data.userId, mic_state: micState, cam_state: camState }
        });

        if (redisConnected) await stateClient.sadd(`meeting:${roomId}:participants`, socket.data.userId);
        
        socket.to(roomId).emit('user-joined', { userId: socket.data.userId, socketId: socket.id });
      } catch (error) {
        socket.emit('error', { message: 'Failed to join meeting' });
      }
    });

    socket.on('webrtc-offer', ({ targetSocketId, offer }) => socket.to(targetSocketId).emit('webrtc-offer', { senderSocketId: socket.id, offer }));
    socket.on('webrtc-answer', ({ targetSocketId, answer }) => socket.to(targetSocketId).emit('webrtc-answer', { senderSocketId: socket.id, answer }));
    socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => socket.to(targetSocketId).emit('webrtc-ice-candidate', { senderSocketId: socket.id, candidate }));

    socket.on('send-message', async ({ content }) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const message = await prisma.chatMessage.create({
        data: { meeting_id: roomId, sender_id: socket.data.userId, content }
      });
      io.to(roomId).emit('chat-message', message);
    });

    socket.on('disconnect', async () => {
      const roomId = socket.data.roomId;
      if (roomId) {
        if (redisConnected) await stateClient.srem(`meeting:${roomId}:participants`, socket.data.userId);
        socket.to(roomId).emit('user-left', { userId: socket.data.userId, socketId: socket.id });
        await prisma.meetingParticipant.updateMany({
          where: { meeting_id: roomId, user_id: socket.data.userId, leave_time: null },
          data: { leave_time: new Date() }
        });
      }
    });
  });
};

// ==========================================
// 5. BOOTSTRAP
// ==========================================
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '8080', 10);
    // Bind fastify first so health checks pass
    await fastify.listen({ port, host: '0.0.0.0' });
    logger.info(`🚀 Server running on http://0.0.0.0:${port}`);
    
    // Setup socket after server binds
    setupSocket();
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

const shutdown = async () => {
  logger.info('Shutting down...');
  await fastify.close();
  await prisma.$disconnect();
  pubClient.quit(); subClient.quit(); stateClient.quit();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
