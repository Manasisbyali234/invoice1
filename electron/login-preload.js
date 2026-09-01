const { contextBridge, ipcRenderer } = require("electron");

try {
  contextBridge.exposeInMainWorld("loginAPI", {
    submit: (password) => ipcRenderer.send("password-submit", password),
    onWrong: (callback) => {
      ipcRenderer.on("password-wrong", () => {
        if (typeof callback === "function") callback();
      });
    },
  });
} catch (err) {
  console.error("Failed to expose loginAPI:", err);
}
