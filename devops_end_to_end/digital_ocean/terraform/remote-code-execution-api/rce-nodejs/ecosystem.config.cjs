module.exports={
    apps:[
        {
            name:"rce-api",
            script:"dist/server.js",
            cwd:__dirname,
            instance:1,
            exec_mode:"fork", //use "cluster"
            autorestart:true,
            max_memory_restart:"300M",
            env:{
                NODE_ENV:"production",
            },

        },
    ],
};