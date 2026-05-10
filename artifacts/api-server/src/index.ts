import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initWebSocketServer } from "./websocket/server.js";
import { scannerService } from "./services/scanner.service.js";
import { paperTradingService } from "./services/paper-trading.service.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);

initWebSocketServer(server);

server.listen(port, () => {
  logger.info({ port }, "Apex Meme Trader AI — server listening");

  scannerService.start();
  paperTradingService.startStopChecker();

  logger.info("Scanner service started — polling DexScreener every 2.5s");
  logger.info("Stop/TP checker started — checking positions every 1.5s");
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
