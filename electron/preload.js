const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("versepilotDesktop", {
  isDesktop: true,
  platform: process.platform,
  systemAudioLoopback: process.platform === "darwin",
});
