'use strict';

function removerRuidoFFF(c) {
  if (c.endsWith('00FFF')) {
    return c.slice(0, -5) + '0';
  }
  if (c.endsWith('0FFF')) {
    return c.slice(0, -4) + '0';
  }
  return c.replace(/FFF$/i, '');
}

function normalizarOEM(codigo) {
  if (!codigo || !codigo.trim()) {
    return { original: codigo || '', normalizado: null, variantes: [] };
  }

  const original = codigo.trim();
  let c = original.toUpperCase().replace(/\s+/g, '');

  // Remove ruído FFF antes de qualquer outra normalização
  c = removerRuidoFFF(c);

  // Remove traços para trabalhar com o código limpo
  const semTraco = c.replace(/-/g, '');

  // Detecta padrão XXXXX-XXXXXNNN (Hyundai/Kia: 5+5 chars)
  // Ex: 35310-04TF0, 90410-80001
  const matchHK = semTraco.match(/^(\d{5})(\w{5})$/);
  if (matchHK) {
    const normalizado = matchHK[1] + '-' + matchHK[2];
    const variantes = [normalizado, semTraco];

    // Cruzamento Hyundai ↔ Kia (9041080001 ↔ 3531004TF0)
    const cruzamentos = {
      '9041080001': ['35310-04TF0', '3531004TF0'],
      '3531004TF0': ['90410-80001', '9041080001'],
    };
    if (cruzamentos[semTraco]) {
      variantes.push(...cruzamentos[semTraco]);
    }

    return { original, normalizado, variantes: [...new Set(variantes)] };
  }

  // Padrão genérico: mantém como está mas adiciona variante sem traço
  const normalizado = c.includes('-') ? c : c;
  const variantes = [normalizado];
  if (normalizado.includes('-')) {
    variantes.push(normalizado.replace(/-/g, ''));
  }

  return { original, normalizado, variantes: [...new Set(variantes)] };
}

module.exports = { normalizarOEM, removerRuidoFFF };
