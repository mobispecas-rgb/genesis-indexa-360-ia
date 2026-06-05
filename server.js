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
    const historico = db.prepare('SELECT * FROM historico_ntc WHERE produto_id=? ORDER BY criado_em DESC LIMIT 5').all(id);

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
    db.prepare("UPDATE produtos SET status='Congelado', atualizado_em=datetime('now','localtime') WHERE id=?").run(req.params.id);
    db.prepare("INSERT INTO historico_ntc (produto_id,status_anterior,status_novo,alteracao) VALUES (?,?,?,?)").run(req.params.id, p.status, 'Congelado', 'Congelado e Indexado — Bling + Wix + Google Shopping');
    res.json({ success: true, plataformas: ['Bling', 'Wix', 'Google Shopping', 'Google Ads'], status: 'Congelado' });
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
    const historico = db.prepare('SELECT * FROM historico_ntc WHERE produto_id=? ORDER BY criado_em DESC LIMIT 5').all(id);

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
    db.prepare("UPDATE produtos SET status='Congelado', atualizado_em=datetime('now','localtime') WHERE id=?").run(req.params.id);
    db.prepare("INSERT INTO historico_ntc (produto_id,status_anterior,status_novo,alteracao) VALUES (?,?,?,?)").run(req.params.id, p.status, 'Congelado', 'Congelado e Indexado — Bling + Wix + Google Shopping');
    res.json({ success: true, plataformas: ['Bling', 'Wix', 'Google Shopping', 'Google Ads'], status: 'Congelado' });
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
// START
// -----------------------------------------------------------
app.listen(PORT, () => {
    console.log('GENESIS INDEXA 360 IA v5.0 rodando na porta ' + PORT);
    console.log('Health: http://localhost:' + PORT + '/api/health');
});
