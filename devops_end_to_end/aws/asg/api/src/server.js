import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path:path.join(__dirname,'..','.env')});

const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || 'simple-asg-api';

const MAX_BURN_MS = 2000;
const startedAt = new Date();

const app = express();
app.set('trust proxy',1);


app.get('/',(_req,res)=>{
    res.json({
        app:APP_NAME,
        message:'Hello from an Auto Scaling Group instance',
        host: os.hostname(),
        pid: process.pid,
        uptimeSeconds:Math.round(process.uptime()),
        startedAt: startedAt.toISOString(),
    });
});

app.get('/health',(_req,res)=>{
    res.status(200).json({status:'ok'});
});


app.get('/load',(req,res)=>{
    const requested = Number.parseInt(req.query.ms,10);
    const ms = Number.isFinite(requested) ? Math.min(Math.max(requested,1),MAX_BURN_MS) : 100;
    const started = process.hrtime.bigint();
    const end = Date.now() + ms;
    let x = 0;
    while(Date.now() < end){
        x+=Math.sqrt(Math.random()*1e6)*Math.sin(x);
    }
    const burnedMs = Number(process.hrtime.bigint()-started)/1e6;
    res.json({
        host: os.hostname(),
        pid: process.pid,
        requestedMs: ms,
        burnedMs: Math.round(burnedMs),
    });
});


app.use((_req,res)=>res.status(404).json({
    error:'Not found'
}));


app.use((err,_req,res,_next)=>{
    console.error(err);
    res.status(500).json({error:'Internal server error'});
});

const server = app.listen(PORT,'0.0.0.0',()=>{
    console.log(`${APP_NAME} listening on :${PORT}(pid ${process.pid})`);
});


const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));