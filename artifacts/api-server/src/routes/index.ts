import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import scannerRouter from "./scanner.js";
import tradingRouter from "./trading.js";
import positionsRouter from "./positions.js";
import analyticsRouter from "./analytics.js";
import watchlistRouter from "./watchlist.js";
import alertsRouter from "./alerts.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scannerRouter);
router.use(tradingRouter);
router.use(positionsRouter);
router.use(analyticsRouter);
router.use(watchlistRouter);
router.use(alertsRouter);

export default router;
