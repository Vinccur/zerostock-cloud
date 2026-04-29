// ═══════════════════════════════════════════════════════════
//  ZeroStock Cloud — Backend API
//  Stack: Express + Firebase Admin + Supabase (PostgreSQL)
//  Deploy: Vercel (serverless)
// ═══════════════════════════════════════════════════════════
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const admin    = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── CORS (permite el HTML local y el dominio de Vercel) ──
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    /\.vercel\.app$/,
    /zerostock/i
  ],
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json({ limit: '5mb' }));

// ── Firebase Admin SDK ──
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    })
  });
}

// ── Supabase Admin Client (usa SERVICE_ROLE key — bypassa RLS) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
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
    req.firebaseUser = decoded;   // { uid, email, name, picture }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ════════════════════════════════════════════════════════════
//  HELPER — Obtener o crear usuario en Supabase
// ════════════════════════════════════════════════════════════
async function getOrCreateUser(firebaseUser) {
  const { uid, email, name, picture } = firebaseUser;

  // Buscar usuario existente
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('google_id', uid)
    .single();

  if (existing) return existing;

  // Crear nuevo usuario
  const { data: created, error } = await supabase
    .from('users')
    .insert({ google_id: uid, email, name, avatar: picture })
    .select()
    .single();

  if (error) throw new Error('Error creando usuario: ' + error.message);
  return created;
}

// ════════════════════════════════════════════════════════════
//  HELPER — Respuesta de error estandar
// ════════════════════════════════════════════════════════════
function dbError(res, error, context = '') {
  console.error(`[ZeroStock] ${context}:`, error);
  return res.status(500).json({ error: error.message || 'Error interno', context });
}

// ════════════════════════════════════════════════════════════
//  ROUTE — GET /api/health
// ════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    project: 'ZeroStock Cloud',
    timestamp: new Date().toISOString()
  });
});

// ════════════════════════════════════════════════════════════
//  AUTH — POST /api/auth/login
//  Verifica el Google token, crea/recupera el usuario en Supabase
// ════════════════════════════════════════════════════════════
app.post('/api/auth/login', authMiddleware, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    res.json({ user });
  } catch (e) {
    dbError(res, e, 'auth/login');
  }
});

// GET /api/auth/me — obtener datos del usuario actual
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
});

app.post('/api/products', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const body = { ...req.body, user_id: user.id };
  delete body.id; // dejar que Postgres genere el id

  const { data, error } = await supabase
    .from('products')
    .upsert(body, { onConflict: 'id' })
    .select()
    .single();

  if (error) return dbError(res, error, 'products/save');
  res.json({ data });
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { id } = req.params;

  // Verificar que pertenece al usuario
  const { data: existing } = await supabase
    .from('products').select('id').eq('id', id).eq('user_id', user.id).single();
  if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });

  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) return dbError(res, error, 'products/delete');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
//  SERIALS
// ════════════════════════════════════════════════════════════
app.get('/api/serials', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { product_id, status } = req.query;

  let query = supabase
    .from('serials')
    .select('*')
    .eq('user_id', user.id);

  if (product_id) query = query.eq('product_id', product_id);
  if (status)     query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return dbError(res, error, 'serials/list');
  res.json({ data });
});

app.post('/api/serials/bulk', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { product_id, items } = req.body; // items: [{serial, cost, salePrice}]

  if (!items?.length) return res.json({ data: [] });

  const rows = items.map(i => ({
    user_id:    user.id,
    product_id,
    serial:     i.serial,
    cost:       i.cost || 0,
    sale_price: i.salePrice || 0,
    status:     'available'
  }));

  const { data, error } = await supabase
    .from('serials')
    .insert(rows)
    .select();

  if (error) return dbError(res, error, 'serials/bulk');
  res.json({ data });
});

