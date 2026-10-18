import os from "node:os";
import { Router } from "express";

const router = Router();

router.get('/cpu',(req,res)=>{
    const ms = Math.min(Math.max(Number.parseInt(req.query.ms,10)||100,1),1000);
    const end = performance.now() + ms;
    let acc = 0;
    while (performance.now()<end){
        acc+=Math.sqrt(Math.random());
    }

    res.json({burnedMs:ms,host:os.hostname(),pid:process.pid,acc:Math.round(acc)});
});


export default router;