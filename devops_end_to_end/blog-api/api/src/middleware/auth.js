import jwt from 'jsonwebtoken';
import {env} from '../config/env.js';
import {AppError} from '../utils/AppError.js';
import { usersRepo } from '../repositories/index.js';

export const authenticate = async (req,_res,next)=>{
    const header = req.headers.authorization ?? '';
    const [scheme,token] = header.split(' ');

    if(scheme !== 'Bearer' || !token){
        throw new AppError('Missing or malformed Authorization header (expected "Bearer <token>")',401);
    }

    const payload = jwt.verify(token,env.jwtSecret);

    const user = await usersRepo.findById(payload.sub);
    if(!user) throw new AppError('User no longer exists',401);
    req.user = {id:String(user.id),name:user.name,email:user.email};
    next();
}