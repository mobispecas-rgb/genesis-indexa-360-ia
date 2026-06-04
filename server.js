// ============================================================
// GENESIS INDEXA 360 IA v4.0 — SERVIDOR PRINCIPAL
// Node.js + Express + SQLite | MOBIS Pecas Automotivas
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// -----------------------------------------------------------
// BANCO DE DADOS SQLite
// -----------------------------------------------------------
const dbPath = path.join(__dirname, 'data', 'genesis.db');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    descricao TEXT NOT NULL,
    marca TEXT,
    categoria TEXT,
    aplicacao TEXT,
    preco REAL DEFAULT 0,
    estoque INTEGER DEFAULT 0,
    observacoes TEXT,
    imagem TEXT,
    status TEXT DEFAULT 'Ativo',
    criado_em TEXT DEFAULT (datetime('now','localtime')),
    atualizado_em TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    senha TEXT NOT NULL,
    role TEXT DEFAULT 'operador',
    criado_em TEXT DEFAULT (datetime('now','localtime'))
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

// Inserir dados iniciais se vazio
const count = db.prepare('SELECT COUNT(*) as c FROM produtos').get();
if (count.c === 0) {
    const insert = db.prepare(`
        INSERT INTO produtos (ref, descricao, marca, categoria, aplicacao, preco, estoque)
        VALUES (?,?,?,?,?,?,?)
    `);
    const dados = [
        ['MOB-001','Pastilha de Freio Dianteira','MOBIS','Freios','Honda Civic 2018-2022',89.90,45],
        ['MOB-002','Filtro de Oleo Motor','MOBIS','Filtros','Universal',32.50,120],
        ['MOB-003','Correia Dentada Kit','MOBIS','Motor','Toyota Corolla 2016-2020',198.00,18],
        ['MOB-004','Amortecedor Traseiro','MOBIS','Suspensao','Hyundai HB20 2019-2023',320.00,8],
        ['MOB-005','Vela de Ignicao NGK','NGK','Ignicao','Universal',28.00,200],
    ];
    dados.forEach(d => insert.run(...d));
}

// Admin padrão
const adminExiste = db.prepare("SELECT id FROM usuarios WHERE email=?").get('admin@mobis.com');
if (!adminExiste) {
    db.prepare("INSERT INTO usuarios (nome,email,senha,role) VALUES (?,?,?,?)")
      .run('Administrador','admin@mobis.com','admin123','admin');
}

// -----------------------------------------------------------
// UPLOAD DE ARQUIVOS
// -----------------------------------------------------------
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Apenas imagens sao permitidas'));
    }
});

// -----------------------------------------------------------
// MIDDLEWARES
// -----------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// -----------------------------------------------------------
// ROTAS — SAUDE
// -----------------------------------------------------------
app.get('/api/health', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as c FROM produtos').get().c;
    res.json({
        ok: true,
        status: 'online',
        sistema: 'Genesis Indexa 360 IA v4.0',
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        total_produtos: total
    });
});

app.get('/api/status', (req, res) => {
    res.json({ ok: true, versao: '4.0.0', sistema: 'Genesis Indexa 360 IA', empresa: 'MOBIS Pecas Automotivas' });
});

// -----------------------------------------------------------
// ROTAS — AUTENTICACAO
// -----------------------------------------------------------
app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ ok: false, erro: 'Email e senha obrigatorios' });
    const user = db.prepare('SELECT id,nome,email,role FROM usuarios WHERE email=? AND senha=?').get(email, senha);
    if (!user) return res.status(401).json({ ok: false, erro: 'Credenciais invalidas' });
    res.json({ ok: true, usuario: user });
});

