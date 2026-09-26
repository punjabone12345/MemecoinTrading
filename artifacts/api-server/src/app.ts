import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import apiRouter from './routes/index.js';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

app.use('/api', apiRouter);

// Serve static terminal UI if built
const candidatePaths = [
  path.resolve(process.cwd(), 'artifacts/terminal/dist/public'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../terminal/dist/public'),
];
const staticDir = candidatePaths.find((p) => fs.existsSync(p));

if (staticDir) {
  logger.info({ staticDir }, 'Serving terminal frontend UI');
  app.use(express.static(staticDir, { maxAge: '1h', etag: true }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(staticDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.json({ name: 'Altcoin Trading Bot API', status: 'running' }));
}

export default app;
