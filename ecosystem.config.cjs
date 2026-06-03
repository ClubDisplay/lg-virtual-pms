module.exports = {
  apps: [{
    name: "virtual-pms",
    script: "server.js",
    args: "--port 80",
    watch: false,
    env: {
      PORT: 80
    }
  }]
};
