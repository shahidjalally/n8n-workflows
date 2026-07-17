module.exports = {
  apps: [{
    name: 'googlemaps-scraper',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/var/log/googlemaps-scraper/error.log',
    out_file: '/var/log/googlemaps-scraper/out.log',
    log_file: '/var/log/googlemaps-scraper/combined.log',
    time: true,
    watch: false,
    autorestart: true,
    max_restarts: 5,
    min_uptime: '10s',
    kill_timeout: 30000
  }]
};
