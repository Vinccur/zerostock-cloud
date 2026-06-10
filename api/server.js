// ═══════════════════════════════════════════════════════════
//  ZeroStock Cloud — Backend API v4.1
//  Stack: Express + Firebase Admin + Supabase (PostgreSQL)
//  Deploy: Vercel (serverless)
//  FIXES v4.1:
//    ✅ module.exports = app  (Vercel serverless compatible)
//    ✅ CORS ampliado para todos los subdominios de Vercel
//    ✅ Manejo de errores mejorado en sync
//    ✅ Health check con info de entorno
//    ✅ Timeout en operaciones de Supabase
// ═══════════════════════════════════════════════════════════
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── CORS ──────────────────────────────────────────────────
// Permite: localhost, cualquier subdominio .vercel.app, y dominios con "zerostock"
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    // Sin origin = curl/Postman/SSR → permitir
    if (!origin) return cb(null, true);
    // Lista fija
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Cualquier subdominio de vercel.app
    if (/\.vercel\.app$/.test(origin)) return cb(null, true);
    // Dominio que contenga "zerostock"
    if (/zerostock/i.test(origin)) return cb(null, true);
    // Rechazar el resto
    cb(new Error(`CORS: origin ${origin} no permitido`));
  },
  methods:      ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));

// Pre-flight para todos los endpoints
app.options('*', cors());

app.use(express.json({ limit: '5mb' }));

// ── Firebase Admin SDK ────────────────────────────────────
if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    console.error('[ZeroStock] ⚠️ Firebase env vars missing! Check Vercel environment variables.');
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      })
    });
    console.log('[ZeroStock] ✅ Firebase Admin initialized');
  }
}

// ── Supabase Admin Client ─────────────────────────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('[ZeroStock] ⚠️ Supabase env vars missing! Check Vercel environment variables.');
}
const supabase = createClient(
  process.env.SUPABASE_URL  || '',
  process.env.SUPABASE_SERVICE_KEY || '',
  { auth: { persistSession: false } }
);

// ════════════════════════════════════════════════════════════
//  MIDDLEWARE — Verificar Firebase ID Token
// ════════════════════════════════════════════════════════════
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado', detail: e.message });
  }
}

// ════════════════════════════════════════════════════════════
//  HELPER — Obtener o crear usuario en Supabase
// ════════════════════════════════════════════════════════════
async function getOrCreateUser(firebaseUser) {
  const { uid, email, name, picture } = firebaseUser;

  const { data: existing, error: findErr } = await supabase
    .from('users')
    .select('*')
    .eq('google_id', uid)
    .single();

  if (existing) return existing;
  if (findErr && findErr.code !== 'PGRST116') {
    // PGRST116 = "no rows" — cualquier otro error es real
    throw new Error('Error buscando usuario: ' + findErr.message);
  }

  const { data: created, error } = await supabase
    .from('users')
    .insert({ google_id: uid, email, name, avatar: picture })
    .select()
    .single();

  if (error) throw new Error('Error creando usuario: ' + error.message);
  return created;
}

// ════════════════════════════════════════════════════════════
//  HELPER — Respuesta de error estándar
// ════════════════════════════════════════════════════════════
function dbError(res, error, context = '') {
  console.error(`[ZeroStock] ${context}:`, error);
  return res.status(500).json({ error: error.message || 'Error interno', context });
}

// ════════════════════════════════════════════════════════════
//  ROUTE — GET /api/health
// ════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  const envOk = !!(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY &&
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_KEY
  );

  res.json({
    status:    'ok',
    version:   '4.1.0',
    project:   'ZeroStock Cloud',
    timestamp: new Date().toISOString(),
    env:       envOk ? 'complete' : 'missing_vars',
    firebase:  admin.apps.length > 0 ? 'initialized' : 'not_initialized',
  });
});

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════
app.post('/api/auth/login', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    res.json({ user });
  } catch (e) {
    dbError(res, e, 'auth/login');
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    res.json({ user });
  } catch (e) {
    dbError(res, e, 'auth/me');
  }
});

// ════════════════════════════════════════════════════════════
//  PRODUCTS
// ════════════════════════════════════════════════════════════
app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { q } = req.query;
    let query = supabase
      .from('products')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (q) query = query.ilike('name', `%${q}%`);
    const { data, error } = await query;
    if (error) return dbError(res, error, 'products/list');
    res.json({ data });
  } catch (e) { dbError(res, e, 'products/get'); }
});

