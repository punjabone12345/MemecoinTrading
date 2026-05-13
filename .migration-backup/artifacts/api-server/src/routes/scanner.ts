import { Router, type IRouter } from "express";
import { scannerService } from "../services/scanner.service.js";

const router: IRouter = Router();

router.get("/scanner", (_req, res) => {
  const tokens = scannerService.getAll();
  res.json({ success: true, count: tokens.length, data: tokens });
});

router.get("/scanner/:pairAddress", async (req, res) => {
  const { pairAddress } = req.params;
  const token = await scannerService.getOrFetchToken(pairAddress);
  if (!token) {
    res.status(404).json({ success: false, error: "Token not found" });
    return;
  }
  res.json({ success: true, data: token });
});

export default router;
