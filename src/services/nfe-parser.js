'use strict';

// Parser simples (regex) de XML de NF-e (nota fiscal eletrônica de entrada).
// Extrai o fornecedor (emitente) e os itens da nota — usado para preservar a
// rastreabilidade do fornecedor no cadastro de produtos (módulo LG do NTC).
// NUNCA inventa: campos ausentes no XML retornam null.

function extrairTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}

function parseNFeXML(xml) {
  const idMatch = xml.match(/<infNFe[^>]*Id="([^"]*)"/);
  const chave = idMatch ? idMatch[1].replace(/^NFe/, '') : null;

  const emitMatch = xml.match(/<emit>([\s\S]*?)<\/emit>/);
  const emitXml = emitMatch ? emitMatch[1] : '';
  const fornecedor = {
    nome: extrairTag(emitXml, 'xNome'),
    cnpj: extrairTag(emitXml, 'CNPJ') || extrairTag(emitXml, 'CPF'),
  };

  const itens = [];
  const detRegex = /<det[^>]*>([\s\S]*?)<\/det>/g;
  let m;
  while ((m = detRegex.exec(xml))) {
    const prodMatch = m[1].match(/<prod>([\s\S]*?)<\/prod>/);
    if (!prodMatch) continue;
    const p = prodMatch[1];
    const ean = extrairTag(p, 'cEAN');
    itens.push({
      codigo: extrairTag(p, 'cProd'),
      ean: (ean && /^\d+$/.test(ean)) ? ean : null,
      nome: extrairTag(p, 'xProd'),
      ncm: extrairTag(p, 'NCM'),
      cest: extrairTag(p, 'CEST'),
      unidade: extrairTag(p, 'uCom'),
      quantidade: parseFloat(extrairTag(p, 'qCom')) || null,
      valor_unitario: parseFloat(extrairTag(p, 'vUnCom')) || null,
      valor_total: parseFloat(extrairTag(p, 'vProd')) || null,
    });
  }

  return { chave, fornecedor, itens };
}

module.exports = { parseNFeXML };