app.delete('/api/serials/:id', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('serials').select('id,status').eq('id', id).eq('user_id', user.id).single();
  if (!existing) return res.status(404).json({ error: 'Serial no encontrado' });
  if (existing.status === 'sold') return res.status(400).json({ error: 'No puedes eliminar un serial vendido' });

  const { error } = await supabase.from('serials').delete().eq('id', id);
  if (error) return dbError(res, error, 'serials/delete');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
//  CUSTOMERS
// ════════════════════════════════════════════════════════════
app.get('/api/customers', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { q } = req.query;

  let query = supabase
    .from('customers')
    .select('*')
    .eq('user_id', user.id)
    .order('last_name');

  if (q) {
    query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,id_number.ilike.%${q}%`);
  }

  const { data, error } = await query;
  if (error) return dbError(res, error, 'customers/list');
  res.json({ data });
});

app.post('/api/customers', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const body = { ...req.body, user_id: user.id };
  delete body.id;

  const { data, error } = await supabase
    .from('customers')
    .upsert(body, { onConflict: 'id' })
    .select()
    .single();

  if (error) return dbError(res, error, 'customers/save');
  res.json({ data });
});

app.delete('/api/customers/:id', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { id } = req.params;

  const { data: hasSales } = await supabase
    .from('sales').select('id').eq('customer_id', id).eq('user_id', user.id).limit(1);
  if (hasSales?.length) return res.status(400).json({ error: 'Cliente tiene ventas registradas' });

  const { error } = await supabase
    .from('customers').delete().eq('id', id).eq('user_id', user.id);
  if (error) return dbError(res, error, 'customers/delete');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
//  SALES — POST (procesar venta atómica)
// ════════════════════════════════════════════════════════════
app.get('/api/sales', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);

  const { data: sales, error } = await supabase
    .from('sales')
    .select(`*, customers(*), sale_items(*, products(*), serials(*))`)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return dbError(res, error, 'sales/list');

  // Normalizar al formato que espera el frontend
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
});

app.post('/api/sales', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { customerId, items, rateOff, rateCus, paymentMethod, paymentCurrency } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'El carrito está vacío' });

  const total = items.reduce((s, i) => s + (i.unitPrice * (i.qty || 1)), 0);

  try {
    // 1. Crear la venta
    const { data: sale, error: saleErr } = await supabase
      .from('sales')
      .insert({
        user_id:          user.id,
        customer_id:      customerId || null,
        total,
        rate_off:         rateOff,
        rate_cus:         rateCus,
        payment_method:   paymentMethod,
        payment_currency: paymentCurrency,
      })
      .select()
      .single();

    if (saleErr) throw saleErr;

    // 2. Crear los items
    const saleItems = items.map(i => ({
      sale_id:      sale.id,
      product_id:   i.productId,
      serial_id:    i.serialId || null,
      product_name: i.productName,
      unit_price:   i.unitPrice,
      qty:          i.qty || 1,
    }));

    const { error: itemsErr } = await supabase.from('sale_items').insert(saleItems);
    if (itemsErr) throw itemsErr;

    // 3. Actualizar seriales vendidos
    const soldSerialIds = items.filter(i => i.serialId).map(i => i.serialId);
    if (soldSerialIds.length) {
      const { error: serialErr } = await supabase
        .from('serials')
        .update({ status: 'sold', sale_id: sale.id })
        .in('id', soldSerialIds);
      if (serialErr) throw serialErr;
    }

    // 4. Decrementar stock de productos masivos
    for (const item of items.filter(i => !i.serialId && i.qty > 0)) {
      await supabase.rpc('decrement_qty', {
        p_product_id: item.productId,
        p_qty:        item.qty,
        p_user_id:    user.id
      });
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
  const user = await getOrCreateUser(req.firebaseUser);

  const { data, error } = await supabase
    .from('settings')
    .select('key,value')
    .eq('user_id', user.id);

  if (error) return dbError(res, error, 'settings/list');

  // Convertir array [{key,value}] a objeto {key:value}
  const obj = {};
  (data || []).forEach(r => { obj[r.key] = r.value; });
  res.json({ data: obj });
});

app.post('/api/settings', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { key, value } = req.body;

  if (!key) return res.status(400).json({ error: 'key requerido' });

  const { data, error } = await supabase
    .from('settings')
    .upsert({ user_id: user.id, key, value }, { onConflict: 'user_id,key' })
    .select()
    .single();

  if (error) return dbError(res, error, 'settings/save');
  res.json({ data });
});

// ════════════════════════════════════════════════════════════
//  SYNC — POST /api/sync
//  Recibe un snapshot completo de IndexedDB y lo sube a Supabase
//  Usado en la primera sincronización (migración de datos locales)
// ════════════════════════════════════════════════════════════
app.post('/api/sync', authMiddleware, async (req, res) => {
  const user = await getOrCreateUser(req.firebaseUser);
  const { products = [], customers = [], serials = [], sales = [], saleItems = [], settings = [] } = req.body;

  const results = { products: 0, customers: 0, serials: 0, sales: 0, errors: [] };

  try {
    // Settings
    for (const s of settings) {
      await supabase.from('settings')
        .upsert({ user_id: user.id, key: s.key, value: s.value }, { onConflict: 'user_id,key' });
    }

    // Customers (mapa de id local → id supabase)
    const custMap = {};
    for (const c of customers) {
      const localId = c.id;
      const row = {
        user_id:    user.id,
        first_name: c.firstName,
        last_name:  c.lastName,
        id_number:  c.idNumber,
        phone:      c.phone || null,
        address:    c.address || null,
      };
      const { data, error } = await supabase
        .from('customers').upsert(row, { onConflict: 'user_id,id_number' })
        .select('id').single();
      if (error) { results.errors.push(`customer ${c.idNumber}: ${error.message}`); continue; }
      custMap[localId] = data.id;
      results.customers++;
    }

    // Products (mapa id local → id supabase)
    const prodMap = {};
    for (const p of products) {
      const localId = p.id;
      const row = {
        user_id:       user.id,
        name:          p.name,
        brand:         p.brand,
        model:         p.model || null,
        category:      p.category,
        cost:          p.cost || 0,
        sale_price:    p.salePrice || 0,
        min_stock:     p.minStock || 1,
        qty_available: p.qtyAvailable || 0,
        qty_sold:      p.qtySold || 0,
        serialized:    p.serialized !== false,
      };
      const { data, error } = await supabase
        .from('products').upsert(row, { onConflict: 'user_id,name,brand' })
        .select('id').single();
      if (error) { results.errors.push(`product ${p.name}: ${error.message}`); continue; }
      prodMap[localId] = data.id;
      results.products++;
    }

    // Serials
    const serialMap = {};
    for (const s of serials) {
      const newProdId = prodMap[s.productId];
      if (!newProdId) continue;
      const row = {
        user_id:    user.id,
        product_id: newProdId,
        serial:     s.serial,
        cost:       s.cost || 0,
        sale_price: s.salePrice || 0,
        status:     s.status || 'available',
      };
      const { data, error } = await supabase
        .from('serials').upsert(row, { onConflict: 'user_id,serial' })
        .select('id').single();
      if (error) { results.errors.push(`serial ${s.serial}: ${error.message}`); continue; }
      serialMap[s.id] = data.id;
      results.serials++;
    }

    // Sales
    const saleMap = {};
    for (const sale of sales) {
      const row = {
        user_id:          user.id,
        customer_id:      custMap[sale.customerId] || null,
        total:            sale.total,
        rate_off:         sale.rateOff,
        rate_cus:         sale.rateCus,
        payment_method:   sale.paymentMethod || 'div-elec',
        payment_currency: sale.paymentCurrency || 'usd',
        created_at:       new Date(sale.createdAt).toISOString(),
      };
      const { data, error } = await supabase
        .from('sales').insert(row).select('id').single();
      if (error) { results.errors.push(`sale ${sale.id}: ${error.message}`); continue; }
      saleMap[sale.id] = data.id;
      results.sales++;
    }

    // Sale items
    for (const item of saleItems) {
      const newSaleId = saleMap[item.saleId];
      if (!newSaleId) continue;
      await supabase.from('sale_items').insert({
        sale_id:      newSaleId,
        product_id:   prodMap[item.productId] || item.productId,
        serial_id:    item.serialId ? (serialMap[item.serialId] || null) : null,
        product_name: item.productName,
        unit_price:   item.unitPrice,
        qty:          item.qty || 1,
      });
    }

    res.json({ ok: true, results });
  } catch (e) {
    dbError(res, e, 'sync/full');
  }
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ ZeroStock API running on http://localhost:${PORT}`);
    console.log(`   Firebase Project: ${process.env.FIREBASE_PROJECT_ID}`);
    console.log(`   Supabase URL:     ${process.env.SUPABASE_URL}`);
  });
}

module.exports = app;
