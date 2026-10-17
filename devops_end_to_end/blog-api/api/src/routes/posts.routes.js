import { Router } from 'express';
import {
  createPost,
  deletePost,
  getPost,
  listPosts,
  updatePost,
} from '../controllers/posts.controller.js';
import { authenticate } from '../middleware/auth.js';
import { requireFields } from '../middleware/validate.js';

const router = Router();

router.get('/', listPosts);
router.get('/:id', getPost);
router.post('/', authenticate, requireFields('title', 'content'), createPost);
router.put('/:id', authenticate, updatePost);
router.delete('/:id', authenticate, deletePost);

export default router;
