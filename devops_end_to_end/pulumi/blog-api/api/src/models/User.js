import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
    {
        name:{type:String,required:true,trim:true,maxlength:80},
        email:{type:String,required:true,unique:true,lowercase:true,trim:true},
        passwordHash:{type:String,required:true},
    },
    {
        timestamps:true,
        toJSON:{
            transform(_doc,ret){
                ret.id=ret._id.toString();
                delete ret._id;
                delete ret.__v;
                delete ret.passwordHash;

                return ret;
            },
        },
    },
);

export const User = mongoose.model('User', userSchema);
