-- ================================================================
--  ZeroStock Cloud — Supabase PostgreSQL Schema
--  Ejecutar en: Supabase Dashboard > SQL Editor > New Query
--  Proyecto: zerostock-0204 / hsnhfubiluakjdsysncr.supabase.co
--
--  Nota: Este script usa IF NOT EXISTS y DROP IF EXISTS para ser idempotente
--  (puedes ejecutarlo varias veces sin error)
-- ================================================================
 
-- ── 1. TABLA: users ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id  VARCHAR UNIQUE NOT NULL,
  email      VARCHAR UNIQUE NOT NULL,
  name       VARCHAR,
  avatar     VARCHAR,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
 
-- ── 2. TABLA: products ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR NOT NULL,
  brand         VARCHAR NOT NULL DEFAULT 'Sin marca',
  model         VARCHAR,
  category      VARCHAR,
  cost          DECIMAL(10,2) DEFAULT 0,
  sale_price    DECIMAL(10,2) DEFAULT 0,
  min_stock     INT DEFAULT 1,
  qty_available INT DEFAULT 0,
  qty_sold      INT DEFAULT 0,
  serialized    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
 
CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_name_brand ON products(user_id, name, brand);
 
-- ── 3. TABLA: serials ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS serials (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  serial     VARCHAR NOT NULL,
  cost       DECIMAL(10,2) DEFAULT 0,
  sale_price DECIMAL(10,2) DEFAULT 0,
  status     VARCHAR DEFAULT 'available',   -- available | sold
  sale_id    BIGINT,                         -- referencia post-venta
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
 
CREATE INDEX IF NOT EXISTS idx_serials_user_id    ON serials(user_id);
CREATE INDEX IF NOT EXISTS idx_serials_product_id ON serials(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_serials_unique ON serials(user_id, serial);
 
-- ── 4. TABLA: customers ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name VARCHAR NOT NULL,
  last_name  VARCHAR NOT NULL,
  id_number  VARCHAR NOT NULL,
  phone      VARCHAR,
  address    VARCHAR,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
 
CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_id_number ON customers(user_id, id_number);
 
-- ── 5. TABLA: sales ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id      BIGINT REFERENCES customers(id),
  total            DECIMAL(10,2),
  rate_off         DECIMAL(10,2),
  rate_cus         DECIMAL(10,2),
  payment_method   VARCHAR,
  payment_currency VARCHAR,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
 
CREATE INDEX IF NOT EXISTS idx_sales_user_id ON sales(user_id);
 
-- ── 6. TABLA: sale_items ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_items (
  id           BIGSERIAL PRIMARY KEY,
  sale_id      BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  serial_id    BIGINT REFERENCES serials(id),
  product_name VARCHAR NOT NULL,
  unit_price   DECIMAL(10,2),
  qty          INT DEFAULT 1,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
 
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
 
-- ── 7. TABLA: settings ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        VARCHAR NOT NULL,
  value      VARCHAR,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, key)
);
 
CREATE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);
 
-- ================================================================
-- ACTUALIZACIÓN DE ESQUEMA PARA COMPATIBILIDAD CON CLAUDE
-- ================================================================

DO $$ 
DECLARE 
    tablas TEXT[] := ARRAY['products', 'serials', 'customers', 'sales', 'sale_items', 'settings'];
    t TEXT;
BEGIN
    FOREACH t IN ARRAY tablas LOOP
        -- 1. Eliminamos las columnas anteriores para evitar conflictos
        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS _mod', t);
        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS _del', t);

        -- 2. Agregamos las columnas con los nombres que usa Claude
        -- updatedAt: para el timestamp de JS (BIGINT)
        -- _deleted: para el borrado lógico (BOOLEAN porque Claude usa true/false)
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "updatedAt" BIGINT DEFAULT (extract(epoch from now()) * 1000)', t);
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "_deleted" BOOLEAN DEFAULT FALSE', t);
    END LOOP;
END $$;

-- 3. Actualizamos la función RPC para que use el nuevo nombre de columna
CREATE OR REPLACE FUNCTION decrement_qty(
  p_product_id BIGINT,
  p_qty        INT,
  p_user_id    UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE products
  SET
    qty_available = GREATEST(0, qty_available - p_qty),
    qty_sold      = qty_sold + p_qty,
    updated_at    = NOW(),
    "updatedAt"   = (extract(epoch from now()) * 1000)::BIGINT
  WHERE id = p_product_id
    AND user_id = p_user_id;
END;
$$;
 
-- ================================================================
--  ROW LEVEL SECURITY (RLS)
--  Cada usuario solo puede ver y modificar SUS propios datos
--
--  Nota: Primero dropear políticas viejas si existen, luego crear nuevas
-- ================================================================
 
-- Habilitar RLS en todas las tablas
ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE serials     ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings    ENABLE ROW LEVEL SECURITY;
 
-- ── Políticas para PRODUCTS ──
DROP POLICY IF EXISTS "products_owner" ON products;
CREATE POLICY "products_owner" ON products
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
 
-- ── Políticas para SERIALS ──
DROP POLICY IF EXISTS "serials_owner" ON serials;
CREATE POLICY "serials_owner" ON serials
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
 
-- ── Políticas para CUSTOMERS ──
DROP POLICY IF EXISTS "customers_owner" ON customers;
CREATE POLICY "customers_owner" ON customers
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
 
-- ── Políticas para SALES ──
DROP POLICY IF EXISTS "sales_owner" ON sales;
CREATE POLICY "sales_owner" ON sales
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
 
-- ── Políticas para SALE_ITEMS ──
DROP POLICY IF EXISTS "sale_items_owner" ON sale_items;
CREATE POLICY "sale_items_owner" ON sale_items
  USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = auth.uid()
    )
  );
 
-- ── Políticas para SETTINGS ──
DROP POLICY IF EXISTS "settings_owner" ON settings;
CREATE POLICY "settings_owner" ON settings
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
 
-- ================================================================
--  Confirmación
-- ================================================================
-- Si llegaste aquí sin errores, el schema está listo.
-- Deberías ver: "Success. No rows returned"
 
