import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ytdlpRouter from "./ytdlp";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ytdlpRouter);

export default router;
