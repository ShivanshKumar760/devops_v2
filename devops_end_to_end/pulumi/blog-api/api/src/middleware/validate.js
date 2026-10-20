import { AppError } from "../utils/AppError.js";

export const requireFields=(...fields)=>
    (req,_res,next)=>{
    const body = req.body ?? {};
    const problems = fields
    .filter((f)=> typeof body[f] !== 'string' || body[f].trim() === '')
    .map((f)=>(
        {field:f,message: `${f} is required and must be a non-empty string`}
    ));

    if (problems.length) throw new AppError('Validation failed',400,problems);
    next()
};

// export const requireFields =(...fields) =>
//   (req, _res, next) => {
//     const body = req.body ?? {};
//     const problems = fields
//       .filter((f) => typeof body[f] !== 'string' || body[f].trim() === '')
//       .map((f) => ({ field: f, message: `${f} is required and must be a non-empty string` }));

//     if (problems.length) throw new AppError('Validation failed', 400, problems);
//     next();
//   };