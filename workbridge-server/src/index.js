import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/users.routes.js';
import projectRoutes from './routes/projects.routes.js';
import applicationRoutes from './routes/applications.routes.js';
import contractRoutes from './routes/contracts.routes.js';
import paymentRoutes from './routes/payments.routes.js';
import reviewRoutes from './routes/reviews.routes.js';
import notificationRoutes from './routes/notifications.routes.js';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();

const isProduction = process.env.NODE_ENV === 'production';

const parseOrigins = (value) => (value || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const allowedOrigins = new Set([
  ...parseOrigins(process.env.CLIENT_URL),
  ...parseOrigins(process.env.CORS_ORIGINS),
  ...(!isProduction ? ['http://localhost:3000'] : []),
]);

const hasAllowedOrigins = allowedOrigins.size > 0;

if (isProduction && !hasAllowedOrigins) {
  console.warn('CLIENT_URL or CORS_ORIGINS must be set for browser CORS requests.');
}

app.use(cors({
  origin(origin, callback) {
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

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects', applicationRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/notifications', notificationRoutes);

app.use(errorHandler);

if (!isProduction) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
