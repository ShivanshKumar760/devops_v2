import {randomUUID} from 'node:crypto';

const users = new Map();
/*
A JavaScript Map object is a collection of key-value pairs where keys can be of any data type (objects, functions, or primitives), unlike standard objects which only allow strings or symbols as keys.
When you instantiate a map with new Map(), it looks like this conceptually and in code:

Visual Structure

Think of a Map as an ordered table of pairs:

Key (Any Type)	Value (Any Type)
"name" (String)	"Shivansh"
42 (Number)	"The Answer"
{ id: 1 } (Object)	"Admin User"

*/

export const usersRepo = {
    async create({name,email,passwordHash}){
        const user = {
            id: randomUUID(),
            name,
            email,
            passwordHash,
            createdAt: new Date().toISOString(),
        };

        users.set(user.id,user);
        return user;
    },

    async findByEmail(email){
        return [...users.values()].find((u)=> u.email === email) ?? null;
    },


    async findById(id){
        return users.get(id) ?? null;
    },
};