// -----------------------------------------------------------
// ROTAS — PRODUTOS (CRUD)
// -----------------------------------------------------------
app.get('/api/produtos', (req, res) => {
    const { q, categoria, status, page = 1, limit = 50 } = req.query;
    let sql = 'SELECT * FROM produtos WHERE 1=1';
    const params = [];
    if (q) {
        sql += ' AND (ref LIKE ? OR descricao LIKE ? OR marca LIKE ? OR aplicacao LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like, like);
    }
    if (categoria) { sql += ' AND categoria=?'; params.push(categoria); }
    if (status) { sql += ' AND status=?'; params.push(status); }
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), (Number(page) - 1) * Number(limit));

    const produtos = db.prepare(sql).all(...params);
    const total = db.prepare('SELECT COUNT(*) as c FROM produtos').get().c;
    res.json({ ok: true, produtos, total, page: Number(page) });
});

app.get('/api/produtos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, erro: 'Produto nao encontrado' });
    res.json({ ok: true, produto: p });
});

app.post('/api/produtos', upload.single('imagem'), (req, res) => {
    const { ref, descricao, marca, categoria, aplicacao, preco, estoque, observacoes } = req.body;
    if (!ref || !descricao) return res.status(400).json({ ok: false, erro: 'Referencia e Descricao sao obrigatorios' });

    const existe = db.prepare('SELECT id FROM produtos WHERE ref=?').get(ref);
    if (existe) return res.status(409).json({ ok: false, erro: 'Referencia ja existe' });

    const imagem = req.file ? `/uploads/${req.file.filename}` : null;
    const stmt = db.prepare(`
        INSERT INTO produtos (ref,descricao,marca,categoria,aplicacao,preco,estoque,observacoes,imagem)
        VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const result = stmt.run(ref, descricao, marca||null, categoria||null, aplicacao||null,
        parseFloat(preco)||0, parseInt(estoque)||0, observacoes||null, imagem);

    // Log IA
    db.prepare("INSERT INTO logs_ia (produto_ref,acao,resultado,confianca) VALUES (?,?,?,?)")
      .run(ref, 'cadastro', 'indexado', 1.0);

    res.json({ ok: true, id: result.lastInsertRowid, mensagem: 'Produto cadastrado com sucesso' });
});

app.put('/api/produtos/:id', upload.single('imagem'), (req, res) => {
    const { descricao, marca, categoria, aplicacao, preco, estoque, observacoes, status } = req.body;
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, erro: 'Produto nao encontrado' });

    const imagem = req.file ? `/uploads/${req.file.filename}` : p.imagem;
    db.prepare(`
        UPDATE produtos SET descricao=?,marca=?,categoria=?,aplicacao=?,preco=?,estoque=?,
        observacoes=?,status=?,imagem=?,atualizado_em=datetime('now','localtime') WHERE id=?
    `).run(descricao||p.descricao, marca||p.marca, categoria||p.categoria, aplicacao||p.aplicacao,
        parseFloat(preco)||p.preco, parseInt(estoque)||p.estoque, observacoes||p.observacoes,
        status||p.status, imagem, req.params.id);

    res.json({ ok: true, mensagem: 'Produto atualizado' });
});

app.delete('/api/produtos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ ok: false, erro: 'Produto nao encontrado' });
    db.prepare('DELETE FROM produtos WHERE id=?').run(req.params.id);
    res.json({ ok: true, mensagem: 'Produto removido' });
});

// -----------------------------------------------------------
// ROTAS — IA DE INDEXACAO
// -----------------------------------------------------------
app.post('/api/ia/indexar', (req, res) => {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ ok: false, erro: 'Texto obrigatorio' });

    // Motor de indexacao por palavras-chave
    const categorias = {
        'Freios': ['freio','pastilha','disco','abs','trava'],
        'Filtros': ['filtro','oleo','ar','combustivel','cabine'],
        'Motor': ['correia','virabrequim','cabecote','pistao','valvula','motor','vela'],
        'Suspensao': ['amortecedor','mola','barra','buchas','suspensao','rolamento'],
        'Ignicao': ['vela','bobina','ignicao','faiscamento','platinado'],
        'Eletrica': ['alternador','bateria','fusivel','rele','sensor','modulo','eletrica'],
        'Transmissao': ['cambio','embreagem','diferencial','semi-eixo','transmissao','plato','embreagem','clutch','kit embreagem'],
    };

    const t = texto.toLowerCase();
    let melhorCat = 'Outros';
    let melhorScore = 0;
    for (const [cat, palavras] of Object.entries(categorias)) {
        const score = palavras.filter(p => t.includes(p)).length;
        if (score > melhorScore) { melhorScore = score; melhorCat = cat; }
    }

    // Extrair marca
    const marcas = ['mobis','bosch','ngk','mahle','valeo','denso','monroe','sachs','mann','luk','exedy','ate','ferodo','brembo','textar','bendix','monroe','cofap','nakata'];
    let marcaDetectada = 'MOBIS';
    for (const m of marcas) {
        if (t.includes(m)) { marcaDetectada = m.toUpperCase(); break; }
    }

    // Sugerir referencia
    const prefix = melhorCat.substring(0,3).toUpperCase();
    const total = db.prepare('SELECT COUNT(*) as c FROM produtos').get().c;
    const refSugerida = `${prefix}-${String(total + 1).padStart(3,'0')}`;

    const confianca = Math.min(0.6 + melhorScore * 0.1, 0.99);

    db.prepare("INSERT INTO logs_ia (produto_ref,acao,resultado,confianca) VALUES (?,?,?,?)")
      .run(refSugerida, 'indexacao', melhorCat, confianca);

    res.json({
        ok: true,
        sugestao: {
            ref: refSugerida,
            categoria: melhorCat,
            marca: marcaDetectada,
            confianca: Math.round(confianca * 100),
        },
        logs: db.prepare('SELECT * FROM logs_ia ORDER BY id DESC LIMIT 10').all()
    });
});

app.get('/api/ia/logs', (req, res) => {
    const logs = db.prepare('SELECT * FROM logs_ia ORDER BY id DESC LIMIT 50').all();
    res.json({ ok: true, logs });
});

// -----------------------------------------------------------
// NTC 4.0 — BASE DE CONHECIMENTO
// -----------------------------------------------------------
const GRUPOS = {
  'luk': { grupo: 'Schaeffler', origem: 'Alemanha' },
  'ina': { grupo: 'Schaeffler', origem: 'Alemanha' },
  'fag': { grupo: 'Schaeffler', origem: 'Alemanha' },
  'bosch': { grupo: 'Robert Bosch GmbH', origem: 'Alemanha' },
  'ngk': { grupo: 'NGK Spark Plug Co.', origem: 'Japao' },
  'denso': { grupo: 'DENSO Corporation', origem: 'Japao' },
  'valeo': { grupo: 'Valeo SA', origem: 'Franca' },
  'sachs': { grupo: 'ZF Friedrichshafen', origem: 'Alemanha' },
  'zf': { grupo: 'ZF Friedrichshafen', origem: 'Alemanha' },
  'monroe': { grupo: 'Tenneco', origem: 'EUA' },
  'cofap': { grupo: 'Tenneco', origem: 'Brasil' },
  'mahle': { grupo: 'MAHLE GmbH', origem: 'Alemanha' },
  'mann': { grupo: 'MANN+HUMMEL', origem: 'Alemanha' },
  'ate': { grupo: 'Continental AG', origem: 'Alemanha' },
  'continental': { grupo: 'Continental AG', origem: 'Alemanha' },
  'brembo': { grupo: 'Brembo SpA', origem: 'Italia' },
  'textar': { grupo: 'TMD Friction', origem: 'Alemanha' },
  'ferodo': { grupo: 'TMD Friction', origem: 'Reino Unido' },
  'exedy': { grupo: 'Exedy Corporation', origem: 'Japao' },
  'ntn': { grupo: 'NTN Corporation', origem: 'Japao' },
  'skf': { grupo: 'SKF AB', origem: 'Suecia' },
  'nsk': { grupo: 'NSK Ltd', origem: 'Japao' },
  'nakata': { grupo: 'Nakata', origem: 'Brasil' },
  'mobis': { grupo: 'Hyundai Mobis', origem: 'Coreia' },
  'bendix': { grupo: 'Bendix Commercial Vehicle Systems', origem: 'EUA' },
};

const TIER1_BRANDS = new Set(['luk','ina','fag','bosch','denso','valeo','sachs','zf','mahle','mann','ate','continental','brembo','exedy','skf','ntn','nsk']);
const KNOWN_BRANDS = new Set(Object.keys(GRUPOS));

function canonicalizeBrand(key) {
    const map = { luk:'LuK', ngk:'NGK', ntn:'NTN', skf:'SKF', nsk:'NSK', zf:'ZF', ate:'ATE', ina:'INA', fag:'FAG', zf:'ZF' };
    return map[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

function analisarNTC(texto) {
    const t = texto.toLowerCase();

    // --- Detectar fabricante ---
    let fabricanteKey = null;
    for (const key of Object.keys(GRUPOS)) {
        if (t.includes(key)) { fabricanteKey = key; break; }
    }
    const grupoInfo = fabricanteKey ? GRUPOS[fabricanteKey] : null;
    const fabricanteDisplay = fabricanteKey ? canonicalizeBrand(fabricanteKey) : null;

    // --- Detectar codigo (7-12 digitos) ---
    const codigoMatch = texto.match(/\b(\d{7,12})\b/);
    const codigo = codigoMatch ? codigoMatch[1] : null;

    // --- Detectar dimensoes ---
    const diamMatch = t.match(/(\d{2,4})\s*mm/);
    const diametro = diamMatch ? diamMatch[1] + 'mm' : null;
    const estriasMatch = t.match(/(\d{1,3})\s*estrias/i);
    const estrias = estriasMatch ? parseInt(estriasMatch[1]) : null;

    // --- Detectar componentes ---
    const compMap = [
        { nome: 'Disco', termos: ['disco'] },
        { nome: 'Plato', termos: ['plato', 'platô'] },
        { nome: 'Rolamento', termos: ['rolamento'] },
        { nome: 'Pastilha', termos: ['pastilha'] },
        { nome: 'Mola', termos: ['mola'] },
        { nome: 'Sensor', termos: ['sensor'] },
        { nome: 'Anel', termos: ['anel'] },
        { nome: 'Cubo', termos: ['cubo'] },
    ];
    const componentes = compMap.filter(c => c.termos.some(term => t.includes(term))).map(c => c.nome);

    // --- Detectar sistema ---
    let sistema = null;
    if (t.includes('monodisco')) sistema = 'Monodisco seco';
    else if (t.includes('hidraul')) sistema = 'Hidraulico';
    else if (t.includes('a cabo') || t.includes('por cabo')) sistema = 'A cabo';
    else if (t.includes('embreagem') || t.includes('clutch')) sistema = 'Monodisco seco';

    // --- Detectar aplicacoes (veiculos) ---
    const veicPatterns = [
        /\b(honda|toyota|ford|chevrolet|gm|volkswagen|vw|fiat|peugeot|renault|hyundai|kia|nissan|mitsubishi|suzuki|bmw|mercedes|audi)\b/gi,
        /\b(civic|corolla|hb20|celta|gol|uno|palio|fiesta|focus|ka|onix|prisma|sandero|logan|tucson|ix35)\b/gi,
    ];
    const veicText = new Set();
    for (const pat of veicPatterns) {
        const matches = texto.match(pat);
        if (matches) matches.forEach(m => veicText.add(m.trim()));
    }
    const veiculos = [...veicText];

    // --- Detectar NCM/EAN (NUNCA inventar) ---
    const ncmMatch = t.match(/\bncm[:\s]*(\d{8})\b/i);
    const eanMatch = t.match(/\bean[:\s]*(\d{13})\b/i);
    const ncm = ncmMatch ? ncmMatch[1] : null;
    const ean = eanMatch ? eanMatch[1] : null;

    // --- Detectar peso/dimensoes logistica ---
    const pesoMatch = t.match(/(\d+[.,]?\d*)\s*(kg|g)\b/i);
    const peso = pesoMatch ? pesoMatch[0] : null;

    // --- Calcular scores por modulo ---
    const fabricanteFound = !!fabricanteKey;
    const grupoKnown = !!grupoInfo;
    const codigoFound = !!codigo;
    const isTier1 = fabricanteKey && TIER1_BRANDS.has(fabricanteKey);
    const isKnown = fabricanteKey && KNOWN_BRANDS.has(fabricanteKey);

    const scores = {
        DNA: Math.min((fabricanteFound ? 0.4 : 0) + (grupoKnown ? 0.3 : 0) + (codigoFound ? 0.2 : 0) + (codigoFound && fabricanteFound ? 0.1 : 0), 1.0),
        TF: Math.min((diametro ? 0.3 : 0) + (estrias ? 0.2 : 0) + (componentes.length > 0 ? Math.min(componentes.length * 0.15, 0.35) : 0) + (sistema ? 0.15 : 0), 1.0),
        FM: isTier1 ? 1.0 : isKnown ? 0.8 : fabricanteFound ? 0.6 : 0.4,
        CO: codigoFound ? 1.0 : 0.0,
        AV: veiculos.length === 0 ? 0.0 : Math.min(0.2 + veiculos.length * 0.15, 1.0),
        MC: grupoKnown ? 1.0 : isKnown ? 0.7 : 0.5,
        EC: componentes.length === 0 ? 0.0 : Math.min(componentes.length * 0.25, 1.0),
        BTA: (fabricanteFound && (codigoFound || diametro || componentes.length > 0)) ? 1.0 : fabricanteFound ? 0.6 : 0.3,
        CC: codigoFound ? 0.8 : 0.3,
        LG: peso ? 0.5 : 0.0,
        FI: (ncm || ean) ? 0.8 : 0.0,
        FP: (fabricanteFound || codigoFound) ? 0.7 : 0.3,
    };

    // Pesos NTC 4.0
    const pesos = { DNA:0.25, TF:0.15, FM:0.10, CO:0.10, AV:0.10, MC:0.05, EC:0.05, BTA:0.05, CC:0.05, LG:0.05, FI:0.03, FP:0.02 };

    let ntcTotal = 0;
    for (const [mod, s] of Object.entries(scores)) {
        ntcTotal += s * pesos[mod];
    }
    ntcTotal = Math.round(ntcTotal * 100) / 100;

    const status = ntcTotal >= 0.90 ? 'APROVADO' : ntcTotal >= 0.75 ? 'CONDICIONAL' : 'REPROVADO';

    // --- Cadeia de suprimentos ---
    const cadeia = fabricanteKey
        ? [fabricanteDisplay, 'Distribuidores', 'Importadores', 'Lojistas']
        : ['Fabricante Desconhecido', 'Distribuidores', 'Lojistas'];

    // --- PDV ---
    const cabParts = ['KIT DE EMBREAGEM'];
    if (diametro) cabParts.push(diametro.toUpperCase());
    if (componentes.length) cabParts.push(componentes.map(c => c.toUpperCase()).join(' '));
    if (fabricanteDisplay) cabParts.push(fabricanteDisplay.toUpperCase());
    if (codigo) cabParts.push(codigo);
    const cabBling = cabParts.join(' ');

    const frenteParts = [];
    frenteParts.push(fabricanteDisplay ? `KIT EMBREAGEM ${fabricanteDisplay.toUpperCase()}` : 'KIT EMBREAGEM');
    if (diametro) frenteParts.push(diametro.toUpperCase());
    if (codigo) frenteParts.push(codigo);
    if (componentes.length) frenteParts.push(componentes.join(' + ').toUpperCase());
    const frenteCaixa = frenteParts.join('\n');

    const tagsSeo = [
        codigo,
        fabricanteKey,
        fabricanteKey ? `kit embreagem ${fabricanteKey}` : null,
        grupoInfo ? grupoInfo.grupo.toLowerCase().split(' ')[0] : null,
    ].filter(Boolean);

    // --- RAST-HASH ---
    const rastParts = [];
    if (fabricanteKey) rastParts.push(`DNA:${fabricanteKey.toUpperCase()}`);
    if (codigo) rastParts.push(`CODIGO:${codigo}`);
    if (componentes.length) rastParts.push(`TIPO:KIT_${componentes[0].toUpperCase()}`);
    const rastHash = rastParts.length ? rastParts.join('|') : 'INDEFINIDO';

    // --- O que falta ---
    const faltando = [];
    if (!peso) faltando.push('Peso oficial de fabrica');
    if (!ean) faltando.push('EAN validado');
    if (!ncm) faltando.push('NCM fiscal');
    if (veiculos.length === 0) faltando.push('Aplicacoes completas');
    if (!estrias) faltando.push('Numero de estrias');
    if (!diametro) faltando.push('Diametro do disco');

    return {
        dna: {
            fabricante: fabricanteDisplay,
            grupo: grupoInfo ? grupoInfo.grupo : null,
            codigo,
            origem: grupoInfo ? grupoInfo.origem : null,
            status: codigoFound && fabricanteFound ? 'Certificado' : fabricanteFound ? 'Identificado' : 'Nao identificado',
        },
        engenharia: { componentes, diametro, estrias, sistema },
        aplicacoes: veiculos,
        cadeia,
        pdv: { cabecalho_bling: cabBling, frente_caixa: frenteCaixa, tags_seo: tagsSeo },
        rast_hash: rastHash,
        scores: Object.fromEntries(Object.entries(scores).map(([k,v]) => [k, Math.round(v * 100) / 100])),
        ntc: ntcTotal,
        status,
        faltando,
        _pesos: pesos,
    };
}

// -----------------------------------------------------------
// ROTA NTC 4.0
// -----------------------------------------------------------
app.post('/api/ia/ntc', (req, res) => {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ ok: false, erro: 'texto obrigatorio' });
    try {
        const ntc = analisarNTC(texto);
        db.prepare("INSERT INTO logs_ia (produto_ref,acao,resultado,confianca) VALUES (?,?,?,?)")
          .run(ntc.dna.codigo || 'NTC', 'ntc4.0', ntc.status, ntc.ntc);
        res.json({ ok: true, ntc });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// -----------------------------------------------------------
// ROTAS — RELATORIOS
// -----------------------------------------------------------
app.get('/api/relatorios/resumo', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as c FROM produtos').get().c;
    const ativos = db.prepare("SELECT COUNT(*) as c FROM produtos WHERE status='Ativo'").get().c;
    const semEstoque = db.prepare('SELECT COUNT(*) as c FROM produtos WHERE estoque=0').get().c;
    const valorTotal = db.prepare('SELECT SUM(preco*estoque) as v FROM produtos').get().v || 0;
    const porCategoria = db.prepare('SELECT categoria, COUNT(*) as total FROM produtos GROUP BY categoria ORDER BY total DESC').all();
    const porMarca = db.prepare('SELECT marca, COUNT(*) as total FROM produtos GROUP BY marca ORDER BY total DESC LIMIT 5').all();
    const maisEstoque = db.prepare('SELECT ref, descricao, estoque FROM produtos ORDER BY estoque DESC LIMIT 5').all();
    const semEstoqueList = db.prepare('SELECT ref, descricao, categoria FROM produtos WHERE estoque=0 LIMIT 10').all();

    res.json({
        ok: true,
        resumo: { total, ativos, semEstoque, valorTotal: valorTotal.toFixed(2) },
        porCategoria,
        porMarca,
        maisEstoque,
        semEstoqueList
    });
});

// -----------------------------------------------------------
// ROTA RAIZ
// -----------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, erro: 'Rota nao encontrada' });
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
