import os from 'node:os';
import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';


const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

if (!MONGODB_URI || !JWT_SECRET){
    console.error('MONGODB_URI and JWT_SECRET are required');
    process.exit(1);
}

const User = mongoose.model('User',new mongoose.Schema({
    name: {type: String, required: true, trim: true, maxlength: 80},
    email: {
        type:String,
        required:true,
        lowercase:true,
        unique:true,
        trim:true
    },

    passwordHash: {type:String,required:true,select:false},
},{timestamps:true}));

const Post = mongoose.model('Post', new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  content: { type: String, required: true, maxlength: 20000 },
  tags: { type: [String], default: [], index: true },
  published: { type: Boolean, default: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
}, { timestamps: true }));

const signToken = (user)=>{
    return jwt.sign({sub:String(user._id)},JWT_SECRET,{algorithm:'HS256',expiresIn:JWT_EXPIRES_IN});
}

//MIDDLEWARE AUTHENTICATION

function requireAuth(req,res,next){
    const [schema,token]=(req.headers.authorization||'').split(' ');
    if (schema !== 'Bearer' || !token) return res.status(401).json({error:'Authentication required'});
    try {
        req.userId = jwt.verify(token,JWT_SECRET,{algorithms:['HS256']}).sub;
        next();
    } catch (error) {
        console.error(error);
        res.status(401).json({error:'Invalid or expired token'});
    }
}

const cleanTags = (tags) => tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);

const app = express();
app.set('trust proxy',1);
app.use(express.json({limit:'100kb'}));
app.get('/',(_req,res)=>{
    res.json({
        app:'blog-api',
        host:os.hostname(),
        docs:'see /health,/ready,/load,/api/auth/*,/api/posts'
    });
});

app.get('/health',(_req,res)=>{
    res.json({status:'ok',host:os.hostname()});
});

app.get('/ready',(_req,res)=>{
    const ok = mongoose.connection.readyState === 1;
    res.status(ok ? 200 : 503).json({db: ok ? 'connected' : 'disconnected'});
});

app.get('/load', (req, res) => {
    const asked = Number.parseInt(req.query.ms, 10);
    // Safely cap the burn window between 1ms and 2000ms
    const ms = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 2000) : 100;
    
    const end = Date.now() + ms;
    let x = 0;
    let operationsCount = 0;

    let sum = 0
    let bigInt = 1000;
    for (let i =1 ; i<bigInt;i++){
        for(let j=1;j<100;j++){
            sum=i+j;
        }
    }
    
    // All CPU stress happens dynamically inside the timer window
    while (Date.now() < end) {
        x += Math.sqrt(Math.random() * 1e6) * Math.sin(x || 1);
        operationsCount++;
    }
    
    // Return the results so the JS compiler cannot optimize out the calculations
    res.json({ 
        host: os.hostname(), 
        pid: process.pid, 
        burnedMs: ms,
        operationsExecuted: operationsCount,
        integrityCheck: x,
        sum:sum
    });
});


app.post('/api/auth/register', async (req, res, next) => {
    // 1. Wrap async operations in a try/catch block
    try {
        const { name, email, password } = req.body;
        
        // 2. Fixed: Wrap 'string' in quotes
        if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ error: 'name, email, and password must be strings' });
        }
        
        // 3. String trimming and empty input check
        if (!name.trim() || !email.trim() || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters and fields cannot be empty' });
        }

        // 4. Securely hash and instantiate using the new keyword
        const userInstance = new User({
            name: name.trim(),
            email: email.trim().toLowerCase(), // Normalized email formatting
            passwordHash: await bcrypt.hash(password, 10)
        });

        // 5. Commit to database safely
        const user = await userInstance.save();

        // 6. Return response safely
        res.status(201).json({
            user: { 
                id: user.id || user._id, 
                name: user.name, 
                email: user.email 
            },
            token: signToken(user)
        });

    } catch (err) {
        // 7. Check for Mongo duplicate key error (code 11000) or SQL constraint
        if (err.code === 11000 || err.name === 'MongoServerError') {
            return res.status(409).json({ error: 'Email address is already registered' });
        }
        // Forward other unexpected server errors to your global error middleware
        next(err);
    }
});



app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ user: { id: user.id, name: user.name, email: user.email }, token: signToken(user) });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});


// app.get('/api/posts',async (req,res)=>{
//     const page = Math.max(parseInt(req.query.page , 10) || 1,1);
//     const limit  = Math.min(Math.max(parseInt(req.query.limit,10)||10,1),50);
//     const filter = {published:true};
//     if (typeof req.query.tag === 'string') filter.tags = req.query.tag.toLowerCase();
//     const [items,total] = await Promise.all([
//         (Post.find(filter)).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).populate('author','name'),
//         Post.countDocuments(filter)
//     ]);
//     res.json({items,page,limit,total,pages:Math.ceil(total/limit)});
// });


app.get('/api/posts', async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
        
        const filter = { published: true };
        if (typeof req.query.tag === 'string') {
            filter.tags = req.query.tag.toLowerCase();
        }

        // Calculate offset skip math
        const skipAmount = (page - 1) * limit;

        // 🔥 FIXED: Standard Mongoose .sort() chaining inside Promise.all
        const [items, total] = await Promise.all([
            Post.find(filter)
                .sort({ createdAt: -1 }) // Replaced .toSorted() with native .sort()
                .skip(skipAmount)
                .limit(limit)
                .populate('author', 'name'),
            Post.countDocuments(filter)
        ]);

        // Return standardized pagination metadata envelope
        res.json({
            items,
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        });

    } catch (err) {
        // Forward unexpected errors to the global Express engine
        next(err);
    }
});


app.get('/api/posts/mine',requireAuth,async (req,res)=>{
    res.json({items:await Post.find({author:req.userId}).sort({createdAt:-1})});
});


app.get('/api/posts/:id',async (req,res)=>{
    const post = await Post.findOne({_id:req.params.id,published:true}).populate('author','name');
    if (!post) return res.status(404).json({error:'Post not found'});
    res.json({post});
});

app.post('/api/posts',requireAuth,async (req,res)=>{
    const {title,content,tags,published} = req.body ?? {};
    const post = await Post.create({
        title,
        content,
        tags:Array.isArray(tags) ? cleanTags(tags) : [],
        published:published===undefined?true:Boolean(published),
        author:req.userId,
    });
    res.status(201).json({post});
});


app.put('/api/posts/:id', requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (String(post.author) !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  const { title, content, tags, published } = req.body ?? {};
  if (title !== undefined) post.title = title;
  if (content !== undefined) post.content = content;
  if (Array.isArray(tags)) post.tags = cleanTags(tags);
  if (published !== undefined) post.published = Boolean(published);
  await post.save();
  res.json({ post });
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (String(post.author) !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  await post.deleteOne();
  res.status(204).end();
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  if (err.name === 'ValidationError') return res.status(400).json({ error: 'Validation failed', details: Object.values(err.errors).map((e) => e.message) });
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ error: 'Already exists' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});


const server = app.listen(PORT,'0.0.0.0',()=>{
    console.log(`blog-api listening on :${PORT}`);
});

(async function connectToMongo() {
    for (;;){
        try{
            await mongoose.connect(MONGODB_URI,{
                serverSelectionTimeoutMS:10000
            });
            console.log('MongoDB connected');
            return ;
        }catch(err){
            console.error('MongoDb connection failed , retrying in 5s:',err.message);
            await new Promise((resolve)=>setTimeout(resolve,5000));
        }
    }
})();

const shutdown = () => {
  server.close(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);