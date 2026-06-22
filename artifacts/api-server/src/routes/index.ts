import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import earlyDiscoveryRouter from "./early-discovery.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(earlyDiscoveryRouter);

export default router;
