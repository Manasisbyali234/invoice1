import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import InvoiceCopyManager from "../InvoiceCopyManager.jsx";

// Dual Persistent Storage: Local Server API + Browser IndexedDB (never vanishes on refresh)
if (!window.db) {
  const API_BASE = "/api/invoices";
  const DB_NAME = "InvoiceManagerLocalDB";
  const STORE_NAME = "invoices_store";
  const PDF_STORE = "pdfs_store";

  function openIDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(PDF_STORE)) {
          db.createObjectStore(PDF_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbSaveInvoices(invoices) {
    try {
      const db = await openIDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const inv of invoices) {
        store.put(inv);
      }
    } catch (e) {
      console.warn("IndexedDB save invoice error:", e);
    }
  }

  async function idbSavePdf(id, arrayBuffer) {
    try {
      if (!arrayBuffer) return;
      const db = await openIDB();
      const tx = db.transaction(PDF_STORE, "readwrite");
      tx.objectStore(PDF_STORE).put({ id, data: arrayBuffer });
    } catch (e) {
      console.warn("IndexedDB save PDF error:", e);
    }
  }

  async function idbGetInvoices() {
    try {
      const db = await openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  async function idbGetPdf(id) {
    try {
      const db = await openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction(PDF_STORE, "readonly");
        const request = tx.objectStore(PDF_STORE).get(id);
        request.onsuccess = () => resolve(request.result?.data || null);
        request.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function idbDelete(id) {
    try {
      const db = await openIDB();
      const tx = db.transaction([STORE_NAME, PDF_STORE], "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.objectStore(PDF_STORE).delete(id);
    } catch (_) {}
  }

  async function idbClear() {
    try {
      const db = await openIDB();
      const tx = db.transaction([STORE_NAME, PDF_STORE], "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.objectStore(PDF_STORE).clear();
    } catch (_) {}
  }

  function bufferToBase64(buf) {
    if (!buf) return null;
    let binary = "";
    const bytes = new Uint8Array(buf);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  window.db = {
    list: async () => {
      try {
        const res = await fetch(API_BASE);
        if (res.ok) {
          const list = await res.json();
          idbSaveInvoices(list);
          return list;
        }
      } catch (_) {}
      return await idbGetInvoices();
    },

    save: async (record) => {
      const entry = {
        id: record.id,
        name: record.name,
        uploadedAt: record.uploadedAt,
        invoiceNo: record.invoiceNo,
        pageCount: record.pageCount,
        pages: record.pages,
      };
      await idbSaveInvoices([entry]);
      if (record.pdfBuffer) {
        await idbSavePdf(record.id, record.pdfBuffer);
      }

      try {
        const payload = {
          ...record,
          pdfBuffer: record.pdfBuffer ? bufferToBase64(record.pdfBuffer) : null,
        };
        await fetch(`${API_BASE}/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (_) {}
    },

    saveBatch: async (records) => {
      const entries = records.map(r => ({
        id: r.id,
        name: r.name,
        uploadedAt: r.uploadedAt,
        invoiceNo: r.invoiceNo,
        pageCount: r.pageCount,
        pages: r.pages,
      }));
      await idbSaveInvoices(entries);
      for (const r of records) {
        if (r.pdfBuffer) {
          await idbSavePdf(r.id, r.pdfBuffer);
        }
      }

      try {
        const payload = records.map(r => ({
          ...r,
          pdfBuffer: r.pdfBuffer ? bufferToBase64(r.pdfBuffer) : null,
        }));
        await fetch(`${API_BASE}/save-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (_) {}
    },

    delete: async (id) => {
      await idbDelete(id);
      try {
        await fetch(`${API_BASE}/${id}`, { method: "DELETE" });
      } catch (_) {}
    },

    clearAll: async () => {
      await idbClear();
      try {
        await fetch(API_BASE, { method: "DELETE" });
      } catch (_) {}
    },

    getPdf: async (id) => {
      try {
        const res = await fetch(`${API_BASE}/${id}/pdf`);
        if (res.ok) {
          return await res.arrayBuffer();
        }
      } catch (_) {}
      return await idbGetPdf(id);
    },
  };
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("React ErrorBoundary caught error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, fontFamily: "sans-serif", background: "#0f172a", color: "#f87171", minHeight: "100vh" }}>
          <h2>Application Error</h2>
          <pre style={{ background: "#1e293b", padding: 16, borderRadius: 8, overflowX: "auto", color: "#f1f5f9" }}>
            {this.state.error ? this.state.error.stack || String(this.state.error) : "Unknown Error"}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: "8px 16px", background: "#0d9488", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}
          >
            Reload Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <InvoiceCopyManager />
    </ErrorBoundary>
  </React.StrictMode>
);
