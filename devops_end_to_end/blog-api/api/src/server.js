// import { sign } from "jsonwebtoken";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDB,disconnectDB } from "./db/connect.js";


if(env.mongoUri){
    await connectDB(env.mongoUri);
}else{
    console.warn('[server] MONGODB_URI not set,using the in-memory store')
}

const server = app.listen(env.port,()=>{
    console.log(`[server] ${env.nodeEnv} listening on port ${env.port} (pid: ${process.pid})`);
});


// const shutdown = (signal)=>{
//     console.log(`[server] ${signal} received , shutting down`);

//     server.close(async ()=>{
//         await disconnectDB();
//         process.exit(0);
//     });
//     setTimeout(()=>process.exit(1),10_000).unref();
// };

const shutdown = (signal) => {
    console.log(`[server] ${signal} received , shutting down`);

    // Force an immediate exit if the server isn't open yet to prevent hanging
    if (!server || !server.listening) {
        process.exit(0);
    }

    server.close(async () => {
        try {
            await disconnectDB();
        } catch (err) {
            console.error('[db] Error while disconnecting', err);
        }
        process.exit(0);
    });
    
    // Safety timeout fallback
    setTimeout(() => process.exit(1), 5_000).unref();
};


process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection', reason);
});