import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as XLSX from "xlsx";
import {
  Upload, Trash2, Download, FileText, Loader2,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Eye, FileSpreadsheet, Menu, X, ZoomIn, ZoomOut, Printer,
  ChevronDown, ChevronUp, Check, SlidersHorizontal
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerRaw from "pdfjs-dist/build/pdf.worker.min.js?raw";

try {
  const blob = new Blob([pdfjsWorkerRaw], { type: "application/javascript" });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
} catch (e) {
  console.warn("Could not create Blob URL for PDF worker:", e);
}

const COPY_TYPES = ["original", "duplicate", "triplicate"];

const TAG_STYLES = {
  original: "bg-teal-50 text-teal-700 border-teal-200",
  duplicate: "bg-amber-50 text-amber-700 border-amber-200",
  triplicate: "bg-purple-50 text-purple-700 border-purple-200",
  unknown: "bg-slate-100 text-slate-500 border-slate-200",
};

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

// In‑memory cache for PDF buffers when running in a pure web environment.
const pdfCache = new Map();
// Shared parsed PDF document cache — all LazyThumb tiles for the same PDF reuse one doc
const pdfDocCache = new Map();
async function getSharedPdfDoc(pdfBuf) {
  if (pdfDocCache.has(pdfBuf)) return pdfDocCache.get(pdfBuf);
  const docPromise = pdfjsLib.getDocument({ data: pdfBuf.slice(0) }).promise;
  pdfDocCache.set(pdfBuf, docPromise);
  return docPromise;
}
// A5 landscape: 210mm × 148mm at 96 dpi → 794 × 559 px
const A5_W_PX = 794;
const A5_H_PX = 559;

/**
 * LazyThumb — renders a PDF page thumbnail only when it enters the viewport.
 */
function LazyThumb({ pdfBuf, pageNum, scale = 0.55 }) {
  const [src, setSrc] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!pdfBuf || !pageNum) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting) return;
      obs.disconnect();
      try {
        const pdf = await getSharedPdfDoc(pdfBuf);
        const pg = await pdf.getPage(pageNum);
        const vp = pg.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        await pg.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        setSrc(canvas.toDataURL("image/jpeg", 0.7));
      } catch (_) {}
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pdfBuf, pageNum, scale]);
  return <div ref={ref} className="w-full">{src ? <img src={src} alt={`page ${pageNum}`} className="w-full block" /> : <div className="w-full bg-slate-100 animate-pulse" style={{ aspectRatio: "0.707" }} />}</div>;
}

/**
 * CopyCanvas — renders one PDF page with correct A5-landscape fit.
 *
 * Layout strategy (no clipping, full scroll):
 *   - The outer wrapper has a fixed A5-proportioned height (A5_H_PX) so the viewer
 *     card has a stable size at fit scale.
 *   - The inner div is overflow-auto, so when zoom > 1 the canvas grows and both
 *     horizontal AND vertical scrollbars appear inside that fixed-height box.
 *   - fitScale = Math.min(containerW / pdfW, A5_H_PX / pdfH)  for "page" mode
 *   - fitScale = containerW / pdfW                              for "width" mode
 *   - renderScale = fitScale * zoom  →  zoom=1 always = 100%, zoom=1.25 = 125%
 *   - ResizeObserver recalculates fitScale whenever the container width changes.
 *   - naturalSizeRef caches the PDF dimensions so re-renders on zoom never re-parse.
 */
