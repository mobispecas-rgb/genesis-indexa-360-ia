// ============================================================
// INDEXAAI CATALOG PRO v5.0 — ENTERPRISE SAAS PLATFORM
// Motor NTC 4.0 + iRollo Engine | Node.js + Express + SQLite
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

// Loga o stack trace completo antes de cair — sem isso, o processo morre
// com "Exited with status 1" e nenhuma pista do motivo real fica nos logs.
process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason);
});

// -----------------------------------------------------------
// DATABASE
// -----------------------------------------------------------
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'genesis.db');
let db;
try {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
} catch (err) {
    console.error('[FATAL] Falha ao iniciar banco de dados em', dbPath, '-', err.message);
    throw err;
}

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
    const insP = db.prepare("INSERT INTO produtos (empresa_id, ref, descricao, status, wix_id) VALUES (?,?,?,?,?)");
    const insD = db.prepare("INSERT INTO dna (produto_id, fabricante, grupo_industrial, origem_pais, codigo_dna, marca, linha, familia, status_certificacao) VALUES (?,?,?,?,?,?,?,?,?)");
    const insF = db.prepare("INSERT INTO dados_fiscais (produto_id, ncm, cest, origem, ipi, icms, pis, cofins, cfop) VALUES (?,?,?,?,?,?,?,?,?)");
    const insL = db.prepare("INSERT INTO logistica (produto_id, peso_liq, peso_bruto, altura, largura, comprimento) VALUES (?,?,?,?,?,?)");

    const p1 = insP.run(1, 'LUK-6203236', 'KIT DE EMBREAGEM 200MM PLATO/DISCO/ROLAMENTO', 'Ativo', 'a50f44fe-1c2e-463e-b21c-491a470007c3');
    insD.run(p1.lastInsertRowid, 'LUK Automotive', 'Schaeffler', 'Alemanha', '6203236000', 'LUK', 'RepSet Pro', 'Embreagem', 'Aprovado');
    insF.run(p1.lastInsertRowid, '8708.93.00', '1512200', '0', 0, 12, 0.65, 3, '5102');
    insL.run(p1.lastInsertRowid, 4.2, 4.8, 12, 22, 22);

    const p2 = insP.run(1, 'BOC-0986494131', 'PASTILHA DE FREIO DIANTEIRA CERAMICA', 'Ativo', 'd5e27817-e588-4da4-ad9d-fe5585356a21');
    insD.run(p2.lastInsertRowid, 'Robert Bosch GmbH', 'Robert Bosch GmbH', 'Alemanha', '0986494131', 'Bosch', 'Quietcast', 'Freios', 'Pendente');
    insF.run(p2.lastInsertRowid, '8708.10.00', '1512100', '0', 0, 12, 0.65, 3, '5102');
    insL.run(p2.lastInsertRowid, 0.8, 1.0, 5, 15, 20);

    const p3 = insP.run(1, 'SKF-VKBA3569', 'ROLAMENTO RODA TRASEIRA COM ABS', 'Ativo', 'ce2aaa9f-ea27-42d4-95d2-7d3553c15380');
    insD.run(p3.lastInsertRowid, 'SKF AB', 'SKF AB', 'Suecia', 'VKBA3569', 'SKF', 'Bearings', 'Rolamentos', 'Reprovado');
    insF.run(p3.lastInsertRowid, '8482.10.10', null, '0', 0, 12, 0.65, 3, '5102');
    insL.run(p3.lastInsertRowid, 1.5, 1.8, 8, 14, 14);

    global.__seedProdutoIds = [p1.lastInsertRowid, p2.lastInsertRowid, p3.lastInsertRowid];
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

// O score e status NTC dos produtos de demonstracao nao sao fixados no
// cadastro: sao calculados e auditados pelo Motor NTC 4.0 a partir dos
// dados reais (DNA, fiscal, logistica) de cada produto, igual ao fluxo
// usado para qualquer produto enriquecido pela plataforma.
if (global.__seedProdutoIds) {
    for (const id of global.__seedProdutoIds) {
        const resultado = calcNTCFromId(id);
        if (resultado) {
            persistNTC(id, resultado, 'Auditoria inicial do Motor NTC 4.0 no cadastro do produto');
            db.prepare('UPDATE dna SET score=? WHERE produto_id=?').run(resultado.score, id);
        }
    }
    delete global.__seedProdutoIds;
}

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
        platform: 'IndexaAI Catalog Pro v5.0 + Motor NTC 4.0',
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
    p.nct = calcNTCFromId(id);
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
        const engData = req.body.engenharia;
        if (engData) db.prepare("INSERT INTO engenharia (produto_id,componentes,diametro,estrias,sistema,material,especificacoes) VALUES (?,?,?,?,?,?,?)").run(pid, engData.componentes||null, engData.diametro||null, engData.estrias||null, engData.sistema||null, engData.material||null, engData.especificacoes||null);
        const hierData = req.body.hierarquia;
        if (hierData) db.prepare("INSERT INTO hierarquia (produto_id,fabricante_original,montadora,distribuidor,importador,marca_propria,lojista) VALUES (?,?,?,?,?,?,?)").run(pid, hierData.fabricante_original||null, hierData.montadora||null, hierData.distribuidor||null, hierData.importador||null, hierData.marca_propria||null, hierData.lojista||null);
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
    const instrucoes = {
        bling: 'Configure a API Key v3 do Bling em Configuracoes > Integracoes para ativar o envio automatico.',
        wix: 'Conecte o MCP do Wix em Configuracoes > Integracoes para sincronizar o catalogo.',
        google_shopping: 'Configure sua conta Google Merchant Center em Configuracoes > Integracoes para gerar o feed.',
    };
    return res.status(501).json({
        success: false,
        stub: true,
        canal,
        mensagem: instrucoes[canal] || 'Integracao com ' + canal + ' ainda nao configurada.',
    });
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
// ENGENHARIA
// -----------------------------------------------------------
app.get('/api/produtos/:id/engenharia', (req, res) => {
    res.json(db.prepare('SELECT * FROM engenharia WHERE produto_id=?').get(req.params.id) || {});
});

