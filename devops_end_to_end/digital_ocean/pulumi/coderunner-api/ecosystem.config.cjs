module.exports = {
  apps: [
    {
      name: 'code-runner',
      script: 'src/server.js',
      exec_mode: 'cluster',      // one worker per core, sharing port 3000
      instances: 'max',
      max_memory_restart: '300M',
      kill_timeout: 8000,        // lets a run (max 5 s) finish before PM2 force-kills
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
