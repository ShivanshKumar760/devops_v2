import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {env} from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { usersRepo } from '../repositories/index.js';


const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


const signToken = (user)=>{
    return jwt.sign({sub:String(user.id)},env.jwtSecret,{expiresIn:env.jwtExpiresIn});
}

const publicUser = (u) => ({ id: String(u.id), name: u.name, email: u.email, createdAt: u.createdAt });

export const register = async (req,res)=>{
    const {name,email,password} = req.body;
    const problems = [];
    if(!EMAIL_RE.test(email)){
        problems.push({field: 'email', message: 'must be a valid email address' });
    }

    if(password.length<8){
        problems.push({
            field: 'password', message: 'must be at least 8 characters'
        });
    }

    if (problems.length){
        throw new AppError('Validation failed',400,problems);
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (await usersRepo.findByEmail(normalizedEmail)){
        throw new AppError('Email is already registered',409);
    }

    const passwordHash = bcrypt.hashSync(password,10);
    const user = await usersRepo.create({name:name.trim(),email:normalizedEmail,passwordHash});

    const token = signToken(user);
    res.status(201).json({user:publicUser(user),token:token});
};


export const login = async (req, res) => {
  const { email, password } = req.body;
  const user = await usersRepo.findByEmail(email.trim().toLowerCase());

  // Same message for "no such user" and "wrong password" so attackers can't enumerate emails.
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw new AppError('Invalid email or password', 401);

  res.json({ user: publicUser(user), token: signToken(user) });
};

export const me = async (req, res) => {
  res.json({ user: req.user });
};

