// ============================================================
// Google Drive — Memória de Catálogos e Exportação de Produtos
// Usa Service Account (GOOGLE_SERVICE_ACCOUNT_JSON) ou API Key pública.
// Funciona como camada de armazenamento de catálogos OEM, CSVs exportados
// e imagens selecionadas — serve de ponte para enriquecimento contínuo.
// ============================================================
let _driveClient = null;

function getDriveClient() {
    if (_driveClient) return _driveClient;
    const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!json) return null;
    try {
        const { google } = require('googleapis');
        const credentials = typeof json === 'string' ? JSON.parse(json) : json;
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: [
                'https://www.googleapis.com/auth/drive',
                'https://www.googleapis.com/auth/drive.file'
            ]
        });
        _driveClient = google.drive({ version: 'v3', auth });
        return _driveClient;
    } catch (e) {
        console.error('[Drive] Erro ao inicializar cliente:', e.message);
        return null;
    }
}

function isConfigured() {
    return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

// Upload de conteúdo (Buffer ou string) para uma pasta do Drive
// Retorna { ok, fileId, webViewLink, nome }
async function uploadArquivo({ nome, conteudo, mimeType = 'text/csv', folderId = null }) {
    const drive = getDriveClient();
    if (!drive) throw new Error('Google Drive não configurado. Adicione GOOGLE_SERVICE_ACCOUNT_JSON nas variáveis de ambiente do Render.');

    const { Readable } = require('stream');
    const body = conteudo instanceof Buffer ? Readable.from(conteudo) : Readable.from([conteudo]);

    const meta = { name: nome };
    if (folderId) meta.parents = [folderId];

    // Verificar se já existe arquivo com o mesmo nome na pasta → substituir
    const existente = await buscarArquivoPorNome(nome, folderId);
    if (existente) {
        const r = await drive.files.update({
            fileId: existente.id,
            media: { mimeType, body },
            fields: 'id,webViewLink,name'
        });
        return { ok: true, fileId: r.data.id, webViewLink: r.data.webViewLink, nome: r.data.name, atualizado: true };
    }

    const r = await drive.files.create({
        requestBody: meta,
        media: { mimeType, body },
        fields: 'id,webViewLink,name'
    });

    // Tornar o arquivo publicamente visível para leitura (importData do Google Sheets)
    await drive.permissions.create({
        fileId: r.data.id,
        requestBody: { role: 'reader', type: 'anyone' }
    });

    return { ok: true, fileId: r.data.id, webViewLink: r.data.webViewLink, nome: r.data.name, atualizado: false };
}

// Busca arquivo por nome exato numa pasta
async function buscarArquivoPorNome(nome, folderId) {
    const drive = getDriveClient();
    if (!drive) return null;
    try {
        let q = `name = '${nome.replace(/'/g, "\\'")}' and trashed = false`;
        if (folderId) q += ` and '${folderId}' in parents`;
        const r = await drive.files.list({ q, fields: 'files(id,name,webViewLink)', pageSize: 1 });
        return (r.data.files || [])[0] || null;
    } catch (_) { return null; }
}

// Lista arquivos CSV/PDF numa pasta do Drive
async function listarArquivos(folderId) {
    const drive = getDriveClient();
    if (!drive) throw new Error('Google Drive não configurado.');
    const q = folderId
        ? `'${folderId}' in parents and trashed = false and (mimeType = 'text/csv' or mimeType = 'application/pdf' or mimeType = 'text/plain')`
        : `trashed = false and (mimeType = 'text/csv' or mimeType = 'application/pdf')`;
    const r = await drive.files.list({
        q,
        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 50
    });
    return r.data.files || [];
}

// Lê conteúdo de um arquivo do Drive (retorna Buffer)
async function lerArquivo(fileId) {
    const drive = getDriveClient();
    if (!drive) throw new Error('Google Drive não configurado.');
    const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data);
}

// Download URL pública para IMPORTDATA do Google Sheets
function urlImportData(fileId) {
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Cria pasta no Drive se não existir, retorna folderId
async function criarPastaSeNecessario(nome, parentId = null) {
    const drive = getDriveClient();
    if (!drive) throw new Error('Google Drive não configurado.');
    let q = `name = '${nome}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const existente = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 });
    if ((existente.data.files || []).length) return existente.data.files[0].id;
    const r = await drive.files.create({
        requestBody: {
            name: nome,
            mimeType: 'application/vnd.google-apps.folder',
            ...(parentId ? { parents: [parentId] } : {})
        },
        fields: 'id'
    });
    return r.data.id;
}

module.exports = { isConfigured, uploadArquivo, listarArquivos, lerArquivo, urlImportData, criarPastaSeNecessario, buscarArquivoPorNome };