function CopyCanvas({ pdfBuf, pageNum, label, zoom, fitMode, onFitScale }) {
  const canvasRef    = useRef(null);
  const wrapperRef   = useRef(null);   // the overflow-auto scroll box
  const renderTask   = useRef(null);
  const naturalSize  = useRef(null);   // { w, h } at scale=1, cached after first load
  const pdfDocRef    = useRef(null);   // cached pdf document
  const latestRender = useRef(0);      // monotonic counter to discard stale renders

  // Load (or reuse) the pdf document and cache natural page size
  const getPdfAndSize = useCallback(async (buf, pgNum) => {
    if (!pdfDocRef.current) {
      pdfDocRef.current = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    }
    if (!naturalSize.current) {
      const pg = await pdfDocRef.current.getPage(pgNum);
      const vp = pg.getViewport({ scale: 1 });
      naturalSize.current = { w: vp.width, h: vp.height };
    }
    return { pdf: pdfDocRef.current, nat: naturalSize.current };
  }, []);

  // Paint the canvas at the given renderScale
  const paint = useCallback(async (buf, pgNum, renderScale, ticket) => {
    if (renderTask.current) { renderTask.current.cancel(); renderTask.current = null; }
    const { pdf } = await getPdfAndSize(buf, pgNum);
    if (ticket !== latestRender.current) return; // superseded
    const pg = await pdf.getPage(pgNum);
    const canvas = canvasRef.current;
    if (!canvas || ticket !== latestRender.current) return;

    const scaled = pg.getViewport({ scale: renderScale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(scaled.width  * dpr);
    canvas.height = Math.round(scaled.height * dpr);
    canvas.style.width  = `${scaled.width}px`;
    canvas.style.height = `${scaled.height}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const task = pg.render({ canvasContext: ctx, viewport: scaled });
    renderTask.current = task;
    try { await task.promise; } catch (e) { if (e?.name !== "RenderingCancelledException") console.error(e); }
  }, [getPdfAndSize]);

  // Compute fitScale from current container width
  const computeAndRender = useCallback(async (containerW) => {
    if (!pdfBuf || !pageNum || !containerW) return;
    const { nat } = await getPdfAndSize(pdfBuf, pageNum);
    const fitW = containerW / nat.w;
    const fitH = A5_H_PX   / nat.h;   // A4 landscape height is the reference for "page" fit
    const fitScale = fitMode === "width" ? fitW : Math.min(fitW, fitH);
    if (onFitScale) onFitScale(fitScale);
    const ticket = ++latestRender.current;
    await paint(pdfBuf, pageNum, fitScale * zoom, ticket);
  }, [pdfBuf, pageNum, zoom, fitMode, getPdfAndSize, paint, onFitScale]);

  // Re-render whenever pdfBuf / pageNum / zoom / fitMode change
  useEffect(() => {
    if (!pdfBuf || !pageNum) return;
    // Reset cached doc/size when the source PDF or page changes
    pdfDocRef.current  = null;
    naturalSize.current = null;
    const w = wrapperRef.current?.clientWidth || A5_W_PX;
    computeAndRender(w);
    return () => {
      if (renderTask.current) { renderTask.current.cancel(); renderTask.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBuf, pageNum]);

  // Re-render on zoom / fitMode change (reuse cached doc + size)
  useEffect(() => {
    if (!pdfBuf || !pageNum) return;
    const w = wrapperRef.current?.clientWidth || A5_W_PX;
    computeAndRender(w);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, fitMode]);

  // ResizeObserver: recalculate fitScale when container width changes
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) computeAndRender(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBuf, pageNum, zoom, fitMode]);

  return (
    <div className="w-full">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
        {label}
      </div>
      {/*
        Fixed A5-height scroll box.
        - overflow-auto → scrollbars appear in BOTH axes when canvas > box.
        - No overflow-hidden anywhere in this subtree.
        - Height = A5_H_PX so the viewer card has a stable, predictable size.
        - When zoom > 1 the canvas grows inside this box and both scrollbars appear.
      */}
      <div
        ref={wrapperRef}
        style={{ height: A5_H_PX }}
        className="w-full overflow-auto rounded-lg border border-slate-200 shadow-sm bg-slate-100"
      >
        {/* Inner div: at least as wide/tall as the scroll box so canvas is centred at fit scale */}
        <div
          className="flex items-center justify-center"
          style={{ minWidth: "100%", minHeight: "100%", width: "max-content", height: "max-content", padding: "8px" }}
        >
          <canvas ref={canvasRef} className="block shadow-md bg-white flex-none" />
        </div>
      </div>
    </div>
  );
}

/** LazyCopyCanvas — mounts CopyCanvas only when scrolled into view, shows placeholder until then */
function LazyCopyCanvas({ pdfBuf, pageNum, zoom, fitMode, onFitScale, onPrint }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: "300px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-slate-500 px-1">
        <span className="font-medium">Page {pageNum}</span>
        <button onClick={onPrint} className="inline-flex items-center gap-1 text-[11px] text-teal-600 hover:underline">
          <Printer size={11} /> Print Page {pageNum}
        </button>
      </div>
      {visible
        ? <CopyCanvas pdfBuf={pdfBuf} pageNum={pageNum} label="" zoom={zoom} fitMode={fitMode} onFitScale={onFitScale} />
        : <div className="w-full bg-slate-100 animate-pulse rounded-lg" style={{ height: A5_H_PX }} />}
    </div>
  );
}

export default function InvoiceCopyManager() {
  // "upload" = upload page, "files" = file list page, "viewer" = viewer page
  const [page, setPage] = useState("upload");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [files, setFiles] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [selectedCopyTypes, setSelectedCopyTypes] = useState(new Set(["original", "duplicate"]));
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState("page");
  const [fitScale, setFitScale] = useState(1);
  const [selectedPageNums, setSelectedPageNums] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const fileInputRef = useRef(null);
  const toastTimer = useRef(null);
  const [paperSize, setPaperSize] = useState("A5");
  const [orientation, setOrientation] = useState("landscape");
  const [cancelRequested, setCancelRequested] = useState(false);
  const [processingTotal, setProcessingTotal] = useState(0);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [isExecutingPrint, setIsExecutingPrint] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const totalPages = Math.ceil(files.length / pageSize) || 1;
  const validCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (validCurrentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedFiles = files.slice(startIndex, endIndex);

  const totalPagesCount = useMemo(() => files.reduce((s, f) => s + (f.pageCount || 0), 0), [files]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [files.length, pageSize, currentPage, totalPages]);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), 2600);
  }, []);

  const regenerateThumbs = useCallback(async (record, pdfBuf) => {
    // Return pages immediately with null thumbs; thumbnails are rendered lazily per-tile
    return record.pages.map(p => ({ ...p, thumb: null }));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const rows = await window.db.list();
        const records = rows.map(m => ({ ...m, pages: m.pages.map(p => ({ pageNum: p.pageNum, type: p.type, thumb: null })), restored: true }));
        setFiles(records);
      } catch (e) { console.warn("db list failed", e); }
    })();
  }, []);

  const persistRecord = useCallback(async (record) => {
    try {
      await window.db.save({
        id: record.id, name: record.name, uploadedAt: record.uploadedAt,
        invoiceNo: record.invoiceNo, pageCount: record.pageCount,
        pages: record.pages.map(p => ({ pageNum: p.pageNum, type: p.type })),
        pdfBuffer: new Uint8Array(record._pdfBuf),
      });
    } catch (e) { console.warn("db save failed", e); }
  }, []);

  const processFile = useCallback(async (file, onProgress) => {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const record = {
      id: "f" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name: file.name, uploadedAt: new Date().toLocaleString(),
      invoiceNo: null, pageCount: pdf.numPages, pages: [], restored: false,
    };
    const rawPages = new Array(pdf.numPages);
    // Extract text with concurrency=4 to avoid blocking the main thread
    const TEXT_CONCURRENCY = 4;
    let nextPage = 1;
    const extractNext = async () => {
      while (nextPage <= pdf.numPages) {
        const i = nextPage++;
        if (onProgress && i % 10 === 1) onProgress(`Reading ${file.name} — page ${i}/${pdf.numPages}`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(it => it.str).join(" ").replace(/\s+/g, " ");
        rawPages[i - 1] = { pageNum: i, text, thumb: null };
        // Yield to browser every 20 pages
        if (i % 20 === 0) await new Promise(r => setTimeout(r, 0));
      }
    };
    await Promise.all(Array.from({ length: TEXT_CONCURRENCY }, extractNext));
    for (const { text } of rawPages) {
      if (!record.invoiceNo) {
        const m = text.match(/Invoice\s*No\.?\s*:?\s*([A-Za-z0-9\-/]+)/i);
        if (m) record.invoiceNo = m[1];
      }
    }
    const POSITIONAL_TYPES = ["original", "duplicate", "triplicate"];
    for (const { pageNum, text } of rawPages) {
      let type = "unknown";
      const t = text.toLowerCase();
      if (t.includes("triplicate")) type = "triplicate";
      else if (t.includes("duplicate")) type = "duplicate";
      else if (t.includes("original")) type = "original";

      // If text detection failed, use YOLO/OCR visual detection
      if (type === "unknown" && window.detect) {
        try {
          if (onProgress) {
            onProgress(`Detecting copy type on page ${pageNum} (visual scan)…`);
          }
          const result = await window.detect.copyType(new Uint8Array(buf), pageNum);
          if (result?.type && result.type !== "unknown") type = result.type;
        } catch (e) { console.warn("YOLO detect failed", e); }
      }

      record.pages.push({ pageNum, type, thumb: null });
    }

    // Positional fallback: if PDF has exactly 3 pages and they don't each have a distinct
    // copy type (e.g. all unknown, or all same type), assign page 1=original, 2=duplicate, 3=triplicate
    if (record.pages.length === 3) {
      const types = record.pages.map(p => p.type);
      const distinctTypes = new Set(types.filter(t => t !== "unknown"));
      const hasAllThree = POSITIONAL_TYPES.every(t => distinctTypes.has(t));
      if (!hasAllThree) {
        record.pages = record.pages.map((p, i) => ({ ...p, type: POSITIONAL_TYPES[i] }));
      }
    }
    record._pdfBuf = buf;
    return record;
  }, []);

  const handleFiles = useCallback(async (fileArr) => {
    if (!fileArr.length) return;
    setLoading(true);
    setCancelRequested(false);
    
    const totalFiles = fileArr.length;
    setProcessingTotal(totalFiles);
    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    
    const BATCH_SIZE = 100;
    const CONCURRENCY = 5;
    
    setLoadingText(`Starting upload of ${totalFiles} file(s)...`);
    setProcessingProgress(0);
    
    let currentBatch = [];
    
    for (let i = 0; i < totalFiles; i++) {
      if (cancelRequested) break; // stop if cancellation requested
      const file = fileArr[i];
      if (file.type !== "application/pdf") {
        toast(`${file.name} is not a PDF — skipped`);
        processedCount++;
        failedCount++;
        continue;
      }
      
      currentBatch.push(file);
      
      if (currentBatch.length === BATCH_SIZE || i === totalFiles - 1) {
        setLoadingText(`Processing batch ${Math.floor(processedCount / BATCH_SIZE) + 1} (${processedCount}-${Math.min(processedCount + currentBatch.length, totalFiles)} of ${totalFiles})...`);
        
        const batchRecords = [];
        let batchIndex = 0;
        
        const runNext = async () => {
          if (batchIndex >= currentBatch.length) return;
          const currentFile = currentBatch[batchIndex++];
          try {
            const record = await processFile(currentFile, (txt) => {
              setLoadingText(`[${processedCount + 1}/${totalFiles}] ${txt}`);
            });
            batchRecords.push(record);
            successCount++;
          } catch (e) {
            console.error(`Error processing ${currentFile.name}:`, e);
            failedCount++;
          } finally {
            processedCount++;
            setProcessingProgress(processedCount);
          };
          if (!cancelRequested) await runNext();
        };
        
        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, currentBatch.length); w++) {
          workers.push(runNext());
        }
        await Promise.all(workers);
        
        if (batchRecords.length > 0) {
          // Store PDF buffers in the in‑memory cache. This avoids hitting the
          // localStorage quota when the app runs in a pure browser.
          batchRecords.forEach(r => {
            try {
              const buf = new Uint8Array(r._pdfBuf);
              pdfCache.set(r.id, buf);
            } catch (_) {
              // If conversion fails we simply skip caching – the PDF will not be viewable.
            }
          });

          const batchToSave = batchRecords.map(r => ({
            id: r.id,
            name: r.name,
            uploadedAt: r.uploadedAt,
            invoiceNo: r.invoiceNo,
            pageCount: r.pageCount,
            pages: r.pages.map(p => ({ pageNum: p.pageNum, type: p.type })),
            // In web mode we omit the heavy pdfBuffer payload to keep storage light.
            pdfBuffer: window?.db ? new Uint8Array(r._pdfBuf) : undefined,
          }));

          try {
            await window.db.saveBatch(batchToSave);
          } catch (e) {
            if (e.name === "QuotaExceededError") {
              console.warn("LocalStorage quota exceeded – PDF data stored only in memory.");
            } else {
              throw e;
            }
          }
            
          const cleanMetadata = batchRecords.map(r => {
            const { _pdfBuf, ...meta } = r;
            return meta;
          });
            
          setFiles(prev => [...cleanMetadata, ...prev]);
            
          if (cleanMetadata.length > 0) {
            setActiveId(cleanMetadata[cleanMetadata.length - 1].id);
          }
        }
        
        currentBatch = [];
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    setLoading(false);
    toast(`Upload complete: ${successCount} processed, ${failedCount} failed.`);
    setPage("files");
    setProcessingProgress(0);
    setProcessingTotal(0);
    setCancelRequested(false);
  }, [processFile, toast]);

  const onInputChange = (e) => { handleFiles([...e.target.files]); e.target.value = ""; };
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]); };

  const removeFile = async (id) => {
    try { await window.db.delete(id); } catch (e) { console.warn("db delete failed", e); }
    pdfCache.delete(id);
    setFiles(prev => prev.filter(f => f.id !== id));
    setSelectedFiles(prev => { const n = new Set(prev); n.delete(id); return n; });
    if (activeId === id) { setActiveId(null); setPage("files"); }
    toast("File removed");
  };

  const downloadPdf = async (f, filterTypes = null, exportOrientation = orientation) => {
    // Prefer the in‑memory cache first, then fall back to the DB bridge.
    let buf = pdfCache.get(f.id) || f._pdfBuf;
    if (!buf) {
      try { buf = await window.db.getPdf(f.id); } catch (e) { /* ignore */ }
    }
    if (!buf) {
      toast("PDF not available");
      return;
    }

    const typesToInclude = filterTypes || [...selectedCopyTypes];
    const pageNums = f.pages
      .filter(p => typesToInclude.includes(p.type))
      .map(p => p.pageNum);

    const allPageNums = f.pages.map(p => p.pageNum);
    const isAll = pageNums.length === allPageNums.length &&
      pageNums.every((n, i) => n === allPageNums[i]);
    const needsFilter = !isAll && pageNums.length > 0;
    const needsLandscape = exportOrientation === "landscape";

    if (needsFilter || needsLandscape) {
      try {
        const { PDFDocument, degrees } = await import("pdf-lib");
        const srcDoc = await PDFDocument.load(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
        const outDoc = await PDFDocument.create();
        const indices = needsFilter ? pageNums.map(n => n - 1) : allPageNums.map(n => n - 1);
        const copied = await outDoc.copyPages(srcDoc, indices);
        for (const page of copied) {
          if (needsLandscape) {
            const { width, height } = page.getSize();
            if (height > width) {
              // Swap MediaBox so width > height (true landscape page dimensions)
              page.setSize(height, width);
              // Rotate content to match new orientation
              page.translateContent(0, width);
              page.rotateContent(degrees(-90));
            }
          }
          outDoc.addPage(page);
        }
        const outBytes = await outDoc.save();
        const blob = new Blob([outBytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const suffix = needsFilter ? typesToInclude.map(t => t[0].toUpperCase()).join("") : "";
        const orientSuffix = needsLandscape ? "_landscape" : "";
        a.href = url;
        a.download = f.name.replace(/\.pdf$/i, `${suffix ? `_${suffix}` : ""}${orientSuffix}.pdf`);
        a.click();
        URL.revokeObjectURL(url);
        toast(`Downloaded ${needsFilter ? pageNums.length : allPageNums.length} page(s)${needsLandscape ? " (landscape)" : ""}`);
        return;
      } catch (e) {
        console.warn("pdf-lib export failed, downloading full PDF:", e);
      }
    }

    const blob = new Blob([buf], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = f.name; a.click();
    URL.revokeObjectURL(url);
    toast("PDF downloaded");
  };

  const viewFile = async (f) => {
    setActiveId(f.id);
    const available = new Set(COPY_TYPES.filter(t => f.pages.some(p => p.type === t)));
    setSelectedCopyTypes(available.size ? available : new Set(["original"]));
    setZoom(1);
    setFitScale(1);
    setFitMode("page");
    setPage("viewer");

    let buf = f._pdfBuf || pdfCache.get(f.id);
    if (!buf) {
      try {
        buf = await window.db?.getPdf(f.id);
      } catch (e) {
        console.error("Failed to load PDF on view:", e);
      }
    }

    if (buf) {
      if (!f._pdfBuf || f.pages.some(p => !p.thumb)) {
        setLoading(true);
        setLoadingText("Loading PDF and generating thumbnails…");
        try {
          const pages = await regenerateThumbs(f, buf);
          setFiles(prev => prev.map(item => item.id === f.id ? { ...item, _pdfBuf: buf, pages, restored: false } : item));
        } catch (e) {
          console.error("Failed to generate thumbs:", e);
        } finally {
          setLoading(false);
        }
      }
    } else if (f.restored) {
      toast("PDF data not available in memory or disk");
    }
  };

  const exportExcel = (targetFiles) => {
    const list = targetFiles || files;
    if (!list.length) { toast("Nothing to export"); return; }
    const rows = list.map((f, idx) => {
      const listPages = t => f.pages.filter(p => p.type === t).map(p => p.pageNum).join(", ");
      return {
        "S.No": idx + 1, "File Name": f.name, "Uploaded At": f.uploadedAt,
        "Invoice No": f.invoiceNo || "", "Total Pages": f.pageCount,
        "Original Page(s)": listPages("original"), "Duplicate Page(s)": listPages("duplicate"),
        "Triplicate Page(s)": listPages("triplicate"), "Unclassified Page(s)": listPages("unknown"),
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 6 }, { wch: 28 }, { wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Invoice Register");
    const summary = XLSX.utils.json_to_sheet([{
      "Total PDFs": list.length,
      "Total Pages": list.reduce((s, f) => s + f.pageCount, 0),
      "Original Pages": list.reduce((s, f) => s + f.pages.filter(p => p.type === "original").length, 0),
      "Duplicate Pages": list.reduce((s, f) => s + f.pages.filter(p => p.type === "duplicate").length, 0),
      "Triplicate Pages": list.reduce((s, f) => s + f.pages.filter(p => p.type === "triplicate").length, 0),
      "Exported At": new Date().toLocaleString(),
    }]);
    XLSX.utils.book_append_sheet(wb, summary, "Summary");
    XLSX.writeFile(wb, `invoice_register_${Date.now()}.xlsx`);
    toast("Excel exported");
  };

  const activeFile = files.find(f => f.id === activeId) || null;
  const selectedFilesList = files.filter(f => selectedFiles.has(f.id));

  const toggleFileSel = (id) => setSelectedFiles(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAllFiles = () => {
    if (selectedFiles.size === files.length) setSelectedFiles(new Set());
    else setSelectedFiles(new Set(files.map(f => f.id)));
  };

  const printingRef = useRef(false);

  const openSystemPrint = useCallback(async (file, pageNums) => {
    if (printingRef.current) return;
    printingRef.current = true;
    toast("Opening print dialog\u2026");
    try {
      let buf = file._pdfBuf || pdfCache.get(file.id);
      if (!buf) { try { buf = await window.db?.getPdf(file.id); } catch (_) {} }
      if (!buf) { toast("PDF not available for printing"); return; }
      let pdfBytes;
      if (buf instanceof Uint8Array) {
        pdfBytes = (buf.byteOffset !== 0 || buf.buffer.byteLength !== buf.byteLength) ? new Uint8Array(buf) : buf;
      } else {
        pdfBytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf);
      }
      const allPageNums = Array.from({ length: file.pageCount }, (_, i) => i + 1);
      const isAllPages = pageNums.length === file.pageCount && pageNums.every((n, i) => n === allPageNums[i]);
      let pageRanges;
      if (!isAllPages) {
        const sorted = [...pageNums].sort((a, b) => a - b);
        pageRanges = [];
        let start = sorted[0], end = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] === end + 1) { end = sorted[i]; }
          else { pageRanges.push({ from: start - 1, to: end - 1 }); start = end = sorted[i]; }
        }
        pageRanges.push({ from: start - 1, to: end - 1 });
      }
      if (window.printAPI?.openSystemDialog) {
        const result = await window.printAPI.openSystemDialog(pdfBytes, pageRanges);
        if (!result?.success) toast(`Print error: ${result?.error || "Unknown error"}`);
      } else {
        toast("Printing is only available inside the Invoice Manager desktop app.");
      }
    } catch (err) {
      toast(`Print error: ${err.message || "Unknown error"}`);
    } finally {
      printingRef.current = false;
    }
  }, [toast]);

  const printPages = useCallback((f, pageNums) => {
    openSystemPrint(f, pageNums);
  }, [openSystemPrint]);

  const bulkPrint = useCallback(async (filesToPrint) => {
    if (!filesToPrint.length) return;
    setIsExecutingPrint(true);
    for (const f of filesToPrint) {
      printingRef.current = false;
      await openSystemPrint(f, f.pages.map(p => p.pageNum));
    }
    setIsExecutingPrint(false);
  }, [openSystemPrint]);

  const openPrintModal = useCallback((file, pageNums) => {
    if (!file || !pageNums || !pageNums.length) return;
    openSystemPrint(file, pageNums);
  }, [openSystemPrint]);



  const csvEscape = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const downloadCsv = (selectAll = false) => {
    if (!activeFile) return;
    let rows;
    if (selectAll) {
      rows = activeFile.pages.filter(p => selectedCopyTypes.has(p.type));
      setSelectedPageNums(new Set(rows.map(p => p.pageNum)));
    } else {
      rows = activeFile.pages.filter(
        p => selectedCopyTypes.has(p.type) && selectedPageNums.has(p.pageNum)
      );
    }
    if (!rows.length) {
      toast("Please select at least one page to export.");
      return;
    }
    const headers = ["File Name", "Invoice No", "Uploaded At", "Total Pages", "Page Number", "Copy Type"];
    const lines = [
      headers.map(csvEscape).join(","),
      ...rows.map(p =>
        [activeFile.name, activeFile.invoiceNo || "", activeFile.uploadedAt, activeFile.pageCount, p.pageNum, p.type]
          .map(csvEscape).join(",")
      ),
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "INV_COP1_selected_pages.csv"; a.click();
    URL.revokeObjectURL(url);
    toast(`CSV exported: ${rows.length} page(s)`);
  };

  const togglePageNum = (num) => setSelectedPageNums(prev => {
    const n = new Set(prev); n.has(num) ? n.delete(num) : n.add(num); return n;
  });

  const visiblePages = activeFile
    ? COPY_TYPES.filter(t => selectedCopyTypes.has(t)).flatMap(t => activeFile.pages.filter(p => p.type === t))
    : [];

  const toggleCopyType = (type) => {
    setSelectedCopyTypes(prev => { const n = new Set(prev); n.has(type) ? n.delete(type) : n.add(type); return n; });
    setSelectedPageNums(new Set());
  };

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden">

      {/* ── SIDEBAR ── */}
      <aside className={`flex-none flex flex-col bg-slate-900 text-slate-100 transition-all duration-300 ${sidebarOpen ? "w-64" : "w-0 overflow-hidden"}`}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-700">
          <div className="w-8 h-8 rounded-lg bg-teal-500 flex items-center justify-center font-bold text-white text-sm flex-none">IC</div>
          <div>
            <div className="font-semibold text-sm leading-tight">Invoice Copy</div>
            <div className="text-[10px] text-slate-400 leading-tight">Register</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-1 p-3 flex-1">
          <button onClick={() => setPage("upload")}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${page === "upload" ? "bg-teal-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>
            <Upload size={16} /> Upload PDF
          </button>
          <button onClick={() => setPage("files")}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${page === "files" || page === "viewer" ? "bg-teal-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>
            <FileText size={16} /> File Register
            {files.length > 0 && <span className="ml-auto bg-slate-700 text-slate-200 text-[10px] font-mono px-1.5 py-0.5 rounded-full">{files.length}</span>}
          </button>
        </nav>

        {/* Stats */}
        <div className="p-4 border-t border-slate-700 grid grid-cols-2 gap-3">
          <div className="bg-slate-800 rounded-lg p-2.5 text-center">
            <div className="text-lg font-bold text-teal-400">{files.length}</div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wide">PDFs</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-2.5 text-center">
            <div className="text-lg font-bold text-teal-400">{totalPagesCount}</div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wide">Pages</div>
          </div>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Topbar */}
        <header className="flex-none flex items-center gap-3 px-5 py-3.5 bg-white border-b border-slate-200 shadow-sm">
          <button onClick={() => setSidebarOpen(o => !o)} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="flex-1">
            <h1 className="font-semibold text-base leading-tight">
              {page === "upload" && "Upload Invoice PDF"}
              {page === "files" && "File Register"}
              {page === "viewer" && (activeFile?.name || "Copy Viewer")}
            </h1>
            {page === "viewer" && activeFile && (
              <div className="text-xs text-slate-500">{activeFile.uploadedAt}{activeFile.invoiceNo ? ` · Invoice ${activeFile.invoiceNo}` : ""}</div>
            )}
          </div>
          {page === "files" && files.length > 0 && (
            <div className="flex items-center gap-2">
              {selectedFiles.size > 0 && (
                <>
                  <button
                    disabled={isExecutingPrint}
                    onClick={() => bulkPrint(selectedFilesList)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 transition-colors">
                    {isExecutingPrint ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
                    Bulk Print ({selectedFiles.size})
                  </button>
                  <button onClick={() => exportExcel(selectedFilesList)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">
                    <FileSpreadsheet size={13} /> Export Selected ({selectedFiles.size})
                  </button>
                </>
              )}
              <button onClick={() => exportExcel(files)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-700 transition-colors">
                <FileSpreadsheet size={13} /> Export All
              </button>
            </div>
          )}
          {page === "viewer" && activeFile && !activeFile.restored && (
            <div className="flex items-center gap-2 flex-wrap">
              {selectedPageNums.size > 0 && (
                <button onClick={() => openPrintModal(activeFile, [...selectedPageNums])}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors">
                  <Printer size={13} /> Print Selected ({selectedPageNums.size})
                </button>
              )}
              <button
                onClick={() => {
                  const nums = COPY_TYPES.filter(t => selectedCopyTypes.has(t)).flatMap(t => activeFile.pages.filter(p => p.type === t).map(p => p.pageNum));
                  openPrintModal(activeFile, nums);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-700 transition-colors">
                <Printer size={13} /> Print All
              </button>
              <button onClick={() => exportExcel([activeFile])}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">
                <FileSpreadsheet size={13} /> Excel
              </button>
              <button onClick={() => downloadPdf(activeFile)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors">
                <Download size={13} /> Download PDF
              </button>
              {selectedPageNums.size === 0 ? (
                <>
                  <button onClick={downloadCsv}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors">
                    <FileSpreadsheet size={13} /> Download CSV
                  </button>
                  <button onClick={() => downloadCsv(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-100 text-violet-700 border border-violet-300 hover:bg-violet-200 transition-colors">
                    <FileSpreadsheet size={13} /> Select All &amp; Download CSV
                  </button>
                </>
              ) : (
                <button onClick={downloadCsv}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors">
                  <FileSpreadsheet size={13} /> Download CSV
                </button>
              )}
            </div>
          )}
        </header>


        <main className="flex-1 overflow-auto p-6">

          {/* ── UPLOAD PAGE ── */}
          {page === "upload" && (
            <div className="max-w-xl mx-auto mt-8">
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-100">
                  <h2 className="font-semibold text-base">Upload Invoice PDFs</h2>
                  <p className="text-sm text-slate-500 mt-0.5">Each page is scanned and sorted into Original, Duplicate, or Triplicate</p>
                </div>
                <div className="p-6">
                  <label
                    onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
                    onDrop={onDrop}
                    className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-10 cursor-pointer transition-all ${dragOver ? "border-teal-500 bg-teal-50" : "border-slate-200 hover:border-teal-400 hover:bg-teal-50/50"}`}>
                    <input ref={fileInputRef} type="file" accept="application/pdf" multiple className="hidden" onChange={onInputChange} />
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-4 transition-colors ${dragOver ? "bg-teal-100" : "bg-slate-100"}`}>
                      <Upload size={26} className={dragOver ? "text-teal-600" : "text-slate-400"} strokeWidth={1.6} />
                    </div>
                    <div className="font-semibold text-slate-700">Drop PDFs here or click to browse</div>
                    <div className="text-sm text-slate-400 mt-1">Multiple files supported</div>
                  </label>

                  {loading && (
                    <div className="flex items-center flex-col gap-2.5 mt-4 p-3 bg-teal-50 rounded-lg border border-teal-100">
                      <Loader2 className="animate-spin text-teal-600 flex-none" size={16} />
                      <span className="text-sm text-teal-700">{loadingText}</span>
                      {processingTotal > 0 && (
                        <div className="w-full bg-gray-200 rounded h-2">
                          <div className="bg-teal-600 h-2 rounded" style={{ width: `${(processingProgress / processingTotal) * 100}%` }}></div>
                        </div>
                      )}
                    </div>
                  )}

                  {files.length > 0 && !loading && (
                    <button onClick={() => setPage("files")}
                      className="w-full mt-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-700 transition-colors flex items-center justify-center gap-2">
                      <FileText size={15} /> View {files.length} file{files.length !== 1 ? "s" : ""} in register →
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── FILES PAGE ── */}
          {page === "files" && (
            <div className="max-w-5xl mx-auto">
              {files.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-slate-400 gap-3">
                  <FileText size={40} strokeWidth={1.2} />
                  <div className="font-semibold text-slate-500">No files uploaded yet</div>
                  <button onClick={() => setPage("upload")} className="text-sm text-teal-600 hover:underline">Upload your first PDF →</button>
                </div>
              ) : (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  {/* Table header */}
                  <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 bg-slate-50">
                    <input type="checkbox" checked={selectedFiles.size === files.length && files.length > 0}
                      onChange={toggleAllFiles} className="w-4 h-4 accent-slate-900 cursor-pointer" />
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex-1">File Name</span>
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide w-32 hidden md:block">Uploaded</span>
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide w-24 hidden md:block">Invoice No</span>
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide w-20 text-center">Pages</span>
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide w-40 text-center">Copy Types</span>
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide w-36 text-center">Actions</span>
                  </div>

                  {/* Rows */}
                  {paginatedFiles.map(f => {
                    const counts = COPY_TYPES.map(t => f.pages.filter(p => p.type === t).length);
                    const isSel = selectedFiles.has(f.id);
                    return (
                      <div key={f.id} className={`flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 last:border-0 transition-colors ${isSel ? "bg-teal-50/60" : "hover:bg-slate-50"}`}>
                        <input type="checkbox" checked={isSel} onChange={() => toggleFileSel(f.id)}
                          className="w-4 h-4 accent-slate-900 cursor-pointer flex-none" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <FileText size={14} className="text-slate-400 flex-none" />
                            <span className="text-sm font-medium truncate">{f.name}</span>
                            {f.restored && <span className="text-[10px] text-slate-400 flex-none bg-slate-100 px-1.5 py-0.5 rounded">log only</span>}
                          </div>
                        </div>
                        <div className="text-xs text-slate-500 w-32 hidden md:block truncate">{f.uploadedAt}</div>
                        <div className="text-xs font-mono text-slate-600 w-24 hidden md:block truncate">{f.invoiceNo || "—"}</div>
                        <div className="text-sm font-semibold text-center w-20">{f.pageCount}</div>
                        <div className="flex gap-1 w-40 justify-center flex-wrap">
                          {COPY_TYPES.map((t, i) => counts[i] > 0 && (
                            <span key={t} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wide ${TAG_STYLES[t]}`}>
                              {t[0].toUpperCase()}×{counts[i]}
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center gap-1 w-36 justify-center">
                          <button onClick={() => viewFile(f)} title="View"
                            className="p-1.5 rounded-lg hover:bg-teal-50 text-teal-600 transition-colors" >
                            <Eye size={15} />
                          </button>
                          <button onClick={() => openPrintModal(f, f.pages.map(p => p.pageNum))} title="Print Invoice"
                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-700 transition-colors">
                            <Printer size={15} />
                          </button>
                          <button onClick={() => downloadPdf(f)} title="Download PDF"
                            className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors">
                            <Download size={15} />
                          </button>
                          <button onClick={() => exportExcel([f])} title="Export to Excel"
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-600 transition-colors">
                            <FileSpreadsheet size={15} />
                          </button>
                          <button onClick={() => removeFile(f.id)} title="Delete"
                            className="p-1.5 rounded-lg hover:bg-red-50 text-red-500 transition-colors">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Pagination Footer */}
                  <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-slate-50 flex-wrap gap-3">
                    <div className="text-xs text-slate-500 font-medium">
                      Showing {files.length > 0 ? startIndex + 1 : 0}–{Math.min(endIndex, files.length)} of {files.length} records
                    </div>
                    <div className="flex items-center gap-4 flex-wrap">
                      {/* Page Size Selector */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">Rows per page:</span>
                        <select
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value));
                            setCurrentPage(1);
                          }}
                          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1 bg-white cursor-pointer outline-none focus:border-teal-500 transition-colors font-medium text-slate-700"
                        >
                          <option value={20}>20</option>
                          <option value={50}>50</option>
                          <option value={100}>100</option>
                          <option value={500}>500</option>
                        </select>
                      </div>
                      {/* Paper Size Selector */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">Paper Size:</span>
                        <select
                          value={paperSize}
                          onChange={(e) => setPaperSize(e.target.value)}
                          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1 bg-white cursor-pointer outline-none focus:border-teal-500 transition-colors font-medium text-slate-700">
                          <option value="A2">A2</option>
                          <option value="A3">A3</option>
                          <option value="A4">A4</option>
                          <option value="A5">A5</option>
                        </select>
                      </div>
                      {/* Orientation Selector */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">Orientation:</span>
                        <select
                          value={orientation}
                          onChange={(e) => setOrientation(e.target.value)}
                          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1 bg-white cursor-pointer outline-none focus:border-teal-500 transition-colors font-medium text-slate-700">
                          <option value="portrait">Portrait</option>
                          <option value="landscape">Landscape</option>
                        </select>
                      </div>

                      {/* Navigation buttons */}
                      <div className="flex items-center gap-1.5">
                        <button
                          disabled={validCurrentPage === 1}
                          onClick={() => setCurrentPage(1)}
                          className="p-1.5 rounded-lg hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-slate-600 flex items-center justify-center"
                          title="First Page"
                        >
                          <ChevronsLeft size={16} />
                        </button>
                        <button
                          disabled={validCurrentPage === 1}
                          onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                          className="p-1.5 rounded-lg hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-slate-600 flex items-center justify-center"
                          title="Previous Page"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span className="text-xs font-semibold text-slate-600 min-w-[80px] text-center">
                          Page {validCurrentPage} of {totalPages}
                        </span>
                        <button
                          disabled={validCurrentPage === totalPages}
                          onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                          className="p-1.5 rounded-lg hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-slate-600 flex items-center justify-center"
                          title="Next Page"
                        >
                          <ChevronRight size={16} />
                        </button>
                        <button
                          disabled={validCurrentPage === totalPages}
                          onClick={() => setCurrentPage(totalPages)}
                          className="p-1.5 rounded-lg hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-slate-600 flex items-center justify-center"
                          title="Last Page"
                        >
                          <ChevronsRight size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── VIEWER PAGE ── */}
          {page === "viewer" && (
            <div className="max-w-3xl mx-auto">
              <button onClick={() => setPage("files")} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 mb-4 transition-colors">
                <ChevronLeft size={15} /> Back to register
              </button>

              {activeFile && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
                  <div className="flex items-center gap-4 px-5 py-3 border-b border-slate-100 bg-slate-50 flex-wrap">
                    <div className="flex items-center gap-5 flex-1">
                      {COPY_TYPES.map(t => {
                        const exists = activeFile.pages.some(p => p.type === t);
                        const checked = selectedCopyTypes.has(t);
                        return (
                          <label key={t} className={`flex items-center gap-2 cursor-pointer select-none ${!exists ? "opacity-30 pointer-events-none" : ""}`}>
                            <input type="checkbox" checked={checked} disabled={!exists}
                              onChange={() => toggleCopyType(t)}
                              className="w-4 h-4 accent-teal-600 cursor-pointer" />
                            <span className={`text-sm font-semibold capitalize ${checked ? "text-slate-800" : "text-slate-400"}`}>{t}</span>
                          </label>
                        );
                      })}
                    </div>
                    {/* Zoom + fit controls */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { setFitMode("page"); setZoom(1); }}
                        title="Fit entire page"
                        className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                          fitMode === "page" && zoom === 1 ? "bg-teal-600 text-white" : "hover:bg-slate-200 text-slate-600"
                        }`}>
                        Fit Page
                      </button>
                      <button
                        onClick={() => { setFitMode("width"); setZoom(1); }}
                        title="Fit to width"
                        className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                          fitMode === "width" && zoom === 1 ? "bg-teal-600 text-white" : "hover:bg-slate-200 text-slate-600"
                        }`}>
                        Fit Width
                      </button>
                      <div className="w-px h-4 bg-slate-300 mx-1" />
                      <button onClick={() => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
                        title="Zoom out" className="p-1.5 rounded hover:bg-slate-200 transition-colors">
                        <ZoomOut size={15} />
                      </button>
                      <span className="text-xs font-mono w-14 text-center text-slate-600">
                        {Math.round(zoom * 100)}%
                      </span>
                      <button onClick={() => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
                        title="Zoom in" className="p-1.5 rounded hover:bg-slate-200 transition-colors">
                        <ZoomIn size={15} />
                      </button>
                    </div>
                  </div>

                  <div className="p-5">
                    {(!activeFile._pdfBuf && !pdfCache.has(activeFile.id) && activeFile.restored) ? (
                      <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
                        <FileText size={36} strokeWidth={1.2} />
                        <div className="font-semibold text-slate-500">Log entry only</div>
                        <div className="text-sm text-center max-w-xs">Re-upload this PDF to view or print its pages.</div>
                        <button onClick={() => setPage("upload")} className="mt-2 text-sm text-teal-600 hover:underline">Go to Upload →</button>
                      </div>
                    ) : selectedCopyTypes.size === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
                        <div className="font-semibold text-slate-500">Select at least one copy type above</div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-6">
                        {/* Thumbnail multi-select grid */}
                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Select pages to print</span>
                            <div className="flex items-center gap-2">
                              <button onClick={() => {
                                const all = new Set(visiblePages.map(p => p.pageNum));
                                const allSel = visiblePages.every(p => selectedPageNums.has(p.pageNum));
                                setSelectedPageNums(allSel ? new Set() : all);
                              }} className="text-xs text-teal-600 hover:underline">
                                {visiblePages.every(p => selectedPageNums.has(p.pageNum)) && visiblePages.length > 0 ? "Deselect all" : "Select all"}
                              </button>
                            </div>
                          </div>
                          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
                            {visiblePages.map((p, i) => {
                              const checked = selectedPageNums.has(p.pageNum);
                              return (
                                <div key={p.pageNum} onClick={() => togglePageNum(p.pageNum)}
                                  className={`border-2 rounded-xl overflow-hidden cursor-pointer transition-all ${
                                    checked ? "border-teal-500 ring-2 ring-teal-400/30 shadow-md" : "border-slate-200 hover:border-slate-300"
                                  }`}>
                                  <div className="relative bg-white">
                                    <LazyThumb pdfBuf={activeFile._pdfBuf || pdfCache.get(activeFile.id)} pageNum={p.pageNum} />
                                    <input type="checkbox" checked={checked} onChange={() => togglePageNum(p.pageNum)}
                                      onClick={e => e.stopPropagation()} className="absolute top-1.5 left-1.5 w-4 h-4 accent-teal-600 cursor-pointer" />
                                    <span className={`absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide border ${TAG_STYLES[p.type]}`}>
                                      {p.type[0].toUpperCase()}
                                    </span>
                                  </div>
                                  <div className="px-2 py-1.5 flex items-center justify-between bg-slate-50">
                                    <span className="text-[11px] font-mono text-slate-500">Pg {p.pageNum}</span>
                                    <button onClick={e => { e.stopPropagation(); printPages(activeFile, [p.pageNum]); }}
                                      title="Print this page" className="text-slate-400 hover:text-slate-900 transition-colors">
                                      <Printer size={13} />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* PDF canvas viewer — lazy: only renders CopyCanvas when scrolled into view */}
                        {COPY_TYPES.filter(t => selectedCopyTypes.has(t)).map(t => {
                          const matchingPages = activeFile.pages.filter(p => p.type === t);
                          if (!matchingPages.length) return null;
                          const activeBuf = activeFile._pdfBuf || pdfCache.get(activeFile.id);
                          return (
                            <div key={t} className="flex flex-col gap-4 border-t border-slate-200 pt-4">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  {t} ({matchingPages.length} {matchingPages.length === 1 ? 'page' : 'pages'})
                                </span>
                                <button onClick={() => printPages(activeFile, matchingPages.map(p => p.pageNum))}
                                  className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors">
                                  <Printer size={12} /> Print all {t}
                                </button>
                              </div>
                              <div className="flex flex-col gap-4">
                                {matchingPages.map(pg => (
                                  <LazyCopyCanvas key={pg.pageNum} pdfBuf={activeBuf} pageNum={pg.pageNum}
                                    zoom={zoom} fitMode={fitMode} onFitScale={setFitScale}
                                    onPrint={() => printPages(activeFile, [pg.pageNum])} />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

        </main>
      </div>

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-xl text-sm shadow-xl flex items-center gap-2 z-50 animate-fade-in">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
