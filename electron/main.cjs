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
      try { wasmBinary = fs.readFileSync(p); } catch (e) { console.warn("Could not read wasm binary buffer:", e); }
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
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_uploadedAt ON invoices(uploadedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_invoices_invoiceNo ON invoices(invoiceNo);
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
  db.run(`
    INSERT OR REPLACE INTO invoices (id, name, uploadedAt, invoiceNo, pageCount, pages, pdfFile)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [record.id, record.name, record.uploadedAt, record.invoiceNo || null,
    record.pageCount, JSON.stringify(record.pages || []), pdfFile]);
  saveDb();
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
        db.run(`
          INSERT OR REPLACE INTO invoices (id, name, uploadedAt, invoiceNo, pageCount, pages, pdfFile)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [record.id, record.name, record.uploadedAt, record.invoiceNo || null,
          record.pageCount, JSON.stringify(record.pages || []), pdfFile]);
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
        db.run(`
          INSERT OR REPLACE INTO invoices (id, name, uploadedAt, invoiceNo, pageCount, pages, pdfFile)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [record.id, record.name, record.uploadedAt, record.invoiceNo || null,
          record.pageCount, JSON.stringify(record.pages || []), pdfFile]);
        savedIds.push(record.id);
      } catch (fallbackErr) {
        console.error(`Fallback failed for record ${record.id}:`, fallbackErr);
      }
    }
  }
  saveDb();
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
  saveDb(true);
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
  saveDb(true);
});

ipcMain.handle("db:getPdf", async (_, id) => {
  if (!db) return null;
  const res = db.exec(`SELECT pdfFile FROM invoices WHERE id = '${id}'`);
  if (!res.length || !res[0].values.length) return null;
  const pdfFile = res[0].values[0][0];
  if (!pdfFile || !fs.existsSync(pdfFile)) return null;
  return await fs.promises.readFile(pdfFile);
});

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

ipcMain.handle("print:writeTempPdf", async (_, { pdfBuffer, jobId }) => {
  try {
    const tmpPath = path.join(app.getPath("temp"), `inv_print_${jobId}.pdf`);
    const buf = toBuffer(pdfBuffer);
    if (!buf || buf.length === 0) return { error: "PDF buffer is empty" };
    const header = buf.slice(0, 4).toString("ascii");
    if (header !== "%PDF") return { error: "Not a valid PDF (bad header: " + header + ")" };
    fs.writeFileSync(tmpPath, buf);
    console.log("[print] temp PDF written:", tmpPath, "size:", buf.length);
    return { path: tmpPath };
  } catch (err) {
    console.error("[print] writeTempPdf error:", err.message);
    return { error: err.message };
  }
});

ipcMain.handle("print:deleteTempPdf", async (_, { filePath }) => {
  try { fs.unlinkSync(filePath); } catch (_) {}
});

ipcMain.handle("print:renderPreview", async (_, { pdfBuffer, pageNums, paperSize, marginsMm }) => {
  const os = require("os");
  const jobId = Date.now();

  const possiblePdfjsPaths = [
    path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "pdfjs-dist"),
    path.join(__dirname, "..", "node_modules", "pdfjs-dist"),
    path.join(__dirname, "node_modules", "pdfjs-dist"),
    path.join(process.resourcesPath || "", "node_modules", "pdfjs-dist"),
  ];
  const pdfjsRoot = possiblePdfjsPaths.find(p => fs.existsSync(p));
  if (!pdfjsRoot) return { error: "pdfjs-dist not found" };

  // Paper dims in mm (landscape: long=W, short=H)
  const PAPER_MM = {
    A2: [594,420], A3: [420,297], A4: [297,210], A5: [210,148],
    B4: [353,250], B5: [250,176],
    Letter: [279,216], Legal: [356,216], IndianLegal: [345,215],
    Tabloid: [432,279], Ledger: [432,279], Executive: [267,184],
  };
  const dims = PAPER_MM[paperSize] || PAPER_MM["A5"];
  const pgWmm = Math.max(...dims);
  const pgHmm = Math.min(...dims);
  const margin = typeof marginsMm === "number" ? marginsMm : 5;

  // Render at 150 DPI for a crisp but fast preview
  const DPI = 150;
  const mmToPx = DPI / 25.4;
  const canvasW = Math.round(pgWmm * mmToPx);
  const canvasH = Math.round(pgHmm * mmToPx);
  const availW  = Math.round((pgWmm - margin * 2) * mmToPx);
  const availH  = Math.round((pgHmm - margin * 2) * mmToPx);
  const offsetX = Math.round(margin * mmToPx);
  const offsetY = Math.round(margin * mmToPx);

  let buf;
  try {
    buf = toBuffer(pdfBuffer);
  } catch (e) {
    return { error: "Bad PDF buffer: " + e.message };
  }
  const pdfBase64   = buf.toString("base64");
  const pdfjsSrc    = path.join(pdfjsRoot, "build", "pdf.js").replace(/\\/g, "/");
  const pdfWorkerSrc = path.join(pdfjsRoot, "build", "pdf.worker.js").replace(/\\/g, "/");
  const pages = Array.isArray(pageNums) ? pageNums : [1];

  const rendererHtml = `<!DOCTYPE html><html><body style="margin:0;background:#fff">
<canvas id="c" width="${canvasW}" height="${canvasH}"></canvas>
<script src="file:///${pdfjsSrc}"></script>
<script>
(async () => {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'file:///${pdfWorkerSrc}';
    const data   = Uint8Array.from(atob('${pdfBase64}'), c => c.charCodeAt(0));
    const pdf    = await pdfjsLib.getDocument({ data }).promise;
    const pages  = ${JSON.stringify(pages)};
    const results = [];
    const canvas = document.getElementById('c');
    const ctx    = canvas.getContext('2d');
    for (const pgNum of pages) {
      canvas.width  = ${canvasW};
      canvas.height = ${canvasH};
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ${canvasW}, ${canvasH});
      const page = await pdf.getPage(pgNum);
      const vp1  = page.getViewport({ scale: 1 });
      const scale = Math.min(${availW} / vp1.width, ${availH} / vp1.height);
      const vp   = page.getViewport({ scale });
      // Centre the scaled page within the available area
      const dx = ${offsetX} + Math.round((${availW} - vp.width)  / 2);
      const dy = ${offsetY} + Math.round((${availH} - vp.height) / 2);
      const offscreen = document.createElement('canvas');
      offscreen.width  = Math.round(vp.width);
      offscreen.height = Math.round(vp.height);
      await page.render({ canvasContext: offscreen.getContext('2d'), viewport: vp }).promise;
      ctx.drawImage(offscreen, dx, dy);
      results.push(canvas.toDataURL('image/jpeg', 0.92));
    }
    window._previewResults = results;
    document.title = 'DONE:' + results.length;
  } catch(e) {
    document.title = 'ERROR:' + e.message;
  }
})();
</script></body></html>`;

  const htmlPath = path.join(os.tmpdir(), `inv_preview_${jobId}.html`);
  fs.writeFileSync(htmlPath, rendererHtml);

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: canvasW, height: canvasH,
      webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
    });
    const cleanup = () => { try { fs.unlinkSync(htmlPath); } catch (_) {} try { win.destroy(); } catch (_) {} };
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };

    win.webContents.on("page-title-updated", async (_, title) => {
      if (settled) return;
      if (title.startsWith("DONE:")) {
        try {
          const dataUrls = await win.webContents.executeJavaScript("window._previewResults");
          done({ pages: dataUrls, paperW: pgWmm, paperH: pgHmm });
        } catch (e) { done({ error: e.message }); }
      } else if (title.startsWith("ERROR:")) {
        done({ error: title.slice(6) });
      }
    });
    win.loadFile(htmlPath);
    setTimeout(() => done({ error: "Preview render timed out" }), 60000);
  });
});

// Print a PDF file directly to the Windows print spooler.
// Strategy: 1. SumatraPDF silent print  2. PowerShell spooler fallback
ipcMain.handle("print:printPdfFile", async (_, options = {}) => {
  const { spawn } = require("child_process");
  const os = require("os"); // declared once at top of handler

  const filePath = options.filePath;
  if (!filePath || !fs.existsSync(filePath)) {
    console.error("[print] PDF file not found:", filePath);
    return { success: false, error: "PDF file not found: " + filePath };
  }

  const printer = (options.deviceName || "").trim();
  const copies  = Math.max(1, parseInt(options.copies, 10) || 1);
  const paper   = options.pageSize || "A5";
  const orient  = (options.orientation || "landscape").toLowerCase(); // "landscape" or "portrait"
  const isLandscape = orient !== "portrait";

  // Physical paper dimensions in inches
  const PAPER_INCHES = {
    A2:          { w: 16.54, h: 23.39 },
    A3:          { w: 11.69, h: 16.54 },
    A4:          { w:  8.27, h: 11.69 },
    A5:          { w:  5.83, h:  8.27 },
    B4:          { w:  9.84, h: 13.90 },
    B5:          { w:  6.93, h:  9.84 },
    Letter:      { w:  8.50, h: 11.00 },
    Legal:       { w:  8.50, h: 14.00 },
    IndianLegal: { w:  8.46, h: 13.58 },
    Tabloid:     { w: 11.00, h: 17.00 },
    Ledger:      { w: 17.00, h: 11.00 },
    Executive:   { w:  7.25, h: 10.50 },
  };
  const paperDim = PAPER_INCHES[paper] || PAPER_INCHES["A5"];
  // Landscape: long edge = width, short edge = height; Portrait: opposite
  const paperW = isLandscape ? Math.max(paperDim.w, paperDim.h) : Math.min(paperDim.w, paperDim.h);
  const paperH = isLandscape ? Math.min(paperDim.w, paperDim.h) : Math.max(paperDim.w, paperDim.h);

  console.log("[print] filePath   :", filePath);
  console.log("[print] printer    :", printer || "(default)");
  console.log("[print] copies     :", copies);
  console.log("[print] paper      :", paper);
  console.log("[print] orientation:", orient);

  // ── 1. Check printer status ──
  if (printer) {
    try {
      const statusScript = `$p = Get-Printer -Name '${printer.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; if (-not $p) { Write-Output 'NOT_FOUND' } elseif ($p.PrinterStatus -eq 'Offline') { Write-Output 'OFFLINE' } elseif ($p.PrinterStatus -eq 'Paused') { Write-Output 'PAUSED' } else { Write-Output 'OK' }`;
      const statusResult = await new Promise((resolve) => {
        let out = "";
        const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", statusScript], { detached: false });
        proc.stdout && proc.stdout.on("data", d => { out += d.toString(); });
        proc.on("close", () => resolve(out.trim()));
        proc.on("error", () => resolve("OK"));
      });
      console.log("[print] printer status:", statusResult);
      if (statusResult === "NOT_FOUND") return { success: false, error: `Printer "${printer}" not found on this system.` };
      if (statusResult === "OFFLINE")   return { success: false, error: `Printer "${printer}" is offline. Please check the connection.` };
      if (statusResult === "PAUSED")    return { success: false, error: `Printer "${printer}" is paused. Please resume it and try again.` };
    } catch (e) {
      console.warn("[print] status check failed (non-fatal):", e.message);
    }
  }

  // Pass the original PDF bytes unchanged — preserves the PDF's own MediaBox
  // so SumatraPDF prints exactly what the preview renders, with no rescaling.
  let printFilePath = filePath;
  let tempRotatedPath = null;

  // If pageRanges are specified, extract only those pages into a new PDF
  // AND rotate each page to landscape so the MediaBox is wider than tall.
  // This ensures SumatraPDF receives a true landscape document.
  try {
    const { PDFDocument, degrees } = require("pdf-lib");
    const srcBytes = fs.readFileSync(filePath);
    const srcDoc = await PDFDocument.load(srcBytes);
    const outDoc = await PDFDocument.create();

    // Determine which 0-based page indices to include
    let pageIndices = [];
    if (options.pageRanges && options.pageRanges.length > 0) {
      for (const r of options.pageRanges) {
        for (let i = r.from; i <= r.to; i++) pageIndices.push(i);
      }
    } else {
      pageIndices = Array.from({ length: srcDoc.getPageCount() }, (_, i) => i);
    }

    const copied = await outDoc.copyPages(srcDoc, pageIndices);
    for (const page of copied) {
      const { width, height } = page.getSize();
      if (isLandscape && height > width) {
        // Portrait page → rotate to landscape
        page.setSize(height, width);
        page.translateContent(0, width);
        page.rotateContent(degrees(-90));
      } else if (!isLandscape && width > height) {
        // Landscape page → rotate to portrait
        page.setSize(height, width);
        page.translateContent(height, 0);
        page.rotateContent(degrees(90));
      }
      outDoc.addPage(page);
    }

    const outBytes = await outDoc.save();
    tempRotatedPath = path.join(app.getPath("temp"), `inv_landscape_${Date.now()}.pdf`);
    fs.writeFileSync(tempRotatedPath, outBytes);
    printFilePath = tempRotatedPath;
    console.log("[print] landscape PDF created:", tempRotatedPath, "pages:", pageIndices.length);
  } catch (pdfLibErr) {
    console.warn("[print] pdf-lib rotation failed (non-fatal), using original:", pdfLibErr.message);
    printFilePath = filePath;
    tempRotatedPath = null;
  }

  // ── 3. Try SumatraPDF ──
  const sumatraCandidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "app.asar.unpacked", "electron", "bin", "SumatraPDF.exe"),
        "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
        "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe",
        path.join(app.getPath("home"), "AppData", "Local", "SumatraPDF", "SumatraPDF.exe"),
      ]
    : [
        path.join(__dirname, "bin", "SumatraPDF.exe"),
        "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
        "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe",
        path.join(app.getPath("home"), "AppData", "Local", "SumatraPDF", "SumatraPDF.exe"),
      ];

  console.log("[PRINT] Packaged:", app.isPackaged);
  const sumatraExe = sumatraCandidates.find(p => {
    try { require("fs").realpathSync(p); return true; } catch (_) { return false; }
  });
  console.log("[PRINT] Sumatra path:", sumatraExe || "(not found)");
  console.log("[PRINT] Sumatra exists:", !!sumatraExe);

  if (sumatraExe) {
    console.log("[print] using SumatraPDF:", sumatraExe);

    // Force landscape on the printer via PowerShell DEVMODE before printing.
    // This overrides the printer driver's default orientation at the OS level
    // so even stubborn drivers (e.g. ImageForce 6155) honour landscape.
    if (printer) {
      const safePrinterName = printer.replace(/'/g, "''");
      const forceScript = `
try {
  $printerName = '${safePrinterName}'
  $orientVal = ${isLandscape ? 2 : 1}  # 1=Portrait, 2=Landscape
  Set-PrintConfiguration -PrinterName $printerName -PaperSize ${paper} -ErrorAction SilentlyContinue
  $wmi = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name='${safePrinterName}'" -ErrorAction SilentlyContinue
  if ($wmi) {
    $wmi.PrinterPreferences.Orientation = $orientVal
    $wmi.Put() | Out-Null
  }
  Write-Output 'OK'
} catch {
  Write-Output ('WARN:' + $_.Exception.Message)
}
`;
      await new Promise((resolve) => {
        let out = "";
        const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", forceScript], { detached: false, windowsHide: true });
        proc.stdout && proc.stdout.on("data", d => { out += d.toString(); });
        proc.on("close", () => { console.log("[print] DEVMODE landscape set:", out.trim()); resolve(); });
        proc.on("error", () => resolve());
      });
    }

    return new Promise((resolve) => {
      // SumatraPDF only accepts: A2 A3 A4 A5 A6 letter legal tabloid
      // Map everything else to the nearest supported size.
      const SUMATRA_PAPER_MAP = {
        A2: "A2", A3: "A3", A4: "A4", A5: "A5",
        B4: "A3", B5: "A4",
        Letter: "letter", Legal: "legal",
        IndianLegal: "A4",  // SumatraPDF has no Indian Legal — use A4+landscape+fit;
                             // the printer uses the actual paper loaded (345x215mm)
        Tabloid: "tabloid", Ledger: "tabloid", Executive: "letter",
      };
      const paperSetting = SUMATRA_PAPER_MAP[options.pageSize] || "A5";

      // Page ranges already handled by pdf-lib extraction above — don't pass again
      const orientSetting = isLandscape ? "landscape" : "portrait";
      const settings = `${copies}x,paper=${paperSetting},${orientSetting},fit`;

      const args = printer
        ? ["-print-to", printer, "-print-settings", settings, "-silent", "-exit-when-done", printFilePath]
        : ["-print-to-default", "-print-settings", settings, "-silent", "-exit-when-done", printFilePath];

      console.log("[print] SumatraPDF args:", args.join(" "));
      const proc = spawn(sumatraExe, args, { detached: false, windowsHide: true });
      let stderr = "";
      proc.stderr && proc.stderr.on("data", d => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (tempRotatedPath) { try { fs.unlinkSync(tempRotatedPath); } catch (_) {} }
        console.log("[print] SumatraPDF exit code:", code, stderr ? `stderr: ${stderr.trim()}` : "");
        resolve({ success: true });
      });
      proc.on("error", (err) => {
        if (tempRotatedPath) { try { fs.unlinkSync(tempRotatedPath); } catch (_) {} }
        console.error("[print] SumatraPDF spawn error:", err.message);
        resolve({ success: false, error: "SumatraPDF could not be started: " + err.message });
      });
    });
  }

  if (tempRotatedPath) { try { fs.unlinkSync(tempRotatedPath); } catch (_) {} }

  // ── 3. Electron hidden-window rasterise → PowerShell System.Drawing print ──
  // Renders each PDF page via pdfjs-dist in a hidden BrowserWindow (real DOM canvas),
  // captures PNGs via capturePage(), then prints via PowerShell System.Drawing.
  // Zero WinRT. Zero Windows.Storage. Zero external tools.
  console.log("[print] SumatraPDF not found — using hidden-window rasterise + PowerShell/GDI");

  const jobId = options.jobId || Date.now();

  // Locate pdfjs-dist — prefer app.asar.unpacked (set via asarUnpack in package.json)
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

  const pdfBase64   = fs.readFileSync(filePath).toString("base64");
  // Normalise to forward slashes for use inside file:// URLs
  const pdfjsSrc    = path.join(pdfjsRoot, "build", "pdf.js").replace(/\\/g, "/");
  const pdfWorkerSrc = path.join(pdfjsRoot, "build", "pdf.worker.js").replace(/\\/g, "/");

  // Render all pages in a hidden BrowserWindow; signal progress via document.title
  let pngPaths = [];
  try {
    pngPaths = await new Promise((resolve, reject) => {
      const renderWin = new BrowserWindow({
        show: false,
        width: 2480,   // A5 landscape at 300 DPI
        height: 1748,  // A5 landscape at 300 DPI
        webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
      });

      // Render each page at its natural PDF size (scale=1, 72dpi points → pixels).
      // The PowerShell GDI path scales to fit the paper, so rendering at natural
      // size preserves every pixel of content without any pre-clipping.
      const rendererHtml = `<!DOCTYPE html><html><body style="margin:0;background:#fff">
<canvas id="c"></canvas>
<script src="file:///${pdfjsSrc}"></script>
<script>
(async () => {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'file:///${pdfWorkerSrc}';
    const data = Uint8Array.from(atob('${pdfBase64}'), c => c.charCodeAt(0));
    const pdf  = await pdfjsLib.getDocument({ data }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page     = await pdf.getPage(i);
      // Use scale=2 for sharp output; GDI will scale-to-fit without cutting
      const viewport = page.getViewport({ scale: 2 });
      const canvas   = document.getElementById('c');
      canvas.width   = Math.round(viewport.width);
      canvas.height  = Math.round(viewport.height);
      document.body.style.width  = canvas.width  + 'px';
      document.body.style.height = canvas.height + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      document.title = 'PAGE_READY:' + i + ':' + pdf.numPages + ':' + canvas.width + ':' + canvas.height;
      await new Promise(r => setTimeout(r, 80));
    }
    document.title = 'ALL_DONE:' + pdf.numPages;
  } catch(e) {
    document.title = 'ERROR:' + e.message;
  }
})();
</script></body></html>`;

      const htmlPath = path.join(os.tmpdir(), `inv_render_${jobId}.html`);
      fs.writeFileSync(htmlPath, rendererHtml);

      const collectedPngs = [];
      let lastPageSeen = 0;
      let settled = false;

      // Always cancel the timeout and clean up before resolving/rejecting
      let timeoutHandle;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        renderWin.webContents.removeListener("page-title-updated", onTitle);
        if (!renderWin.isDestroyed()) renderWin.destroy();
        try { fs.unlinkSync(htmlPath); } catch (_) {}
        fn();
      };

      const onTitle = async (event, title) => {
        if (settled) return;
        try {
          if (title.startsWith("PAGE_READY:")) {
            const parts   = title.split(":");
            const pageNum = parseInt(parts[1]);
            const canvasW = parseInt(parts[3]);
            const canvasH = parseInt(parts[4]);
            if (pageNum > lastPageSeen) {
              lastPageSeen = pageNum;
              // Resize window to exact canvas size so capturePage() captures only the page
              if (!renderWin.isDestroyed()) {
                renderWin.setContentSize(canvasW, canvasH);
                // Give the resize a frame to settle before capturing
                await new Promise(r => setTimeout(r, 60));
              }
              if (settled) return;
              const img     = await renderWin.webContents.capturePage();
              const pngPath = path.join(os.tmpdir(), `inv_print_${jobId}_p${pageNum}.png`);
              fs.writeFileSync(pngPath, img.toPNG());
              collectedPngs.push({ pageNum, pngPath });
            }
          } else if (title.startsWith("ALL_DONE:")) {
            finish(() => {
              collectedPngs.sort((a, b) => a.pageNum - b.pageNum);
              resolve(collectedPngs.map(x => x.pngPath));
            });
          } else if (title.startsWith("ERROR:")) {
            finish(() => reject(new Error(title.slice(6))));
          }
        } catch (e) {
          finish(() => reject(e));
        }
      };

      renderWin.webContents.on("page-title-updated", onTitle);
      renderWin.loadFile(htmlPath);

      timeoutHandle = setTimeout(() => {
        finish(() => reject(new Error("PDF render timed out after 2 minutes")));
      }, 120000);
    });
  } catch (renderErr) {
    console.error("[print] rasterise failed:", renderErr.message);
    return { success: false, error: "Print failed: could not rasterise PDF. " + renderErr.message };
  }

  if (!pngPaths.length) {
    return { success: false, error: "Print failed: no pages were rendered from the PDF." };
  }
  console.log("[print] rasterised", pngPaths.length, "page(s)");

  // PowerShell: print PNG files via System.Drawing.Printing — no WinRT at all
  const safePrinter = printer.replace(/'/g, "''");
  const pngList     = pngPaths.map(p => `'${p.replace(/\\/g, "\\\\").replace(/'/g, "''")}' `).join(",");
  const psScriptPath = path.join(os.tmpdir(), `inv_ps_${jobId}.ps1`);
  // paperW/paperH are in inches (landscape: long=width, short=height)
  const psScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing | Out-Null
  $pngFiles    = @(${pngList})
  $printerName = '${safePrinter}'
  $copies      = ${copies}
  # Target paper in inches (landscape)
  $targetW     = ${paperW}
  $targetH     = ${paperH}

  $pd = New-Object System.Drawing.Printing.PrintDocument
  if ($printerName -ne '') {
    $pd.PrinterSettings.PrinterName = $printerName
    if (-not $pd.PrinterSettings.IsValid) {
      Write-Host ('FAIL:PRINTER_INVALID:' + $printerName); exit 3
    }
  }
  $pd.PrinterSettings.Copies = [Math]::Min($copies, [int16]::MaxValue)

  # Set default page settings to correct orientation + paper size
  $isLandscape = $${isLandscape ? 'true' : 'false'}
  $pd.DefaultPageSettings.Landscape = $isLandscape
  # Find the matching PaperSize from the printer's supported sizes
  $targetW100 = [int]($targetW * 100)
  $targetH100 = [int]($targetH * 100)
  $matchedPaper = $null
  foreach ($ps in $pd.PrinterSettings.PaperSizes) {
    $psW = $ps.Width; $psH = $ps.Height
    if ($isLandscape) {
      $psLong  = [Math]::Max($psW, $psH)
      $psShort = [Math]::Min($psW, $psH)
      if ([Math]::Abs($psLong - $targetW100) -le 20 -and [Math]::Abs($psShort - $targetH100) -le 20) {
        $matchedPaper = $ps; break
      }
    } else {
      $psShort = [Math]::Min($psW, $psH)
      $psLong  = [Math]::Max($psW, $psH)
      if ([Math]::Abs($psShort - $targetW100) -le 20 -and [Math]::Abs($psLong - $targetH100) -le 20) {
        $matchedPaper = $ps; break
      }
    }
  }
  if ($matchedPaper) {
    $pd.DefaultPageSettings.PaperSize = $matchedPaper
    Write-Host ('PAPER_MATCHED:' + $matchedPaper.PaperName)
  } else {
    # Fallback: create a custom paper size
    $custom = New-Object System.Drawing.Printing.PaperSize('Custom', $targetW100, $targetH100)
    $pd.DefaultPageSettings.PaperSize = $custom
    Write-Host 'PAPER_CUSTOM'
  }

  $script:pageIndex = 0
  $pd.add_PrintPage({
    param($sender, $ev)
    $bmp = [System.Drawing.Bitmap]::FromFile($pngFiles[$script:pageIndex])
    $bmp.SetResolution(300, 300)
    $pdfInchW = $bmp.Width  / 300.0
    $pdfInchH = $bmp.Height / 300.0
    $ev.PageSettings.Landscape = $isLandscape
    $ev.Graphics.PageUnit          = [System.Drawing.GraphicsUnit]::Inch
    $ev.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $ev.Graphics.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $ev.Graphics.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    # Printable area in inches (PageBounds is in 1/100 inch units)
    $printW  = $ev.PageBounds.Width  / 100.0
    $printH  = $ev.PageBounds.Height / 100.0
    $marginL = $ev.PageSettings.HardMarginX / 100.0
    $marginT = $ev.PageSettings.HardMarginY / 100.0
    $scaleX  = $printW / $pdfInchW
    $scaleY  = $printH / $pdfInchH
    $scale   = [Math]::Min($scaleX, $scaleY)
    $drawW   = $pdfInchW * $scale
    $drawH   = $pdfInchH * $scale
    $drawX   = $marginL + ($printW - $drawW) / 2.0
    $drawY   = $marginT + ($printH - $drawH) / 2.0
    $ev.Graphics.DrawImage($bmp, [System.Drawing.RectangleF]::new(
      [float]$drawX, [float]$drawY, [float]$drawW, [float]$drawH))
    $bmp.Dispose()
    $script:pageIndex++
    $ev.HasMorePages = ($script:pageIndex -lt $pngFiles.Count)
  })
  $pd.Print()
  $pd.Dispose()
  Write-Host 'SUCCESS'
} catch {
  Write-Host ('FAIL:' + $_.Exception.Message); exit 1
}
`;

  try { fs.writeFileSync(psScriptPath, psScript, "utf8"); } catch (e) {
    pngPaths.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
    return { success: false, error: "Print failed: could not write PS script. " + e.message };
  }

  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psScriptPath],
      { detached: false }
    );
    proc.stdout && proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr && proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("close", (code) => {
      pngPaths.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
      try { fs.unlinkSync(psScriptPath); } catch (_) {}
      const out = stdout.trim();
      console.log("[print] PowerShell exit:", code, out);
      if (stderr) console.error("[print] stderr:", stderr.trim());
      if (out.includes("SUCCESS")) { resolve({ success: true }); return; }
      const raw = out || stderr.trim() || `PowerShell exited with code ${code}`;
      console.error("[print] error:", raw);
      resolve({ success: false, error: "Print failed: " + raw });
    });
    proc.on("error", (err) => {
      pngPaths.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
      try { fs.unlinkSync(psScriptPath); } catch (_) {}
      resolve({ success: false, error: "Print failed: " + err.message });
    });
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
        preload: getElectronAsset("login-preload.js"),
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

  win.webContents.on("console-message", (event, level, message, line, sourceId) => {
    console.log(`[Renderer Log] [${level}] ${message} (line ${line} in ${sourceId})`);
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
    if (distIndex && fs.existsSync(distIndex)) win.loadFile(distIndex);
  });
}

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

app.on("before-quit", () => saveDb(true));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
