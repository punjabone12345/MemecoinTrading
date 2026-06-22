import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    // Silence /api/healthz ping requests so UptimeRobot pings don't flood logs
    autoLogging: {
      ignore: (req) => req.url === "/api/healthz",
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── Single-service deployment (Render, Railway, etc.) ─────────────────────
// When SERVE_FRONTEND=true or NODE_ENV=production AND the frontend build
// exists, serve it from the same process so one Render service handles both.
const shouldServeFrontend =
  process.env["SERVE_FRONTEND"] === "true" ||
  process.env["NODE_ENV"] === "production";

if (shouldServeFrontend) {
  // In the compiled bundle (dist/index.mjs) __dirname = artifacts/api-server/dist
  // The frontend build lands at artifacts/terminal/dist/public
  const frontendDir = path.resolve(__dirname, "../../terminal/dist/public");
  app.use(express.static(frontendDir, { maxAge: "1h", etag: true }));

  // SPA fallback — anything that isn't an /api call gets index.html
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });

  logger.info({ frontendDir }, "Serving frontend static files");
}

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ success: false, error: "Internal server error" });
  },
);

export default app;
