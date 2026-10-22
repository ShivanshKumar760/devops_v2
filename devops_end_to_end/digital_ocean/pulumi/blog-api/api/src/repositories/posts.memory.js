import {randomUUID} from 'node:crypto';
import { create } from 'node:domain';
const posts = new Map();


export const postsRepo={
    async create({title,content,author}){
        const now = new Date().toISOString();
        const post = {id:randomUUID(),title,content,author,createdAt:now,updatedAt:now};
        posts.set(post.id,post);
        return post;
    },

    async findAll({page,limit}){
        const all = [...posts.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        const start = (page-1)*limit
        return {items:all.slice(start,start+limit),total:all.length};
        /*
        Let's calculate exactly what happens when page = 2.
To make the math easy to see, let’s assume your limit is 10 items per page, and your all array contains 25 items total.

1. Step-by-Step Calculation

• Calculate start:
\(\text{start}=(\text{page}-1)\times \text{limit}\)
\(\text{start}=(2-1)\times 10=\mathbf{1}\)
So, the slice will start at index 10 (which is actually the 11th item in the array, since coding starts at 0).
• Calculate the end index:
\(\text{start}+\text{limit}=10+10=\mathbf{20}\)
• Execute the slice:
all.slice(10, 20) extracts items from index 10 up to (but not including) 20.

What it looks like visually


Page	Formula	Indexes Extracted	Items Returned
Page 1	(1 - 1) * 10 = 0	0 through 9	First 10 items
Page 2 🎯	(2 - 1) * 10 = 10	10 through 19	Next 10 items
Page 3	(3 - 1) * 10 = 20	20 through 24	Last 5 items


        */
    },

    async findById(id){
        return posts.get(id) ?? null;
    },

    async update(id,changes){
        const post = posts.get(id);
        if(!post) return null;

        Object.assign(post,changes,{updatedAt:new Date().toISOString()});
        return post;
    },

    async remove(id){
        return posts.delete(id);
    }


}