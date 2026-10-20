module.exports = {
  apps: [
    {
      name: 'blog-api',
      script: 'src/server.js',
      exec_mode: 'cluster',      // one worker per core, sharing port 3000
      instances: 'max',
      max_memory_restart: '250M',
      kill_timeout: 10000,       // matches the 10 s graceful shutdown in server.js
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