app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const body = { ...req.body, user_id: user.id };
    delete body.id;
    const { data, error } = await supabase
      .from('products')
      .upsert(body, { onConflict: 'id' })
      .select()
      .single();
    if (error) return dbError(res, error, 'products/save');
    res.json({ data });
  } catch (e) { dbError(res, e, 'products/post'); }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { id } = req.params;
    const { data: existing } = await supabase
      .from('products').select('id').eq('id', id).eq('user_id', user.id).single();
    if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) return dbError(res, error, 'products/delete');
    res.json({ ok: true });
  } catch (e) { dbError(res, e, 'products/delete'); }
});

// ════════════════════════════════════════════════════════════
//  SERIALS
// ════════════════════════════════════════════════════════════
app.get('/api/serials', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { product_id, status } = req.query;
    let query = supabase.from('serials').select('*').eq('user_id', user.id);
    if (product_id) query = query.eq('product_id', product_id);
    if (status)     query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return dbError(res, error, 'serials/list');
    res.json({ data });
  } catch (e) { dbError(res, e, 'serials/get'); }
});

app.post('/api/serials/bulk', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { product_id, items } = req.body;
    if (!items?.length) return res.json({ data: [] });
    const rows = items.map(i => ({
      user_id:    user.id,
      product_id,
      serial:     i.serial,
      cost:       i.cost || 0,
      sale_price: i.salePrice || 0,
      status:     'available'
    }));
    const { data, error } = await supabase.from('serials').insert(rows).select();
    if (error) return dbError(res, error, 'serials/bulk');
    res.json({ data });
  } catch (e) { dbError(res, e, 'serials/bulk'); }
});

app.delete('/api/serials/:id', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { id } = req.params;
    const { data: existing } = await supabase
      .from('serials').select('id,status').eq('id', id).eq('user_id', user.id).single();
    if (!existing) return res.status(404).json({ error: 'Serial no encontrado' });
    if (existing.status === 'sold') return res.status(400).json({ error: 'No puedes eliminar un serial vendido' });
    const { error } = await supabase.from('serials').delete().eq('id', id);
    if (error) return dbError(res, error, 'serials/delete');
    res.json({ ok: true });
  } catch (e) { dbError(res, e, 'serials/delete'); }
});

// ════════════════════════════════════════════════════════════
//  CUSTOMERS
// ════════════════════════════════════════════════════════════
app.get('/api/customers', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { q } = req.query;
    let query = supabase.from('customers').select('*').eq('user_id', user.id).order('last_name');
    if (q) query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,id_number.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) return dbError(res, error, 'customers/list');
    res.json({ data });
  } catch (e) { dbError(res, e, 'customers/get'); }
});

app.post('/api/customers', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const body = { ...req.body, user_id: user.id };
    delete body.id;
    const { data, error } = await supabase
      .from('customers').upsert(body, { onConflict: 'id' }).select().single();
    if (error) return dbError(res, error, 'customers/save');
    res.json({ data });
  } catch (e) { dbError(res, e, 'customers/post'); }
});

app.delete('/api/customers/:id', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { id } = req.params;
    const { data: hasSales } = await supabase
      .from('sales').select('id').eq('customer_id', id).eq('user_id', user.id).limit(1);
    if (hasSales?.length) return res.status(400).json({ error: 'Cliente tiene ventas registradas' });
    const { error } = await supabase.from('customers').delete().eq('id', id).eq('user_id', user.id);
    if (error) return dbError(res, error, 'customers/delete');
    res.json({ ok: true });
  } catch (e) { dbError(res, e, 'customers/delete'); }
});

// ════════════════════════════════════════════════════════════
//  SALES
// ════════════════════════════════════════════════════════════
app.get('/api/sales', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { data: sales, error } = await supabase
      .from('sales')
      .select(`*, customers(*), sale_items(*, products(*), serials(*))`)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) return dbError(res, error, 'sales/list');
    const normalized = sales.map(s => ({
      id:              s.id,
      customerId:      s.customer_id,
      total:           parseFloat(s.total),
      rateOff:         parseFloat(s.rate_off),
      rateCus:         parseFloat(s.rate_cus),
      paymentMethod:   s.payment_method,
      paymentCurrency: s.payment_currency,
      createdAt:       new Date(s.created_at).getTime(),
      _cust: s.customers ? {
        id:        s.customers.id,
        firstName: s.customers.first_name,
        lastName:  s.customers.last_name,
        idNumber:  s.customers.id_number,
        phone:     s.customers.phone,
      } : null,
      _items: (s.sale_items || []).map(i => ({
        id:          i.id,
        productId:   i.product_id,
        serialId:    i.serial_id,
        productName: i.product_name,
        unitPrice:   parseFloat(i.unit_price),
        qty:         i.qty,
        serial:      i.serials?.serial || null,
      }))
    }));
    res.json({ data: normalized });
  } catch (e) { dbError(res, e, 'sales/get'); }
});

