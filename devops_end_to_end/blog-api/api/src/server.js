// import { sign } from "jsonwebtoken";
import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.port,()=>{
    console.log(`[server] ${env.nodeEnv} listening on port ${env.port} (pid: ${process.pid})`);
});


const shutdown = (signal)=>{
    console.log(`[server] ${signal} received , shutting down`);

    server.close(()=>process.emit(0));
    setTimeout(()=>process.exit(1),10_000).unref();
};

process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));