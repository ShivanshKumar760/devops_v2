import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { LANGUAGES } from './languages.js';
import dotenv from 'dotenv';

dotenv.config();


export const docker = new Docker();


const RUN_DIR = process.env.RUN_DIR ?? path.join(os.tmpdir(),'code-runner');

const TIMEOUT_MS = 5000;
const MAX_OUTPUT = 64*1024;

function containerOptions({lang,dir}){
    const memory = 128*1024*1024;// 128 mb
    return {
        Image: lang.image,
        Cmd:['sh','-c',lang.cmd],
        User:'65534:65534',
        Tty:true,
        NetworkDisabled:true,
        Labels:{app:'code-runner'},
        HostConfig:{
            Binds:[`${dir}:/code:ro`],
            NetworkMode:'node',
            Memory:memory,
            MemorySwap:memory,
            NanoCpus:0.5e9,
            LogConfig:{Type:'json-file',Config:{
                'max-size':'256k',
                'max-file':'1'
            }},
        },
    };

};

export async function runCode({language,code,stdin}) {
    const lang = LANGUAGES[language];
    const started = Date.now();

    await fs.mkdir(RUN_DIR,{recursive:true,mode:0o755});
    const dir = await fs.mkdtemp(path.join(RUN_DIR,'run-'));
    let container;

    try {
        await fs.chmod(dir,0o755);
        await fs.writeFile(path.join(dir,lang.file),code,{mode:0o644});
        await fs.writeFile(path.join(dir,'input.txt'),stdin,{mode:0o644});
        container=await docker.createContainer(containerOptions({lang,dir}));
        await container.start();

        let timedOut=false;
        const timer = setTimeout(()=>{
            timedOut=true;
            container.kill().catch(()=>{});
        },TIMEOUT_MS);//aync will run in background so our program 
        //will move to next line

        const {StatusCode:exitCode}=await container.wait();
        clearTimeout(timer);
        const logs = await container.logs({stdout:true,stderr:true});
        console.log('logs type:', typeof logs);
        console.log('Is Buffer:', Buffer.isBuffer(logs));
        console.log('logs value:', logs);
        const info = await container.inspect();
        const output = Buffer.isBuffer(logs)
                    ? logs.toString('utf8')
                    : String(logs);

        return {
            output: output
                .replaceAll('\r\n', '\n')
                .slice(0, MAX_OUTPUT),
            exitCode,
            timedOut,
            oomKilled: info.State.OOMKilled,
            durationMs: Date.now() - started,
        };

    }finally{
        if(container) container.remove({force:true}).catch(()=>{});
        fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
    } 
};