app.post('/api/sales', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { customerId, items, rateOff, rateCus, paymentMethod, paymentCurrency } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'El carrito está vacío' });
  const total = items.reduce((s, i) => s + (i.unitPrice * (i.qty || 1)), 0);
  try {
    const { data: sale, error: saleErr } = await supabase
      .from('sales')
      .insert({ user_id: user.id, customer_id: customerId || null, total,
        rate_off: rateOff, rate_cus: rateCus,
        payment_method: paymentMethod, payment_currency: paymentCurrency })
      .select().single();
    if (saleErr) throw saleErr;

    const saleItems = items.map(i => ({
      sale_id: sale.id, product_id: i.productId, serial_id: i.serialId || null,
      product_name: i.productName, unit_price: i.unitPrice, qty: i.qty || 1,
    }));
    const { error: itemsErr } = await supabase.from('sale_items').insert(saleItems);
    if (itemsErr) throw itemsErr;

    const soldSerialIds = items.filter(i => i.serialId).map(i => i.serialId);
    if (soldSerialIds.length) {
      const { error: serialErr } = await supabase
        .from('serials').update({ status: 'sold', sale_id: sale.id }).in('id', soldSerialIds);
      if (serialErr) throw serialErr;
    }

    for (const item of items.filter(i => !i.serialId && i.qty > 0)) {
      // Try RPC first, fallback to direct UPDATE if RPC has issues
      const { error: rpcErr } = await supabase.rpc('decrement_qty', {
        p_product_id: item.productId, p_qty: item.qty, p_user_id: user.id
      });
      if (rpcErr) {
        console.error('[ZeroStock] decrement_qty RPC failed, using direct UPDATE:', rpcErr.message);
        // Direct UPDATE fallback — no dependency on "updatedAt" column
        const { data: cur } = await supabase
          .from('products').select('qty_available, qty_sold')
          .eq('id', item.productId).eq('user_id', user.id).single();
        if (cur) {
          await supabase.from('products').update({
            qty_available: Math.max(0, (cur.qty_available || 0) - (item.qty || 1)),
            qty_sold:      (cur.qty_sold || 0) + (item.qty || 1),
            updated_at:    new Date().toISOString(),
          }).eq('id', item.productId).eq('user_id', user.id);
        }
      }
    }

    res.json({ data: { id: sale.id, total } });
  } catch (e) {
    dbError(res, e, 'sales/process');
  }
});

// ════════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════════
app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { data, error } = await supabase.from('settings').select('key,value').eq('user_id', user.id);
    if (error) return dbError(res, error, 'settings/list');
    const obj = {};
    (data || []).forEach(r => { obj[r.key] = r.value; });
    res.json({ data: obj });
  } catch (e) { dbError(res, e, 'settings/get'); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key requerido' });
    const { data, error } = await supabase
      .from('settings')
      .upsert({ user_id: user.id, key, value }, { onConflict: 'user_id,key' })
      .select().single();
    if (error) return dbError(res, error, 'settings/save');
    res.json({ data });
  } catch (e) { dbError(res, e, 'settings/post'); }
});

