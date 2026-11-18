module.exports = {
  apps: [
    {
      name: "hyperion-web",
      script: "npm",
      args: "run start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOSTNAME: "0.0.0.0",
        HYPERION_EXECUTION_ROLE: "leader",
      },
    },
  ],
};
