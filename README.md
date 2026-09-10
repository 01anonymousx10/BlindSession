<div align="center">

<img src="assets/blindsession-banner.svg" alt="BlindSession" width="700" />

<br/><br/>

### The server is blind. Your messages are not.

Server-blind, zero-knowledge, end-to-end encrypted messaging.
No phone. No email. No username. Just a cryptographic fingerprint.

<br/>

<img src="https://img.shields.io/badge/Encryption-XChaCha20--Poly1305-00ff9d?style=for-the-badge" />
<img src="https://img.shields.io/badge/Key_Exchange-X25519_ECDH-00b3ff?style=for-the-badge" />
<img src="https://img.shields.io/badge/Identity-Ed25519-ff4d4d?style=for-the-badge" />
<br/>
<img src="https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white" />
<img src="https://img.shields.io/badge/PostgreSQL-16-336791?style=for-the-badge&logo=postgresql&logoColor=white" />
<img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" />
<img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" />

<br/><br/>

[Quick Start](#-quick-start) &bull;
[Features](#-features) &bull;
[How It Works](#-how-it-works) &bull;
[Tech Stack](#-tech-stack) &bull;
[Security](#-security-model) &bull;
[Architecture](#-project-structure)

</div>

<br/>

---

## The Problem

Every major messaging platform claims "end-to-end encryption." But ask yourself:

> **Who holds your identity keys?** Most platforms generate and store them server-side.
>
> **What does the server actually see?** Metadata: who you talk to, when, how often, your contact list.
>
> **Can the server inject new devices?** Many E2EE apps allow server-side "key change" notifications that silently add eavesdropping devices.
>
> **What if the server is compromised?** If the server handles key distribution, a breach can enable man-in-the-middle attacks on all future conversations.

**BlindSession solves this by making the server completely blind.**

<div align="center">

| What the server sees | What the server never sees |
|:---:|:---:|
| Your public identity key **hash** | Your private keys |
| Ciphertext blobs | Message plaintext |
| When a message was sent | What the message says |
| That a message was delivered | Your contact list contents |
| That a message was read | Session keys or shared secrets |

</div>

The server is a **dumb relay** — it stores and forwards encrypted blobs. All key generation, key exchange, encryption, and decryption happen **in your browser** using libsodium. The server cannot read your messages, cannot inject new devices, and cannot derive your session keys even if compromised.

---

## Quick Start

### Run with Docker (recommended)

The only requirement is [Docker](https://docs.docker.com/get-docker/). No Node.js, no PostgreSQL, no npm.

```bash
git clone https://github.com/01anonymousx10/BlindSession.git
cd BlindSession
docker compose up --build
```

Open **http://localhost:3000** — that's it.

<details>
<summary><b>Other Docker commands</b></summary>

```bash
# Update to the latest version
git pull origin main
docker compose up -d --build

# Stop the app
docker compose down

# Stop and wipe the database
docker compose down -v
```
</details>

### Run locally (for development)

<details>
<summary><b>Local development setup</b></summary>

**Prerequisites:** Node.js v18+ and PostgreSQL

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL connection string

# Initialize database
psql -U postgres -d encrypted_chat_db -f database/schema.sql

# Start development server
npm run dev
```

Open **http://localhost:3000** in your browser.
</details>

---

## Features

### Encryption & Identity

| Feature | Description |
|---|---|
| Ed25519 identity keys | Generated in the browser, never sent to the server in plaintext |
| X25519 prekeys | Diffie-Hellman key exchange for forward-secret session derivation |
| XChaCha20-Poly1305 | Authenticated encryption for every message |
| Signed HTTP requests | Every API call is signed with your Ed25519 private key |
| Server-blind architecture | The server only sees ciphertext, hashes, and signatures |

### Messaging

| Feature | Description |
|---|---|
| Real-time delivery | WebSocket transport with instant push |
| Offline queuing | Messages stored as ciphertext when the recipient is offline |
| One-way contact add | Send messages to someone before they add you back |
| Image sharing | Auto-compressed (max 1200x1200, JPEG 0.85) with in-chat lightbox viewer |
| Encrypted backup | Export/import your identity with recovery code for cross-device portability |

### Delivery & Read Status

| Status | Meaning |
|:---:|---|
| `✓` Sent | Message handed to the network, awaiting delivery |
| `✓` Delivered | Recipient received the message (online push or offline queue pull) |
| `✓✓` Read | Recipient opened and read the message |

Per-message tracking with offline persistence — read receipts are stored server-side when the sender is offline.

### Presence

| State | Meaning |
|:---:|---|
| `Online` | WebSocket connected and active |
| `Offline` | No active WebSocket connection |
| `Active in chat` | Recipient is viewing your conversation right now |

Tab-switch aware — stays online when switching tabs, marks inactive in chat instead.

### Disappearing Messages

| Timer | Use case |
|---|---|
| 5 seconds | Ephemeral notes |
| 1 minute | Quick confidential replies |
| 1 hour | Sensitive conversations |
| 24 hours | Daily auto-cleanup |

Live countdown with visual hourglass badge. Timer changes sync to both users. Messages evaporate with a pixel-dissolve animation on expiry.

### Privacy & Control

| Feature | Description |
|---|---|
| Panic shredder | One-click account deletion with prekey cleanup — wipes everything instantly |
| Recovery code | Zero-knowledge encrypted 12-word recovery code for passphrase reset |
| Local storage | All message history stored in browser localStorage, encrypted at rest |
| No server-side history | Offline queue is deleted on delivery — server has no message archive |
| Duress passphrase | Silent shredder trigger under coercion (wipes keys, leaves no trace) |

---

## How It Works

### Key Exchange Flow

```
┌──────────┐                    ┌──────────┐                  ┌──────────┐
│  Alice   │                    │  Server  │                  │   Bob    │
│ (browser)│                    │ (blind)  │                  │ (browser)│
└────┬─────┘                    └────┬─────┘                  └────┬─────┘
     │                               │                             │
     │ 1. Generate Ed25519 identity  │  1. Generate Ed25519 identity│
     │    + X25519 prekey in browser │     + X25519 prekey in browser│
     │                               │                             │
     │ 2. Send public keys + hash ──>│<── Send public keys + hash  │
     │    (private keys stay local)  │    (private keys stay local) │
     │                               │                             │
     │ 3. Look up Bob's public key ─>│──> Return Bob's public key  │
     │                               │                             │
     │ 4. Derive shared secret:      │                             │
     │    Alice_priv × Bob_pub       │                             │
     │    (X25519 ECDH)              │                             │
     │                               │                             │
     │ 5. Encrypt with XChaCha20 ───>│──> Forward ciphertext ────> │
     │    (server sees only blob)    │                             │
     │                               │    6. Derive shared secret:  │
     │                               │       Bob_priv × Alice_pub   │
     │                               │       (same ECDH result)     │
     │                               │                             │
     │                               │<── 7. Decrypt with same key  │
     │                               │       → plaintext            │
```

### Why the server is blind

1. **Keys are generated in the browser** — Private keys never leave the user's device
2. **Key exchange is client-side** — The server only forwards public keys, never participates in ECDH
3. **Encryption is client-side** — The server only stores/forwards ciphertext blobs
4. **Authentication is signed** — Every HTTP request is signed with Ed25519; the server verifies but cannot forge
5. **No server-side session keys** — Shared secrets are derived independently by both clients from ECDH

---

## Security Model

### Cryptographic Primitives

| Primitive | Algorithm | Purpose |
|---|---|---|
| Identity signing | Ed25519 | Sign HTTP requests, authenticate WebSocket connections |
| Key exchange | X25519 ECDH | Derive shared session secrets (forward secrecy) |
| Message encryption | XChaCha20-Poly1305 | Authenticated encryption of all message content |
| Key derivation | Argon2id | Derive encryption key from passphrase (local storage) |
| Hashing | SHA-256 | Identity fingerprint generation |
| Random bytes | libsodium `randombytes` | Nonces, salts, key generation |

### Threat Model

| Threat | Mitigation |
|---|---|
| Server compromise | Server has no plaintext, no keys, no session secrets — nothing to steal |
| Man-in-the-middle | Ed25519 signature verification on every request + WebSocket connection |
| Key injection | Keys generated client-side; server cannot inject new devices |
| Metadata leakage | Server sees only hashes and timestamps, not identities or content |
| Replay attacks | Timestamp validation (60s drift) + per-request signatures |
| Offline brute force | Argon2id key derivation with random salt per identity |
| Device seizure | Panic shredder wipes all keys, contacts, and history instantly |
| Coercion | Duress passphrase triggers silent shredder — leaves no trace |

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Backend | Node.js + Fastify | HTTP API + WebSocket server |
| WebSocket | @fastify/websocket | Real-time message delivery |
| Database | PostgreSQL | User keys, offline message queue, event persistence |
| Crypto | libsodium (WASM) | Ed25519, X25519, XChaCha20-Poly1305, Argon2id |
| Frontend | Vanilla HTML/CSS/JS | No framework, no build step, no tracking |
| Container | Docker + Docker Compose | Zero-dependency deployment |
| PWA | Service Worker | Installable, offline-capable web app |

---

## Project Structure

```
src/
  server.js               — Server bootstrap + database auto-migration
  app.js                  — Fastify app setup (routes, static files, CORS)
  crypto/
    authMiddleware.js     — Ed25519 signature verification for HTTP requests
    verify.js             — Signature verification utilities
  routes/
    auth.js               — Identity registration, prekey rotation, account deletion
    chat.js               — Message send/retrieve, chat events, read receipts
    users.js              — User lookup by identity key hash
  socket/
    connection.js         — WebSocket manager (presence, delivery, chat state, events)

config/
  db.js                   — PostgreSQL connection pool

database/
  schema.sql              — Database schema (users, messages, chat_events, read_receipts)

public/
  index.html              — Full frontend (HTML + CSS)
  assets/js/
    ui.js                 — UI logic, rendering, state management
    socket.js             — WebSocket client + HTTP fallback
    crypto.js             — Client-side encryption/decryption (libsodium)
  assets/css/
    style.css             — External stylesheet

assets/
  blindsession-logo.svg   — Project logo
  blindsession-banner.svg — README banner
```

---

<div align="center">

## License

MIT — see [LICENSE](LICENSE)

<br/>

<sub>Built with privacy as the default, not an afterthought.</sub>

</div>
