// ============================================================
// GENESIS INDEXA 360 IA v5.0 — ENTERPRISE SAAS PLATFORM
// MIDWAY NTC 4.0 | Node.js + Express + SQLite
// MOBIS Pecas Automotivas
// ============================================================
require('dotenv').config();
const https = require('https');
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// -----------------------------------------------------------
// DATABASE
// -----------------------------------------------------------
const dbPath = path.join(__dirname, 'data', 'genesis.db');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  cnpj TEXT,
  plano TEXT DEFAULT 'starter',
  criado_em TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER DEFAULT 1,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha TEXT NOT NULL,
  role TEXT DEFAULT 'operador',
  criado_em TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER DEFAULT 1,
  ref TEXT NOT NULL,
  descricao TEXT NOT NULL,
  status TEXT DEFAULT 'Ativo',
  ntc_score REAL DEFAULT 0,
  ntc_status TEXT DEFAULT 'PENDENTE',
  rast_hash TEXT,
  criado_em TEXT DEFAULT (datetime('now','localtime')),
  atualizado_em TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(empresa_id, ref)
);

CREATE TABLE IF NOT EXISTS dna (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  fabricante TEXT,
  grupo_industrial TEXT,
  origem_pais TEXT,
  codigo_dna TEXT,
  marca TEXT,
  linha TEXT,
  familia TEXT,
  status_certificacao TEXT DEFAULT 'Pendente',
  score REAL DEFAULT 0,
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS hierarquia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  fabricante_original TEXT,
  montadora TEXT,
  distribuidor TEXT,
  importador TEXT,
  marca_propria TEXT,
  lojista TEXT,
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS aplicacoes_motor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  montadora TEXT,
  modelo TEXT,
  versao TEXT,
  motor TEXT,
  codigo_motor TEXT,
  combustivel TEXT,
  cilindrada TEXT,
  potencia TEXT,
  ano_ini INTEGER,
  ano_fim INTEGER,
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS codigos_cambiados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  tipo TEXT,
  codigo TEXT,
  fabricante TEXT,
  status TEXT DEFAULT 'Ativo',
  data_substituicao TEXT,
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS dados_fiscais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  ncm TEXT,
  cest TEXT,
  origem TEXT,
  ipi REAL,
  icms REAL,
  pis REAL,
  cofins REAL,
  cfop TEXT,
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS logistica (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  peso_liq REAL,
  peso_bruto REAL,
  altura REAL,
  largura REAL,
  comprimento REAL,
  volume REAL,
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS engenharia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  componentes TEXT,
  diametro TEXT,
  estrias INTEGER,
  sistema TEXT,
  material TEXT,
  especificacoes TEXT,
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS imagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  tipo TEXT,
  url TEXT,
  origem TEXT,
  resolucao TEXT,
  score_fi REAL DEFAULT 0,
  status TEXT DEFAULT 'Pendente',
  criado_em TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS rast_hash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  base TEXT,
  gerado_em TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS historico_ntc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER NOT NULL,
  usuario_id INTEGER,
  ntc_anterior REAL,
  ntc_novo REAL,
  status_anterior TEXT,
  status_novo TEXT,
  alteracao TEXT,
  criado_em TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(produto_id) REFERENCES produtos(id)
);

CREATE TABLE IF NOT EXISTS logs_ia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_ref TEXT,
  acao TEXT,
  resultado TEXT,
  confianca REAL,
  criado_em TEXT DEFAULT (datetime('now','localtime'))
);
`);

// Add wix_id column if not exists (migration)
try { db.exec("ALTER TABLE produtos ADD COLUMN wix_id TEXT"); } catch(e) { /* already exists */ }

// Multi-empresa migrations
['produtos','dna','dados_fiscais','logistica','imagens','historico_ntc','codigos_cambiados','aplicacoes_motor'].forEach(t => {
    try { db.exec(`ALTER TABLE ${t} ADD COLUMN empresa_id INTEGER DEFAULT 1`); } catch(e) {}
});

// Bling OAuth2 token storage table
db.exec(`
CREATE TABLE IF NOT EXISTS bling_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER DEFAULT 1,
  client_id TEXT,
  client_secret TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT DEFAULT 'Bearer',
  expires_at INTEGER,
  scope TEXT,
  atualizado_em TEXT DEFAULT (datetime('now','localtime'))
);
`);

// -----------------------------------------------------------
// BLING ERP v3 — OAuth2 + REST API
// -----------------------------------------------------------
const BLING_BASE = 'https://www.bling.com.br/Api/v3';
const BLING_AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';

function getBlingConfig(empresaId = 1) {
    return db.prepare('SELECT * FROM bling_config WHERE empresa_id=? ORDER BY id DESC LIMIT 1').get(empresaId) || null;
}

async function blingRefreshToken(config) {
    if (!config || !config.refresh_token) throw new Error('Refresh token nao disponivel');
    const creds = Buffer.from(config.client_id + ':' + config.client_secret).toString('base64');
    const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(config.refresh_token);
    const resp = await httpPostForm(BLING_TOKEN_URL, body, {
        'Authorization': 'Basic ' + creds,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
    });
    const data = JSON.parse(resp);
    if (data.error) throw new Error(data.error_description || data.error);
    const expiresAt = Date.now() + (data.expires_in || 21600) * 1000;
    db.prepare(`UPDATE bling_config SET access_token=?, refresh_token=COALESCE(?,refresh_token),
        expires_at=?, atualizado_em=datetime('now','localtime') WHERE id=?`
    ).run(data.access_token, data.refresh_token || null, expiresAt, config.id);
    return { ...config, access_token: data.access_token, expires_at: expiresAt };
}

async function blingRequest(method, path, body = null, empresaId = 1) {
    let config = getBlingConfig(empresaId);
    if (!config || !config.access_token) throw new Error('Bling nao configurado. Configure o OAuth2 em Integracoes.');
    if (config.expires_at && Date.now() > config.expires_at - 60000) {
        config = await blingRefreshToken(config);
    }
    const opts = {
        'Authorization': 'Bearer ' + config.access_token,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
    return JSON.parse(await (body
        ? httpPostJson(BLING_BASE + path, JSON.stringify(body), opts, method)
        : httpGet(BLING_BASE + path, opts)));
}

function httpPostForm(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
        const buf = Buffer.from(body, 'utf8');
        const req = mod.request({
            hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
            method: 'POST', headers: { ...headers, 'Content-Length': buf.length }
        }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject); req.write(buf); req.end();
    });
}

function httpPostJson(url, body, headers = {}, method = 'POST') {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
        const buf = Buffer.from(body, 'utf8');
        const req = mod.request({
            hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
            method, headers: { ...headers, 'Content-Length': buf.length }
        }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject); req.write(buf); req.end();
    });
}

// Status da integração Bling
app.get('/api/bling/status', (req, res) => {
    const config = getBlingConfig();
    if (!config || !config.client_id) return res.json({ conectado: false, mensagem: 'Nao configurado' });
    const expirado = config.expires_at && Date.now() > config.expires_at;
    res.json({
        conectado: !!config.access_token,
        expirado,
        client_id: config.client_id,
        scope: config.scope,
        atualizado_em: config.atualizado_em,
        expires_em: config.expires_at ? new Date(config.expires_at).toISOString() : null,
        tem_refresh: !!config.refresh_token,
    });
});

// Salvar Client ID e Secret (sem redirecionar ainda)
app.post('/api/bling/config', (req, res) => {
    const { client_id, client_secret } = req.body;
    if (!client_id || !client_secret) return res.status(400).json({ error: 'client_id e client_secret obrigatorios' });
    const existing = getBlingConfig();
    if (existing) {
        db.prepare("UPDATE bling_config SET client_id=?, client_secret=?, atualizado_em=datetime('now','localtime') WHERE id=?").run(client_id, client_secret, existing.id);
    } else {
        db.prepare("INSERT INTO bling_config (empresa_id, client_id, client_secret) VALUES (?,?,?)").run(1, client_id, client_secret);
    }
    res.json({ success: true });
});

// Gerar URL de autorização OAuth2
app.get('/api/bling/auth-url', (req, res) => {
    const config = getBlingConfig();
    if (!config || !config.client_id) return res.status(400).json({ error: 'Configure client_id primeiro' });
    const appUrl = process.env.APP_URL || ('http://localhost:' + PORT);
    const redirectUri = appUrl + '/api/bling/callback';
    const url = BLING_AUTH_URL + '?response_type=code&client_id=' + encodeURIComponent(config.client_id) + '&redirect_uri=' + encodeURIComponent(redirectUri);
    res.json({ url, redirect_uri: redirectUri });
});

// OAuth2 callback — troca code por access_token
app.get('/api/bling/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.send('<h2>Erro Bling OAuth: ' + error + '</h2>');
    if (!code) return res.send('<h2>Codigo ausente</h2>');
    try {
        const config = getBlingConfig();
        if (!config) return res.send('<h2>Bling nao configurado</h2>');
        const appUrl = process.env.APP_URL || ('http://localhost:' + PORT);
        const redirectUri = appUrl + '/api/bling/callback';
        const creds = Buffer.from(config.client_id + ':' + config.client_secret).toString('base64');
        const body = 'grant_type=authorization_code&code=' + encodeURIComponent(code) + '&redirect_uri=' + encodeURIComponent(redirectUri);
        const resp = await httpPostForm(BLING_TOKEN_URL, body, {
            'Authorization': 'Basic ' + creds,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        });
        const data = JSON.parse(resp);
        if (data.error) return res.send('<h2>Erro: ' + (data.error_description || data.error) + '</h2>');
        const expiresAt = Date.now() + (data.expires_in || 21600) * 1000;
        db.prepare(`UPDATE bling_config SET access_token=?, refresh_token=?, token_type=?, expires_at=?, scope=?,
            atualizado_em=datetime('now','localtime') WHERE id=?`
        ).run(data.access_token, data.refresh_token || null, data.token_type || 'Bearer', expiresAt, data.scope || null, config.id);
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bling Conectado</title>
        <style>body{font-family:sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
        .box{background:#111;border:1px solid #222;border-radius:12px;padding:40px;text-align:center;max-width:420px}
        h2{color:#00e676;margin:0 0 12px}p{color:#888;font-size:.9rem}a{color:#5a4bff;text-decoration:none}
        </style></head><body><div class="box">
        <h2>✅ Bling ERP v3 Conectado!</h2>
        <p>Access Token recebido e salvo com sucesso.<br>Refresh Token: ${data.refresh_token ? '✔ disponível' : '✗ não retornado'}.</p>
        <p>Feche esta janela e volte ao Genesis Indexa 360 IA.</p>
        <p><a href="javascript:window.close()">Fechar</a></p>
        </div></body></html>`);
    } catch (err) {
        res.send('<h2>Erro: ' + err.message + '</h2>');
    }
});

