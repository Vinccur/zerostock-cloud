# Ø ZeroStock Cloud

Inventario y Facturación · Offline-First · Multi-Dispositivo  
**Stack:** Firebase Auth (Google Login) + Supabase (PostgreSQL) + Vercel (Node.js)

---

## Setup en 5 pasos

### 1. Clonar el repositorio

```bash
git clone https://github.com/Vinccur/zerostock-cloud.git
cd zerostock-cloud
npm install
```

### 2. Ejecutar el SQL en Supabase

- Ve a **Supabase Dashboard → SQL Editor → New Query**
- Copia y pega el contenido de `sql/schema.sql`
- Click **Run**

### 3. Obtener Firebase Service Account

- Ve a **Firebase Console → Project Settings → Service Accounts**
- Click **"Generate new private key"** → descarga el JSON
- Necesitarás: `client_email` y `private_key`

### 4. Configurar variables de entorno en Vercel

En Vercel Dashboard → Tu proyecto → Settings → Environment Variables:

| Variable | Valor | Dónde obtenerlo |
|----------|-------|-----------------|
| `FIREBASE_PROJECT_ID` | `zerostock-0204` | Firebase Project Settings |
| `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk-xxx@...` | Service Account JSON |
| `FIREBASE_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----\n...` | Service Account JSON |
| `SUPABASE_URL` | `https://hsnhfubiluakjdsysncr.supabase.co` | Supabase Settings → API |
| `SUPABASE_SERVICE_KEY` | `eyJh...` | Supabase Settings → API → service_role |

> ⚠️ `SUPABASE_SERVICE_KEY` es la clave **service_role** (la secreta), NO la anon key.
> Nunca la expongas en el frontend.

### 5. Deploy

```bash
git add .
git commit -m "feat: ZeroStock Cloud v4.0"
git push origin main
```

Vercel desplegará automáticamente desde GitHub.

---

## Desarrollo local

```bash
# Crear .env con tus credenciales (copia .env.example)
cp .env.example .env
# Editar .env con tus valores reales

npm run dev
# API disponible en http://localhost:3001
```

---

## Arquitectura

```
Browser (HTML + IndexedDB)
    ↕ Firebase SDK (Google Login)
    ↕ fetch() con Bearer token

Vercel (api/server.js — Express)
    ↕ firebase-admin verifica token
    ↕ @supabase/supabase-js

Supabase (PostgreSQL)
    Row-Level Security por user_id
    Datos completamente aislados por usuario
```

---

## Flujo de sincronización

1. Usuario abre la app → pantalla de login
2. Click "Continuar con Google" → popup OAuth
3. Firebase valida → genera ID Token (JWT)
4. Token se envía al backend en cada request
5. Backend verifica token con Firebase Admin SDK
6. Backend lee/escribe en Supabase con user_id
7. Al completar login: datos locales (IndexedDB) se sincronizan a Supabase
8. App funciona offline → sincroniza automáticamente al volver online

---

## Estructura de archivos

```
zerostock-cloud/
├── api/
│   └── server.js          ← Backend Express (todos los endpoints)
├── public/
│   └── zerostock.html     ← ZeroStock completo con Firebase integrado
├── sql/
│   └── schema.sql         ← Schema PostgreSQL + RLS policies
├── .env.example           ← Template de variables de entorno
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

---

## Endpoints de la API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/auth/login` | Login / crear usuario |
| GET | `/api/auth/me` | Datos del usuario actual |
| GET | `/api/products` | Listar productos del usuario |
| POST | `/api/products` | Crear / actualizar producto |
| DELETE | `/api/products/:id` | Eliminar producto |
| GET | `/api/serials` | Listar seriales |
| POST | `/api/serials/bulk` | Agregar seriales en lote |
| DELETE | `/api/serials/:id` | Eliminar serial |
| GET | `/api/customers` | Listar clientes |
| POST | `/api/customers` | Crear / actualizar cliente |
| DELETE | `/api/customers/:id` | Eliminar cliente |
| GET | `/api/sales` | Historial de ventas |
| POST | `/api/sales` | Procesar venta |
| GET | `/api/settings` | Leer configuración |
| POST | `/api/settings` | Guardar configuración |
| POST | `/api/sync` | Sync completo IndexedDB → Supabase |

Todos los endpoints requieren `Authorization: Bearer {firebase_id_token}`

---

## Costos (tier gratuito)

| Servicio | Plan | Límite gratuito |
|----------|------|-----------------|
| Firebase Auth | Spark (gratis) | 50,000 usuarios/mes |
| Supabase | Free | 500 MB DB · 2 GB bandwidth |
| Vercel | Hobby (gratis) | 100 GB bandwidth |
| **Total** | **$0/mes** | Más que suficiente para MVP |