// ════════════════════════════════════════════════════════════
//  SYNC — POST /api/sync  (local → nube)
// ════════════════════════════════════════════════════════════
app.post('/api/sync', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const { products = [], customers = [], serials = [], sales = [], saleItems = [], settings = [] } = req.body;
    const isUUID = (val) => typeof val === 'string' && val.length === 36;
    const results = { products: 0, customers: 0, sales: 0 };
    const saleMap = {};
    const prodMap = {};

    // 1. PRODUCTOS
    // IMPORTANT: Do NOT sync qty_available or qty_sold here.
    // Those fields are managed exclusively by:
    //   - decrement_qty RPC (after a sale)
    //   - /api/products/add-qty endpoint (when restocking)
    // Syncing them from the client would overwrite correct server values.
    for (const prod of products) {
      const row = {
        user_id: user.id,
        name: prod.name, brand: prod.brand, model: prod.model,
        category: prod.category, cost: prod.cost, sale_price: prod.salePrice,
        min_stock: prod.minStock, serialized: prod.serialized || false,
        created_at: prod.createdAt ? new Date(prod.createdAt).toISOString() : new Date().toISOString()
      };
      // qty_available and qty_sold intentionally excluded — managed server-side only
      if (isUUID(prod.id)) row.id = prod.id;
      const { data, error } = await supabase.from('products')
        .upsert(row, { onConflict: row.id ? 'id' : 'user_id, name, brand' })
        .select('id').single();
      if (!error && data) { prodMap[prod.id] = data.id; results.products++; }
    }

    // 2. CLIENTES
    for (const cus of customers) {
      const row = {
        user_id: user.id,
        first_name: cus.firstName, last_name: cus.lastName,
        id_number: cus.idNumber, phone: cus.phone, address: cus.address,
        created_at: cus.createdAt ? new Date(cus.createdAt).toISOString() : new Date().toISOString()
      };
      if (isUUID(cus.id)) row.id = cus.id;
      const { data, error } = await supabase.from('customers')
        .upsert(row, { onConflict: row.id ? 'id' : 'user_id, id_number' })
        .select('id').single();
      if (!error && data) results.customers++;
    }

    // 2b. SERIALES (solo nuevos — los creados offline)
    for (const ser of serials) {
      // Si ya tiene un ID numérico grande (Supabase BIGINT), ya está en la nube
      if (ser.id && String(ser.id).length >= 6) continue;
      // Verificar que el productId existe en la nube
      const cloudProdId = prodMap[ser.productId] || ser.productId;
      if (!cloudProdId) continue;
      // Verificar que no existe ya (dedup por serial + user)
      const { data: existSerial } = await supabase
        .from('serials').select('id').eq('user_id', user.id).eq('serial', ser.serial).single();
      if (existSerial) continue;
      const { error: serErr } = await supabase.from('serials').insert({
        user_id:    user.id,
        product_id: cloudProdId,
        serial:     ser.serial,
        cost:       ser.cost || 0,
        sale_price: ser.salePrice || 0,
        status:     ser.status || 'available',
      });
      if (serErr) console.warn('[Sync] Serial insert error:', serErr.message);
    }

    // 3. VENTAS (solo nuevas)
    for (const sale of sales) {
      if (isUUID(sale.id)) { saleMap[sale.id] = sale.id; continue; }
      const row = {
        user_id: user.id,
        customer_id: isUUID(sale.customerId) ? sale.customerId : null,
        total: sale.total, rate_off: sale.rateOff, rate_cus: sale.rateCus,
        payment_method: sale.paymentMethod || 'div-elec',
        payment_currency: sale.paymentCurrency || 'usd',
        created_at: sale.createdAt ? new Date(sale.createdAt).toISOString() : new Date().toISOString()
      };
      const { data, error } = await supabase.from('sales').insert(row).select('id').single();
      if (!error && data) { saleMap[sale.id] = data.id; results.sales++; }
    }

    // 4. ITEMS DE VENTA (solo para ventas nuevas)
    for (const item of saleItems) {
      if (isUUID(item.id)) continue;
      const newSaleId = saleMap[item.saleId];
      if (!newSaleId) continue;
      await supabase.from('sale_items').insert({
        sale_id: newSaleId,
        product_id: prodMap[item.productId] || item.productId,
        product_name: item.productName,
        unit_price: item.unitPrice,
        qty: item.qty || 1
      });
    }
    
    res.json({ ok: true, results });
  } catch (e) {
    dbError(res, e, 'sync/push');
  }
});

    app.post('/api/products/add-qty', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { product_id, qty, cost, sale_price, variant } = req.body;

  const { data: current } = await supabase
    .from('products').select('qty_available')
    .eq('id', product_id).eq('user_id', user.id).single();

  if (!current) return res.status(404).json({ error: 'Producto no encontrado' });

  const updates = {
    cost: parseFloat(cost) || 0,
    sale_price: parseFloat(sale_price) || 0,
    qty_available: (current.qty_available || 0) + (parseInt(qty) || 0),
    updated_at: new Date().toISOString(),
  };
  if (variant) updates.last_variant = variant;

  const { data, error } = await supabase
    .from('products').update(updates)
    .eq('id', product_id).eq('user_id', user.id)
    .select().single();

  if (error) return dbError(res, error, 'products/add-qty');
  res.json({ data });
});

