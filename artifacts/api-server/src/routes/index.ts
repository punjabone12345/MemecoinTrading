import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import graduationSniperRouter from "./graduation-sniper.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(graduationSniperRouter);

export default router;
