"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const client_1 = require("@prisma/client");
const socket_io_1 = require("socket.io");
const redis_adapter_1 = require("@socket.io/redis-adapter");
const ioredis_1 = __importDefault(require("ioredis"));
const pino_1 = __importDefault(require("pino"));
const zod_1 = require("zod");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
// ==========================================
// 1. INITIALIZATION & CONFIG
// ==========================================
const logger = (0, pino_1.default)({ level: process.env.LOG_LEVEL || 'info' });
const prisma = new client_1.PrismaClient();
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const pubClient = new ioredis_1.default(REDIS_URL);
const subClient = pubClient.duplicate();
const stateClient = pubClient.duplicate(); // For pure state K/V operations
const fastify = (0, fastify_1.default)({ logger: false }); // Using custom pino instance manually where needed
// ==========================================
// 2. MIDDLEWARES & PLUGINS
// ==========================================
fastify.register(cors_1.default, { origin: '*' }); // Configure properly for production
fastify.register(helmet_1.default);
fastify.register(jwt_1.default, { secret: process.env.JWT_SECRET || 'super-secret-fallback-do-not-use' });
fastify.register(rate_limit_1.default, { max: 100, timeWindow: '1 minute' });
// Decorate request to extract user from JWT
fastify.decorate('authenticate', async (request, reply) => {
    try {
        await request.jwtVerify();
    }
    catch (err) {
        reply.code(401).send({ error: 'Unauthorized' });
    }
});
// ==========================================
// 3. WEBSOCKET & WEBRTC SIGNALING (SOCKET.IO)
// ==========================================
// We attach socket.io to the raw Node HTTP server inside Fastify
const io = new socket_io_1.Server(fastify.server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    adapter: (0, redis_adapter_1.createAdapter)(pubClient, subClient) // Critical for multi-instance scaling on App Runner
});
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token)
        return next(new Error('Authentication error'));
    try {
        const decoded = fastify.jwt.verify(token);
        socket.data.userId = decoded.id;
        next();
    }
    catch (err) {
        next(new Error('Authentication error'));
    }
});
io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (User: ${socket.data.userId})`);
    socket.on('join-meeting', async ({ joinToken, micState, camState }) => {
        try {
            const meeting = await prisma.meeting.findUnique({ where: { join_token: joinToken } });
            if (!meeting || meeting.status === 'ended')
                throw new Error('Meeting unavailable');
            const roomId = meeting.id;
            socket.join(roomId);
            socket.data.roomId = roomId;
            // Track participant in Postgres
            const participant = await prisma.meetingParticipant.create({
                data: { meeting_id: roomId, user_id: socket.data.userId, mic_state: micState, cam_state: camState }
            });
            // Track presence in Redis (Fast lookups)
            await stateClient.sadd(`meeting:${roomId}:participants`, socket.data.userId);
            // Notify others in room
            socket.to(roomId).emit('user-joined', { userId: socket.data.userId, socketId: socket.id });
            logger.info(`User ${socket.data.userId} joined meeting ${roomId}`);
        }
        catch (error) {
            socket.emit('error', { message: 'Failed to join meeting' });
        }
    });
    // WebRTC Signaling: Forwarding offers, answers, and ICE candidates
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
        if (!roomId)
            return;
        const message = await prisma.chatMessage.create({
            data: { meeting_id: roomId, sender_id: socket.data.userId, content }
        });
        io.to(roomId).emit('chat-message', message);
    });
    socket.on('disconnect', async () => {
        const roomId = socket.data.roomId;
        if (roomId) {
            await stateClient.srem(`meeting:${roomId}:participants`, socket.data.userId);
            socket.to(roomId).emit('user-left', { userId: socket.data.userId, socketId: socket.id });
            // Update DB leaving time
            await prisma.meetingParticipant.updateMany({
                where: { meeting_id: roomId, user_id: socket.data.userId, leave_time: null },
                data: { leave_time: new Date() }
            });
        }
        logger.info(`Socket disconnected: ${socket.id}`);
    });
});
// ==========================================
// 4. REST API ROUTES (CONTROLLERS)
// ==========================================
// --- Auth Routes ---
const registerSchema = zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string().min(6), org_id: zod_1.z.string().uuid().optional() });
fastify.post('/auth/register', async (request, reply) => {
    const { email, password, org_id } = registerSchema.parse(request.body);
    const password_hash = await bcryptjs_1.default.hash(password, 10);
    // Default org creation logic if none provided
    let finalOrgId = org_id;
    if (!finalOrgId) {
        const org = await prisma.organization.create({ data: { name: 'Personal Workspace' } });
        finalOrgId = org.id;
    }
    const user = await prisma.user.create({ data: { email, password_hash, org_id: finalOrgId } });
    const token = fastify.jwt.sign({ id: user.id });
    return { token, user: { id: user.id, email: user.email } };
});
const loginSchema = zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string() });
fastify.post('/auth/login', async (request, reply) => {
    const { email, password } = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password_hash || !(await bcryptjs_1.default.compare(password, user.password_hash))) {
        return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const token = fastify.jwt.sign({ id: user.id });
    return { token, user: { id: user.id, email: user.email } };
});
// --- Meeting Routes ---
const createMeetingSchema = zod_1.z.object({ title: zod_1.z.string(), type: zod_1.z.string(), start_time: zod_1.z.string().datetime(), max_participants: zod_1.z.number().optional() });
fastify.post('/meetings', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user;
    const data = createMeetingSchema.parse(request.body);
    const host = await prisma.user.findUnique({ where: { id: user.id } });
    if (!host || !host.org_id)
        return reply.code(400).send({ error: 'User must belong to an organization' });
    const meeting = await prisma.meeting.create({
        data: { ...data, host_id: user.id, org_id: host.org_id, start_time: new Date(data.start_time) }
    });
    return meeting;
});
fastify.post('/meetings/:id/end', { preValidation: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user;
    const { id } = request.params;
    const meeting = await prisma.meeting.findUnique({ where: { id } });
    if (!meeting)
        return reply.code(404).send({ error: 'Meeting not found' });
    if (meeting.host_id !== user.id)
        return reply.code(403).send({ error: 'Only host can end meeting' });
    const updated = await prisma.meeting.update({
        where: { id },
        data: { status: 'ended', end_time: new Date() }
    });
    // Kick everyone out via WebSockets
    io.to(id).emit('meeting-ended');
    io.in(id).disconnectSockets();
    return updated;
});
// Health check
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date() }));
// Global error handler mapping Zod errors
fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof zod_1.z.ZodError) {
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
        // AWS App Runner sets the PORT environment variable. Defaults to 8080.
        const port = parseInt(process.env.PORT || '8080', 10);
        // Bind to '0.0.0.0' for Docker/App Runner container networking
        await fastify.listen({ port, host: '0.0.0.0' });
        logger.info(`🚀 Server running on http://0.0.0.0:${port}`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
// Graceful shutdown
const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    await fastify.close();
    await prisma.$disconnect();
    pubClient.quit();
    subClient.quit();
    stateClient.quit();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
start();
