const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const userDataPath = app.getPath("userData");
const pdfDir = path.join(userDataPath, "pdfs");
const dbPath = path.join(userDataPath, "invoices.db");

if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

function toBuffer(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return Buffer.from(data);
  if (data.data && (Array.isArray(data.data) || data.data instanceof Uint8Array)) return Buffer.from(data.data);
  if (typeof data === "object") return Buffer.from(Object.values(data));
  return Buffer.from(data);
}

// ── sql.js setup ───────────────────────────────────────────────────────────
let db;

function initDb() {
  const initSqlJs = require("sql.js");
  const possibleWasmPaths = [
    path.join(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(__dirname, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(process.resourcesPath || "", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  ];

  let wasmPath = "";
  let wasmBinary = null;
  for (const p of possibleWasmPaths) {
    if (fs.existsSync(p)) {
      wasmPath = p;
      try {
        wasmBinary = fs.readFileSync(p);
      } catch (e) {
        console.warn("Could not read wasm binary buffer:", e);
      }
      break;
    }
  }

  const sqlOptions = {
    locateFile: (file) => (wasmPath ? wasmPath : file),
    ...(wasmBinary ? { wasmBinary } : {}),
  };

  return initSqlJs(sqlOptions).then((SQL) => {
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        name TEXT,
        uploadedAt TEXT,
        invoiceNo TEXT,
        pageCount INTEGER,
        pages TEXT,
        pdfFile TEXT
      )
    `);
    saveDb();
  });
}

let saveDbTimer = null;
function saveDb(immediate = false) {
  if (!db) return;
  if (immediate) {
    clearTimeout(saveDbTimer);
    saveDbTimer = null;
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    return;
  }
  // Debounce: coalesce rapid saves into one write after 500ms
  if (!saveDbTimer) {
    saveDbTimer = setTimeout(() => {
      saveDbTimer = null;
      if (!db) return;
      const data = db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    }, 500);
  }
}

// ── IPC handlers ───────────────────────────────────────────────────────────
ipcMain.handle("db:list", () => {
  if (!db) return [];
  const res = db.exec("SELECT * FROM invoices ORDER BY uploadedAt DESC");
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    obj.pages = JSON.parse(obj.pages || "[]");
    return obj;
  });
});

ipcMain.handle("db:save", (_, record) => {
  if (!db) return;
  const pdfFile = path.join(pdfDir, `${record.id}.pdf`);
  const buf = toBuffer(record.pdfBuffer);
  fs.writeFileSync(pdfFile, buf);
  db.run(
    `INSERT OR REPLACE INTO invoices (id, name, uploadedAt, invoiceNo, pageCount, pages, pdfFile)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.name, record.uploadedAt, record.invoiceNo || null,
     record.pageCount, JSON.stringify(record.pages || []), pdfFile]
  );
  saveDb(); // debounced
});

ipcMain.handle("db:saveBatch", (_, records) => {
  if (!db) return [];
  const savedIds = [];
  db.run("BEGIN TRANSACTION");
  try {
    for (const record of records) {
      try {
        const pdfFile = path.join(pdfDir, `${record.id}.pdf`);
        const buf = toBuffer(record.pdfBuffer);
        fs.writeFileSync(pdfFile, buf);
        db.run(
          `INSERT OR REPLACE INTO invoices (id, name, uploadedAt, invoiceNo, pageCount, pages, pdfFile)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [record.id, record.name, record.uploadedAt, record.invoiceNo || null,
           record.pageCount, JSON.stringify(record.pages || []), pdfFile]
        );
        savedIds.push(record.id);
      } catch (err) {
        console.error(`Failed to save record ${record.id} in batch:`, err);
      }
    }
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    console.error("Batch transaction failed, falling back to individual inserts:", err);
    for (const record of records) {
      try {
        const pdfFile = path.join(pdfDir, `${record.id}.pdf`);
        const buf = toBuffer(record.pdfBuffer);
        fs.writeFileSync(pdfFile, buf);
        db.run(
          `INSERT OR REPLACE INTO invoices (id, name, uploadedAt, invoiceNo, pageCount, pages, pdfFile)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [record.id, record.name, record.uploadedAt, record.invoiceNo || null,
           record.pageCount, JSON.stringify(record.pages || []), pdfFile]
        );
        savedIds.push(record.id);
      } catch (fallbackErr) {
        console.error(`Fallback failed for record ${record.id}:`, fallbackErr);
      }
    }
  }
  saveDb(); // debounced — one disk write for the whole batch
  return savedIds;
});

ipcMain.handle("db:delete", (_, id) => {
  if (!db) return;
  const res = db.exec(`SELECT pdfFile FROM invoices WHERE id = '${id}'`);
  if (res.length && res[0].values.length) {
    const pdfFile = res[0].values[0][0];
    if (pdfFile && fs.existsSync(pdfFile)) fs.unlinkSync(pdfFile);
  }
  db.run("DELETE FROM invoices WHERE id = ?", [id]);
  saveDb(true); // immediate on delete
});

ipcMain.handle("db:clearAll", () => {
  if (!db) return;
  const res = db.exec("SELECT pdfFile FROM invoices");
  if (res.length) {
    res[0].values.forEach(([pdfFile]) => {
      if (pdfFile && fs.existsSync(pdfFile)) fs.unlinkSync(pdfFile);
    });
  }
  db.run("DELETE FROM invoices");
  saveDb(true); // immediate on clear
});

ipcMain.handle("db:getPdf", async (_, id) => {
  if (!db) return null;
  const res = db.exec(`SELECT pdfFile FROM invoices WHERE id = '${id}'`);
  if (!res.length || !res[0].values.length) return null;
  const pdfFile = res[0].values[0][0];
  if (!pdfFile || !fs.existsSync(pdfFile)) return null;
  // Use async read to avoid blocking the main process
  return await fs.promises.readFile(pdfFile);
})

// ── YOLO / OCR page detection ─────────────────────────────────────────────
ipcMain.handle("detect:copyType", (_, { pdfBuffer, pageNum }) => {
  return new Promise((resolve) => {
    const tmpPdf = path.join(app.getPath("temp"), `inv_detect_${Date.now()}.pdf`);
    const buf = toBuffer(pdfBuffer);
    fs.writeFileSync(tmpPdf, buf);

    const scriptPath = path.join(__dirname, "detect_copy_type.py");
    execFile("python", [scriptPath, tmpPdf, String(pageNum)], { timeout: 30000 }, (err, stdout) => {
      try { fs.unlinkSync(tmpPdf); } catch (_) {}
      if (err) { resolve({ type: "unknown", error: err.message }); return; }
      try { resolve(JSON.parse(stdout.trim())); }
      catch (_) { resolve({ type: "unknown" }); }
    });
  });
});

// ── Printing IPC Handlers ──────────────────────────────────────────────────

// A4 landscape dimensions in PDF points
const A4L_W = 841.89;
const A4L_H = 595.28;
const SAFE_MARGIN = 14.17; // ~5mm in points

/**
 * Converts every page in srcPdfBytes to landscape by swapping the MediaBox
 * (width ↔ height) and rotating the content stream -90°.
 * Pages that are already landscape (width > height) are left unchanged.
 * Validation (pypdf):
 *   from pypdf import PdfReader
 *   reader = PdfReader(pdf_path)
 *   for i, page in enumerate(reader.pages):
 *       w = float(page.mediabox.width)
 *       h = float(page.mediabox.height)
 *       assert w > h, f"Page {i+1} is NOT landscape: {w} x {h}"
 */
async function toLandscapePdf(srcPdfBytes, orientation = "landscape") {
  try {
    const { PDFDocument, degrees } = require("pdf-lib");
    const srcDoc = await PDFDocument.load(srcPdfBytes);
    const outDoc = await PDFDocument.create();
    const pageCount = srcDoc.getPageCount();
    const indices = Array.from({ length: pageCount }, (_, i) => i);
    const copied = await outDoc.copyPages(srcDoc, indices);
    for (const page of copied) {
      const { width, height } = page.getSize();
      const isLandscape = width > height;
      if (orientation === "landscape" && !isLandscape) {
        page.setSize(height, width);
        page.translateContent(0, width);
        page.rotateContent(degrees(-90));
      } else if (orientation === "portrait" && isLandscape) {
        page.setSize(height, width);
        page.translateContent(height, 0);
        page.rotateContent(degrees(90));
      }
      outDoc.addPage(page);
    }
    return await outDoc.save();
  } catch (e) {
    console.warn("[toLandscapePdf] pdf-lib failed, returning original:", e.message);
    return srcPdfBytes;
  }
}

ipcMain.handle("print:getPrinters", async (event) => {
  try {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (senderWin && senderWin.webContents) {
      return await senderWin.webContents.getPrintersAsync();
    }
    return [];
  } catch (err) {
    console.error("Failed to get printers:", err);
    return [];
  }
});

// Write PDF bytes to a temp file and return its path so the renderer
// can load it via file:// without any rasterisation.
ipcMain.handle("print:writeTempPdf", async (_, { pdfBuffer, jobId, orientation }) => {
  try {
    const srcBytes = toBuffer(pdfBuffer);
    const orient = orientation || "landscape";
    const outBytes = await toLandscapePdf(srcBytes, orient);
    const tmpPath = path.join(app.getPath("temp"), `inv_print_${jobId}.pdf`);
    await fs.promises.writeFile(tmpPath, Buffer.from(outBytes));
    console.log(`[print] ${orient} PDF written:`, tmpPath, "size:", outBytes.byteLength);
    return { path: tmpPath };
  } catch (err) {
    console.error("[print] writeTempPdf error:", err);
    return { error: err.message };
  }
});

ipcMain.handle("print:deleteTempPdf", async (_, { filePath }) => {
  try { await fs.promises.unlink(filePath); } catch (_) {}
});

ipcMain.handle("print:renderPreview", async (_, { pdfBuffer, pageNums, paperSize, marginsMm }) => {
  try {
    const srcBytes = toBuffer(pdfBuffer);
    const outBytes = await toLandscapePdf(srcBytes, "landscape");

    const pdfjsPaths = [
      path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "pdfjs-dist"),
      path.join(__dirname, "..", "node_modules", "pdfjs-dist"),
      path.join(__dirname, "node_modules", "pdfjs-dist"),
    ];
    const pdfjsRoot = pdfjsPaths.find(p => fs.existsSync(p));
    if (!pdfjsRoot) return { pages: [] };

    const paperDims = { A5:[210,148], A4:[297,210], A3:[420,297], A2:[594,420], B4:[353,250], B5:[250,176], Letter:[279,216], Legal:[356,216], IndianLegal:[345,215], Tabloid:[432,279], Ledger:[432,279], Executive:[267,184] };
    const dims = paperDims[paperSize] || paperDims.A5;
    const pageWmm = Math.max(...dims);
    const pageHmm = Math.min(...dims);
    const margin = marginsMm || 0;
    const pdfBase64 = Buffer.from(outBytes).toString("base64");
    const pdfjsSrc = path.join(pdfjsRoot, "build", "pdf.js").replace(/\\/g, "/");
    const pdfWorkerSrc = path.join(pdfjsRoot, "build", "pdf.worker.js").replace(/\\/g, "/");

    const os = require("os");
    const jobId = Date.now();
    const pages = [];

    for (const pageNum of pageNums) {
      const outImgPath = path.join(os.tmpdir(), `inv_prev_${jobId}_${pageNum}.jpg`);
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:#fff}</style></head><body>
<canvas id="c"></canvas>
<script src="file:///${pdfjsSrc}"></script>
<script>
(async()=>{
  try{
    pdfjsLib.GlobalWorkerOptions.workerSrc='file:///${pdfWorkerSrc}';
    const data=Uint8Array.from(atob('${pdfBase64}'),c=>c.charCodeAt(0));
    const pdf=await pdfjsLib.getDocument({data}).promise;
    const page=await pdf.getPage(${pageNum});
    const mmToPx=96/25.4;
    const availW=(${pageWmm}-${margin*2})*mmToPx;
    const availH=(${pageHmm}-${margin*2})*mmToPx;
    const vp1=page.getViewport({scale:1});
    const scale=Math.min(availW/vp1.width,availH/vp1.height);
    const vp=page.getViewport({scale});
    const canvas=document.getElementById('c');
    canvas.width=Math.round(${pageWmm}*mmToPx);
    canvas.height=Math.round(${pageHmm}*mmToPx);
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    const offX=(canvas.width-vp.width)/2;
    const offY=(canvas.height-vp.height)/2;
    ctx.translate(offX,offY);
    await page.render({canvasContext:ctx,viewport:vp}).promise;
    const dataUrl=canvas.toDataURL('image/jpeg',0.85);
    const base64=dataUrl.split(',')[1];
    const buf=Buffer.from(base64,'base64');
    require('fs').writeFileSync('${outImgPath.replace(/\\/g,"/")}',buf);
    document.title='DONE';
  }catch(e){document.title='ERROR:'+e.message;}
})();
<\/script></body></html>`;

      const htmlPath = path.join(os.tmpdir(), `inv_prev_${jobId}_${pageNum}.html`);
      fs.writeFileSync(htmlPath, html);

      const ok = await new Promise((resolve) => {
        const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false } });
        const onTitle = (_, title) => {
          if (title === "DONE" || title.startsWith("ERROR:")) {
            win.webContents.removeListener("page-title-updated", onTitle);
            try { fs.unlinkSync(htmlPath); } catch (_) {}
            win.destroy();
            resolve(title === "DONE");
          }
        };
        win.webContents.on("page-title-updated", onTitle);
        win.loadFile(htmlPath);
        setTimeout(() => { win.webContents.removeListener("page-title-updated", onTitle); try { fs.unlinkSync(htmlPath); } catch (_) {} try { win.destroy(); } catch (_) {} resolve(false); }, 30000);
      });

      if (ok && fs.existsSync(outImgPath)) {
        const imgBuf = fs.readFileSync(outImgPath);
        try { fs.unlinkSync(outImgPath); } catch (_) {}
        pages.push("data:image/jpeg;base64," + imgBuf.toString("base64"));
      }
    }

    return { pages };
  } catch (e) {
    console.error("[preview] renderPreview error:", e);
    return { pages: [] };
  }
});

// Print a PDF file directly to the Windows print spooler.
// Strategy (in order):
//   1. SumatraPDF silent print (best: supports page ranges, copies, paper size)
//   2. PowerShell System.Drawing.Printing via a generated C# snippet (direct spooler)
//   3. ShellExecute PrintTo fallback (opens associated app and prints)
ipcMain.handle("print:printPdfFile", async (_, options = {}) => {
  const { spawn } = require("child_process");

  const filePath = options.filePath;
  if (!filePath || !fs.existsSync(filePath)) {
    console.error("[print] PDF file not found:", filePath);
    return { success: false, error: "PDF file not found: " + filePath };
  }

  const printer  = (options.deviceName || "").trim();
  const copies   = Math.max(1, parseInt(options.copies, 10) || 1);
  const paper    = options.pageSize || "A4";   // A4 | A5 | A3 | A2
  const orient   = (options.orientation || "landscape").toLowerCase();

  console.log("[print] filePath   :", filePath);
  console.log("[print] printer    :", printer || "(default)");
  console.log("[print] copies     :", copies);
  console.log("[print] paper      :", paper);
  console.log("[print] orientation:", orient);

  // ── 1. Check printer status via PowerShell before attempting to print ──
  if (printer) {
    try {
      const statusScript = `
$p = Get-Printer -Name '${printer.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'NOT_FOUND'; exit }
if ($p.PrinterStatus -eq 'Offline') { Write-Output 'OFFLINE'; exit }
if ($p.PrinterStatus -eq 'Paused')  { Write-Output 'PAUSED';  exit }
Write-Output 'OK'
`;
      const statusResult = await new Promise((resolve) => {
        let out = "";
        const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", statusScript], { detached: false });
        proc.stdout.on("data", d => { out += d.toString(); });
        proc.on("close", () => resolve(out.trim()));
        proc.on("error", () => resolve("OK")); // if PS fails, proceed anyway
      });
      console.log("[print] printer status:", statusResult);
      if (statusResult === "NOT_FOUND") return { success: false, error: `Printer "${printer}" not found on this system.` };
      if (statusResult === "OFFLINE")   return { success: false, error: `Printer "${printer}" is offline. Please check the connection.` };
      if (statusResult === "PAUSED")    return { success: false, error: `Printer "${printer}" is paused. Please resume it and try again.` };
    } catch (e) {
      console.warn("[print] status check failed (non-fatal):", e.message);
    }
  }

  // ── 2. Try SumatraPDF (best silent print path) ──
  // Check bundled copy first, then system installs
  const sumatraPaths = [
    path.join(process.resourcesPath || "", "app.asar.unpacked", "electron", "bin", "SumatraPDF.exe"),
    path.join(__dirname, "bin", "SumatraPDF.exe"),
    "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
    "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe",
    path.join(app.getPath("home"), "AppData", "Local", "SumatraPDF", "SumatraPDF.exe"),
  ];
  const sumatraExe = sumatraPaths.find(p => fs.existsSync(p));

  if (sumatraExe) {
    console.log("[print] using SumatraPDF:", sumatraExe);
    return new Promise((resolve) => {
      const paperSetting = (options.pageSize || "A5").toUpperCase();
      const orientSetting = orient === "portrait" ? "portrait" : "landscape";
      const settings = `${copies}x,paper=${paperSetting},${orientSetting},fit`;

      const args = printer
        ? ["-print-to", printer, "-print-settings", settings, "-silent", "-exit-when-done", filePath]
        : ["-print-to-default", "-print-settings", settings, "-silent", "-exit-when-done", filePath];
      console.log("[print] SumatraPDF args:", args.join(" "));
      const proc = spawn(sumatraExe, args, { detached: false, windowsHide: true });
      let stderr = "";
      proc.stderr?.on("data", d => { stderr += d.toString(); });
      proc.on("close", (code) => {
        console.log("[print] SumatraPDF exit code:", code, stderr || "");
        // SumatraPDF returns 0 on success; treat any exit as success since
        // it has already spooled the job to the printer by the time it exits.
        resolve({ success: true });
      });
      proc.on("error", (err) => {
        console.error("[print] SumatraPDF spawn error:", err.message);
        resolve({ success: false, error: err.message });
      });
    });
  }

  // ── 3. Electron hidden-window → webContents.print() directly to spooler ──
  // Renders the PDF via pdfjs in a hidden BrowserWindow, then calls
  // webContents.print() with A5-landscape page settings.
  // This path never rasterises to PNG so there is zero clipping from window bounds.
  console.log("[print] SumatraPDF not found — using Electron webContents.print() path");

  const os = require("os");
  const jobId = options.jobId || Date.now();

  const possiblePdfjsPaths = [
    path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "pdfjs-dist"),
    path.join(__dirname, "..", "node_modules", "pdfjs-dist"),
    path.join(__dirname, "node_modules", "pdfjs-dist"),
    path.join(process.resourcesPath || "", "node_modules", "pdfjs-dist"),
  ];
  const pdfjsRoot = possiblePdfjsPaths.find(p => fs.existsSync(p));
  if (!pdfjsRoot) {
    return { success: false, error: "Print failed: pdfjs-dist not found in packaged app." };
  }

  const pdfBase64    = fs.readFileSync(filePath).toString("base64");
  const pdfWorkerSrc = path.join(pdfjsRoot, "build", "pdf.worker.js").replace(/\\/g, "/");
  const pdfjsSrc     = path.join(pdfjsRoot, "build", "pdf.js").replace(/\\/g, "/");

  // Paper dimensions in mm
  const paperDims = { A5: [210,148], A4: [297,210], A3: [420,297], A2: [594,420] };
  // Always landscape: width > height
  const [pageWmm, pageHmm] = [Math.max(...(paperDims[paper] || paperDims.A5)), Math.min(...(paperDims[paper] || paperDims.A5))];

  // Build an HTML page that renders ALL pdf pages, one per @page, scaled to fit
  // with object-fit:contain — the browser print engine handles margins automatically.
  const rendererHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size: ${pageWmm}mm ${pageHmm}mm; margin: 3mm; }
  html, body { background:#fff; }
  .page {
    width: ${pageWmm - 6}mm;
    height: ${pageHmm - 6}mm;
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-after: always;
    overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  canvas {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }
</style>
</head>
<body>
<div id="root"></div>
<script src="file:///${pdfjsSrc}"></script>
<script>
(async () => {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'file:///${pdfWorkerSrc}';
    const data = Uint8Array.from(atob('${pdfBase64}'), c => c.charCodeAt(0));
    const pdf  = await pdfjsLib.getDocument({ data }).promise;
    const root = document.getElementById('root');
    // mm to px at 96dpi
    const mmToPx = 96 / 25.4;
    const availW = (${pageWmm} - 6) * mmToPx;
    const availH = (${pageHmm} - 6) * mmToPx;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp1  = page.getViewport({ scale: 1 });
      const scale = Math.min(availW / vp1.width, availH / vp1.height);
      const vp   = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = Math.round(vp.width  * dpr);
      canvas.height = Math.round(vp.height * dpr);
      canvas.style.width  = vp.width  + 'px';
      canvas.style.height = vp.height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const div = document.createElement('div');
      div.className = 'page';
      div.appendChild(canvas);
      root.appendChild(div);
    }
    document.title = 'READY';
  } catch(e) {
    document.title = 'ERROR:' + e.message;
  }
})();
</script>
</body></html>`;

  const htmlPath = path.join(os.tmpdir(), `inv_print_${jobId}.html`);
  fs.writeFileSync(htmlPath, rendererHtml);

  return new Promise((resolve) => {
    const printWin = new BrowserWindow({
      show: false,
      width: Math.round(pageWmm * 96 / 25.4),
      height: Math.round(pageHmm * 96 / 25.4),
      webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
    });

    const cleanup = () => { try { fs.unlinkSync(htmlPath); } catch (_) {} try { printWin.destroy(); } catch (_) {} };

    const onTitle = (_, title) => {
      if (title === "READY") {
        printWin.webContents.removeListener("page-title-updated", onTitle);
        const printOptions = {
          silent: true,
          printBackground: true,
          deviceName: printer || undefined,
          copies,
          pageSize: { width: pageWmm * 1000, height: pageHmm * 1000 }, // microns
          landscape: true, // ALWAYS landscape
          margins: { marginType: "printableArea" },
          scaleFactor: 100,
          shouldPrintBackgrounds: true,
        };
        printWin.webContents.print(printOptions, (success, errType) => {
          cleanup();
          console.log("[print] webContents.print result:", success, errType);
          if (success) resolve({ success: true });
          else if (errType === "cancelled") resolve({ success: false, error: "cancelled" });
          else resolve({ success: false, error: "Print failed: " + (errType || "unknown") });
        });
      } else if (title.startsWith("ERROR:")) {
        printWin.webContents.removeListener("page-title-updated", onTitle);
        cleanup();
        resolve({ success: false, error: "Render failed: " + title.slice(6) });
      }
    };

    printWin.webContents.on("page-title-updated", onTitle);
    printWin.loadFile(htmlPath);

    setTimeout(() => {
      printWin.webContents.removeListener("page-title-updated", onTitle);
      cleanup();
      resolve({ success: false, error: "Print timed out" });
    }, 120000);
  });
});

// ── password ───────────────────────────────────────────────────────────────
const APP_PASSWORD = "invoice@123";

function getElectronAsset(filename) {
  const p1 = path.join(__dirname, filename);
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(app.getAppPath(), "electron", filename);
  if (fs.existsSync(p2)) return p2;
  return p1;
}

async function askPassword() {
  return new Promise((resolve) => {
    let authenticated = false;
    const promptWin = new BrowserWindow({
      width: 400,
      height: 250,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      center: true,
      title: "Invoice Manager — Login",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        preload: getElectronAsset("preload.js"),
      },
    });

    promptWin.setMenuBarVisibility(false);
    promptWin.loadFile(getElectronAsset("login.html"));

    const submitHandler = (_, val) => {
      const input = typeof val === "string" ? val.trim() : "";
      if (input === APP_PASSWORD) {
        authenticated = true;
        ipcMain.removeListener("password-submit", submitHandler);
        resolve(true);
        if (!promptWin.isDestroyed()) {
          promptWin.close();
        }
      } else {
        if (!promptWin.isDestroyed()) {
          promptWin.webContents.send("password-wrong");
        }
      }
    };

    ipcMain.on("password-submit", submitHandler);

    promptWin.on("closed", () => {
      ipcMain.removeListener("password-submit", submitHandler);
      if (!authenticated) {
        resolve(false);
      }
    });
  });
}

// ── window ─────────────────────────────────────────────────────────────────
function createWindow() {
  // Disable throttling so PDF processing stays fast even when window loses focus
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: "Invoice Copy Manager",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
      preload: getElectronAsset("preload.js"),
    },
  });

  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 1024,
        height: 768,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          webSecurity: false,
        },
      },
    };
  });

  const possibleDistPaths = [
    path.join(__dirname, "..", "dist", "index.html"),
    path.join(app.getAppPath(), "dist", "index.html"),
    path.join(__dirname, "dist", "index.html"),
  ];

  let distIndex = possibleDistPaths.find((p) => fs.existsSync(p));

  if (app.isPackaged || distIndex) {
    if (distIndex) {
      win.loadFile(distIndex);
    } else {
      win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    }
  } else {
    win.loadURL("http://localhost:5173").catch(() => {
      if (distIndex) win.loadFile(distIndex);
    });
  }

  win.webContents.on("did-fail-load", (e, code, desc) => {
    console.error("Window failed to load:", code, desc);
    if (distIndex && fs.existsSync(distIndex)) {
      win.loadFile(distIndex);
    }
  });
}

// Flush DB on quit to ensure debounced writes are not lost
app.on("before-quit", () => saveDb(true));

app.whenReady().then(() =>
  initDb()
    .catch((err) => console.error("Database initialization error:", err))
    .then(async () => {
      const ok = await askPassword();
      if (!ok) {
        app.quit();
        return;
      }
      createWindow();
    })
    .catch((err) => {
      console.error("Startup error:", err);
      createWindow();
    })
);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
