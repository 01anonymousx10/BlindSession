import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Route Imports
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import chatRoutes from './routes/chat.js';
import websocketRoutes from './socket/connection.js';

export function buildApp(opts = {}) {
  const fastify = Fastify(opts);

  // 1. Register CORS support for security
  fastify.register(cors, {
    origin: '*', // Adjust for production environments
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Identity-Key', 'X-Signature', 'X-Timestamp']
  });

  // 2. Serve static files from /public folder
  fastify.register(staticFiles, {
    root: join(__dirname, '..', 'public'),
    prefix: '/'
  });

  // 3. Register Native Fastify WebSocket Plugin
  fastify.register(websocket);

  // 3. Register Application API Routes
  fastify.register(authRoutes, { prefix: '/api/auth' });
  fastify.register(userRoutes, { prefix: '/api/users' });
  fastify.register(chatRoutes, { prefix: '/api/chat' });

  // 4. Register WebSocket Routing handler
  fastify.register(websocketRoutes);

  // Health check route
  fastify.get('/health', async (request, reply) => {
    return { status: 'OK', timestamp: new Date().toISOString() };
  });

  return fastify;
}
