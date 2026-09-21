import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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

  // 0. Security headers — CSP allows inline script/style because the frontend
  //    is intentionally a single-file app (index.html carries its own <style>
  //    and <script> blocks). A nonce/hash-based CSP would require a full HTML
  //    refactor; unsafe-inline still blocks external script injection.
  fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false // libsodium WASM needs this off
  });

  // 1. Register CORS support for security
  fastify.register(cors, {
    origin: '*', // Stateless Ed25519-signed API — no cookies, so wildcard is safe
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Identity-Key', 'X-Signature', 'X-Timestamp']
  });

  // 1a. Rate limiting — blunt brute-force attempts on register/login/message
  //     endpoints. Generous ceiling so normal chat traffic never trips it.
  fastify.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute'
  });

  // 2. Serve static files from /public folder
  fastify.register(staticFiles, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
    cacheControl: false,
    etag: false,
    lastModified: false
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
