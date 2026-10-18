import os from 'node:os';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import postsRoutes from './routes/posts.routes.js';
import stressRoutes from './routes/stress.routes.js';


export const app = express();

// Behind Nginx (Phase 3) or a load balancer (Phase 5) there is exactly one proxy hop.
// This makes req.ip and req.protocol reflect the real client.
if (env.nodeEnv === 'production') app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '100kb' }));

// Deliberately does NOT touch the database: if it did, an Atlas hiccup would make the
// load balancer pull every server out of rotation at once.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', host: os.hostname(), uptime: Math.round(process.uptime()) });
});

app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
if (env.enableStress) app.use('/stress',stressRoutes);
// Order matters: 404 handler, then the error handler, both LAST.
app.use(notFound);
app.use(errorHandler);
