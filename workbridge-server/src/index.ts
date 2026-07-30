// `dotenv/config` must stay the first import. It compiles to a `require()` that runs
// before the ones below it, and `lib/openai.ts` / `middlewares/upload.ts` read
// `process.env` at module-evaluation time — so moving it breaks boot.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env } from './env';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/users.routes';
import projectRoutes from './routes/projects.routes';
import applicationRoutes from './routes/applications.routes';
import contractRoutes from './routes/contracts.routes';
import paymentRoutes from './routes/payments.routes';
import reviewRoutes from './routes/reviews.routes';
import notificationRoutes from './routes/notifications.routes';
import { errorHandler } from './middlewares/errorHandler';

const app = express();

const isProduction = env.isProduction;

const parseOrigins = (value: string | undefined): string[] => (value || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const allowedOrigins = new Set([
  ...parseOrigins(env.CLIENT_URL),
  ...parseOrigins(env.CORS_ORIGINS),
  ...(!isProduction ? ['http://localhost:3000'] : []),
]);

const hasAllowedOrigins = allowedOrigins.size > 0;

if (isProduction && !hasAllowedOrigins) {
  console.warn('CLIENT_URL or CORS_ORIGINS must be set for browser CORS requests.');
}

app.use(cors({
  // `@types/cors` keeps its `CustomOrigin` alias module-local, so these params are
  // annotated inline rather than imported.
  origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.has(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Both `projectRoutes` and `applicationRoutes` mount on `/api/projects`; applications
// live at nested paths (`/:id/applications`). This order is load-bearing.
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects', applicationRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/notifications', notificationRoutes);

app.use(errorHandler);

// Also skipped under test: supertest spins up its own ephemeral server per request, so
// binding a real port here would collide across test files and leave an open handle that
// stops the test process from exiting.
if (!isProduction && env.NODE_ENV !== 'test') {
  // `env.PORT` is a string (defaulted to '4000'); `app.listen` needs the number
  // overload, otherwise a string resolves to the unix-socket-path signature.
  const PORT = Number(env.PORT);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Vercel's `@vercel/node` uses this default export as the serverless handler — an
// Express `app` is itself a `(req, res)` handler, so no wrapper is needed.
export default app;
