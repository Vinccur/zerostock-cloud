-- ================================================================
--  ZeroStock Cloud — Supabase PostgreSQL Schema
--  Ejecutar en: Supabase Dashboard > SQL Editor > New Query
--  Proyecto: zerostock-0204 / hsnhfubiluakjdsysncr.supabase.co
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
--  RPC FUNCTION: decrement_qty
--  Usada por el backend al procesar ventas de productos masivos
-- ================================================================
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
    updated_at    = NOW()
  WHERE id = p_product_id
    AND user_id = p_user_id;
END;
$$;

-- ================================================================
--  ROW LEVEL SECURITY (RLS)
--  Cada usuario solo puede ver y modificar SUS propios datos
--  Nota: el backend usa service_role key que bypassa RLS,
--  pero es buena práctica habilitarlo de todas formas.
-- ================================================================

ALTER TABLE products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE serials     ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings    ENABLE ROW LEVEL SECURITY;

-- Políticas para products
CREATE POLICY "products_owner" ON products
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Políticas para serials
CREATE POLICY "serials_owner" ON serials
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Políticas para customers
CREATE POLICY "customers_owner" ON customers
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Políticas para sales
CREATE POLICY "sales_owner" ON sales
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Políticas para sale_items (via sale)
CREATE POLICY "sale_items_owner" ON sale_items
  USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = auth.uid()
    )
  );

-- Políticas para settings
CREATE POLICY "settings_owner" ON settings
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
