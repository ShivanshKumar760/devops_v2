import { AppError } from '../utils/AppError.js';
import { postsRepo } from '../repositories/index.js';

const clampInt = (value, fallback, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
};

/** Loads a post and verifies that the logged-in user owns it. */
const loadOwnedPost = async (req)=>{
    const post = await postsRepo.findById(req.params.id);
    if (!post) throw new AppError('Post not found',404);
    if(String(post.author)!==req.user.id){
        throw new AppError('You can only modify your own posts',403);
    }
    return post;
}


export const listPosts = async(req,res)=>{
    console.log(req.query);
    const page=clampInt(req.query.page,1,10_000);
    console.log(page);
    const limit = clampInt(req.query.limit,10,50);
    console.log(limit);
    const {items,total} = await postsRepo.findAll({page,limit});

    res.json({
        data: items,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });

};

export const getPost = async (req,res)=>{
    const post = await postsRepo.findById(req.params.id);
    if (!post) throw new AppError('Post not found',404);
    res.json({data:post});
};


export const createPost = async (req,res) => {
    const {title , content} = req.body;
    const post = await postsRepo.create({
        title:title.trim(),
        content:content.trim(),
        author:req.user.id,
    });
    res.status(201).json({data:post});
};


export const updatePost = async (req, res) => {
  await loadOwnedPost(req);

  const changes = {};
  for (const key of ['title', 'content']) {
    const value = req.body?.[key];
    if (typeof value === 'string' && value.trim() !== '') changes[key] = value.trim();
  }
  if (Object.keys(changes).length === 0) {
    throw new AppError('Provide at least one of: title, content', 400);
  }

  const post = await postsRepo.update(req.params.id, changes);
  res.json({ data: post });
};

export const deletePost = async (req, res) => {
  await loadOwnedPost(req);
  await postsRepo.remove(req.params.id);
  res.status(204).end();
};