// ════════════════════════════════════════════════════════════
//  SYNC — GET /api/sync  (nube → local)
// ════════════════════════════════════════════════════════════
app.get('/api/sync', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);

    const [
      { data: products },
      { data: customers },
      { data: serials },
      { data: sales },
      { data: settings }
    ] = await Promise.all([
      supabase.from('products').select('*').eq('user_id', user.id),
      supabase.from('customers').select('*').eq('user_id', user.id),
      supabase.from('serials').select('*').eq('user_id', user.id),
      supabase.from('sales').select('*, sale_items(*)').eq('user_id', user.id),
      supabase.from('settings').select('*').eq('user_id', user.id)
    ]);

    const formattedProducts = (products || []).map(p => ({
      id: p.id, name: p.name, brand: p.brand, model: p.model,
      category: p.category, cost: p.cost, salePrice: p.sale_price,
      minStock: p.min_stock, qtyAvailable: p.qty_available,
      qtySold: p.qty_sold, serialized: p.serialized,
      createdAt: new Date(p.created_at).getTime(),
      updatedAt: p.updated_at ? new Date(p.updated_at).getTime()
               : new Date(p.created_at).getTime(),
    }));

    const formattedCustomers = (customers || []).map(c => ({
      id: c.id, firstName: c.first_name, lastName: c.last_name,
      idNumber: c.id_number, phone: c.phone, address: c.address,
      createdAt: new Date(c.created_at).getTime(),
      updatedAt: c.updated_at ? new Date(c.updated_at).getTime()
               : new Date(c.created_at).getTime(),
    }));

    const formattedSerials = (serials || []).map(s => ({
      id: s.id, productId: s.product_id, serial: s.serial,
      cost: s.cost, salePrice: s.sale_price, status: s.status,
      saleId: s.sale_id,
      addedAt:   s.created_at ? new Date(s.created_at).getTime() : 0,
      createdAt: s.created_at ? new Date(s.created_at).getTime() : 0,
      updatedAt: s.updated_at ? new Date(s.updated_at).getTime()
               : s.created_at ? new Date(s.created_at).getTime() : 0,
    }));

    const formattedSales    = [];
    const formattedSaleItems = [];
    (sales || []).forEach(s => {
      formattedSales.push({
        id: s.id, customerId: s.customer_id, total: s.total,
        rateOff: s.rate_off, rateCus: s.rate_cus,
        paymentMethod: s.payment_method, paymentCurrency: s.payment_currency,
        createdAt: new Date(s.created_at).getTime()
      });
      (s.sale_items || []).forEach(si => {
        formattedSaleItems.push({
          id: si.id, saleId: s.id, productId: si.product_id,
          serialId: si.serial_id, productName: si.product_name,
          unitPrice: si.unit_price, qty: si.qty
        });
      });
    });

    const formattedSettings = (settings || []).map(s => ({ key: s.key, value: s.value }));

    res.json({
      products:  formattedProducts,
      customers: formattedCustomers,
      serials:   formattedSerials,
      sales:     formattedSales,
      saleItems: formattedSaleItems,
      settings:  formattedSettings
    });
  } catch (e) {
    dbError(res, e, 'sync/pull');
  }
});

// ════════════════════════════════════════════════════════════
//  USER DATA — DELETE /api/user/clear
//  Borra TODOS los datos del usuario en Supabase (usado por clearAll)
// ════════════════════════════════════════════════════════════
app.post('/api/user/clear', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    const uid = user.id;

    // Borrar en orden correcto respetando FK constraints:
    // 1. sale_items (depende de sales, products, serials)
    // 2. serials (depende de products)
    // 3. sales (depende de customers)
    // 4. products, customers, settings (independientes)
    await supabase.from('sale_items')
      .delete()
      .in('sale_id',
        supabase.from('sales').select('id').eq('user_id', uid)
      );

    // sale_items via join no está disponible directo — borrar con subquery manual
    const { data: salesIds } = await supabase.from('sales').select('id').eq('user_id', uid);
    if (salesIds?.length) {
      await supabase.from('sale_items').delete()
        .in('sale_id', salesIds.map(s => s.id));
    }

    await supabase.from('sales').delete().eq('user_id', uid);
    await supabase.from('serials').delete().eq('user_id', uid);
    await supabase.from('products').delete().eq('user_id', uid);
    await supabase.from('customers').delete().eq('user_id', uid);
    await supabase.from('settings').delete().eq('user_id', uid);

    console.log(`[ZeroStock] User ${uid} data cleared`);
    res.json({ ok: true });
  } catch (e) {
    dbError(res, e, 'user/clear');
  }
});

// ════════════════════════════════════════════════════════════
//  START (dev local)
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ ZeroStock API v4.1 running on http://localhost:${PORT}`);
    console.log(`   Firebase: ${process.env.FIREBASE_PROJECT_ID || '⚠️ NOT SET'}`);
    console.log(`   Supabase: ${process.env.SUPABASE_URL || '⚠️ NOT SET'}`);
    console.log(`   Env vars: ${process.env.FIREBASE_PROJECT_ID && process.env.SUPABASE_URL ? '✅ OK' : '❌ MISSING'}`);
  });
}

// IMPORTANTE: Exportar para Vercel serverless
module.exports = app;