app.put('/api/produtos/:id/engenharia', (req, res) => {
    const e = req.body;
    const existing = db.prepare('SELECT id FROM engenharia WHERE produto_id=?').get(req.params.id);
    if (existing) {
        db.prepare("UPDATE engenharia SET componentes=?,diametro=?,estrias=?,sistema=?,material=?,especificacoes=? WHERE produto_id=?").run(
            e.componentes||null, e.diametro||null, e.estrias||null, e.sistema||null, e.material||null, e.especificacoes||null, req.params.id
        );
    } else {
        db.prepare("INSERT INTO engenharia (produto_id,componentes,diametro,estrias,sistema,material,especificacoes) VALUES (?,?,?,?,?,?,?)").run(
            req.params.id, e.componentes||null, e.diametro||null, e.estrias||null, e.sistema||null, e.material||null, e.especificacoes||null
        );
    }
    res.json({ success: true });
});

// -----------------------------------------------------------
// HIERARQUIA
// -----------------------------------------------------------
app.get('/api/produtos/:id/hierarquia', (req, res) => {
    res.json(db.prepare('SELECT * FROM hierarquia WHERE produto_id=?').get(req.params.id) || {});
});

app.put('/api/produtos/:id/hierarquia', (req, res) => {
    const h = req.body;
    const existing = db.prepare('SELECT id FROM hierarquia WHERE produto_id=?').get(req.params.id);
    if (existing) {
        db.prepare("UPDATE hierarquia SET fabricante_original=?,montadora=?,distribuidor=?,importador=?,marca_propria=?,lojista=? WHERE produto_id=?").run(
            h.fabricante_original||null, h.montadora||null, h.distribuidor||null, h.importador||null, h.marca_propria||null, h.lojista||null, req.params.id
        );
    } else {
        db.prepare("INSERT INTO hierarquia (produto_id,fabricante_original,montadora,distribuidor,importador,marca_propria,lojista) VALUES (?,?,?,?,?,?,?)").run(
            req.params.id, h.fabricante_original||null, h.montadora||null, h.distribuidor||null, h.importador||null, h.marca_propria||null, h.lojista||null
        );
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

app.put('/api/imagens/:id/tipo', (req, res) => {
    const { tipo } = req.body;
    if (!tipo) return res.status(400).json({ error: 'tipo obrigatorio' });
    db.prepare("UPDATE imagens SET tipo=? WHERE id=?").run(tipo, req.params.id);
    res.json({ success: true });
});

// Classificacao automatica de imagem por IA — sempre usa o contexto DNA do produto
// (marca/fabricante/familia/descricao) para validar coerencia, e apenas SUGERE a
// categoria: a aplicacao depende de confirmacao manual via PUT /api/imagens/:id/tipo
app.post('/api/imagens/:id/classificar-ia', async (req, res) => {
    const img = db.prepare('SELECT * FROM imagens WHERE id=?').get(req.params.id);
    if (!img) return res.status(404).json({ error: 'Imagem nao encontrada' });
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(img.produto_id);
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(img.produto_id);

    let base64, mediaType;
    try {
        if (img.url.startsWith('/uploads/')) {
            const filePath = path.join(__dirname, 'public', img.url);
            base64 = fs.readFileSync(filePath).toString('base64');
            mediaType = imageMediaType(filePath);
        } else {
            const { buffer, contentType } = await fetchImageBuffer(img.url);
            base64 = buffer.toString('base64');
            mediaType = (contentType || '').split(';')[0].trim() || imageMediaType(img.url);
        }
    } catch (e) {
        return res.status(500).json({ error: 'Falha ao carregar imagem: ' + e.message });
    }

    const categorias = Object.entries(IMG_CATEGORIAS_IA).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const dnaContexto = `Marca: ${dna?.marca || 'desconhecida'}\nFabricante: ${dna?.fabricante || 'desconhecido'}\nFamilia: ${dna?.familia || 'desconhecida'}\nCodigo OEM: ${dna?.codigo_dna || 'nao informado'}\nDescricao do produto: ${p?.descricao || ''}`;

    const systemPrompt = `Voce e um classificador de imagens de autopecas para um catalogo certificado (NTC).
Analise a imagem enviada e classifique-a em UMA das categorias abaixo, sempre considerando o contexto DNA do produto (marca, familia, descricao) para verificar coerencia entre a imagem e o produto:

${categorias}

Contexto DNA do produto (use sempre para validar se a imagem condiz com o produto):
${dnaContexto}

Responda SOMENTE com um JSON no formato:
{"categoria": "<uma das chaves acima>", "confianca": <numero de 0 a 1>, "justificativa": "<explicacao curta em portugues, citando o que ve na imagem e como isso se relaciona ao DNA do produto>"}

Regras:
- NUNCA invente o que nao esta visivel na imagem
- Se a imagem nao parecer condizer com o produto/DNA informado, reduza a confianca e explique a divergencia na justificativa
- categoria deve ser exatamente uma das chaves listadas`;

    const userContent = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Classifique esta imagem do produto seguindo as instrucoes do system prompt.' }
    ];

    const result = await callClaude(systemPrompt, userContent, 500);
    if (result.error) return res.status(502).json({ error: result.error });

    let parsed = null;
    try {
        let jsonText = (result.text || '').trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const match = jsonText.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
    } catch (e) { parsed = null; }

    if (!parsed || !parsed.categoria) return res.json({ success: false, error: 'Parse error', raw: result.text });

    res.json({
        success: true,
        sugestao: parsed.categoria,
        confianca: typeof parsed.confianca === 'number' ? parsed.confianca : null,
        justificativa: parsed.justificativa || '',
        tipo_atual: img.tipo
    });
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

function buildProductNTCInput(p, dna, fiscal, logistica, aplicacoes, codigos, imagens) {
    const eanRecord = codigos.find(c => c.tipo === 'EAN' || c.tipo === 'GTIN');
    const ean = eanRecord ? eanRecord.codigo : null;
    const dimText = logistica && logistica.largura ? logistica.largura + 'mm' : '';
    const altText = logistica && logistica.altura ? logistica.altura + 'mm' : '';
    const text = [p.ref, p.descricao, dna ? (dna.marca || '') : '', dna ? (dna.fabricante || '') : '', dimText, altText].filter(Boolean).join(' ');
    const extra = {
        ncm: fiscal && fiscal.ncm,
        cest: fiscal && fiscal.cest,
        cfop: fiscal && fiscal.cfop,
        ean,
        peso: logistica && logistica.peso_liq,
        dimensoes: logistica ? !!(logistica.altura || logistica.largura || logistica.comprimento) : false,
        aplicacoes,
        codigos,
        imagens
    };
    return { text, extra };
}

app.get('/api/produtos/:id/ntc', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(req.params.id);
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(req.params.id);
    const logistica = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(req.params.id);
    const aplicacoes = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(req.params.id);
    const codigos = db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(req.params.id);
    const imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(req.params.id);
    const { text, extra } = buildProductNTCInput(p, dna, fiscal, logistica, aplicacoes, codigos, imagens);
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
    const { text, extra } = buildProductNTCInput(p, dna, fiscal, logistica, aplicacoes, codigos, imagens);
    const result = calcNTC(text, extra);
    db.prepare("INSERT INTO historico_ntc (produto_id,ntc_anterior,ntc_novo,status_anterior,status_novo,alteracao) VALUES (?,?,?,?,?,?)").run(req.params.id, p.ntc_score, result.score, p.ntc_status, result.status, 'Recalculo NTC');
    db.prepare("UPDATE produtos SET ntc_score=?,ntc_status=?,rast_hash=?,atualizado_em=datetime('now','localtime') WHERE id=?").run(result.score, result.status, result.rast_hash, req.params.id);
    const existing = db.prepare('SELECT id FROM rast_hash WHERE produto_id=?').get(req.params.id);
    if (existing) db.prepare("UPDATE rast_hash SET hash=?,base=?,gerado_em=datetime('now','localtime') WHERE produto_id=?").run(result.rast_hash, text.substring(0, 200), req.params.id);
    else db.prepare("INSERT INTO rast_hash (produto_id,hash,base) VALUES (?,?,?)").run(req.params.id, result.rast_hash, text.substring(0, 200));
    res.json({ success: true, ntc: result });
});

// -----------------------------------------------------------
// UNIFIED NTC HELPERS — single source of truth for all endpoints
// -----------------------------------------------------------
function calcNTCFromId(id) {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return null;
    const dna = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);
    const fiscal = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(id);
    const logistica = db.prepare('SELECT * FROM logistica WHERE produto_id=?').get(id);
    const aplicacoes = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(id);
    const codigos = db.prepare('SELECT * FROM codigos_cambiados WHERE produto_id=?').all(id);
    const imagens = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id);
    const { text, extra } = buildProductNTCInput(p, dna, fiscal, logistica, aplicacoes, codigos, imagens);
    return calcNTC(text, extra);
}

function persistNTC(id, result, motivo) {
    const p = db.prepare('SELECT ntc_score, ntc_status, descricao FROM produtos WHERE id=?').get(id);
    db.prepare("INSERT INTO historico_ntc (produto_id,ntc_anterior,ntc_novo,status_anterior,status_novo,alteracao) VALUES (?,?,?,?,?,?)")
        .run(id, p?.ntc_score || 0, result.score, p?.ntc_status || 'PENDENTE', result.status, motivo || 'Recalculo NTC');
    db.prepare("UPDATE produtos SET ntc_score=?,ntc_status=?,rast_hash=?,atualizado_em=datetime('now','localtime') WHERE id=?")
        .run(result.score, result.status, result.rast_hash, id);
    const base = (p?.descricao || '').substring(0, 200);
    const existing = db.prepare('SELECT id FROM rast_hash WHERE produto_id=?').get(id);
    if (existing) db.prepare("UPDATE rast_hash SET hash=?,base=?,gerado_em=datetime('now','localtime') WHERE produto_id=?").run(result.rast_hash, base, id);
    else db.prepare("INSERT INTO rast_hash (produto_id,hash,base) VALUES (?,?,?)").run(id, result.rast_hash, base);
}

// -----------------------------------------------------------
// APROVACAO DE ENRIQUECIMENTO
// -----------------------------------------------------------

// Stats da fila de aprovacao
app.get('/api/aprovacao/stats', (req, res) => {
    const pendentes = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ntc_status='PENDENTE' AND status!='Congelado'").get().c;
    const reprovados = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ntc_status='REPROVADO' AND status!='Congelado'").get().c;
    const imgsPendentes = db.prepare("SELECT COUNT(*) as c FROM imagens WHERE status='Pendente'").get().c;
    const aprovados = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ntc_status='APROVADO' AND status!='Congelado'").get().c;
    const prontosCongelar = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ntc_score>=0.80 AND status='Ativo'").get().c;
    res.json({ pendentes, reprovados, imgsPendentes, aprovados, prontosCongelar, total_fila: pendentes + reprovados });
});

// Fila de aprovacao com detalhes completos
app.get('/api/aprovacao/fila', (req, res) => {
    const { tipo = 'todos', page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const whereMap = {
        todos: "p.ntc_status IN ('PENDENTE','REPROVADO')",
        pendente: "p.ntc_status='PENDENTE'",
        reprovado: "p.ntc_status='REPROVADO'",
        aprovado: "p.ntc_status='APROVADO'"
    };
    const where = whereMap[tipo] || whereMap.todos;
    const total = db.prepare(`SELECT COUNT(*) as c FROM produtos p WHERE ${where} AND p.status!='Congelado'`).get().c;
    const rows = db.prepare(`SELECT p.*, d.fabricante, d.marca, d.familia, d.grupo_industrial, d.origem_pais, d.codigo_dna FROM produtos p LEFT JOIN dna d ON d.produto_id=p.id WHERE ${where} AND p.status!='Congelado' ORDER BY p.ntc_score DESC LIMIT ? OFFSET ?`).all(parseInt(limit), offset);
    rows.forEach(row => {
        const img = db.prepare("SELECT url FROM imagens WHERE produto_id=? ORDER BY CASE WHEN tipo='Principal' THEN 0 ELSE 1 END, id ASC LIMIT 1").get(row.id);
        row.imagem_principal = img ? img.url : null;
        row.aplicacoes_count = db.prepare('SELECT COUNT(*) as c FROM aplicacoes_motor WHERE produto_id=?').get(row.id).c;
        row.imagens_count = db.prepare('SELECT COUNT(*) as c FROM imagens WHERE produto_id=?').get(row.id).c;
        row.imagens_pendentes = db.prepare("SELECT COUNT(*) as c FROM imagens WHERE produto_id=? AND status='Pendente'").get(row.id).c;
        row.codigos_count = db.prepare('SELECT COUNT(*) as c FROM codigos_cambiados WHERE produto_id=?').get(row.id).c;
    });
    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
});

// Aprovar enriquecimento — recalcula NTC 12-modulos, aprova imagens pendentes
app.post('/api/produtos/:id/aprovar', (req, res) => {
    const id = req.params.id;
    const { congelar = false, motivo = 'Aprovacao de enriquecimento' } = req.body;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    const ntcResult = calcNTCFromId(id);
    if (!ntcResult) return res.status(500).json({ error: 'Erro ao calcular NTC' });
    db.transaction(() => {
        persistNTC(id, ntcResult, motivo);
        db.prepare("UPDATE imagens SET status='Aprovada' WHERE produto_id=? AND status='Pendente'").run(id);
        if (congelar && ntcResult.score >= 0.80) {
            db.prepare("UPDATE produtos SET status='Congelado', atualizado_em=datetime('now','localtime') WHERE id=?").run(id);
            db.prepare("INSERT INTO historico_ntc (produto_id,status_anterior,status_novo,alteracao) VALUES (?,?,?,?)").run(id, p.status, 'Congelado', 'Congelado apos aprovacao');
        }
    })();
    res.json({
        success: true,
        ntc: { score: ntcResult.score, status: ntcResult.status },
        congelado: congelar && ntcResult.score >= 0.80,
        produto: db.prepare('SELECT id,ref,descricao,ntc_score,ntc_status,status FROM produtos WHERE id=?').get(id)
    });
});

// Rejeitar produto — marca imagens como rejeitadas e loga motivo
app.post('/api/produtos/:id/rejeitar', (req, res) => {
    const id = req.params.id;
    const { motivo = 'Rejeitado pelo operador' } = req.body;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    db.prepare("UPDATE imagens SET status='Rejeitada' WHERE produto_id=? AND status='Pendente'").run(id);
    db.prepare("INSERT INTO historico_ntc (produto_id,ntc_anterior,ntc_novo,status_anterior,status_novo,alteracao) VALUES (?,?,?,?,?,?)").run(id, p.ntc_score, p.ntc_score, p.ntc_status, p.ntc_status, 'Rejeitado: ' + motivo);
    res.json({ success: true, produto: db.prepare('SELECT id,ref,descricao,ntc_score,ntc_status,status FROM produtos WHERE id=?').get(id) });
});

// Aprovacao em lote
app.post('/api/aprovacao/lote', (req, res) => {
    const { ids = [], acao = 'aprovar', congelar = false } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids obrigatorio' });
    const resultados = [];
    for (const id of ids.slice(0, 50)) {
        try {
            const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
            if (!p) { resultados.push({ id, error: 'nao encontrado' }); continue; }
            if (acao === 'aprovar') {
                const ntcResult = calcNTCFromId(id);
                if (ntcResult) {
                    db.transaction(() => {
                        persistNTC(id, ntcResult, 'Aprovacao em lote');
                        db.prepare("UPDATE imagens SET status='Aprovada' WHERE produto_id=? AND status='Pendente'").run(id);
                        if (congelar && ntcResult.score >= 0.80) {
                            db.prepare("UPDATE produtos SET status='Congelado', atualizado_em=datetime('now','localtime') WHERE id=?").run(id);
                        }
                    })();
                    resultados.push({ id, success: true, ntc_score: ntcResult.score, ntc_status: ntcResult.status });
                }
            } else if (acao === 'rejeitar') {
                db.prepare("UPDATE imagens SET status='Rejeitada' WHERE produto_id=? AND status='Pendente'").run(id);
                resultados.push({ id, success: true, acao: 'rejeitado' });
            }
        } catch (e) { resultados.push({ id, error: e.message }); }
    }
    res.json({ success: true, processados: resultados.length, resultados });
});

// Imagens pendentes de aprovacao (todas as marcas)
app.get('/api/imagens/pendentes', (req, res) => {
    const { limit = 50 } = req.query;
    const imgs = db.prepare(`SELECT i.*, p.ref as produto_ref, p.descricao as produto_descricao FROM imagens i JOIN produtos p ON p.id=i.produto_id WHERE i.status='Pendente' ORDER BY i.criado_em DESC LIMIT ?`).all(parseInt(limit));
    res.json({ total: imgs.length, data: imgs });
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

// Baixa uma imagem (URL externa) preservando os bytes binarios — usado pela classificacao
// automatica por IA, que precisa enviar a imagem em base64 para a API de visao da Anthropic.
function fetchImageBuffer(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('http://') ? require('http') : https;
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GenesisIndexa/5.0)' }, timeout: 10000 }, (res) => {
            if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// Categorias do "Banco de Imagens Certificadas" usadas pela classificacao automatica por IA
const IMG_CATEGORIAS_IA = {
    Principal: 'Produto isolado em fundo neutro, sem contexto — foto de catalogo padrao',
    Lateral: 'Vista lateral ou de outro angulo do produto isolado',
    Tecnica: 'Foto tecnica destacando especificacoes, medidas, conectores ou componentes internos',
    Detalhe: 'Zoom em um detalhe especifico do produto (acabamento, gravacao, textura, encaixe)',
    Embalagem: 'Caixa, embalagem ou etiqueta do produto',
    OEM: 'Codigo OEM, numero de peca ou gravacao de identificacao visivel na peca',
    Aplicada: 'Produto montado/instalado no veiculo ou em um conjunto/aplicacao real'
};

function imageMediaType(urlOrPath) {
    const ext = path.extname(urlOrPath).toLowerCase().replace('.', '');
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    return 'image/jpeg';
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
    const imgUrls = [];
    // Multiple query variations for better coverage
    const queries = [query, query + ' fundo branco produto', query + ' autoparts photo'];
    for (const q of queries) {
        try {
            const encoded = encodeURIComponent(q);
            const r = await httpGet(
                `https://www.bing.com/images/search?q=${encoded}&form=HDRSC2&first=1&mmasync=1`,
                { 'Accept-Language': 'pt-BR,pt;q=0.9', 'User-Agent': 'Mozilla/5.0 (compatible; Genesis/5.0)', 'Referer': 'https://www.bing.com/' }
            );
            const matches = r.body.matchAll(/murl&quot;:&quot;(https?:\/\/[^&"]+\.(?:jpg|jpeg|png|webp))&quot;/gi);
            for (const m of matches) {
                if (imgUrls.length >= 10) break;
                const url = m[1].replace(/&amp;/g, '&');
                if (!imgUrls.includes(url)) imgUrls.push(url);
            }
            if (!imgUrls.length) {
                const matches2 = r.body.matchAll(/"murl":"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi);
                for (const m of matches2) {
                    if (imgUrls.length >= 10) break;
                    if (!imgUrls.includes(m[1])) imgUrls.push(m[1]);
                }
            }
            if (imgUrls.length >= 4) break; // enough from first query
        } catch (e) { /* continue */ }
    }
    return imgUrls;
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

    const oem = dna?.codigo_dna || p.ref;
    const marca = dna?.marca || dna?.fabricante || '';

    // Build rich search queries — include OEM code + part type
    const descTipo = p.descricao.split(' ').slice(0,4).join(' ');
    const searchQuery = `${oem} ${descTipo} autopeça aplicação veicular`.trim();
    const imgQuery = `"${oem}" ${descTipo} autopeça foto produto`;

    const [ddg, imgUrls] = await Promise.all([
        searchDuckDuckGo(searchQuery),
        searchBingImages(imgQuery)
    ]);

    // Additional search with just OEM code for better results
    const ddg2 = await searchDuckDuckGo(oem + ' autopeca especificacao tecnica');
    const contextoWeb = [ddg?.abstract, ddg2?.abstract].filter(Boolean).join(' | ') || 'sem resultado';

    const contexto = `Produto: ${p.descricao}
Referencia/OEM: ${oem}
Fabricante/Marca: ${marca || 'desconhecido'}
Contexto web encontrado: ${contextoWeb}`;

    const systemPrompt = `Voce e um especialista em autopecas automotivas brasileiro.
TAREFA: Analise o produto e retorne SOMENTE JSON valido (sem markdown, sem texto antes ou depois).

ESTRUTURA EXATA — nao altere os nomes dos campos:
{"dna":{"fabricante":null,"marca":null,"familia":null,"codigo_oem":null},"aplicacoes":[{"montadora":null,"modelo":null,"versao":null,"motor":null,"cilindrada":null,"combustivel":null,"ano_ini":null,"ano_fim":null}],"codigos_cambiados":[{"tipo":"OEM","codigo":null,"fabricante":null}],"logistica":{"peso_liq":null,"peso_bruto":null,"altura":null,"largura":null,"comprimento":null},"fiscal":{"ncm":null,"cest":null},"especificacoes":{"diametro":null,"estrias":null,"material":null,"componentes":null},"descricao_tecnica":null}

REGRAS ABSOLUTAS — VIOLACAO E ERRO CRITICO:
- TIPO DO PRODUTO: determinado EXCLUSIVAMENTE pela descricao fornecida. Se diz "embreagem" e embreagem. Se diz "correia" e correia. NUNCA reclassifique com base no contexto web.
- NUNCA invente fabricante, marca, montadora, modelo, motor, ano, NCM, peso, dimensao ou codigo equivalente
- NUNCA use nomes de fabricantes inventados como TRIMGO, AUTOFLEX, AUTOPARTS — null se desconhecido
- dna.fabricante: somente se explicitamente mencionado no contexto (ex: LUK, Bosch, INDYSA) — null se duvida
- dna.familia: baseada APENAS na descricao do produto — nunca reclassifique pelo contexto web
- Se contexto web contradiz o tipo do produto da descricao: IGNORE o contexto, retorne null
- NCM: apenas se compativel com o tipo do produto e com certeza absoluta (formato 0000.00.00)
- aplicacoes: somente veiculos CONFIRMADOS com montadora+modelo+ano — null se nao confirmado
- descricao_tecnica: descreva o produto com base APENAS no nome/ref — sem inventar componentes`;

    const userPrompt = `PRODUTO (tipo nao pode ser alterado): ${p.descricao}\n\nDados para extracao:\n\n${contexto}`;
    const claudeResult = await callClaude(systemPrompt, userPrompt, 1200);
    if (claudeResult.error) return res.json({ success: false, error: claudeResult.error });

    let parsed = null;
    try {
        let jsonText = (claudeResult.text || '').trim();
        // Remove markdown fences
        jsonText = jsonText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        // Extract first JSON object found (handles extra text before/after)
        const match = jsonText.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
    } catch (e) { parsed = null; }

    if (!parsed) return res.json({ success: false, error: 'Parse error', raw: claudeResult.text || claudeResult.error });

    const txResult = db.transaction(() => {
        // DNA — salvar fabricante, marca, familia, codigo_oem separados (nunca com espacos no OEM)
        const dnaPayload = parsed.dna || {};
        const existDna = db.prepare('SELECT id FROM dna WHERE produto_id=?').get(id);
        const dnaFab  = dnaPayload.fabricante || null;
        const dnaMrc  = dnaPayload.marca || marca || null;
        const dnaFam  = dnaPayload.familia || null;
        const dnaOem  = (dnaPayload.codigo_oem || oem || '').split(/\s+/)[0] || null;
        // Só persiste DNA se codigo_dna + pelo menos marca ou fabricante estiverem presentes
        if (dnaOem && (dnaMrc || dnaFab)) {
            if (existDna) {
                db.prepare("UPDATE dna SET fabricante=COALESCE(?,fabricante),marca=COALESCE(?,marca),familia=COALESCE(?,familia),codigo_dna=? WHERE produto_id=?")
                  .run(dnaFab, dnaMrc, dnaFam, dnaOem, id);
            } else {
                db.prepare("INSERT INTO dna (produto_id,fabricante,marca,familia,codigo_dna) VALUES (?,?,?,?,?)")
                  .run(id, dnaFab, dnaMrc, dnaFam, dnaOem);
            }
        }

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
        // IMAGENS WEB — salvar com status Pendente para revisao humana
        const slots = ['Principal','Lateral','Tecnica','Detalhe','Embalagem','Aplicada'];
        const existImgs = new Set(db.prepare('SELECT url FROM imagens WHERE produto_id=?').all(id).map(i => i.url));
        let si = 0;
        // Filtrar URLs claramente invalidas
        const validUrls = imgUrls.filter(url =>
            url && url.startsWith('http') &&
            !url.includes('logo') && !url.includes('favicon') &&
            !url.includes('banner') && !url.includes('avatar')
        );
        for (const url of validUrls.slice(0, 6)) {
            if (!existImgs.has(url)) {
                // Status Pendente — precisa aprovacao humana pois busca web pode trazer imagem errada
                db.prepare("INSERT INTO imagens (produto_id,tipo,url,origem,status) VALUES (?,?,?,?,?)").run(id, slots[si%slots.length], url, 'Web-Auto', 'Pendente');
                existImgs.add(url);
            }
            si++;
        }
        // RECALCULAR NTC
        const dnaU = db.prepare('SELECT * FROM dna WHERE produto_id=?').get(id);
        const fiscalU = db.prepare('SELECT * FROM dados_fiscais WHERE produto_id=?').get(id);
        const aplicU = db.prepare('SELECT * FROM aplicacoes_motor WHERE produto_id=?').all(id);
        const imgsU = db.prepare('SELECT * FROM imagens WHERE produto_id=?').all(id);
        const nctTF = dnaU?.codigo_dna ? 0.97 : (dnaU?.marca || dnaU?.fabricante ? 0.70 : dnaU?.familia ? 0.50 : 0.10);
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
// LIMPAR ENRIQUECIMENTO WEB — remove dados incorretos gravados por IA
// -----------------------------------------------------------
app.delete('/api/produtos/:id/enriquecimento-web', (req, res) => {
    const id = req.params.id;
    const p = db.prepare('SELECT id FROM produtos WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
    db.transaction(() => {
        db.prepare("DELETE FROM aplicacoes_motor WHERE produto_id=?").run(id);
        db.prepare("DELETE FROM codigos_cambiados WHERE produto_id=?").run(id);
        db.prepare("DELETE FROM imagens WHERE produto_id=?").run(id);
        db.prepare("DELETE FROM dna WHERE produto_id=?").run(id);
    })();
    res.json({ success: true, msg: 'DNA, aplicacoes e imagens removidos. Produto pronto para re-enriquecimento.' });
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
    const nctTF = dna?.codigo_dna ? 0.97 : (dna?.marca || dna?.fabricante ? 0.70 : dna?.familia ? 0.50 : 0.10);
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
async function callClaude(systemPrompt, userPrompt, maxTokens = 800) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { error: 'ANTHROPIC_API_KEY nao configurada. Adicione no painel de Configuracoes.' };
    return new Promise((resolve) => {
        const body = JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
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
        system: `Voce e um engenheiro redator especialista em autopecas OEM brasileiro.
REGRAS ABSOLUTAS:
- Use APENAS os dados fornecidos no prompt. NUNCA invente fabricante, marca, nome de empresa, grupo industrial, OEM, aplicacao ou especificacao tecnica.
- Se fabricante/marca for "?" ou ausente: escreva "fabricante nao identificado" — NUNCA substitua por nome inventado.
- Se nao houver aplicacoes: escreva "consultar catalogo" — NUNCA invente modelos de veiculos.
- Linha 1: codigo OEM real (se disponivel) + descricao do produto.
- Especifique material SAE/ABNT somente se informado nos dados.
- Inclua NTC score e status conforme fornecido.
- Tom de laudo tecnico, sem emojis. Maximo 8 linhas.`,
        user: (p, dna, aplic, ntc, fiscal) => `DADOS REAIS DO PRODUTO (use apenas estes — nao invente):
DESCRICAO: ${p.descricao}
OEM/REF: ${dna?.codigo_dna || p.ref || 'nao informado'}
FABRICANTE: ${dna?.fabricante || 'nao identificado'}
MARCA: ${dna?.marca || 'nao identificada'}
GRUPO INDUSTRIAL: ${dna?.grupo_industrial || 'nao informado'}
ORIGEM: ${dna?.origem_pais || 'nao informada'}
NCM: ${fiscal?.ncm || 'nao informado'}
NTC: score=${((ntc?.score||0)*100).toFixed(1)}% status=${ntc?.status||'REPROVADO'}
APLICACOES REAIS: ${aplic.length ? aplic.map(a=>`${a.montadora||''} ${a.modelo||''} ${a.motor||''} ${a.ano_ini||''}${a.ano_fim?'-'+a.ano_fim:''}`).join(' | ') : 'nao cadastradas'}

Gere descricao tecnica formato LAUDO usando SOMENTE os dados acima.`
    },
    seo: {
        system: `Voce e um especialista SEO para e-commerce de autopecas com foco em CPC alto.
REGRAS ABSOLUTAS:
- Use APENAS os dados fornecidos. NUNCA invente marca, fabricante, OEM, modelo de veiculo ou especificacao.
- Se marca for ausente: use o codigo OEM/ref como identificador. Nao crie nome de empresa.
- FORMATO OBRIGATORIO:
TITULO: [max 70 chars — ref+produto+modelo se disponivel]
META: [max 160 chars — ref+compatibilidade+CTA]
H1: [variacao do titulo]
SLUG: [kebab-case com ref real]
KEYWORDS: [8-12 termos long-tail com ref+modelo+ano — CPC alto]`,
        user: (p, dna, aplic, ntc, fiscal) => `DADOS REAIS (use apenas estes):
DESCRICAO: ${p.descricao}
REF/OEM: ${dna?.codigo_dna || p.ref || 'nao informado'}
MARCA: ${dna?.marca || 'nao identificada'}
NCM: ${fiscal?.ncm || 'nao informado'}
NTC: ${ntc?.status||'REPROVADO'} (${((ntc?.score||0)*100).toFixed(1)}%)
APLICACOES: ${aplic.length ? aplic.map(a=>`${a.montadora||''} ${a.modelo||''} ${a.ano_ini||''}${a.ano_fim?'-'+a.ano_fim:''}`).slice(0,5).join(', ') : 'nao cadastradas'}

Gere SEO completo com keywords de alto CPC usando SOMENTE estes dados.`
    },
    comercial: {
        system: `Voce e um copywriter de alta conversao para autopecas.
REGRAS ABSOLUTAS:
- Use APENAS os dados reais fornecidos. NUNCA invente certificacoes, grupos industriais ou nomes de empresa.
- Se marca/fabricante for ausente: mencione o codigo de referencia ou omita — NUNCA substitua por nome inventado.
- Estrutura: 1) Beneficio principal. 2) Qualidade com dados reais. 3) NTC como prova. 4) Compatibilidade real. 5) Garantia. Maximo 6 linhas.`,
        user: (p, dna, aplic, ntc, fiscal) => `DADOS REAIS (use apenas estes):
DESCRICAO: ${p.descricao}
OEM/REF: ${dna?.codigo_dna || p.ref || 'nao informado'}
FABRICANTE: ${dna?.fabricante || 'nao identificado'}
MARCA: ${dna?.marca || 'nao identificada'}
GRUPO: ${dna?.grupo_industrial || 'nao informado'}
NTC: ${ntc?.status||'REPROVADO'} score ${((ntc?.score||0)*100).toFixed(1)}%
APLICACOES: ${aplic.length ? aplic.map(a=>`${a.montadora||''} ${a.modelo||''}`).slice(0,4).join(', ') : 'consultar catalogo'}

Gere descricao comercial usando SOMENTE os dados acima.`
    },
    whatsapp: {
        system: `Voce e um vendedor expert de autopecas via WhatsApp.
REGRAS ABSOLUTAS:
- Use APENAS os dados fornecidos. NUNCA invente marca, fabricante ou compatibilidade.
- Se marca for ausente: use a referencia/OEM. Nao invente nome de empresa.
- Confirme OEM + compatibilidade real. Prazo realista. CTA claro. Max 2-3 emojis. 5 linhas.`,
        user: (p, dna, aplic, ntc, fiscal) => `DADOS REAIS:
DESCRICAO: ${p.descricao}
OEM/REF: ${dna?.codigo_dna || p.ref || 'nao informado'}
MARCA: ${dna?.marca || 'nao identificada'}
APLICACOES: ${aplic.length ? aplic.map(a=>`${a.montadora||''} ${a.modelo||''} ${a.ano_ini||''}${a.ano_fim?'-'+a.ano_fim:''}`).slice(0,3).join(', ') : 'consultar catalogo'}
NTC: ${ntc?.status||'REPROVADO'}

Gere mensagem WhatsApp com dados REAIS acima.`
    },
    pmax: {
        system: `Voce e um especialista Google Ads Performance Max para autopecas.
REGRAS ABSOLUTAS:
- Use APENAS os dados reais. NUNCA invente marca, fabricante ou aplicacao.
- Se marca ausente: use REF/OEM como identificador.
- FORMATO OBRIGATORIO:
H1: [max 30 chars]
H2: [max 30 chars]
H3: [max 30 chars]
D1: [max 90 chars — ref+compatibilidade real]
D2: [max 90 chars — beneficio+CTA]
CALLOUT: [max 25 chars]
SITELINK: [max 25 chars]`,
        user: (p, dna, aplic, ntc, fiscal) => `DADOS REAIS:
DESCRICAO: ${p.descricao}
REF/OEM: ${dna?.codigo_dna || p.ref || 'nao informado'}
MARCA: ${dna?.marca || 'nao identificada'}
NTC: ${ntc?.status||'REPROVADO'}
APLICACOES: ${aplic.length ? aplic.map(a=>`${a.montadora||''} ${a.modelo||''}`).slice(0,2).join(', ') : 'consultar catalogo'}

Gere assets P-Max com dados REAIS acima.`
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
    const nctTF = dna?.codigo_dna ? 0.97 : (dna?.marca || dna?.fabricante ? 0.70 : dna?.familia ? 0.50 : 0.10);
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
        site_id: '53fd407a-65d0-42ef-a64b-0f3e9755cbc0',
        site_nome: 'MOBIS AUTOPARTS',
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
                const nctTF = dnaU?.codigo_dna ? 0.97 : (dnaU?.marca || dnaU?.fabricante ? 0.70 : dnaU?.familia ? 0.50 : 0.10);
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
// START
// -----------------------------------------------------------
app.listen(PORT, () => {
    console.log('INDEXAAI CATALOG PRO v5.0 rodando na porta ' + PORT);
    console.log('Health: http://localhost:' + PORT + '/api/health');

    // Keep-alive: ping proprio servidor a cada 14 min para evitar cold start no Render
    let APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    if (!/^https?:\/\//i.test(APP_URL)) APP_URL = 'https://' + APP_URL;
    if (process.env.NODE_ENV === 'production') {
        setInterval(() => {
            try {
                const urlObj = new URL(APP_URL + '/api/health');
                const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
                mod.get(urlObj, (r) => {
                    console.log('[keep-alive] ping ' + r.statusCode);
                }).on('error', () => {});
            } catch (e) {
                console.error('[keep-alive] erro ao montar URL:', e.message);
            }
        }, 14 * 60 * 1000);
    }
});
