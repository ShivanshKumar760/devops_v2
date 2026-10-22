import dotenv from 'dotenv';
import os from 'node:os';
import cors from 'cors';
import express from 'express';
import { LANGUAGES } from './languages.js';
import { docker,runCode } from './runner.js';
import { error } from 'node:console';

const PORT = Number(process.env.PORT ?? 3000);
const MAX_CODE = 64*1024;
const MAX_STDIN = 16*1024;


const app = express();

if(process.env.NODE_ENV==='production') app.set('trust proxy',1);
app.use(cors({
    origin:process.env.CORS_ORIGIN ?? '*'
}));

app.use(express.json({limit:'128kb'}));

app.get('/health',async (_req,res)=>{
    const host = os.hostname();
    try {
        await docker.ping();
        res.json({status:'ok',docker:'up',host});
    } catch  {
        res.status(503).json({ status: 'degraded', docker: 'down', host });
    }
});


app.get('/api/languages',(_req,res)=>{
    res.json({languages:Object.keys(LANGUAGES)});
});

app.post('/api/run',async(req , res) =>{
    const {language,code,stdin=''} = req.body ?? {} ;
   if(!Object.hasOwn(LANGUAGES,language)){
    return res.status(400).json({error:`language must be one of ${Object.keys(LANGUAGES).join(', ')} `});
   }

   if(typeof code !=='string' || code.trim() === '' || code.length>MAX_CODE){
    return res.status(400).json({error:`code must be a non-empty string of at most ${MAX_CODE} characters`});
   }
   if (typeof stdin !== 'string' || stdin.length > MAX_STDIN) {
    return res.status(400).json({ error: `stdin must be a string of at most ${MAX_STDIN} characters` });
   }

   const result = await runCode({language,code,stdin});
   res.json({language,...result,host:os.hostname()});
});


app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler: Express recognises it by its 4 parameters. (Express 5 sends errors thrown
// inside async route handlers here automatically.)
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  console.error(err); // the real cause goes to the log, never to the client
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => console.log(`listening on port ${PORT}`));

// Stop cleanly when PM2 / systemd asks us to.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}