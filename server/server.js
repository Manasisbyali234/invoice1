import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { db } from "./db.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Allow large payloads (for PDF uploads in base64 / binary arrays)
app.use(cors());
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ extended: true, limit: "150mb" }));

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") {
    if (data.startsWith("data:") && data.includes(";base64,")) {
      const base64Str = data.split(";base64,")[1];
      return Buffer.from(base64Str, "base64");
    }
    return Buffer.from(data, "base64");
  }
  if (Array.isArray(data) || data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  if (typeof data === "object" && data.data) {
    return Buffer.from(data.data);
  }
  return Buffer.from(Object.values(data));
}

// ── Endpoints ──────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", db: "local_ready" });
});

// List all invoices (metadata only)
app.get("/api/invoices", async (req, res) => {
  try {
    const list = await db.list();
    res.json(list);
  } catch (err) {
    console.error("GET /api/invoices error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get PDF binary by invoice ID
app.get("/api/invoices/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const pdfBuf = await db.getPdf(id);
    if (!pdfBuf) {
      return res.status(404).json({ error: "PDF not found" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="invoice_${id}.pdf"`);
    res.send(pdfBuf);
  } catch (err) {
    console.error("GET /api/invoices/:id/pdf error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Save single invoice
app.post("/api/invoices/save", async (req, res) => {
  try {
    const { pdfBuffer, ...record } = req.body;
    const buf = toBuffer(pdfBuffer);
    const saved = await db.save(record, buf);
    res.json({ success: true, id: saved.id });
  } catch (err) {
    console.error("POST /api/invoices/save error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Save batch of invoices
app.post("/api/invoices/save-batch", async (req, res) => {
  try {
    const records = req.body;
    if (!Array.isArray(records)) {
      return res.status(400).json({ error: "Expected an array of records" });
    }
    const recordsWithBufs = records.map(r => {
      const { pdfBuffer, ...meta } = r;
      return { record: meta, pdfBuf: toBuffer(pdfBuffer) };
    });

    const savedIds = await db.saveBatch(recordsWithBufs);
    res.json({ success: true, savedCount: savedIds.length, savedIds });
  } catch (err) {
    console.error("POST /api/invoices/save-batch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete single invoice
app.delete("/api/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(id);
    res.json({ success: true, id });
  } catch (err) {
    console.error("DELETE /api/invoices/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete all invoices
app.delete("/api/invoices", async (req, res) => {
  try {
    await db.clearAll();
    res.json({ success: true, message: "All invoices deleted" });
  } catch (err) {
    console.error("DELETE /api/invoices error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Invoice Storage API Server running at http://localhost:${PORT}`);
});
