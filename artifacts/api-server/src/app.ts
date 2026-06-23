import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './lib/logger.js';
import apiRouter from './routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

app.use('/api', apiRouter);

if (process.env.NODE_ENV === 'production') {
  // In production, Express serves the built frontend from artifacts/terminal/dist/public
  // This means frontend + API + WebSocket all share the same host → WebSocket works correctly
  const staticDir = path.resolve(__dirname, '../../terminal/dist/public');
  app.use(express.static(staticDir));

  // SPA fallback: any non-API route serves index.html
  app.use((_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.json({ name: 'Apex Meme Trader API', status: 'running' }));
}

export default app;
