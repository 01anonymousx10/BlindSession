# Deployment Guide

## Docker (recommended)

```bash
git clone https://github.com/YOUR_USERNAME/BlindSession.git
cd BlindSession
docker compose up --build
```

Open http://localhost:3000.

## Local development

```bash
npm install
cp .env.example .env
# Edit .env with your PostgreSQL connection string
psql -U postgres -d encrypted_chat_db -f database/schema.sql
npm run dev
```

## Production deployment

### Railway / Render

1. Create a PostgreSQL database on the platform
2. Connect your GitHub repository
3. Set environment variables:
   - `PORT` — 3000 or the platform's provided port
   - `DATABASE_URL` — your managed PostgreSQL connection string
   - `NODE_ENV` — production
4. Build command: `npm install`
5. Start command: `npm start`

### VPS with Docker

```bash
git clone https://github.com/YOUR_USERNAME/BlindSession.git
cd BlindSession
docker compose up -d
```

### VPS without Docker

```bash
git clone https://github.com/YOUR_USERNAME/BlindSession.git
cd BlindSession
npm install --omit=dev
cp .env.example .env
# Edit .env with production database credentials
psql -U postgres -d encrypted_chat_db -f database/schema.sql
npm install -g pm2
pm2 start src/server.js --name blindsession
pm2 save
pm2 startup
```
