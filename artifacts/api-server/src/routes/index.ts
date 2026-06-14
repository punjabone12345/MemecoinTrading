import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import graduationSniperRouter from "./graduation-sniper.js";
import paperSniperRouter from "./paper-sniper.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(graduationSniperRouter);
router.use(paperSniperRouter);

export default router;
