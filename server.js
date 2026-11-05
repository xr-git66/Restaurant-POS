/* =====================================================================
   Shop POS server
   - Serves the POS web page (the "public" folder)
   - Provides a small API the page uses to read/write the database
   - Database: SQLite, stored in the file "shop.db" next to this file
   Needs Node.js 22.13 or newer. No npm install needed.
   Start it with:   node server.js
   ===================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");   // SQLite is built into Node

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";       // 127.0.0.1 = this computer only
const PUBLIC = path.join(__dirname, "public");

/* ---------- 1. DATABASE: create the tables the first time ---------- */
const db = new DatabaseSync(path.join(__dirname, "shop.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    price    REAL NOT NULL CHECK (price >= 0),
    stock    INTEGER                      -- NULL means unlimited (cooked dishes)
  );
  CREATE TABLE IF NOT EXISTS sales (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    subtotal     REAL NOT NULL,
    discount     REAL NOT NULL,
    total        REAL NOT NULL,
    method       TEXT NOT NULL,           -- 'cash' or 'card'
    cash         REAL NOT NULL,
    change_given REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    name    TEXT NOT NULL,                -- copied at sale time, so old bills never change
    price   REAL NOT NULL,
    qty     INTEGER NOT NULL
  );
`);

const round2 = n => Math.round(n * 100) / 100;

/* ---------- 2. MENU ITEMS ---------- */
function cleanProduct(body) {
  const name = String(body.name || "").trim();
  const category = String(body.category || "").trim() || "General";
  const price = Number(body.price);
  const blank = body.stock === null || body.stock === undefined || body.stock === "";
  const stock = blank ? null : Number(body.stock);
  if (!name) throw new Error("Name is required");
  if (!Number.isFinite(price) || price < 0) throw new Error("Price is not valid");
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) throw new Error("Stock is not valid");
  return { name, category, price, stock };
}

function listProducts() {
  return db.prepare("SELECT id, name, category, price, stock FROM products ORDER BY category, name").all();
}

function addProduct(body) {
  const p = cleanProduct(body);
  const r = db.prepare("INSERT INTO products (name, category, price, stock) VALUES (?, ?, ?, ?)")
    .run(p.name, p.category, p.price, p.stock);
  return { id: Number(r.lastInsertRowid), ...p };
}

function updateProduct(id, body) {
  const p = cleanProduct(body);
  const r = db.prepare("UPDATE products SET name = ?, category = ?, price = ?, stock = ? WHERE id = ?")
    .run(p.name, p.category, p.price, p.stock, id);
  if (!r.changes) throw new Error("Item not found");
  return { id, ...p };
}

function deleteProduct(id) {
  db.prepare("DELETE FROM products WHERE id = ?").run(id);
  return { ok: true };
}

/* ---------- 3. SALES ---------- */
function listSales() {
  const sales = db.prepare("SELECT * FROM sales ORDER BY id").all();
  const itemsOf = db.prepare("SELECT name, price, qty FROM sale_items WHERE sale_id = ? ORDER BY id");
  return sales.map(s => ({
    id: s.id, date: s.date, items: itemsOf.all(s.id),
    subtotal: s.subtotal, discount: s.discount, total: s.total,
    method: s.method, cash: s.cash, change: s.change_given
  }));
}

// The server works out the prices itself from the database, so the page cannot cheat.
// BEGIN/COMMIT makes it all-or-nothing: either the whole sale is saved, or nothing is.
function createSale(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new Error("The bill is empty");

  db.exec("BEGIN IMMEDIATE");
  try {
    const getProduct = db.prepare("SELECT * FROM products WHERE id = ?");
    let subtotal = 0;
    const lines = items.map(i => {
      const p = getProduct.get(Number(i.id));
      const qty = Number(i.qty);
      if (!p) throw new Error("An item on the bill no longer exists");
      if (!Number.isInteger(qty) || qty <= 0) throw new Error("Quantity is not valid");
      if (p.stock !== null && qty > p.stock) throw new Error("Not enough stock for " + p.name);
      subtotal += p.price * qty;
      return { p, qty };
    });
    subtotal = round2(subtotal);

    const discount = round2(Math.min(Math.max(Number(body.discount) || 0, 0), subtotal));
    const total = round2(subtotal - discount);
    const method = body.method === "card" ? "card" : "cash";
    const cash = method === "card" ? total : round2(Number(body.cash));
    if (!Number.isFinite(cash) || cash < total) throw new Error("Cash received is less than the total");
    const change = round2(cash - total);

    const date = new Date().toISOString();
    const r = db.prepare(
      "INSERT INTO sales (date, subtotal, discount, total, method, cash, change_given) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(date, subtotal, discount, total, method, cash, change);
    const saleId = Number(r.lastInsertRowid);

    const addItem = db.prepare("INSERT INTO sale_items (sale_id, name, price, qty) VALUES (?, ?, ?, ?)");
    const takeStock = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL");
    for (const { p, qty } of lines) {
      addItem.run(saleId, p.name, p.price, qty);
      takeStock.run(qty, p.id);
    }
    db.exec("COMMIT");

    return {
      id: saleId, date,
      items: lines.map(l => ({ name: l.p.name, price: l.p.price, qty: l.qty })),
      subtotal, discount, total, method, cash, change
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/* ---------- 4. WEB SERVER ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
                ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) { reject(new Error("Request too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Invalid data sent to the server")); }
    });
  });
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400); return res.end("Bad request"); }
  const file = path.join(PUBLIC, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return serveStatic(req, res);

  try {
    const id = parts[2] ? Number(parts[2]) : null;
    let result;
    if (parts[1] === "products") {
      if (req.method === "GET" && !id)         result = listProducts();
      else if (req.method === "POST" && !id)   result = addProduct(await readJson(req));
      else if (req.method === "PUT" && id)     result = updateProduct(id, await readJson(req));
      else if (req.method === "DELETE" && id)  result = deleteProduct(id);
      else return send(res, 404, { error: "Not found" });
    } else if (parts[1] === "sales") {
      if (req.method === "GET")                result = listSales();
      else if (req.method === "POST")          result = createSale(await readJson(req));
      else return send(res, 404, { error: "Not found" });
    } else {
      return send(res, 404, { error: "Not found" });
    }
    send(res, 200, result);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Shop POS is running:  http://localhost:${PORT}`);
  console.log("Database file: " + path.join(__dirname, "shop.db"));
});
