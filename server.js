// ============================================================
// GENESIS INDEXA 360 IA v4.0 — SERVIDOR PRINCIPAL
// Node.js + Express | MOBIS Pecas Automotivas
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// -----------------------------------------------------------
// MIDDLEWARES
// -----------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir arquivos estaticos (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Logger
app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// -----------------------------------------------------------
// ROTAS API
// -----------------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
    res.json({
          ok: true,
          status: 'online',
          sistema: 'Genesis Indexa 360 IA v4.0',
          uptime: Math.round(process.uptime()),
          timestamp: new Date().toISOString()
    });
});

// Status
app.get('/api/status', (req, res) => {
    res.json({
          ok: true,
          versao: '4.0.0',
          sistema: 'Genesis Indexa 360 IA',
          empresa: 'MOBIS Pecas Automotivas'
    });
});

// -----------------------------------------------------------
// ROTA RAIZ — Serve o frontend HTML
// -----------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Todas as outras rotas retornam o frontend (SPA)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
          return res.status(404).json({ ok: false, erro: 'Rota nao encontrada' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------
// INICIAR SERVIDOR
// -----------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('  GENESIS INDEXA 360 IA v4.0   ONLINE');
    console.log('  MOBIS Pecas Automotivas');
    console.log(`  http://localhost:${PORT}`);
    console.log('='.repeat(60));
});
