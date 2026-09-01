const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DB || "invoice_manager",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      invoice_no TEXT,
      page_count INTEGER NOT NULL,
      pages JSONB NOT NULL,
      pdf_data BYTEA NOT NULL
    )
  `);
}

async function saveInvoice({ id, name, uploadedAt, invoiceNo, pageCount, pages, pdfBuffer }) {
  await pool.query(
    `INSERT INTO invoices (id, name, uploaded_at, invoice_no, page_count, pages, pdf_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, uploaded_at=EXCLUDED.uploaded_at,
       invoice_no=EXCLUDED.invoice_no, page_count=EXCLUDED.page_count,
       pages=EXCLUDED.pages, pdf_data=EXCLUDED.pdf_data`,
    [id, name, uploadedAt, invoiceNo, pageCount, JSON.stringify(pages), pdfBuffer]
  );
}

async function saveInvoicesBatch(records) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const record of records) {
      await client.query(
        `INSERT INTO invoices (id, name, uploaded_at, invoice_no, page_count, pages, pdf_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, uploaded_at=EXCLUDED.uploaded_at,
           invoice_no=EXCLUDED.invoice_no, page_count=EXCLUDED.page_count,
           pages=EXCLUDED.pages, pdf_data=EXCLUDED.pdf_data`,
        [
          record.id,
          record.name,
          record.uploadedAt,
          record.invoiceNo,
          record.pageCount,
          JSON.stringify(record.pages),
          record.pdfBuffer
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listInvoices() {
  const { rows } = await pool.query(
    `SELECT id, name, uploaded_at, invoice_no, page_count, pages FROM invoices ORDER BY uploaded_at DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    uploadedAt: r.uploaded_at,
    invoiceNo: r.invoice_no,
    pageCount: r.page_count,
    pages: r.pages,
  }));
}

async function getPdf(id) {
  const { rows } = await pool.query(`SELECT pdf_data FROM invoices WHERE id=$1`, [id]);
  return rows[0]?.pdf_data ?? null; // Buffer
}

async function deleteInvoice(id) {
  await pool.query(`DELETE FROM invoices WHERE id=$1`, [id]);
}

async function clearAll() {
  await pool.query(`DELETE FROM invoices`);
}

module.exports = { init, saveInvoice, saveInvoicesBatch, listInvoices, getPdf, deleteInvoice, clearAll };
