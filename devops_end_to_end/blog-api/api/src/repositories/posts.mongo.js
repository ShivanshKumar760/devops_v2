import {Post} from "../models/Post.js";

export const postsRepo = {
    create:  (data)=>Post.create(data),
    async findAll({page,limit}){
        const [items,total] = await Promise.all([
            Post.find().sort({ createdAt: -1 })
            .skip((page-1)*limit).limit(limit),
            Post.countDocuments()
            
        ]);

        return {items,total};
    },

    findById: (id)=> Post.findById(id),

    update: (id,changes)=> Post.findByIdAndUpdate(id,changes,{new:true,runValidators:true}),
    async remove(id){
        const deleted = await Post.findByIdAndDelete(id);
        return Boolean(deleted);
    },
}