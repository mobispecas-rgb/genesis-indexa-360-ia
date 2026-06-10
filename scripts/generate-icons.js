#!/usr/bin/env node
// Gera os ícones PWA do iRollo 360 (gradiente laranja + raio, igual ao logo da sidebar)
// usando apenas módulos nativos do Node (zlib), sem dependências externas.
// Uso: node scripts/generate-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// Gradiente 135deg #ff4500 -> #ff6b00 (mesmo do .logo-icon da sidebar)
const COR_A = [0xff, 0x45, 0x00];
const COR_B = [0xff, 0x6b, 0x00];

// Polígono de um raio/relâmpago (estilo Material "flash_on"), normalizado em [0,1]
const RAIO = [
  [0.5417, 0.00],
  [0.1250, 0.5833],
  [0.4167, 0.5833],
  [0.2917, 1.00],
  [0.8333, 0.3333],
  [0.5000, 0.3333]
];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Gera os bytes RGBA de um ícone `size`x`size`.
// `escala` define o tamanho do raio em relação ao ícone (ícones "maskable"
// usam uma escala menor para respeitar a área segura do sistema).
function gerarPixels(size, escala) {
  const buf = Buffer.alloc(size * size * 4);
  const off = (1 - escala) / 2;
  const SS = 2; // supersampling 2x2 para suavizar as bordas do raio

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * (size - 1));
      const r = Math.round(COR_A[0] + (COR_B[0] - COR_A[0]) * t);
      const g = Math.round(COR_A[1] + (COR_B[1] - COR_A[1]) * t);
      const b = Math.round(COR_A[2] + (COR_B[2] - COR_A[2]) * t);

      let cobertura = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          const nx = (px - off) / escala;
          const ny = (py - off) / escala;
          if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 && pointInPolygon(nx, ny, RAIO)) cobertura++;
        }
      }
      const fracaoBranco = cobertura / (SS * SS);
      const idx = (y * size + x) * 4;
      buf[idx]     = Math.round(r + (255 - r) * fracaoBranco);
      buf[idx + 1] = Math.round(g + (255 - g) * fracaoBranco);
      buf[idx + 2] = Math.round(b + (255 - b) * fracaoBranco);
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

// ===== Encoder PNG mínimo (assinatura + IHDR + IDAT + IEND) =====
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Cada scanline precisa do byte de filtro (0 = sem filtro) na frente
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const srcStart = y * width * 4;
    const dstStart = y * (1 + width * 4);
    raw[dstStart] = 0;
    rgba.copy(raw, dstStart + 1, srcStart, srcStart + width * 4);
  }
  const idatData = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function gerarIcone(nome, size, escala) {
  const png = encodePNG(size, size, gerarPixels(size, escala));
  fs.writeFileSync(path.join(OUT_DIR, nome), png);
  console.log('Gerado', nome, '(' + size + 'x' + size + ')');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
gerarIcone('icon-192.png', 192, 0.62);
gerarIcone('icon-512.png', 512, 0.62);
gerarIcone('icon-180.png', 180, 0.62);
gerarIcone('icon-512-maskable.png', 512, 0.42);
