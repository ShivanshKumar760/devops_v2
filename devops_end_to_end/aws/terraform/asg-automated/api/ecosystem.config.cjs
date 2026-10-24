module.exports = {
  apps: [
    {
      name: 'simple-api',
      script: 'src/server.js',
      cwd: '/opt/simple-api',
      exec_mode: 'cluster',
      instances: 'max', // one worker per vCPU
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 10000,
    },
  ],
};
