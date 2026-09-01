const { contextBridge, ipcRenderer } = require("electron");

const dbApi = {
  list: () => ipcRenderer.invoke("db:list"),
  save: (record) => ipcRenderer.invoke("db:save", record),
  saveBatch: (records) => ipcRenderer.invoke("db:saveBatch", records),
  delete: (id) => ipcRenderer.invoke("db:delete", id),
  clearAll: () => ipcRenderer.invoke("db:clearAll"),
  getPdf: (id) => ipcRenderer.invoke("db:getPdf", id),
};

const detectApi = {
  copyType: (pdfBuffer, pageNum) => ipcRenderer.invoke("detect:copyType", { pdfBuffer, pageNum }),
};

const loginApi = {
  submit: (password) => ipcRenderer.send("password-submit", password),
  onWrong: (callback) => {
    ipcRenderer.on("password-wrong", () => {
      if (typeof callback === "function") callback();
    });
  },
};

const printApi = {
  getPrinters: () => ipcRenderer.invoke("print:getPrinters"),
  writeTempPdf: (pdfBuffer, jobId, orientation) => ipcRenderer.invoke("print:writeTempPdf", { pdfBuffer, jobId, orientation }),
  deleteTempPdf: (filePath) => ipcRenderer.invoke("print:deleteTempPdf", { filePath }),
  printPdfFile: (options) => ipcRenderer.invoke("print:printPdfFile", options),
  renderPreview: (pdfBuffer, pageNums, paperSize, marginsMm) =>
    ipcRenderer.invoke("print:renderPreview", { pdfBuffer, pageNums, paperSize, marginsMm }),
  openSystemDialog: (pdfBuffer, pageRanges) =>
    ipcRenderer.invoke("print:openSystemDialog", { pdfBuffer, pageRanges }),
};

contextBridge.exposeInMainWorld("loginAPI", loginApi);
contextBridge.exposeInMainWorld("detect", detectApi);
contextBridge.exposeInMainWorld("db", dbApi);
contextBridge.exposeInMainWorld("printAPI", printApi);