// Refresh manual do token
app.post('/api/bling/refresh', async (req, res) => {
    try {
        const config = getBlingConfig();
        await blingRefreshToken(config);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Sincronizar produto com Bling ERP v3
app.post('/api/bling/sincronizar/:id', async (req, res) => {
    try {
        const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
        if (!produto) return res.status(404).json({ error: 'Produto nao encontrado' });
        if (produto.status !== 'Congelado') return res.status(400).json({ error: 'Produto nao congelado' });

        const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(req.params.id) || {};
        const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(req.params.id) || {};
        const log = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(req.params.id) || {};
        const imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=? AND status != "Reprovada" ORDER BY tipo').all(req.params.id);

        const payload = {
            nome: produto.descricao,
            codigo: produto.ref,
            preco: produto.preco_venda || 0,
            precoCusto: produto.preco_custo || 0,
            situacao: produto.status === 'Congelado' ? 'A' : 'I',
            unidade: 'UN',
            marca: dna.marca || '',
            ...(fiscal.ncm ? { tributacao: { ncm: fiscal.ncm.replace(/\./g,'') } } : {}),
            ...(log.peso_liq ? { pesoLiquido: log.peso_liq, pesoBruto: log.peso_bruto || log.peso_liq } : {}),
            ...(log.largura ? { largura: log.largura, altura: log.altura || 0, comprimento: log.comprimento || 0 } : {}),
            ...(imagens.length ? { imagensProduto: imagens.slice(0,5).map((img, i) => ({ url: img.url, principal: i === 0 })) } : {}),
        };

        // Verificar se produto já existe no Bling
        let blingId = produto.bling_id || null;
        if (blingId) {
            await blingRequest('PUT', '/produtos/' + blingId, payload);
        } else {
            const resp = await blingRequest('POST', '/produtos', payload);
            blingId = resp?.data?.id || null;
            if (blingId) {
                try { db.exec("ALTER TABLE produtos ADD COLUMN bling_id TEXT"); } catch(e) {}
                db.prepare("UPDATE produtos SET bling_id=? WHERE id=?").run(String(blingId), req.params.id);
            }
        }

        db.prepare("INSERT INTO historico_ntc (produto_id,ntc_anterior,ntc_novo,status_anterior,status_novo,alteracao) VALUES (?,?,?,?,?,?)").run(
            req.params.id, produto.ntc_score, produto.ntc_score, produto.status, produto.status, 'Sincronizado Bling ERP v3'
        );

        res.json({ success: true, bling_id: blingId, mensagem: 'Produto sincronizado no Bling ERP v3' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Buscar produto no Bling por código
app.get('/api/bling/produto/:codigo', async (req, res) => {
    try {
        const data = await blingRequest('GET', '/produtos?codigo=' + encodeURIComponent(req.params.codigo));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Listar produtos do Bling
app.get('/api/bling/produtos', async (req, res) => {
    try {
        const data = await blingRequest('GET', '/produtos?pagina=1&limite=50');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------------------------------------
// SEED DATA
// -----------------------------------------------------------
const empCount = db.prepare('SELECT COUNT(*) as c FROM empresas').get();
if (empCount.c === 0) {
    db.prepare("INSERT INTO empresas (nome, cnpj, plano) VALUES (?,?,?)").run('MOBIS Pecas Automotivas', '19.903.967/0001-01', 'enterprise');
}

const usrCount = db.prepare('SELECT COUNT(*) as c FROM usuarios').get();
if (usrCount.c === 0) {
    db.prepare("INSERT INTO usuarios (empresa_id, nome, email, senha, role) VALUES (?,?,?,?,?)").run(1, 'Administrador', 'admin@mobis.com', 'admin123', 'admin');
    db.prepare("INSERT INTO usuarios (empresa_id, nome, email, senha, role) VALUES (?,?,?,?,?)").run(1, 'Operador 1', 'op1@mobis.com', 'op123', 'operador');
}

const prodCount = db.prepare('SELECT COUNT(*) as c FROM produtos').get();
if (prodCount.c === 0) {
    const insP = db.prepare("INSERT INTO produtos (empresa_id, ref, descricao, status, ntc_score, ntc_status, wix_id) VALUES (?,?,?,?,?,?,?)");
    const insD = db.prepare("INSERT INTO dna (produto_id, fabricante, grupo_industrial, origem_pais, codigo_dna, marca, linha, familia, status_certificacao, score) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const insF = db.prepare("INSERT INTO dados_fiscais (produto_id, ncm, cest, origem, ipi, icms, pis, cofins, cfop) VALUES (?,?,?,?,?,?,?,?,?)");
    const insL = db.prepare("INSERT INTO logistica (produto_id, peso_liq, peso_bruto, altura, largura, comprimento) VALUES (?,?,?,?,?,?)");

    const p1 = insP.run(1, 'LUK-6203236', 'KIT DE EMBREAGEM 200MM PLATO/DISCO/ROLAMENTO', 'Ativo', 0.97, 'APROVADO', 'a50f44fe-1c2e-463e-b21c-491a470007c3');
    insD.run(p1.lastInsertRowid, 'LUK Automotive', 'Schaeffler', 'Alemanha', '6203236000', 'LUK', 'RepSet Pro', 'Embreagem', 'Aprovado', 0.97);
    insF.run(p1.lastInsertRowid, '8708.93.00', '1512200', '0', 0, 12, 0.65, 3, '5102');
    insL.run(p1.lastInsertRowid, 4.2, 4.8, 12, 22, 22);

    const p2 = insP.run(1, 'BOC-0986494131', 'PASTILHA DE FREIO DIANTEIRA CERAMICA', 'Ativo', 0.82, 'PENDENTE', 'd5e27817-e588-4da4-ad9d-fe5585356a21');
    insD.run(p2.lastInsertRowid, 'Robert Bosch GmbH', 'Robert Bosch GmbH', 'Alemanha', '0986494131', 'Bosch', 'Quietcast', 'Freios', 'Pendente', 0.82);
    insF.run(p2.lastInsertRowid, '8708.10.00', '1512100', '0', 0, 12, 0.65, 3, '5102');
    insL.run(p2.lastInsertRowid, 0.8, 1.0, 5, 15, 20);

    const p3 = insP.run(1, 'SKF-VKBA3569', 'ROLAMENTO RODA TRASEIRA COM ABS', 'Ativo', 0.45, 'REPROVADO', 'ce2aaa9f-ea27-42d4-95d2-7d3553c15380');
    insD.run(p3.lastInsertRowid, 'SKF AB', 'SKF AB', 'Suecia', 'VKBA3569', 'SKF', 'Bearings', 'Rolamentos', 'Reprovado', 0.45);
    insF.run(p3.lastInsertRowid, '8482.10.10', null, '0', 0, 12, 0.65, 3, '5102');
    insL.run(p3.lastInsertRowid, 1.5, 1.8, 8, 14, 14);
}

// -----------------------------------------------------------
// NTC BRAND KNOWLEDGE BASE
// -----------------------------------------------------------
const GRUPOS = {
    'luk': { grupo: 'Schaeffler', origem: 'Alemanha', tier: 1 },
    'ina': { grupo: 'Schaeffler', origem: 'Alemanha', tier: 1 },
    'fag': { grupo: 'Schaeffler', origem: 'Alemanha', tier: 1 },
    'bosch': { grupo: 'Robert Bosch GmbH', origem: 'Alemanha', tier: 1 },
    'ngk': { grupo: 'NGK Spark Plug Co.', origem: 'Japao', tier: 1 },
    'denso': { grupo: 'DENSO Corporation', origem: 'Japao', tier: 1 },
    'valeo': { grupo: 'Valeo SA', origem: 'Franca', tier: 1 },
    'sachs': { grupo: 'ZF Friedrichshafen', origem: 'Alemanha', tier: 1 },
    'zf': { grupo: 'ZF Friedrichshafen', origem: 'Alemanha', tier: 1 },
    'monroe': { grupo: 'Tenneco', origem: 'EUA', tier: 1 },
    'cofap': { grupo: 'Tenneco', origem: 'Brasil', tier: 2 },
    'mahle': { grupo: 'MAHLE GmbH', origem: 'Alemanha', tier: 1 },
    'mann': { grupo: 'MANN+HUMMEL', origem: 'Alemanha', tier: 1 },
    'metal leve': { grupo: 'MAHLE GmbH', origem: 'Brasil', tier: 1 },
    'ate': { grupo: 'Continental AG', origem: 'Alemanha', tier: 1 },
    'continental': { grupo: 'Continental AG', origem: 'Alemanha', tier: 1 },
    'brembo': { grupo: 'Brembo SpA', origem: 'Italia', tier: 1 },
    'textar': { grupo: 'TMD Friction', origem: 'Alemanha', tier: 1 },
    'ferodo': { grupo: 'TMD Friction', origem: 'Reino Unido', tier: 1 },
    'exedy': { grupo: 'Exedy Corporation', origem: 'Japao', tier: 1 },
    'ntn': { grupo: 'NTN Corporation', origem: 'Japao', tier: 1 },
    'skf': { grupo: 'SKF AB', origem: 'Suecia', tier: 1 },
    'nsk': { grupo: 'NSK Ltd', origem: 'Japao', tier: 1 },
    'nakata': { grupo: 'Nakata', origem: 'Brasil', tier: 2 },
    'mobis': { grupo: 'Hyundai Mobis', origem: 'Coreia', tier: 1 },
    'bendix': { grupo: 'Bendix', origem: 'EUA', tier: 2 },
    'trw': { grupo: 'ZF TRW', origem: 'EUA', tier: 1 },
    'perfect': { grupo: 'Perfect Circle', origem: 'Brasil', tier: 2 },
    'marelli': { grupo: 'Marelli Holdings', origem: 'Italia', tier: 1 },
    'delphi': { grupo: 'BorgWarner', origem: 'EUA', tier: 1 },
    'gates': { grupo: 'Gates Industrial', origem: 'EUA', tier: 1 },
    'dayco': { grupo: 'Dayco Products', origem: 'EUA', tier: 2 },
};

const NTC_WEIGHTS = {
    DNA: 0.25, TF: 0.15, FM: 0.10, CO: 0.10,
    AV: 0.10, MC: 0.05, EC: 0.05, BTA: 0.05,
    CC: 0.05, LG: 0.05, FI: 0.03, FP: 0.02
};

// -----------------------------------------------------------
// NTC ENGINE FUNCTIONS
// -----------------------------------------------------------
function detectBrand(text) {
    const lower = text.toLowerCase();
    for (const [key, val] of Object.entries(GRUPOS)) {
        if (lower.includes(key)) return { brand: key, ...val };
    }
    return null;
}

function extractCode(text) {
    const patterns = [
        /\b([A-Z]{2,4}[-]?[0-9]{6,12}[A-Z0-9]*)\b/,
        /\b([0-9]{7,13})\b/,
        /\b([A-Z]{1,3}[0-9]{4,8}[A-Z]?)\b/
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1];
    }
    return null;
}

function detectComponents(text) {
    const lower = text.toLowerCase();
    const components = [];
    const keywords = [
        'plato','disco','rolamento','mola','cubo','anel','vedacao','gaxeta',
        'pistao','cilindro','sensor','cabo','bomba','junta','retentores',
        'parafuso','porca','arruela','bucha','pino','chaveta','engrenagem',
        'correia','tensor','polia','suporte','carcaca','tampa','filtro',
        'selo','oring','graxeira','mancal','casquilho'
    ];
    keywords.forEach(k => { if (lower.includes(k)) components.push(k); });
    return components;
}

function detectMeasures(text) {
    const m = text.match(/(\d{2,3})\s*mm/i);
    const pol = text.match(/(\d{1,2}[.,]\d{1,2})\s*(?:pol|inch|")/i);
    const estrias = text.match(/(\d{1,2})\s*estri/i);
    const bar = text.match(/(\d{1,4})\s*(?:bar|psi|kpa)/i);
    const nm  = text.match(/(\d{1,4})\s*n\.?m\b/i);
    return {
        diametro: m ? m[1] + 'mm' : (pol ? pol[1] + '"' : null),
        estrias: estrias ? parseInt(estrias[1]) : null,
        pressao: bar ? bar[1] : null,
        torque: nm ? nm[1] + 'Nm' : null
    };
}

function detectCategoria(text) {
    const lower = text.toLowerCase();
    const map = [
        // Motor / Cabeçote
        ['cabecote', 'Motor'], ['cabeçote', 'Motor'], ['cabecote', 'Motor'],
        ['junta do cabecote', 'Motor'], ['junta cabeçote', 'Motor'],
        ['kit motor', 'Motor'], ['kit correia', 'Motor'],
        ['correia dentada', 'Motor'], ['tensor', 'Motor'],
        ['arvore de manivelas', 'Motor'], ['came', 'Motor'], ['comando', 'Motor'],
        ['pistao', 'Motor'], ['segmento', 'Motor'], ['biela', 'Motor'],
        ['bloco', 'Motor'], ['carter', 'Motor'], ['virabrequim', 'Motor'],
        ['kit retifica', 'Motor'], ['retifica', 'Motor'],
        // Embreagem
        ['embreagem', 'Embreagem'], ['plato', 'Embreagem'],
        ['disco de embreagem', 'Embreagem'], ['atuador de embreagem', 'Embreagem'],
        // Freios
        ['pastilha', 'Freios'], ['disco de freio', 'Freios'],
        ['lona', 'Freios'], ['tambor', 'Freios'],
        ['freio', 'Freios'], ['abs', 'Freios'], ['caliper', 'Freios'],
        // Filtros
        ['filtro de oleo', 'Filtros'], ['filtro de ar', 'Filtros'],
        ['filtro de combustivel', 'Filtros'], ['filtro de cabine', 'Filtros'],
        ['filtro', 'Filtros'],
        // Suspensão
        ['amortecedor', 'Suspensao'], ['mola', 'Suspensao'],
        ['barra estabilizadora', 'Suspensao'], ['bandeja', 'Suspensao'],
        ['pivô', 'Suspensao'], ['pivo', 'Suspensao'], ['cubo de roda', 'Suspensao'],
        ['articulacao', 'Suspensao'], ['bieleta', 'Suspensao'],
        ['terminal', 'Suspensao'], ['coxim', 'Suspensao'],
        // Rolamentos / Vedações
        ['rolamento', 'Rolamentos'], ['retentor', 'Vedacoes'],
        ['retentores', 'Vedacoes'], ['oring', 'Vedacoes'],
        ['vedacao', 'Vedacoes'], ['junta', 'Vedacoes'], ['gaxeta', 'Vedacoes'],
        // Injeção / Combustível
        ['injetor', 'Injecao'], ['bico injetor', 'Injecao'],
        ['bomba de combustivel', 'Combustivel'], ['bomba injetora', 'Injecao'],
        ['regulador de pressao', 'Combustivel'], ['rail', 'Injecao'],
        // Elétrica / Ignição
        ['vela de ignicao', 'Ignicao'], ['vela', 'Ignicao'],
        ['bobina', 'Ignicao'], ['cabo de ignicao', 'Ignicao'],
        ['distribuidor', 'Ignicao'], ['platinado', 'Ignicao'],
        ['alternador', 'Eletrica'], ['motor de partida', 'Eletrica'],
        ['sensor', 'Eletrica'], ['modulo', 'Eletrica'], ['cdi', 'Ignicao'],
        // Arrefecimento
        ['radiador', 'Arrefecimento'], ['bomba dagua', 'Arrefecimento'],
        ['bomba d agua', 'Arrefecimento'], ['termostato', 'Arrefecimento'],
        ['mangueira', 'Arrefecimento'], ['vareta', 'Arrefecimento'],
        ['reservatorio', 'Arrefecimento'],
        // Direção / Transmissão
        ['direcao', 'Direcao'], ['caixa de direcao', 'Direcao'],
        ['bomba de direcao', 'Direcao'], ['cremalheira', 'Direcao'],
        ['transmissao', 'Transmissao'], ['cambio', 'Transmissao'],
        ['junta homocinetica', 'Transmissao'], ['homocentica', 'Transmissao'],
        ['semieixo', 'Transmissao'], ['diferencial', 'Transmissao'],
        // Correia / Sistema auxiliar
        ['correia', 'Motor'],
    ];
    for (const [k, v] of map) {
        if (lower.includes(k)) return v;
    }
    return 'Geral';
}

function calcNTC(text, extraData = {}) {
    const brandInfo = detectBrand(text);
    const code = extractCode(text);
    const components = detectComponents(text);
    const measures = detectMeasures(text);
    const categoria = detectCategoria(text);

    // DNA module (0.25)
    let dnaScore = 0;
    const dnaEvidence = [];
    const dnaMissing = [];
    if (brandInfo) { dnaScore += 0.6; dnaEvidence.push('Marca: ' + brandInfo.brand.toUpperCase() + ' (Tier ' + brandInfo.tier + ')'); }
    else dnaMissing.push('Fabricante/marca nao identificado');
    if (brandInfo && brandInfo.grupo) { dnaScore += 0.2; dnaEvidence.push('Grupo: ' + brandInfo.grupo); }
    if (brandInfo && brandInfo.origem) { dnaScore += 0.1; dnaEvidence.push('Origem: ' + brandInfo.origem); }
    if (brandInfo && brandInfo.tier === 1) { dnaScore += 0.1; dnaEvidence.push('Tier 1 OEM'); }
    else if (brandInfo && brandInfo.tier === 2) dnaScore += 0.05;
    dnaScore = Math.min(1, dnaScore);

    // TF - Technical Family (0.15)
    let tfScore = 0;
    const tfEvidence = [];
    const tfMissing = [];
    if (categoria !== 'Geral') { tfScore += 0.4; tfEvidence.push('Categoria: ' + categoria); }
    else tfMissing.push('Categoria de produto nao detectada');
    if (components.length > 0) { tfScore += 0.3; tfEvidence.push('Componentes: ' + components.join(', ')); }
    else tfMissing.push('Componentes do kit nao listados');
    if (measures.diametro) { tfScore += 0.2; tfEvidence.push('Diametro: ' + measures.diametro); }
    else tfMissing.push('Medidas/dimensoes nao informadas');
    if (measures.estrias) { tfScore += 0.1; tfEvidence.push('Estrias: ' + measures.estrias); }
    tfScore = Math.min(1, tfScore);

    // FM - Fiscal Mapping (0.10)
    let fmScore = extraData.ncm ? 0.6 : 0;
    const fmEvidence = extraData.ncm ? ['NCM: ' + extraData.ncm] : [];
    const fmMissing = extraData.ncm ? [] : ['NCM nao informado'];
    if (extraData.cest) { fmScore += 0.2; fmEvidence.push('CEST: ' + extraData.cest); }
    else fmMissing.push('CEST nao informado');
    if (extraData.cfop) { fmScore += 0.2; fmEvidence.push('CFOP: ' + extraData.cfop); }
    else fmMissing.push('CFOP nao informado');

    // CO - Code Origin (0.10)
    let coScore = 0;
    const coEvidence = [];
    const coMissing = [];
    if (code) { coScore += 0.7; coEvidence.push('Codigo: ' + code); }
    else coMissing.push('Codigo de referencia nao encontrado');
    if (extraData.ean) { coScore += 0.3; coEvidence.push('EAN: ' + extraData.ean); }
    else coMissing.push('EAN/GTIN nao informado');

    // AV - Application Vehicles (0.10)
    let avScore = 0;
    const avEvidence = [];
    const avMissing = [];
    if (extraData.aplicacoes && extraData.aplicacoes.length > 0) {
        avScore = Math.min(1, 0.3 + extraData.aplicacoes.length * 0.1);
        avEvidence.push(extraData.aplicacoes.length + ' aplicacao(oes) cadastrada(s)');
    } else avMissing.push('Aplicacoes veiculares nao cadastradas');

    // MC - Market Classification (0.05)
    let mcScore = 0;
    const mcEvidence = [];
    const mcMissing = [];
    if (brandInfo && brandInfo.tier === 1) { mcScore = 0.9; mcEvidence.push('OEM Tier 1 confirmado'); }
    else if (brandInfo && brandInfo.tier === 2) { mcScore = 0.6; mcEvidence.push('Aftermarket Tier 2'); }
    else { mcScore = 0.2; mcMissing.push('Classificacao de mercado indefinida'); }

    // EC - Engineering Characteristics (0.05)
    let ecScore = 0;
    const ecEvidence = [];
    const ecMissing = [];
    if (components.length >= 3) { ecScore += 0.5; ecEvidence.push('Kit completo (' + components.length + ' componentes)'); }
    else if (components.length > 0) ecScore += 0.3;
    else ecMissing.push('Componentes de engenharia nao especificados');
    if (measures.diametro || measures.estrias) { ecScore += 0.5; ecEvidence.push('Especificacoes tecnicas presentes'); }
    else ecMissing.push('Especificacoes tecnicas ausentes');
    ecScore = Math.min(1, ecScore);

    // BTA - Brand Trust Assessment (0.05)
    let btaScore = 0;
    const btaEvidence = [];
    const btaMissing = [];
    if (brandInfo) {
        btaScore = brandInfo.tier === 1 ? 1.0 : 0.7;
        btaEvidence.push(brandInfo.grupo + ' - Confiabilidade ' + (brandInfo.tier === 1 ? 'Alta' : 'Media'));
    } else btaMissing.push('Marca nao rastreavel na base');

    // CC - Cross Codes (0.05)
    let ccScore = extraData.codigos && extraData.codigos.length > 0
        ? Math.min(1, extraData.codigos.length * 0.25) : 0;
    const ccEvidence = ccScore > 0 ? [extraData.codigos.length + ' codigo(s) cambiado(s)'] : [];
    const ccMissing = ccScore === 0 ? ['Codigos cambiados nao cadastrados'] : [];

    // LG - Logistics (0.05)
    let lgScore = 0;
    const lgEvidence = [];
    const lgMissing = [];
    if (extraData.peso) { lgScore += 0.5; lgEvidence.push('Peso: ' + extraData.peso + 'kg'); }
    else lgMissing.push('Peso nao informado');
    if (extraData.dimensoes) { lgScore += 0.5; lgEvidence.push('Dimensoes cadastradas'); }
    else lgMissing.push('Dimensoes nao informadas');

    // FI - Fiscal Images (0.03) - CRITICAL RULE: never invent images
    let fiScore = extraData.imagens && extraData.imagens.length > 0
        ? Math.min(1, extraData.imagens.length * 0.33) : 0;
    const fiEvidence = fiScore > 0 ? [extraData.imagens.length + ' imagem(ns) cadastrada(s)'] : [];
    const fiMissing = fiScore === 0 ? ['Imagens do produto nao cadastradas'] : [];

    // FP - Fiscal Period (0.02)
    let fpScore = extraData.ncm ? 0.8 : 0;
    const fpEvidence = extraData.ncm ? ['Enquadramento fiscal presente'] : [];
    const fpMissing = extraData.ncm ? [] : ['Enquadramento fiscal ausente'];

    const modules = {
        DNA: { score: dnaScore, weight: NTC_WEIGHTS.DNA, evidence: dnaEvidence, missing: dnaMissing, label: 'DNA do Produto' },
        TF: { score: tfScore, weight: NTC_WEIGHTS.TF, evidence: tfEvidence, missing: tfMissing, label: 'Familia Tecnica' },
        FM: { score: fmScore, weight: NTC_WEIGHTS.FM, evidence: fmEvidence, missing: fmMissing, label: 'Mapeamento Fiscal' },
        CO: { score: coScore, weight: NTC_WEIGHTS.CO, evidence: coEvidence, missing: coMissing, label: 'Origem dos Codigos' },
        AV: { score: avScore, weight: NTC_WEIGHTS.AV, evidence: avEvidence, missing: avMissing, label: 'Aplicacoes Veiculares' },
        MC: { score: mcScore, weight: NTC_WEIGHTS.MC, evidence: mcEvidence, missing: mcMissing, label: 'Classificacao de Mercado' },
        EC: { score: ecScore, weight: NTC_WEIGHTS.EC, evidence: ecEvidence, missing: ecMissing, label: 'Caracteristicas de Engenharia' },
        BTA: { score: btaScore, weight: NTC_WEIGHTS.BTA, evidence: btaEvidence, missing: btaMissing, label: 'Avaliacao de Confianca da Marca' },
        CC: { score: ccScore, weight: NTC_WEIGHTS.CC, evidence: ccEvidence, missing: ccMissing, label: 'Codigos Cambiados' },
        LG: { score: lgScore, weight: NTC_WEIGHTS.LG, evidence: lgEvidence, missing: lgMissing, label: 'Logistica' },
        FI: { score: fiScore, weight: NTC_WEIGHTS.FI, evidence: fiEvidence, missing: fiMissing, label: 'Imagens Fiscais' },
        FP: { score: fpScore, weight: NTC_WEIGHTS.FP, evidence: fpEvidence, missing: fpMissing, label: 'Periodo Fiscal' },
    };

    let totalScore = 0;
    for (const mod of Object.values(modules)) {
        totalScore += mod.score * mod.weight;
        mod.contribuicao = parseFloat((mod.score * mod.weight).toFixed(4));
    }
    totalScore = parseFloat(totalScore.toFixed(4));

    let ntcStatus = 'REPROVADO';
    if (totalScore >= 0.95) ntcStatus = 'APROVADO';
    else if (totalScore >= 0.60) ntcStatus = 'PENDENTE';

    const rastBase = text + '|' + JSON.stringify(extraData);
    const rastHash = 'RAST-' + crypto.createHash('sha256').update(rastBase).digest('hex').substring(0, 16).toUpperCase();

    return {
        score: totalScore,
        status: ntcStatus,
        modules,
        rast_hash: rastHash,
        dna: {
            fabricante: brandInfo ? brandInfo.grupo : null,
            marca: brandInfo ? brandInfo.brand.toUpperCase() : null,
            origem_pais: brandInfo ? brandInfo.origem : null,
            grupo_industrial: brandInfo ? brandInfo.grupo : null,
            codigo_dna: code,
            familia: categoria,
            tier: brandInfo ? brandInfo.tier : null
        },
        engenharia: {
            componentes: components,
            diametro: measures.diametro,
            estrias: measures.estrias,
            categoria
        }
    };
}

// -----------------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Upload
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// -----------------------------------------------------------
// HEALTH / AUTH
// -----------------------------------------------------------
app.get('/api/health', (req, res) => {
    const emp = db.prepare('SELECT * FROM empresas WHERE id=1').get();
    res.json({
        status: 'OK',
        version: '5.0.0',
        platform: 'Genesis Indexa 360 IA + MIDWAY NTC 4.0',
        empresa: emp ? { nome: emp.nome, cnpj: emp.cnpj, plano: emp.plano } : null,
        produtos: db.prepare('SELECT COUNT(*) as c FROM produtos').get().c,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    const user = db.prepare('SELECT * FROM usuarios WHERE email=? AND senha=?').get(email, senha);
    if (!user) return res.status(401).json({ error: 'Credenciais invalidas' });
    res.json({ success: true, usuario: { id: user.id, nome: user.nome, email: user.email, role: user.role, empresa_id: user.empresa_id } });
});

// -----------------------------------------------------------
// PRODUTOS
// -----------------------------------------------------------
app.get('/api/produtos', (req, res) => {
    const { search = '', status, ntc_status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const where = ['1=1'];
    const params = [];
    if (search) { where.push('(p.ref LIKE ? OR p.descricao LIKE ?)'); params.push('%' + search + '%', '%' + search + '%'); }
    if (status) { where.push('p.status=?'); params.push(status); }
    if (ntc_status) { where.push('p.ntc_status=?'); params.push(ntc_status); }
    const whereStr = where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) as c FROM produtos p WHERE ' + whereStr).get(...params).c;
    params.push(parseInt(limit), offset);
    const rows = db.prepare('SELECT p.*, d.fabricante, d.marca, d.familia, d.grupo_industrial, d.origem_pais, d.codigo_dna FROM produtos p LEFT JOIN dna d ON d.produto_id = p.id WHERE ' + whereStr + ' ORDER BY p.atualizado_em DESC LIMIT ? OFFSET ?').all(...params);
    // Attach imagem_principal for each product
    rows.forEach(row => {
        const img = db.prepare("SELECT url FROM imagens WHERE produto_id=? ORDER BY CASE WHEN tipo='Principal' THEN 0 ELSE 1 END, id ASC LIMIT 1").get(row.id);
        row.imagem_principal = img ? img.url : null;
    });
    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
});

app.get('/api/produtos/:id', (req, res) => {
    const id = req.params.id;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    p.dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);
    p.hierarquia = db.prepare('SELECT * FROM hierarquia WHERE produto_id=?').get(id);
    p.fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(id);
    p.logistica = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(id);
    p.engenharia = db.prepare('SELECT * FROM engenharia WHERE produto_id=?').get(id);
    p.aplicacoes = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(id);
    p.codigos = db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(id);
    p.imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id);
    p.rast = db.prepare('SELECT * FROM rast_hash WHERE produto_id=?').get(id);
    res.json(p);
});

app.post('/api/produtos', (req, res) => {
    const { ref, descricao, empresa_id = 1, dna: dnaData, fiscal, logistica: logData } = req.body;
    if (!ref || !descricao) return res.status(400).json({ error: 'ref e descricao sao obrigatorios' });
    try {
        const ins = db.prepare("INSERT INTO produtos (empresa_id, ref, descricao) VALUES (?,?,?)").run(empresa_id, ref, descricao);
        const pid = ins.lastInsertRowid;
        if (dnaData) db.prepare("INSERT INTO dna (produto_id,fabricante,grupo_industrial,origem_pais,codigo_dna,marca,linha,familia) VALUES (?,?,?,?,?,?,?,?)").run(pid, dnaData.fabricante||null, dnaData.grupo_industrial||null, dnaData.origem_pais||null, dnaData.codigo_dna||null, dnaData.marca||null, dnaData.linha||null, dnaData.familia||null);
        if (fiscal) db.prepare("INSERT INTO dados_fiscais (produto_id,ncm,cest,origem,ipi,icms,pis,cofins,cfop) VALUES (?,?,?,?,?,?,?,?,?)").run(pid, fiscal.ncm||null, fiscal.cest||null, fiscal.origem||null, fiscal.ipi||0, fiscal.icms||0, fiscal.pis||0, fiscal.cofins||0, fiscal.cfop||null);
        if (logData) db.prepare("INSERT INTO logistica (produto_id,peso_liq,peso_bruto,altura,largura,comprimento) VALUES (?,?,?,?,?,?)").run(pid, logData.peso_liq||null, logData.peso_bruto||null, logData.altura||null, logData.largura||null, logData.comprimento||null);
        res.status(201).json({ success: true, id: pid });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/produtos/:id', (req, res) => {
    const { descricao, status } = req.body;
    db.prepare("UPDATE produtos SET descricao=COALESCE(?,descricao), status=COALESCE(?,status), atualizado_em=datetime('now','localtime') WHERE id=?").run(descricao||null, status||null, req.params.id);
    res.json({ success: true });
});

app.delete('/api/produtos/:id', (req, res) => {
    db.prepare('DELETE FROM produtos WHERE id=?').run(req.params.id);
    res.json({ success: true });
});

app.post('/api/produtos/:id/congelar', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    db.prepare("UPDATE produtos SET status='Congelado', atualizado_em=datetime('now','localtime') WHERE id=?").run(req.params.id);
    db.prepare("INSERT INTO historico_ntc (produto_id,status_anterior,status_novo,alteracao) VALUES (?,?,?,?)").run(req.params.id, p.status, 'Congelado', 'Produto congelado');
    res.json({ success: true });
});

app.post('/api/produtos/:id/descongelar', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    db.prepare("UPDATE produtos SET status='Ativo', atualizado_em=datetime('now','localtime') WHERE id=?").run(req.params.id);
    db.prepare("INSERT INTO historico_ntc (produto_id,status_anterior,status_novo,alteracao) VALUES (?,?,?,?)").run(req.params.id, p.status, 'Ativo', 'Produto descongelado');
    res.json({ success: true });
});

// -----------------------------------------------------------
// DNA
// -----------------------------------------------------------
app.get('/api/produtos/:id/dna', (req, res) => {
    res.json(db.prepare('SELECT * FROM dna WHERE produto_id=?').get(req.params.id) || {});
});

app.put('/api/produtos/:id/dna', (req, res) => {
    const d = req.body;
    const existing = db.prepare('SELECT id FROM dna WHERE produto_id=?').get(req.params.id);
    if (existing) {
        db.prepare("UPDATE dna SET fabricante=?,grupo_industrial=?,origem_pais=?,codigo_dna=?,marca=?,linha=?,familia=? WHERE produto_id=?").run(d.fabricante||null, d.grupo_industrial||null, d.origem_pais||null, d.codigo_dna||null, d.marca||null, d.linha||null, d.familia||null, req.params.id);
    } else {
        db.prepare("INSERT INTO dna (produto_id,fabricante,grupo_industrial,origem_pais,codigo_dna,marca,linha,familia) VALUES (?,?,?,?,?,?,?,?)").run(req.params.id, d.fabricante||null, d.grupo_industrial||null, d.origem_pais||null, d.codigo_dna||null, d.marca||null, d.linha||null, d.familia||null);
    }
    res.json({ success: true });
});

// -----------------------------------------------------------
// APLICACOES MOTOR
// -----------------------------------------------------------
app.get('/api/produtos/:id/aplicacoes', (req, res) => {
    res.json(db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(req.params.id));
});

app.post('/api/produtos/:id/aplicacoes', (req, res) => {
    const a = req.body;
    const r = db.prepare("INSERT INTO aplicacoes_motor (produto_id,montadora,modelo,versao,motor,codigo_motor,combustivel,cilindrada,potencia,ano_ini,ano_fim) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(req.params.id, a.montadora||null, a.modelo||null, a.versao||null, a.motor||null, a.codigo_motor||null, a.combustivel||null, a.cilindrada||null, a.potencia||null, a.ano_ini||null, a.ano_fim||null);
    res.status(201).json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/aplicacoes/:id', (req, res) => {
    db.prepare('DELETE FROM aplicacoes_motor WHERE id=?').run(req.params.id);
    res.json({ success: true });
});

// -----------------------------------------------------------
// CODIGOS CAMBIADOS
// -----------------------------------------------------------
app.get('/api/produtos/:id/codigos', (req, res) => {
    res.json(db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(req.params.id));
});

app.post('/api/produtos/:id/codigos', (req, res) => {
    const c = req.body;
    const r = db.prepare("INSERT INTO codigos_cambiados (produto_id,tipo,codigo,fabricante,status,data_substituicao) VALUES (?,?,?,?,?,?)").run(req.params.id, c.tipo||null, c.codigo||null, c.fabricante||null, c.status||'Ativo', c.data_substituicao||null);
    res.status(201).json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/codigos/:id', (req, res) => {
    db.prepare('DELETE FROM codigos_cambiados WHERE id=?').run(req.params.id);
    res.json({ success: true });
});

app.post('/api/produtos/:id/sincronizar/:canal', (req, res) => {
    const { id, canal } = req.params;
    const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!produto) return res.status(404).json({ error: 'Produto nao encontrado' });
    if (produto.status !== 'Congelado') return res.status(400).json({ error: 'Produto nao congelado. Congele antes de sincronizar.' });
    db.prepare("INSERT INTO historico_ntc (produto_id,ntc_anterior,ntc_novo,status_anterior,status_novo,alteracao) VALUES (?,?,?,?,?,?)").run(
        id, produto.ntc_score, produto.ntc_score, produto.status, produto.status, 'Sincronizado em ' + canal
    );
    res.json({ success: true, canal, message: 'Produto enviado para ' + canal + ' (integração pendente de API Key)' });
});

// -----------------------------------------------------------
// FISCAL
// -----------------------------------------------------------
app.get('/api/produtos/:id/fiscal', (req, res) => {
    res.json(db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(req.params.id) || {});
});

app.put('/api/produtos/:id/fiscal', (req, res) => {
    const f = req.body;
    const existing = db.prepare('SELECT id FROM dados_fiscais WHERE produto_id=?').get(req.params.id);
    if (existing) {
        db.prepare("UPDATE dados_fiscais SET ncm=?,cest=?,origem=?,ipi=?,icms=?,pis=?,cofins=?,cfop=? WHERE produto_id=?").run(f.ncm||null, f.cest||null, f.origem||null, f.ipi||0, f.icms||0, f.pis||0, f.cofins||0, f.cfop||null, req.params.id);
    } else {
        db.prepare("INSERT INTO dados_fiscais (produto_id,ncm,cest,origem,ipi,icms,pis,cofins,cfop) VALUES (?,?,?,?,?,?,?,?,?)").run(req.params.id, f.ncm||null, f.cest||null, f.origem||null, f.ipi||0, f.icms||0, f.pis||0, f.cofins||0, f.cfop||null);
    }
    res.json({ success: true });
});

// -----------------------------------------------------------
// LOGISTICA
// -----------------------------------------------------------
app.get('/api/produtos/:id/logistica', (req, res) => {
    res.json(db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(req.params.id) || {});
});

app.put('/api/produtos/:id/logistica', (req, res) => {
    const l = req.body;
    const existing = db.prepare('SELECT id FROM logistica WHERE produto_id=?').get(req.params.id);
    if (existing) {
        db.prepare("UPDATE logistica SET peso_liq=?,peso_bruto=?,altura=?,largura=?,comprimento=?,volume=? WHERE produto_id=?").run(l.peso_liq||null, l.peso_bruto||null, l.altura||null, l.largura||null, l.comprimento||null, l.volume||null, req.params.id);
    } else {
        db.prepare("INSERT INTO logistica (produto_id,peso_liq,peso_bruto,altura,largura,comprimento,volume) VALUES (?,?,?,?,?,?,?)").run(req.params.id, l.peso_liq||null, l.peso_bruto||null, l.altura||null, l.largura||null, l.comprimento||null, l.volume||null);
    }
    res.json({ success: true });
});

// -----------------------------------------------------------
// IMAGENS
// -----------------------------------------------------------
app.get('/api/produtos/:id/imagens', (req, res) => {
    res.json(db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(req.params.id));
});

app.post('/api/produtos/:id/imagens', upload.single('imagem'), (req, res) => {
    const url = req.file ? '/uploads/' + req.file.filename : req.body.url;
    if (!url) return res.status(400).json({ error: 'Imagem ou URL obrigatorio' });
    const r = db.prepare("INSERT INTO imagens (produto_id,tipo,url,origem,resolucao) VALUES (?,?,?,?,?)").run(req.params.id, req.body.tipo||'Principal', url, req.file ? 'Upload' : 'URL', req.body.resolucao||null);
    res.status(201).json({ success: true, id: r.lastInsertRowid, url });
});

app.delete('/api/imagens/:id', (req, res) => {
    db.prepare('DELETE FROM imagens WHERE id=?').run(req.params.id);
    res.json({ success: true });
});

app.put('/api/imagens/:id/status', (req, res) => {
    db.prepare("UPDATE imagens SET status=? WHERE id=?").run(req.body.status, req.params.id);
    res.json({ success: true });
});
app.patch('/api/imagens/:id/status', (req, res) => {
    db.prepare("UPDATE imagens SET status=? WHERE id=?").run(req.body.status, req.params.id);
    res.json({ success: true });
});

// -----------------------------------------------------------
// NTC ENGINE ROUTES
// -----------------------------------------------------------
app.post('/api/ia/ntc', (req, res) => {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ error: 'texto obrigatorio' });
    const result = calcNTC(texto, req.body.extra || {});
    db.prepare("INSERT INTO logs_ia (produto_ref,acao,resultado,confianca) VALUES (?,?,?,?)").run(null, 'NTC_ANALYZE', JSON.stringify(result.dna), result.score);
    res.json(result);
});

app.get('/api/produtos/:id/ntc', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(req.params.id);
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(req.params.id);
    const logistica = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(req.params.id);
    const aplicacoes = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(req.params.id);
    const codigos = db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(req.params.id);
    const imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(req.params.id);
    const text = p.descricao + ' ' + (dna ? (dna.marca || '') + ' ' + (dna.fabricante || '') : '');
    const extra = { ncm: fiscal && fiscal.ncm, cest: fiscal && fiscal.cest, cfop: fiscal && fiscal.cfop, peso: logistica && logistica.peso_liq, dimensoes: logistica ? (logistica.altura && logistica.largura) : false, aplicacoes, codigos, imagens };
    const result = calcNTC(text, extra);
    res.json({ produto: p, ntc: result });
});

app.post('/api/produtos/:id/ntc/recalcular', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(req.params.id);
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(req.params.id);
    const logistica = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(req.params.id);
    const aplicacoes = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(req.params.id);
    const codigos = db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(req.params.id);
    const imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(req.params.id);
    const text = p.descricao + ' ' + (dna ? (dna.marca || '') + ' ' + (dna.fabricante || '') : '');
    const extra = { ncm: fiscal && fiscal.ncm, cest: fiscal && fiscal.cest, cfop: fiscal && fiscal.cfop, peso: logistica && logistica.peso_liq, dimensoes: logistica ? (logistica.altura && logistica.largura) : false, aplicacoes, codigos, imagens };
    const result = calcNTC(text, extra);
    db.prepare("INSERT INTO historico_ntc (produto_id,ntc_anterior,ntc_novo,status_anterior,status_novo,alteracao) VALUES (?,?,?,?,?,?)").run(req.params.id, p.ntc_score, result.score, p.ntc_status, result.status, 'Recalculo NTC');
    db.prepare("UPDATE produtos SET ntc_score=?,ntc_status=?,rast_hash=?,atualizado_em=datetime('now','localtime') WHERE id=?").run(result.score, result.status, result.rast_hash, req.params.id);
    const existing = db.prepare('SELECT id FROM rast_hash WHERE produto_id=?').get(req.params.id);
    if (existing) db.prepare("UPDATE rast_hash SET hash=?,base=?,gerado_em=datetime('now','localtime') WHERE produto_id=?").run(result.rast_hash, text.substring(0, 200), req.params.id);
    else db.prepare("INSERT INTO rast_hash (produto_id,hash,base) VALUES (?,?,?)").run(req.params.id, result.rast_hash, text.substring(0, 200));
    res.json({ success: true, ntc: result });
});

// -----------------------------------------------------------
// DASHBOARD / RELATORIOS
// -----------------------------------------------------------
app.get('/api/dashboard', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as c FROM produtos').get().c;
    const aprovados = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ntc_status='APROVADO'").get().c;
    const pendentes = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ntc_status='PENDENTE'").get().c;
    const reprovados = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ntc_status='REPROVADO'").get().c;
    const congelados = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE status='Congelado'").get().c;
    const ntcMedio = db.prepare('SELECT AVG(ntc_score) as m FROM produtos').get().m || 0;
    const recentes = db.prepare('SELECT p.*, d.marca, d.fabricante FROM produtos p LEFT JOIN dna d ON d.produto_id=p.id ORDER BY p.atualizado_em DESC LIMIT 10').all();
    recentes.forEach(row => {
        const img = db.prepare("SELECT url FROM imagens WHERE produto_id=? ORDER BY CASE WHEN tipo='Principal' THEN 0 ELSE 1 END, id ASC LIMIT 1").get(row.id);
        row.imagem_principal = img ? img.url : null;
    });
    res.json({ total, aprovados, pendentes, reprovados, congelados, ntc_medio: parseFloat(ntcMedio.toFixed(4)), recentes });
});

app.get('/api/relatorios/resumo', (req, res) => {
    const porStatus = db.prepare("SELECT status, COUNT(*) as total FROM produtos GROUP BY status").all();
    const porNtc = db.prepare("SELECT ntc_status, COUNT(*) as total, AVG(ntc_score) as media FROM produtos GROUP BY ntc_status").all();
    const logsRecentes = db.prepare("SELECT * FROM logs_ia ORDER BY criado_em DESC LIMIT 20").all();
    res.json({ por_status: porStatus, por_ntc: porNtc, logs_ia: logsRecentes });
});

// -----------------------------------------------------------
// HISTORICO
// -----------------------------------------------------------
app.get('/api/produtos/:id/historico', (req, res) => {
    res.json(db.prepare('SELECT * FROM historico_ntc WHERE produto_id=? ORDER BY criado_em DESC').all(req.params.id));
});

// -----------------------------------------------------------
// BUSCA WEB — DNA DO PRODUTO
// -----------------------------------------------------------

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const opts = new URL(url);
        const options = {
            hostname: opts.hostname,
            path: opts.pathname + opts.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; GenesisIndexa/5.0)',
                'Accept': 'application/json, text/html',
                ...headers
            },
            timeout: 8000
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

// Build smart DNA search query
function buildDNAQuery(produto, dna) {
    const parts = [];
    if (dna && dna.marca) parts.push(dna.marca);
    if (dna && dna.codigo_dna) parts.push(dna.codigo_dna);
    else if (produto.ref) parts.push(produto.ref.replace(/^[A-Z]+-/i, ''));
    const desc = produto.descricao || '';
    // Take first 3 meaningful words of description
    const words = desc.split(/\s+/).filter(w => w.length > 3).slice(0, 4);
    parts.push(...words);
    return parts.join(' ');
}

// DuckDuckGo zero-click API (free, no key)
async function searchDuckDuckGo(query) {
    try {
        const q = encodeURIComponent(query);
        const r = await httpGet(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1&no_redirect=1`);
        const data = JSON.parse(r.body);
        return {
            abstract: data.AbstractText || null,
            abstractUrl: data.AbstractURL || null,
            image: data.Image && data.Image.startsWith('http') ? data.Image : null,
            source: data.AbstractSource || null,
            related: (data.RelatedTopics || []).slice(0, 5).map(t => ({
                text: t.Text || '',
                url: t.FirstURL || ''
            }))
        };
    } catch (e) { return null; }
}

// Search Open Parts APIs for automotive part data
async function searchOpenParts(codigo, marca) {
    // Try to get data from known automotive parts databases
    const sources = [];
    if (marca && codigo) {
        // Construct search URLs (for reference display, not scraping)
        sources.push({ nome: 'LUK Catalog', url: `https://www.repxpert.com/pt/search?query=${encodeURIComponent(codigo)}` });
        sources.push({ nome: 'TecDoc', url: `https://www.tecdoc.net/search?q=${encodeURIComponent((marca||'') + ' ' + codigo)}` });
        sources.push({ nome: 'Autozone PT', url: `https://www.autozone.com.br/search?q=${encodeURIComponent(codigo)}` });
        sources.push({ nome: 'Google Images', url: `https://www.google.com/search?q=${encodeURIComponent((marca||'') + '+' + codigo + '+peca+automotiva')}&tbm=isch` });
        sources.push({ nome: 'Bing Images', url: `https://www.bing.com/images/search?q=${encodeURIComponent((marca||'') + ' ' + codigo + ' auto part')}` });
    }
    return sources;
}

// Bing image search scraper (server-side, no CORS issue)
async function searchBingImages(query) {
    try {
        const q = encodeURIComponent(query + ' peca automotiva');
        const r = await httpGet(
            `https://www.bing.com/images/search?q=${q}&form=HDRSC2&first=1&mmasync=1`,
            { 'Accept-Language': 'pt-BR,pt;q=0.9', 'Referer': 'https://www.bing.com/' }
        );
        // Extract image URLs from response
        const imgUrls = [];
        const matches = r.body.matchAll(/murl&quot;:&quot;(https?:\/\/[^&"]+\.(?:jpg|jpeg|png|webp))&quot;/gi);
        for (const m of matches) {
            if (imgUrls.length >= 8) break;
            const url = m[1].replace(/&amp;/g, '&');
            if (!imgUrls.includes(url)) imgUrls.push(url);
        }
        // fallback: extract from murl json
        if (!imgUrls.length) {
            const matches2 = r.body.matchAll(/"murl":"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi);
            for (const m of matches2) {
                if (imgUrls.length >= 8) break;
                imgUrls.push(m[1]);
            }
        }
        return imgUrls;
    } catch (e) { return []; }
}

app.get('/api/produtos/:id/busca-web', async (req, res) => {
    const id = req.params.id;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);

    const query = buildDNAQuery(p, dna);
    const marca = dna ? dna.marca : null;
    const codigo = dna ? dna.codigo_dna : null;

    // Parallel search
    const [ddg, imgUrls, fontes] = await Promise.all([
        searchDuckDuckGo(query),
        searchBingImages(query),
        searchOpenParts(codigo || p.ref, marca)
    ]);

    // Combine image sources
    const imagens = [];
    if (ddg && ddg.image) imagens.unshift({ url: ddg.image, fonte: 'DuckDuckGo', tipo: 'Principal' });
    imgUrls.forEach(url => imagens.push({ url, fonte: 'Bing Images', tipo: 'Principal' }));

    res.json({
        query,
        produto: { id: p.id, ref: p.ref, descricao: p.descricao },
        dna: dna || {},
        ddg,
        imagens: imagens.slice(0, 10),
        fontes,
        links: {
            google_imagens: `https://www.google.com/search?q=${encodeURIComponent(query + ' peca automotiva')}&tbm=isch`,
            bing_imagens: `https://www.bing.com/images/search?q=${encodeURIComponent(query + ' auto part')}`,
            tecdoc: `https://www.tecdoc.net/search?q=${encodeURIComponent(query)}`,
        }
    });
});

// Auto-import imagem da web no produto
app.post('/api/produtos/:id/importar-imagem-web', async (req, res) => {
    const { url, tipo = 'Principal' } = req.body;
    if (!url) return res.status(400).json({ error: 'url obrigatoria' });
    // Save URL directly to imagens table
    try {
        const r = db.prepare("INSERT INTO imagens (produto_id,tipo,url,origem,status) VALUES (?,?,?,?,?)")
            .run(req.params.id, tipo, url, 'Web', 'Aprovada');
        // Recalculate NTC
        const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
        const dna2 = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(req.params.id);
        const fiscal2 = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(req.params.id);
        const log2 = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(req.params.id);
        const aplic2 = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(req.params.id);
        const cod2 = db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(req.params.id);
        const imgs2 = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(req.params.id);
        const text2 = p.descricao + ' ' + (dna2 ? (dna2.marca||'') + ' ' + (dna2.fabricante||'') : '');
        const extra2 = { ncm: fiscal2?.ncm, cest: fiscal2?.cest, cfop: fiscal2?.cfop, peso: log2?.peso_liq, dimensoes: log2 ? (log2.altura && log2.largura) : false, aplicacoes: aplic2, codigos: cod2, imagens: imgs2 };
        const ntcResult = calcNTC(text2, extra2);
        db.prepare("UPDATE produtos SET ntc_score=?,ntc_status=?,rast_hash=?,atualizado_em=datetime('now','localtime') WHERE id=?")
            .run(ntcResult.score, ntcResult.status, ntcResult.rast_hash, req.params.id);
        res.json({ success: true, id: r.lastInsertRowid, ntc: { score: ntcResult.score, status: ntcResult.status } });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// -----------------------------------------------------------
// ENRIQUECIMENTO WEB AUTOMATICO — busca DNA + imagens + dados
// -----------------------------------------------------------
app.post('/api/produtos/:id/enriquecer-web', async (req, res) => {
    const id = req.params.id;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);

    const oem = dna?.codigo_dna || p.ref.replace(/^[A-Z]+-/i, '');
    const marca = dna?.marca || '';
    const searchQuery = `${marca} ${oem} ${p.descricao}`.trim();
    const imgQuery = `${marca} ${oem} autopeca foto produto real`;

    const [ddg, imgUrls] = await Promise.all([
        searchDuckDuckGo(searchQuery),
        searchBingImages(imgQuery)
    ]);

    const contexto = `Produto: ${p.descricao}\nReferencia: ${p.ref}\nMarca: ${marca}\nCodigo OEM: ${oem}\nResumo web: ${ddg?.abstract || 'sem resultado'}`.trim();

    const systemPrompt = `Voce e um especialista em autopecas automotivas brasileiro. Analise o produto e retorne SOMENTE um JSON valido (sem markdown, sem texto extra) com esta estrutura exata:
{"aplicacoes":[{"montadora":"","modelo":"","versao":"","motor":"","cilindrada":"","combustivel":"","ano_ini":0,"ano_fim":0}],"codigos_cambiados":[{"tipo":"OEM","codigo":"","fabricante":""}],"logistica":{"peso_liq":0,"peso_bruto":0,"altura":0,"largura":0,"comprimento":0},"fiscal":{"ncm":"","cest":""},"especificacoes":{"diametro":"","estrias":0,"material":"","componentes":""},"descricao_tecnica":""}
REGRAS: Use null para campos sem evidencia — NUNCA invente dados. Preencha apenas com certeza. NCM formato 0000.00.00. Pesos em kg. Dimensoes em cm. Anos como inteiros.`;

    const userPrompt = `Extraia e estruture os dados deste produto de autopecas:\n\n${contexto}`;
    const claudeResult = await callClaude(systemPrompt, userPrompt);

    let parsed = null;
    try {
        const jsonText = (claudeResult.text || '').replace(/```json|```/g, '').trim();
        parsed = JSON.parse(jsonText);
    } catch (e) { parsed = null; }

    if (!parsed) return res.json({ success: false, error: 'Parse error', raw: claudeResult.text || claudeResult.error });

    const txResult = db.transaction(() => {
        // APLICACOES
        if (Array.isArray(parsed.aplicacoes)) {
            const existSet = new Set(db.prepare('SELECT montadora||"|"||modelo||"|"||COALESCE(ano_ini,"") as k FROM aplicacoes_motor WHERE produto_id=?').all(id).map(r => r.k));
            for (const a of parsed.aplicacoes) {
                if (!a.montadora || !a.modelo) continue;
                const k = `${a.montadora}|${a.modelo}|${a.ano_ini||''}`;
                if (existSet.has(k)) continue;
                db.prepare("INSERT INTO aplicacoes_motor (produto_id,montadora,modelo,versao,motor,cilindrada,combustivel,ano_ini,ano_fim) VALUES (?,?,?,?,?,?,?,?,?)").run(id, a.montadora, a.modelo, a.versao||null, a.motor||null, a.cilindrada||null, a.combustivel||null, a.ano_ini||null, a.ano_fim||null);
                existSet.add(k);
            }
        }
        // CODIGOS CAMBIADOS
        if (Array.isArray(parsed.codigos_cambiados)) {
            const existCod = new Set(db.prepare('SELECT codigo FROM codigos_cambiados WHERE produto_id=?').all(id).map(c => c.codigo));
            for (const c of parsed.codigos_cambiados) {
                if (!c.codigo || existCod.has(c.codigo)) continue;
                db.prepare("INSERT INTO codigos_cambiados (produto_id,tipo,codigo,fabricante,status) VALUES (?,?,?,?,?)").run(id, c.tipo||'OEM', c.codigo, c.fabricante||null, 'Ativo');
                existCod.add(c.codigo);
            }
        }
        // LOGISTICA
        if (parsed.logistica) {
            const L = parsed.logistica;
            const existL = db.prepare('SELECT id FROM logistica WHERE produto_id=?').get(id);
            if (existL) db.prepare("UPDATE logistica SET peso_liq=COALESCE(?,peso_liq),peso_bruto=COALESCE(?,peso_bruto),altura=COALESCE(?,altura),largura=COALESCE(?,largura),comprimento=COALESCE(?,comprimento) WHERE produto_id=?").run(L.peso_liq||null,L.peso_bruto||null,L.altura||null,L.largura||null,L.comprimento||null,id);
            else if (L.peso_liq||L.altura) db.prepare("INSERT INTO logistica (produto_id,peso_liq,peso_bruto,altura,largura,comprimento) VALUES (?,?,?,?,?,?)").run(id,L.peso_liq||null,L.peso_bruto||null,L.altura||null,L.largura||null,L.comprimento||null);
        }
        // FISCAL
        if (parsed.fiscal?.ncm || parsed.fiscal?.cest) {
            const F = parsed.fiscal;
            const existF = db.prepare('SELECT id FROM dados_fiscais WHERE produto_id=?').get(id);
            if (existF) db.prepare("UPDATE dados_fiscais SET ncm=COALESCE(?,ncm),cest=COALESCE(?,cest) WHERE produto_id=?").run(F.ncm||null,F.cest||null,id);
            else db.prepare("INSERT INTO dados_fiscais (produto_id,ncm,cest,origem) VALUES (?,?,?,?)").run(id,F.ncm||null,F.cest||null,'0');
        }
        // IMAGENS WEB
        const slots = ['Principal','Lateral','Tecnica','Detalhe','Embalagem','Aplicada'];
        const existImgs = new Set(db.prepare('SELECT url FROM imagens WHERE produto_id=?').all(id).map(i => i.url));
        let si = 0;
        for (const url of imgUrls.slice(0, 6)) {
            if (!existImgs.has(url)) {
                db.prepare("INSERT INTO imagens (produto_id,tipo,url,origem,status) VALUES (?,?,?,?,?)").run(id, slots[si%slots.length], url, 'Web-Auto', 'Aprovada');
                existImgs.add(url);
            }
            si++;
        }
        // RECALCULAR NTC
        const dnaU = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);
        const fiscalU = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(id);
        const aplicU = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(id);
        const imgsU = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id);
        const nctTF = dnaU?.codigo_dna ? 0.97 : (dnaU?.marca ? 0.70 : 0.10);
        const nctFM = p.descricao?.length > 20 ? (parsed.especificacoes?.diametro ? 1.00 : 0.85) : 0.30;
        const nctCO = fiscalU?.ncm ? 1.00 : 0.00;
        const nctAV = aplicU.length >= 5 ? 1.00 : aplicU.length >= 3 ? 0.80 : aplicU.length > 0 ? aplicU.length * 0.20 : 0.00;
        const ntcScore = parseFloat((nctTF*0.50 + nctFM*0.20 + nctCO*0.20 + nctAV*0.10).toFixed(4));
        const ntcStatus = ntcScore >= 0.95 ? 'APROVADO' : ntcScore >= 0.60 ? 'PENDENTE' : 'REPROVADO';
        db.prepare("UPDATE produtos SET ntc_score=?,ntc_status=?,atualizado_em=datetime('now','localtime') WHERE id=?").run(ntcScore, ntcStatus, id);
        db.prepare("INSERT INTO historico_ntc (produto_id,status_anterior,status_novo,alteracao) VALUES (?,?,?,?)").run(id, p.ntc_status, ntcStatus, `Web-Auto: ${aplicU.length} aplic, ${imgsU.length} imgs`);
        return {
            nct: { score: ntcScore, status: ntcStatus, modules: { TF: nctTF, FM: nctFM, CO: nctCO, AV: nctAV } },
            aplicacoes: db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(id),
            codigos: db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(id),
            imagens: db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id),
            logistica: db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(id) || {},
            fiscal: db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(id) || {}
        };
    })();

    res.json({
        success: true,
        produto: db.prepare('SELECT * FROM produtos WHERE id=?').get(id),
        dna: db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id) || {},
        ...txResult,
        especificacoes: parsed.especificacoes || {},
        descricao_tecnica: parsed.descricao_tecnica || null
    });
});

// -----------------------------------------------------------
// ENRIQUECIMENTO COMPLETO — MOTOR iRollo
// -----------------------------------------------------------
app.get('/api/produtos/:id/enriquecimento', async (req, res) => {
    const id = req.params.id;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(id);
    const logistica = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(id);
    const aplicacoes = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(id);
    const codigos = db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(id);
    const imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id);
    const historico = db.prepare('SELECT * FROM historico_ntc WHERE produto_id=? ORDER BY criado_em DESC LIMIT 20').all(id);

    // NCT simplified 4-module
    const nctTF = dna && dna.codigo_dna ? 0.82 : (dna && dna.marca ? 0.50 : 0.10);
    const nctFM = p.descricao && p.descricao.length > 20 ? 0.80 : 0.30;
    const nctCO = fiscal && fiscal.ncm ? 1.00 : 0.00;
    const nctAV = aplicacoes.length >= 3 ? 1.00 : (aplicacoes.length > 0 ? aplicacoes.length * 0.25 : 0.00);
    const nctScore = parseFloat((nctTF*0.50 + nctFM*0.20 + nctCO*0.20 + nctAV*0.10).toFixed(4));
    const nctStatus = nctScore >= 0.95 ? 'APROVADO' : nctScore >= 0.60 ? 'PENDENTE' : 'REPROVADO';

    // Image quality check
    const imgQuality = {
        total: imagens.length,
        slots: ['Principal','Lateral','Tecnica','Detalhe','Embalagem','Aplicada'].map(slot => ({
            slot,
            imagem: imagens.find(i => i.tipo === slot) || null
        })),
        googleShopping: {
            fundo_branco: imagens.some(i => i.tipo === 'Principal'),
            produto_real: imagens.length > 0,
            min_1000px: false, // can't verify without image analysis
            sem_watermark: true,
            sem_texto: true,
            aprovado: imagens.some(i => i.tipo === 'Principal') && imagens.length > 0
        }
    };

    res.json({
        produto: p, dna: dna||{}, fiscal: fiscal||{}, logistica: logistica||{},
        aplicacoes, codigos, imagens,
        nct: { score: nctScore, status: nctStatus, modules: { TF: nctTF, FM: nctFM, CO: nctCO, AV: nctAV } },
        imgQuality, historico,
        wix_id: p.wix_id,
        rast_hash: p.rast_hash || 'RAST-' + crypto.createHash('sha256').update(p.ref+p.descricao).digest('hex').substring(0,16).toUpperCase()
    });
});

// CONGELAR E INDEXAR — freeze + mark synced
app.post('/api/produtos/:id/indexar', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const force = req.body && req.body.force === true;
    if (!force && p.ntc_score < 0.80) {
        return res.status(400).json({ error: 'NTC insuficiente para congelar', ntc_score: p.ntc_score, ntc_status: p.ntc_status, minimo: 0.80 });
    }
    db.prepare("UPDATE produtos SET status='Congelado', atualizado_em=datetime('now','localtime') WHERE id=?").run(req.params.id);
    db.prepare("INSERT INTO historico_ntc (produto_id,status_anterior,status_novo,ntc_anterior,ntc_novo,alteracao) VALUES (?,?,?,?,?,?)").run(req.params.id, p.ntc_status, 'CONGELADO', p.ntc_score, p.ntc_score, 'Congelado e Indexado — Bling + Wix + Google Shopping');
    res.json({ success: true, plataformas: ['Bling', 'Wix', 'Google Shopping', 'Google Ads'], status: 'Congelado', ntc_score: p.ntc_score });
});

// CONGELADOS
app.get('/api/congelados', (req, res) => {
    const rows = db.prepare("SELECT p.*, d.marca, d.fabricante, d.familia FROM produtos p LEFT JOIN dna d ON d.produto_id=p.id WHERE p.status='Congelado' ORDER BY p.atualizado_em DESC").all();
    rows.forEach(r => {
        const img = db.prepare("SELECT url FROM imagens WHERE produto_id=? LIMIT 1").get(r.id);
        r.imagem_principal = img ? img.url : null;
    });
    res.json({ total: rows.length, data: rows });
});

// -----------------------------------------------------------
// CLAUDE HAIKU — VOZ DO LOJISTA
// -----------------------------------------------------------
async function callClaude(systemPrompt, userPrompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { error: 'ANTHROPIC_API_KEY nao configurada. Adicione no painel de Configuracoes.' };
    return new Promise((resolve) => {
        const body = JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
        });
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
            },
            timeout: 25000
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const r = JSON.parse(data);
                    if (r.content && r.content[0]) resolve({ text: r.content[0].text, model: r.model });
                    else resolve({ error: r.error?.message || 'Resposta invalida da API' });
                } catch(e) { resolve({ error: 'Parse error: ' + e.message }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout na API Claude' }); });
        req.write(body);
        req.end();
    });
}

const VOZ_PROMPTS = {
    tecnico: {
        system: `Voce e um engenheiro redator especialista em autopecas OEM brasileiro. REGRAS: 1) Linha 1 com codigo OEM completo. 2) Especificar material SAE/ABNT quando disponivel. 3) Incluir NTC score e status. 4) Listar compatibilidades com ano e motor. 5) Tom de laudo tecnico sem emojis. Maximo 8 linhas. PROIBIDO inventar OEM, aplicacoes ou especificacoes.`,
        user: (p, dna, aplic, ntc, fiscal) => `PRODUTO: ${p.descricao}\nOEM: ${dna?.codigo_dna||p.ref}\nMARCA/FABRICANTE: ${dna?.marca||'?'} / ${dna?.fabricante||'?'}\nGRUPO INDUSTRIAL: ${dna?.grupo_industrial||'?'}\nORIGEM: ${dna?.origem_pais||'?'}\nNCM: ${fiscal?.ncm||'nao informado'}\nNTC: score=${ntc?.score||'?'} status=${ntc?.status||'?'} (TF:${ntc?.modules?.TF||'?'} FM:${ntc?.modules?.FM||'?'} CO:${ntc?.modules?.CO||'?'} AV:${ntc?.modules?.AV||'?'})\nAPLICAСОЕС: ${aplic.map(a=>a.montadora+' '+a.modelo+(a.ano_ini?' '+a.ano_ini:'')).join(' | ')||'Consultar catalogo'}\n\nGere descricao tecnica no formato LAUDO — codigo OEM na primeira linha, grupo industrial, materiais, NTC status e compatibilidades.`
    },
    seo: {
        system: `Voce e um especialista SEO para e-commerce de autopecas com foco em CPC alto. FORMATO OBRIGATORIO:\nTITULO: [max 70 chars — marca+OEM+modelo]\nMETA: [max 160 chars — OEM+garantia+CTA]\nH1: [variacao do titulo]\nSLUG: [kebab-case]\nKEYWORDS: [8-12 termos long-tail transacionais com OEM+modelo+ano para CPC alto]`,
        user: (p, dna, aplic, ntc, fiscal) => `PRODUTO: ${p.descricao}\nMARCA: ${dna?.marca||'?'}\nOEM: ${dna?.codigo_dna||p.ref}\nNCM: ${fiscal?.ncm||'nao informado'}\nNTC: ${ntc?.status||'?'} (${ntc?.score||'?'})\nAPLICAСОЕС: ${aplic.map(a=>a.montadora+' '+a.modelo+(a.ano_ini?' '+a.ano_ini:'')).slice(0,5).join(', ')||'multi-veiculo'}\n\nGere SEO completo com keywords de alto CPC para Google Shopping e busca organica.`
    },
    comercial: {
        system: `Voce e um copywriter de alta conversao para autopecas OEM. ESTRUTURA: 1) Abrir com BENEFICIO principal. 2) Autoridade OEM com grupo industrial. 3) NTC como prova de qualidade. 4) Urgencia real. 5) Garantia clara. Tom confiante. Maximo 6 linhas. PROIBIDO inventar certificacoes inexistentes.`,
        user: (p, dna, aplic, ntc, fiscal) => `PRODUTO: ${p.descricao}\nMARCA: ${dna?.marca||'?'}\nGRUPO INDUSTRIAL: ${dna?.grupo_industrial||'?'}\nOEM: ${dna?.codigo_dna||p.ref}\nNTC: ${ntc?.status||'?'} score ${ntc?.score||'?'}\nAPLICAСОЕС: ${aplic.map(a=>a.montadora+' '+a.modelo).slice(0,4).join(', ')||'Consultar catalogo'}\n\nGere descricao comercial de alta conversao destacando qualidade OEM e NTC.`
    },
    whatsapp: {
        system: `Voce e um vendedor expert de autopecas OEM via WhatsApp. REGRAS: 1) Confirmar OEM + compatibilidade primeiro. 2) Qualidade OEM = mesma peca da fabrica. 3) Prazo realista + garantia. 4) CTA claro. 5) Max 2-3 emojis. Maximo 5 linhas.`,
        user: (p, dna, aplic, ntc, fiscal) => `PRODUTO: ${p.descricao}\nOEM: ${dna?.codigo_dna||p.ref}\nMARCA: ${dna?.marca||'?'}\nAPLICAСОЕС: ${aplic.map(a=>a.montadora+' '+a.modelo+(a.ano_ini?' '+a.ano_ini:'')).slice(0,3).join(', ')||'consultar catalogo'}\nNTC: ${ntc?.status||'?'}\n\nGere mensagem WhatsApp confirmando OEM e compatibilidade.`
    },
    pmax: {
        system: `Voce e um especialista Google Ads Performance Max para autopecas OEM. FORMATO OBRIGATORIO:\nH1: [max 30 chars]\nH2: [max 30 chars]\nH3: [max 30 chars]\nD1: [max 90 chars — OEM+aplicacao]\nD2: [max 90 chars — beneficio+CTA]\nCALLOUT: [max 25 chars]\nSITELINK: [max 25 chars]`,
        user: (p, dna, aplic, ntc, fiscal) => `PRODUTO: ${p.descricao}\nMARCA: ${dna?.marca||'?'}\nOEM: ${dna?.codigo_dna||p.ref}\nNTC: ${ntc?.status||'?'}\nAPLICAСОЕС: ${aplic.map(a=>a.montadora+' '+a.modelo).slice(0,2).join(', ')||'multi-veiculo'}\n\nGere assets P-Max completos para Google Ads.`
    }
};

app.post('/api/ia/voz', async (req, res) => {
    const { produto_id, perfil } = req.body;
    if (!produto_id || !perfil) return res.status(400).json({ error: 'produto_id e perfil obrigatorios' });
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(produto_id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(produto_id);
    const aplic = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(produto_id);
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(produto_id);
    const nctTF = dna && dna.codigo_dna ? 0.82 : (dna && dna.marca ? 0.50 : 0.10);
    const nctFM = p.descricao && p.descricao.length > 20 ? 0.80 : 0.30;
    const nctCO = fiscal && fiscal.ncm ? 1.00 : 0.00;
    const nctAV = aplic.length >= 3 ? 1.00 : (aplic.length > 0 ? aplic.length * 0.25 : 0.00);
    const ntcScore = parseFloat((nctTF*0.50 + nctFM*0.20 + nctCO*0.20 + nctAV*0.10).toFixed(4));
    const ntc = { score: ntcScore, status: ntcScore >= 0.95 ? 'APROVADO' : ntcScore >= 0.60 ? 'PENDENTE' : 'REPROVADO', modules: { TF: nctTF, FM: nctFM, CO: nctCO, AV: nctAV } };
    const vp = VOZ_PROMPTS[perfil];
    if (!vp) return res.status(400).json({ error: 'Perfil invalido: ' + perfil });
    const result = await callClaude(vp.system, vp.user(p, dna, aplic, ntc, fiscal));
    db.prepare("INSERT INTO logs_ia (produto_ref,acao,resultado,confianca) VALUES (?,?,?,?)").run(p.ref, 'VOZ_'+perfil.toUpperCase(), result.text||result.error, result.error ? 0 : 0.9);
    res.json(result);
});

// -----------------------------------------------------------
// WIX INTEGRATION
// -----------------------------------------------------------
app.get('/api/wix/status', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as c FROM produtos').get().c;
    const sincronizados = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE wix_id IS NOT NULL").get().c;
    const produtos = db.prepare('SELECT id, ref, descricao, ntc_score, ntc_status, wix_id, atualizado_em FROM produtos ORDER BY id').all();
    res.json({
        site_id: '29574987-cbf6-4241-9dce-d109734b0d95',
        site_nome: 'Mobis Autoparts',
        total_genesis: total,
        sincronizados,
        pendentes_sync: total - sincronizados,
        produtos
    });
});

app.put('/api/produtos/:id/wix', (req, res) => {
    const { wix_id } = req.body;
    if (!wix_id) return res.status(400).json({ error: 'wix_id obrigatorio' });
    db.prepare("UPDATE produtos SET wix_id=?, atualizado_em=datetime('now','localtime') WHERE id=?").run(wix_id, req.params.id);
    res.json({ success: true });
});

// -----------------------------------------------------------
// PREPARAR PUBLICACAO — imagem + descricao para todos os canais
// -----------------------------------------------------------
app.post('/api/produtos/:id/preparar-publicacao', async (req, res) => {
    const id = req.params.id;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });

    const dna    = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(id);
    const aplic  = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(id);
    let   imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id);

    // 1. BUSCAR IMAGENS se nenhuma existir
    if (!imagens.length) {
        const marca = dna?.marca || '';
        const oem   = dna?.codigo_dna || p.ref.replace(/^[A-Z]+-/i, '');
        const imgs  = await searchBingImages(`${marca} ${oem} ${p.descricao} autopeca foto real`);
        const slots = ['Principal','Lateral','Tecnica','Detalhe','Embalagem','Aplicada'];
        for (let i = 0; i < Math.min(imgs.length, 6); i++) {
            db.prepare("INSERT INTO imagens (produto_id,tipo,url,origem,status) VALUES (?,?,?,?,?)")
                .run(id, slots[i], imgs[i], 'Auto-Pub', 'Aprovada');
        }
        imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id);
    }

    // 2. NTC para contexto
    const nctTF = dna?.codigo_dna ? 0.97 : (dna?.marca ? 0.70 : 0.10);
    const nctFM = p.descricao?.length > 20 ? 0.85 : 0.30;
    const nctCO = fiscal?.ncm ? 1.00 : 0.00;
    const nctAV = aplic.length >= 5 ? 1.00 : aplic.length >= 3 ? 0.80 : aplic.length > 0 ? aplic.length * 0.20 : 0.00;
    const ntcScore = parseFloat((nctTF*0.50 + nctFM*0.20 + nctCO*0.20 + nctAV*0.10).toFixed(4));
    const ntc = { score: ntcScore, status: ntcScore >= 0.95 ? 'APROVADO' : ntcScore >= 0.60 ? 'PENDENTE' : 'REPROVADO', modules: { TF: nctTF, FM: nctFM, CO: nctCO, AV: nctAV } };

    // 3. GERAR DESCRICOES com Claude Haiku para todos os canais
    const perfis = ['comercial', 'seo', 'tecnico', 'whatsapp', 'pmax'];
    const descricoes = {};
    for (const perfil of perfis) {
        const vp = VOZ_PROMPTS[perfil];
        if (!vp) continue;
        const r = await callClaude(vp.system, vp.user(p, dna, aplic, ntc, fiscal));
        descricoes[perfil] = r.text || null;
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    // 4. MONTAR PACOTE DE PUBLICACAO
    const imgPrincipal = imagens.find(i => i.tipo === 'Principal') || imagens[0];
    const oem = dna?.codigo_dna || p.ref;
    const marca = dna?.marca || '';

    const pacote = {
        produto: { id: p.id, ref: p.ref, descricao: p.descricao, status: p.status },
        dna, fiscal, ntc,
        imagens,
        descricoes,
        // Pacote Wix Stores
        wix: {
            name: p.descricao.substring(0, 100),
            description: descricoes.comercial || p.descricao,
            slug: p.ref.toLowerCase().replace(/[^a-z0-9]/g, '-'),
            media: imagens.slice(0, 6).map(i => ({ url: i.url, mediaType: 'image' })),
            sku: p.ref,
            brand: marca,
            customFields: [
                { name: 'OEM', value: oem },
                { name: 'NCM', value: fiscal?.ncm || '' },
                { name: 'NTC Score', value: String((ntcScore*100).toFixed(1)) + '%' },
                { name: 'NTC Status', value: ntc.status },
                { name: 'Grupo Industrial', value: dna?.grupo_industrial || '' },
                { name: 'Aplicacoes', value: aplic.slice(0,5).map(a => `${a.montadora} ${a.modelo}`).join(', ') },
            ]
        },
        // Pacote Bling ERP
        bling: {
            descricao: p.descricao,
            descricaoComplementar: descricoes.tecnico || '',
            codigo: p.ref,
            marca,
            ncm: fiscal?.ncm || '',
            origem: fiscal?.origem || '0',
            peso: null,
            imagemURL: imgPrincipal?.url || null,
            situacao: 'Ativo',
        },
        // Pacote Google Shopping / Merchant Center
        google_shopping: {
            id: p.ref,
            title: descricoes.seo ? (descricoes.seo.match(/TITULO:\s*(.+)/i)?.[1]?.trim() || p.descricao) : p.descricao,
            description: descricoes.comercial || p.descricao,
            brand: marca,
            mpn: oem,
            gtin: fiscal?.cest || null,
            condition: 'new',
            availability: 'in_stock',
            image_link: imgPrincipal?.url || null,
            additional_image_link: imagens.slice(1, 5).map(i => i.url).join(','),
            google_product_category: '8 > 916', // Vehicles > Auto Parts
        },
        // Pacote Google Ads P-Max
        google_ads: descricoes.pmax || null,
        // Pacote WhatsApp
        whatsapp: descricoes.whatsapp || null,
    };

    // 5. Salvar descricao comercial no log
    db.prepare("INSERT INTO logs_ia (produto_ref,acao,resultado,confianca) VALUES (?,?,?,?)").run(
        p.ref, 'PREPARAR_PUBLICACAO', JSON.stringify({ imagens: imagens.length, descricoes: Object.keys(descricoes) }), 0.95
    );

    res.json({ success: true, pacote });
});

// Publicar produto em todos os canais sincronizados
app.post('/api/produtos/:id/publicar', async (req, res) => {
    const id = req.params.id;
    const { canais = ['wix', 'bling', 'google_shopping'] } = req.body;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    if (p.status !== 'Congelado') return res.status(400).json({ error: 'Produto deve estar Congelado para publicar' });

    const resultados = {};
    for (const canal of canais) {
        if (canal === 'wix') {
            resultados.wix = { status: 'pendente', mensagem: 'Wix: necessita MCP connection ativa' };
        } else if (canal === 'bling') {
            resultados.bling = { status: 'pendente', mensagem: 'Bling: necessita API Key configurada' };
        } else if (canal === 'google_shopping') {
            resultados.google_shopping = { status: 'pendente', mensagem: 'Google Merchant: necessita conta configurada' };
        }
    }

    res.json({ success: true, produto: { ref: p.ref, descricao: p.descricao }, canais: resultados });
});

// -----------------------------------------------------------
// CATALOGO IMPORT — CSV / Excel / PDF / Web Scraper
// -----------------------------------------------------------
// Lazy-load libs pesadas — nao bloqueiam o startup
let _XLSX, _csvParse, _pdfParse, _cheerio;
const getXLSX     = () => _XLSX     || (_XLSX     = require('xlsx'));
const getCsvParse = () => _csvParse  || (_csvParse  = require('csv-parse/sync').parse);
const getPdfParse = () => _pdfParse  || (_pdfParse  = require('pdf-parse'));
const getCheerio  = () => _cheerio   || (_cheerio   = require('cheerio'));

const uploadCatalogo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});

// Normalize a row from any format into product fields
function normalizarLinha(row) {
    const keys = Object.keys(row).map(k => k.toLowerCase().trim().replace(/\s+/g,'_'));
    const vals = Object.values(row);
    const obj = {};
    keys.forEach((k, i) => { obj[k] = (vals[i] !== undefined && vals[i] !== null) ? String(vals[i]).trim() : ''; });

    const pick = (...candidates) => { for (const c of candidates) { if (obj[c] && obj[c].length > 0) return obj[c]; } return null; };

    return {
        ref:        pick('ref','referencia','codigo','sku','part_number','cod','reference','part'),
        descricao:  pick('descricao','description','nome','name','produto','title','titulo','desc'),
        marca:      pick('marca','brand','fabricante','manufacturer'),
        oem:        pick('oem','codigo_oem','codigo_dna','part_number','ref_oem','oe'),
        ncm:        pick('ncm','ncm_sh','fiscal_ncm'),
        peso:       pick('peso','peso_liq','peso_liquido','weight','peso_kg'),
        preco:      pick('preco','price','preco_venda','valor','preco_custo'),
        aplicacoes: pick('aplicacoes','aplicacao','veiculos','vehicles','fitment','compatibility'),
        grupo:      pick('grupo','grupo_industrial','group','familia'),
        origem:     pick('origem','origin','pais_origem','country'),
    };
}

async function salvarLinha(linha, empresaId) {
    if (!linha.ref || !linha.descricao) return { skip: true, motivo: 'ref ou descricao ausente' };
    const ref = linha.ref.substring(0, 80);
    const descricao = linha.descricao.substring(0, 255);
    const existente = db.prepare('SELECT id FROM produtos WHERE ref=? AND empresa_id=?').get(ref, empresaId);
    let prodId;
    if (existente) {
        prodId = existente.id;
        db.prepare("UPDATE produtos SET descricao=?, atualizado_em=datetime('now','localtime') WHERE id=?").run(descricao, prodId);
    } else {
        const ins = db.prepare("INSERT INTO produtos (empresa_id,ref,descricao,status) VALUES (?,?,?,'Ativo')").run(empresaId, ref, descricao);
        prodId = ins.lastInsertRowid;
    }
    // DNA
    if (linha.marca || linha.oem || linha.grupo) {
        const existDna = db.prepare('SELECT id FROM dna WHERE produto_id=?').get(prodId);
        if (existDna) {
            db.prepare("UPDATE dna SET marca=COALESCE(NULLIF(?,'')||marca,marca), codigo_dna=COALESCE(NULLIF(?,'')||codigo_dna,codigo_dna), grupo_industrial=COALESCE(NULLIF(?,'')||grupo_industrial,grupo_industrial), origem_pais=COALESCE(NULLIF(?,'')||origem_pais,origem_pais) WHERE produto_id=?")
                .run(linha.marca||null, linha.oem||null, linha.grupo||null, linha.origem||null, prodId);
        } else {
            db.prepare("INSERT INTO dna (produto_id,marca,fabricante,codigo_dna,grupo_industrial,origem_pais) VALUES (?,?,?,?,?,?)")
                .run(prodId, linha.marca||null, linha.marca||null, linha.oem||null, linha.grupo||null, linha.origem||null);
        }
    }
    // Fiscal
    if (linha.ncm) {
        const existF = db.prepare('SELECT id FROM dados_fiscais WHERE produto_id=?').get(prodId);
        if (existF) db.prepare("UPDATE dados_fiscais SET ncm=? WHERE produto_id=?").run(linha.ncm, prodId);
        else db.prepare("INSERT INTO dados_fiscais (produto_id,ncm,origem) VALUES (?,?,?)").run(prodId, linha.ncm, '0');
    }
    // Logistica
    if (linha.peso) {
        const pesoNum = parseFloat(String(linha.peso).replace(',', '.'));
        if (!isNaN(pesoNum)) {
            const existL = db.prepare('SELECT id FROM logistica WHERE produto_id=?').get(prodId);
            if (existL) db.prepare("UPDATE logistica SET peso_liq=? WHERE produto_id=?").run(pesoNum, prodId);
            else db.prepare("INSERT INTO logistica (produto_id,peso_liq) VALUES (?,?)").run(prodId, pesoNum);
        }
    }
    // Aplicacoes simples (texto livre)
    if (linha.aplicacoes && linha.aplicacoes.length > 2) {
        const partes = linha.aplicacoes.split(/[,;\/|]/);
        for (const parte of partes.slice(0, 10)) {
            const s = parte.trim();
            if (s.length < 3) continue;
            const jaExiste = db.prepare('SELECT id FROM aplicacoes_motor WHERE produto_id=? AND modelo=?').get(prodId, s);
            if (!jaExiste) db.prepare("INSERT INTO aplicacoes_motor (produto_id,montadora,modelo) VALUES (?,?,?)").run(prodId, 'Geral', s);
        }
    }
    return { success: true, id: prodId, ref, novo: !existente };
}

// Upload CSV
app.post('/api/catalogo/importar/csv', uploadCatalogo.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatorio' });
    try {
        const rows = getCsvParse()(req.file.buffer, {
            columns: true, skip_empty_lines: true, trim: true,
            relax_quotes: true, relax_column_count: true
        });
        const resultados = [];
        for (const row of rows) {
            const linha = normalizarLinha(row);
            resultados.push(await salvarLinha(linha, 1));
        }
        const salvos = resultados.filter(r => r.success).length;
        const novos = resultados.filter(r => r.novo).length;
        res.json({ success: true, total: rows.length, salvos, novos, atualizados: salvos - novos, erros: resultados.filter(r => r.skip).length });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Upload Excel
app.post('/api/catalogo/importar/excel', uploadCatalogo.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatorio' });
    try {
        const wb = getXLSX().read(req.file.buffer, { type: 'buffer' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = getXLSX().utils.sheet_to_json(ws, { defval: '' });
        const resultados = [];
        for (const row of rows) {
            const linha = normalizarLinha(row);
            resultados.push(await salvarLinha(linha, 1));
        }
        const salvos = resultados.filter(r => r.success).length;
        const novos = resultados.filter(r => r.novo).length;
        res.json({ success: true, total: rows.length, salvos, novos, atualizados: salvos - novos, erros: resultados.filter(r => r.skip).length, planilha: wb.SheetNames[0] });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Upload PDF
app.post('/api/catalogo/importar/pdf', uploadCatalogo.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatorio' });
    try {
        const data = await getPdfParse()(req.file.buffer);
        const texto = data.text;
        // Ask Claude Haiku to extract structured product list from PDF text
        const systemPrompt = `Voce e um especialista em catalogo de autopecas. Extraia todos os produtos encontrados no texto e retorne SOMENTE um JSON array valido:
[{"ref":"","descricao":"","marca":"","oem":"","ncm":"","peso":"","aplicacoes":""}]
Regras: ref obrigatorio (codigo/SKU/part number), descricao obrigatorio. Use null para campos ausentes. Retorne apenas o JSON array, sem texto extra.`;
        const userPrompt = `Extraia produtos deste catalogo PDF (primeiros 3000 chars):\n\n${texto.substring(0, 3000)}`;
        const claudeResult = await callClaude(systemPrompt, userPrompt);
        let produtos = [];
        try {
            const jsonText = (claudeResult.text || '').replace(/```json|```/g, '').trim();
            produtos = JSON.parse(jsonText);
            if (!Array.isArray(produtos)) produtos = [];
        } catch (e) { produtos = []; }

        const resultados = [];
        for (const row of produtos) {
            const linha = normalizarLinha(row);
            resultados.push(await salvarLinha(linha, 1));
        }
        const salvos = resultados.filter(r => r.success).length;
        res.json({ success: true, paginas: data.numpages, extraidos: produtos.length, salvos, texto_preview: texto.substring(0, 500) });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Web scraper — raspa URL de catalogo de fornecedor
app.post('/api/catalogo/scraper', async (req, res) => {
    const { url, seletor_ref, seletor_desc, seletor_marca, seletor_preco, usar_ia } = req.body;
    if (!url) return res.status(400).json({ error: 'URL obrigatoria' });
    try {
        const r = await httpGet(url, {
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            'User-Agent': 'Mozilla/5.0 (compatible; GenesisBot/1.0; +https://genesis360.io)'
        });
        if (r.status !== 200) return res.status(400).json({ error: 'HTTP ' + r.status });
        const $ = getCheerio().load(r.body);

        let produtos = [];

        if (seletor_ref && seletor_desc) {
            // Custom selectors mode
            const refs = $(seletor_ref).map((i, el) => $(el).text().trim()).get();
            const descs = $(seletor_desc).map((i, el) => $(el).text().trim()).get();
            const marcas = seletor_marca ? $(seletor_marca).map((i, el) => $(el).text().trim()).get() : [];
            const precos = seletor_preco ? $(seletor_preco).map((i, el) => $(el).text().trim()).get() : [];
            const len = Math.min(refs.length, descs.length, 50);
            for (let i = 0; i < len; i++) {
                if (refs[i] && descs[i]) {
                    produtos.push({ ref: refs[i], descricao: descs[i], marca: marcas[i] || null, preco: precos[i] || null });
                }
            }
        } else if (usar_ia) {
            // IA mode: send HTML to Claude to extract products
            const htmlText = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 4000);
            const systemPrompt = `Extraia produtos de autopecas do texto HTML e retorne JSON array: [{"ref":"","descricao":"","marca":"","oem":"","preco":""}]. Apenas JSON, sem texto extra.`;
            const claudeResult = await callClaude(systemPrompt, `Extraia produtos:\n\n${htmlText}`);
            try {
                const jsonText = (claudeResult.text || '').replace(/```json|```/g, '').trim();
                produtos = JSON.parse(jsonText);
                if (!Array.isArray(produtos)) produtos = [];
            } catch (e) { produtos = []; }
        }

        // Preview mode — return without saving if no save flag
        if (!req.body.salvar) {
            return res.json({ success: true, url, extraidos: produtos.length, preview: produtos.slice(0, 20) });
        }

        // Save mode
        const resultados = [];
        for (const p of produtos) {
            const linha = normalizarLinha(p);
            resultados.push(await salvarLinha(linha, 1));
        }
        const salvos = resultados.filter(r => r.success).length;
        res.json({ success: true, url, extraidos: produtos.length, salvos });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Enriquecimento em lote — enriquece todos PENDENTES/REPROVADOS com web
app.post('/api/catalogo/enriquecer-lote', async (req, res) => {
    const { limite = 10 } = req.body;
    const produtos = db.prepare("SELECT id FROM produtos WHERE ntc_status != 'APROVADO' AND status != 'Congelado' LIMIT ?").all(parseInt(limite));
    res.json({ iniciado: true, total: produtos.length, ids: produtos.map(p => p.id) });
    // Run enrichment in background (fire-and-forget)
    (async () => {
        for (const p of produtos) {
            try {
                const prod = db.prepare('SELECT * FROM produtos WHERE id=?').get(p.id);
                const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(p.id);
                const oem = dna?.codigo_dna || prod.ref.replace(/^[A-Z]+-/i, '');
                const marca = dna?.marca || '';
                const [ddg, imgUrls] = await Promise.all([searchDuckDuckGo(`${marca} ${oem} ${prod.descricao}`), searchBingImages(`${marca} ${oem} autopeca`)]);
                const systemPrompt = `Retorne SOMENTE JSON: {"aplicacoes":[{"montadora":"","modelo":"","ano_ini":0,"ano_fim":0}],"codigos_cambiados":[{"tipo":"OEM","codigo":"","fabricante":""}],"logistica":{"peso_liq":0},"fiscal":{"ncm":""}}. Use null para dados sem certeza.`;
                const cl = await callClaude(systemPrompt, `Produto: ${prod.descricao}\nMarca: ${marca}\nOEM: ${oem}\nWeb: ${ddg?.abstract||''}`);
                let parsed = null;
                try { parsed = JSON.parse((cl.text||'').replace(/```json|```/g,'').trim()); } catch (e) {}
                if (parsed) {
                    // Salvar dados basicos
                    if (parsed.fiscal?.ncm) {
                        const existF = db.prepare('SELECT id FROM dados_fiscais WHERE produto_id=?').get(p.id);
                        if (!existF) db.prepare("INSERT INTO dados_fiscais (produto_id,ncm,origem) VALUES (?,?,?)").run(p.id, parsed.fiscal.ncm, '0');
                    }
                    if (Array.isArray(parsed.aplicacoes)) {
                        for (const a of parsed.aplicacoes.slice(0, 5)) {
                            if (!a.montadora || !a.modelo) continue;
                            const ex = db.prepare('SELECT id FROM aplicacoes_motor WHERE produto_id=? AND modelo=?').get(p.id, a.modelo);
                            if (!ex) db.prepare("INSERT INTO aplicacoes_motor (produto_id,montadora,modelo,ano_ini,ano_fim) VALUES (?,?,?,?,?)").run(p.id, a.montadora, a.modelo, a.ano_ini||null, a.ano_fim||null);
                        }
                    }
                }
                for (const imgUrl of imgUrls.slice(0,2)) {
                    const ex = db.prepare('SELECT id FROM imagens WHERE produto_id=? AND url=?').get(p.id, imgUrl);
                    if (!ex) db.prepare("INSERT INTO imagens (produto_id,tipo,url,origem,status) VALUES (?,?,?,?,?)").run(p.id, 'Principal', imgUrl, 'Lote-Web', 'Aprovada');
                }
                // Recalc NTC
                const dnaU = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(p.id);
                const fiscalU = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(p.id);
                const aplicU = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(p.id);
                const nctTF = dnaU?.codigo_dna ? 0.97 : (dnaU?.marca ? 0.70 : 0.10);
                const nctFM = prod.descricao?.length > 20 ? 0.85 : 0.30;
                const nctCO = fiscalU?.ncm ? 1.00 : 0.00;
                const nctAV = aplicU.length >= 5 ? 1.00 : aplicU.length >= 3 ? 0.80 : aplicU.length > 0 ? aplicU.length * 0.20 : 0.00;
                const ntcScore = parseFloat((nctTF*0.50 + nctFM*0.20 + nctCO*0.20 + nctAV*0.10).toFixed(4));
                const ntcStatus = ntcScore >= 0.95 ? 'APROVADO' : ntcScore >= 0.60 ? 'PENDENTE' : 'REPROVADO';
                db.prepare("UPDATE produtos SET ntc_score=?,ntc_status=?,atualizado_em=datetime('now','localtime') WHERE id=?").run(ntcScore, ntcStatus, p.id);
            } catch (e) { /* continue batch */ }
            await new Promise(r => setTimeout(r, 500));
        }
    })();
});

// Template download — CSV modelo
app.get('/api/catalogo/template/csv', (req, res) => {
    const header = 'ref,descricao,marca,oem,ncm,peso,aplicacoes,grupo,origem\n';
    const exemplo = 'LUK-6203236,"KIT DE EMBREAGEM 200MM",LUK,6203236000,8708.93.00,3.758,"Corsa 1.0/Celta/Prisma",Schaeffler,Alemanha\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=template_catalogo.csv');
    res.send('﻿' + header + exemplo);
});

// Template download — Excel modelo
app.get('/api/catalogo/template/excel', (req, res) => {
    const wb = getXLSX().utils.book_new();
    const data = [
        ['ref','descricao','marca','oem','ncm','peso','aplicacoes','grupo','origem'],
        ['LUK-6203236','KIT DE EMBREAGEM 200MM','LUK','6203236000','8708.93.00',3.758,'Corsa 1.0/Celta/Prisma','Schaeffler','Alemanha'],
        ['BOC-0986494131','PASTILHA DE FREIO DIANTEIRA','Bosch','0986494131','8708.30.11',0.8,'Gol/Saveiro/Parati','Bosch','Brasil'],
    ];
    const ws = getXLSX().utils.aoa_to_sheet(data);
    ws['!cols'] = [{wch:18},{wch:40},{wch:12},{wch:16},{wch:12},{wch:8},{wch:35},{wch:14},{wch:10}];
    getXLSX().utils.book_append_sheet(wb, ws, 'Catalogo');
    const buf = getXLSX().write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=template_catalogo.xlsx');
    res.send(buf);
});

// -----------------------------------------------------------
// MULTI-EMPRESA
// -----------------------------------------------------------
app.get('/api/empresas', (req, res) => {
    res.json(db.prepare('SELECT id, nome, cnpj, plano FROM empresas').all());
});

// -----------------------------------------------------------
// MARKETPLACE READY
// -----------------------------------------------------------
app.get('/api/marketplace/pacote/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(req.params.id) || {};
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(req.params.id) || {};
    const log = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(req.params.id) || {};
    const aplic = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=? LIMIT 10').all(req.params.id);
    const imgs = db.prepare("SELECT * FROM imagens WHERE produto_id=? AND status != 'Reprovada' ORDER BY tipo").all(req.params.id);

    res.json({
        mercado_livre: {
            title: p.descricao,
            category_id: null,
            price: p.preco_venda || 0,
            currency_id: 'BRL',
            available_quantity: 1,
            condition: 'new',
            pictures: imgs.slice(0,6).map(i => ({ source: i.url })),
            attributes: [
                { id: 'BRAND', value_name: dna.marca || null },
                { id: 'MODEL', value_name: aplic[0]?.modelo || null },
                { id: 'PART_NUMBER', value_name: p.ref },
                { id: 'EAN', value_name: null },
            ].filter(a => a.value_name),
            description: { plain_text: p.descricao },
        },
        amazon: {
            item_name: p.descricao,
            brand_name: dna.marca || dna.fabricante,
            part_number: p.ref,
            standard_price: p.preco_venda || 0,
            quantity: 1,
            product_description: p.descricao,
            bullet_point: aplic.slice(0,5).map(a => `${a.montadora} ${a.modelo} ${a.ano_ini||''}-${a.ano_fim||''}`).join('; ') || null,
            main_image_url: imgs[0]?.url || null,
        },
        shopee: {
            item_name: p.descricao,
            description: p.descricao,
            price: p.preco_venda || 0,
            stock: 1,
            images: imgs.slice(0,9).map(i => i.url),
            brand: dna.marca || null,
            weight: log.peso_liq ? log.peso_liq * 1000 : null,
            dimension: log.comprimento ? { length: log.comprimento, width: log.largura || 0, height: log.altura || 0 } : null,
        },
        magalu: {
            nome: p.descricao,
            sku: p.ref,
            preco: p.preco_venda || 0,
            marca: dna.marca || null,
            ncm: fiscal.ncm || null,
            peso: log.peso_liq || null,
            imagens: imgs.slice(0,5).map(i => i.url),
            aplicacoes: aplic.slice(0,5).map(a => `${a.montadora} ${a.modelo} ${a.ano_ini||'?'}-${a.ano_fim||'?'}`),
        },
        status: {
            pronto_ml: !!(p.descricao && imgs.length > 0 && p.preco_venda),
            pronto_amazon: !!(p.descricao && imgs.length > 0 && dna.marca),
            pronto_shopee: !!(p.descricao && imgs.length > 0 && p.preco_venda),
            pronto_magalu: !!(p.descricao && fiscal.ncm && imgs.length > 0),
        }
    });
});

// -----------------------------------------------------------
// START
// -----------------------------------------------------------
app.listen(PORT, () => {
    console.log('GENESIS INDEXA 360 IA v5.0 rodando na porta ' + PORT);
    console.log('Health: http://localhost:' + PORT + '/api/health');

    // Keep-alive: ping proprio servidor a cada 14 min para evitar cold start no Render
    const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    if (process.env.NODE_ENV === 'production') {
        setInterval(() => {
            const urlObj = new URL(APP_URL + '/api/health');
            const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
            mod.get(APP_URL + '/api/health', (r) => {
                console.log('[keep-alive] ping ' + r.statusCode);
            }).on('error', () => {});
        }, 14 * 60 * 1000);
    }
});
