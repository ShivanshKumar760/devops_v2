import dotenv from 'dotenv'

dotenv.config()

// const value = process.env["JWT_SECRET"]
// console.log(value);

const required=(name)=>{
    const value = process.env[name];
    if(!value) throw new Error(`Missing required environment variable : ${name}`);
    return value;
}

export const env = Object.freeze({
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000) ,
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
    mongoUri: process.env.MONGODB_URI ?? '',
    enableStress: process.env.ENABLE_STRESS === true ,//USED in phase 5
});