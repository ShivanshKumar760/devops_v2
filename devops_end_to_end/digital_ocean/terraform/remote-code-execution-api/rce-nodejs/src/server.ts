import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import express , {type NextFunction , type Request, type Response} from 'express';
import jwt , {type JwtPayload} from 'jsonwebtoken';

import { Prisma,PrismaClient } from "./generated/prisma/client.js";
import { verify } from "node:crypto";
import { access } from "node:fs";
import { subscribe } from "node:diagnostics_channel";

dotenv.config();

const execFileAsync = promisify(execFile);

function requireEnv(key:string):string{
    const value = process.env[key];
    if(!value) throw new Error(`Missing environment variable:${key}`);
    return value;
}

const JWT_SECRET = requireEnv("JWT_SECRET");
const DATABASE_URL = requireEnv("DATABASE_URL");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = hostname()
const ACCESS_TTL = "30m";
const REFRESH_TTL = "7d";

const prisma = new PrismaClient({
    adapter: new PrismaPg({connectionString:DATABASE_URL}),
});


type TokenType = "access" | "refresh";

function signToken(userId:number,type:TokenType):string{
    return jwt.sign({type},JWT_SECRET,{
        subject:String(userId),
        expiresIn:type==="access"?ACCESS_TTL:REFRESH_TTL,
    });
}

function verifyToken(token:string,type:TokenType):JwtPayload | null {
    try{
        const payload = jwt.verify(token,JWT_SECRET);
        if(typeof payload === "string"|| payload.type !== type) return null;
        return payload;
    }catch{
        return null;//expired , tampered , malformed
    }
}


//Express request with the logged-in user's id attached by 
//require auth 

type AuthedRequest = Request & {userId:number};

function requireAuth(type:TokenType="access"){
    return (req:Request,res:Response,next:NextFunction)=>{
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer") ? header.slice(7):"";
        const payload = token ? verifyToken(token,type):null;
        if(!payload?.sub){
            res.status(401).json({"error":"missing or invalid token"});
            return ;
        }

        (req as AuthedRequest).userId = Number(payload.sub);
        next();
    };
}

function readCredentials(req: Request): { name: string; password: string } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    password: typeof body.password === "string" ? body.password : "",
  };
}


const app = express();

app.use(express.json({limit:"100kb"}));


app.get("/",(_req,res)=>{
    res.json({status:"ok"});
});

app.post("/signup",async (req , res)=>{
    const {name,password} = readCredentials(req);
    if(!name||!password||name.length>80||password.length<8){
        res.status(400).json({error:"name (max 80 chars required) and password with atleast 8 chars required"});
        return ;
    }

    try {
        const user = await prisma.user.create({
            data:{name,password:await bcrypt.hash(password,10)},
        });
        res.status(201).json({message:"signup success",id:user.id});
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            res.status(409).json({ error: "user already exists" });
            return;
        }
    throw err;
    }
});

app.post("/signin",async (req,res)=>{
    const {name , password} = readCredentials(req);
    const user = await prisma.user.findUnique({where:{name}});
    if (!user || !(await bcrypt.compare(password,user.password))){
        res.status(401).json({error:"invalid credentials"});
        return ;
    }

    res.json({
        access_token: signToken(user.id,"access"),
        refresh_token: signToken(user.id,"refresh")
    });
});

app.post("/refresh", requireAuth("refresh"), (req, res) => {
  res.json({ access_token: signToken((req as AuthedRequest).userId, "access") });
});

app.get("/me",requireAuth(),async (req , res)=>{
    const user = await prisma.user.findUnique({
        where: {id:(req as AuthedRequest).userId},
        select:{id:true,name:true},//never select the password hash 
    });

    if (!user){
        res.status(404).json({error:"user not found"});
        return ;
    }
    res.json(user);
})


app.post("/execute",requireAuth(),async (req,res)=>{
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || !code) {
        res.status(400).json({ error: "Please provide code to run" });
        return;
    }

    if(code.length>20_000){
        res.status(413).json({error:"code too large"});
        return ;
    }

    const dir = await mkdtemp(join(tmpdir(),"run-"));
    try{
        await writeFile(join(dir,"script.js"),code);
        try{
            const {stdout,stderr}=await execFileAsync(process.execPath,["script.js"],{
                cwd:dir,
                timeout:5000,
                maxBuffer:1024*1024,
                env : {PATH:"/usr/bin:/bin"},//do not leak DATABASE_URL / JWT_SECRET
            });

            res.json({
                message: "Success",
                stdout: stdout.slice(0, 10_000),
                stderr: stderr.slice(0, 10_000),
                returncode: 0,
            });
        }catch(err){
            const e = err as { killed?: boolean; code?: number | string; stdout?: string; stderr?: string };
            if (e.killed) {
                res.status(408).json({ error: "execution timed out (5s)" });
                return;
            }
      // the script ran but exited non-zero (e.g. it threw an error)
            res.json({
                message: "Success",
                stdout: (e.stdout ?? "").slice(0, 10_000),
                stderr: (e.stderr ?? "").slice(0, 10_000),
                returncode: typeof e.code === "number" ? e.code : 1,
            });
        }
    }finally{
        await rm(dir,{recursive:true,force:true});
    }
});


// Anything thrown inside a route lands here (Express 5 forwards async errors automatically)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ------------------------------------------------------------------ start + graceful shutdown
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`API listening on http://${HOST}:${PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force-exit if connections hang
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));