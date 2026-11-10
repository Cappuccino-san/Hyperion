module.exports = {
  apps: [
    {
      name: "hyperion-auditor",
      script: "scripts/runAuditor.js",
      cwd: "d:\\SN850X\\Home\\Documents\\Projects\\gexvex",
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 5000,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};

