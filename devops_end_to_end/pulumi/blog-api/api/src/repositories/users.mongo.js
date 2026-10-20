import { User } from "../models/User.js";

export const usersRepo = {
    create: (data)=>User.create(data),
    findByEmail:(email)=>User.findOne({email}),
    findById:(id)=>User.findById(id),
}