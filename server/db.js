import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "..", "data");
const PDF_DIR = path.join(DATA_DIR, "pdfs");
const DB_FILE = path.join(DATA_DIR, "invoices.json");

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const content = fs.readFileSync(DB_FILE, "utf-8");
    return JSON.parse(content || "[]");
  } catch (err) {
    console.error("Error reading db file:", err);
    return [];
  }
}

function writeDb(records) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing db file:", err);
  }
}

export const db = {
  list: async () => {
    return readDb().map(r => ({
      id: r.id,
      name: r.name,
      uploadedAt: r.uploadedAt,
      invoiceNo: r.invoiceNo,
      pageCount: r.pageCount,
      pages: r.pages || [],
    }));
  },

  save: async (record, pdfBuf) => {
    const list = readDb();
    const idx = list.findIndex(r => r.id === record.id);
    const entry = {
      id: record.id,
      name: record.name,
      uploadedAt: record.uploadedAt || new Date().toLocaleString(),
      invoiceNo: record.invoiceNo || null,
      pageCount: record.pageCount || 0,
      pages: record.pages || [],
      pdfFile: path.join(PDF_DIR, `${record.id}.pdf`),
    };

    if (pdfBuf && pdfBuf.length) {
      fs.writeFileSync(entry.pdfFile, pdfBuf);
    }

    if (idx >= 0) {
      list[idx] = { ...list[idx], ...entry };
    } else {
      list.unshift(entry);
    }

    writeDb(list);
    return entry;
  },

  saveBatch: async (recordsWithBufs) => {
    const list = readDb();
    const savedIds = [];

    for (const { record, pdfBuf } of recordsWithBufs) {
      const idx = list.findIndex(r => r.id === record.id);
      const entry = {
        id: record.id,
        name: record.name,
        uploadedAt: record.uploadedAt || new Date().toLocaleString(),
        invoiceNo: record.invoiceNo || null,
        pageCount: record.pageCount || 0,
        pages: record.pages || [],
        pdfFile: path.join(PDF_DIR, `${record.id}.pdf`),
      };

      if (pdfBuf && pdfBuf.length) {
        fs.writeFileSync(entry.pdfFile, pdfBuf);
      }

      if (idx >= 0) {
        list[idx] = { ...list[idx], ...entry };
      } else {
        list.unshift(entry);
      }
      savedIds.push(record.id);
    }

    writeDb(list);
    return savedIds;
  },

  delete: async (id) => {
    let list = readDb();
    const item = list.find(r => r.id === id);
    if (item?.pdfFile && fs.existsSync(item.pdfFile)) {
      try { fs.unlinkSync(item.pdfFile); } catch (_) {}
    }
    list = list.filter(r => r.id !== id);
    writeDb(list);
  },

  clearAll: async () => {
    const list = readDb();
    for (const r of list) {
      if (r.pdfFile && fs.existsSync(r.pdfFile)) {
        try { fs.unlinkSync(r.pdfFile); } catch (_) {}
      }
    }
    writeDb([]);
  },

  getPdf: async (id) => {
    const pdfPath = path.join(PDF_DIR, `${id}.pdf`);
    if (fs.existsSync(pdfPath)) {
      return fs.readFileSync(pdfPath);
    }
    return null;
  },
};
