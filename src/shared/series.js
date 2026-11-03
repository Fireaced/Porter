'use strict';
// Deduce la serie a partir del nombre de un tomo: «One Piece - Tomo 03 (2020) [Grupo]» -> «One Piece».
// Se usa en el PC (archivos sueltos sin subcarpeta) y en Android, con el mismo resultado en los dos.

const KW = '(?:vol(?:umen|ume)?|tomo|t|v|n[ºo°.]?|no|num(?:ero|ber)?|#|cap(?:[ií]tulo)?|ch(?:apter)?|book|libro|parte?|part|issue|ep(?:isodio)?)';
const RX = [
  // «Serie - Tomo 01 …», «Serie Vol. 2», «Serie v03», «Serie #4», «Serie 05 - subtítulo»
  new RegExp(`^(.+?)[\\s\\-–—,:#]+(?:${KW}\\.?\\s*)?\\d{1,4}(?:[.,]\\d+)?(?:\\s*(?:de|of|/)\\s*\\d+)?(?:\\b.*)?$`, 'i'),
  // «Serievol01», «SerieT03»
  new RegExp(`^(.+?[^\\d\\s])${KW}\\.?\\d{1,4}\\b.*$`, 'i'),
  // «Serie01»
  /^(.*?[^\d\s])\d{1,4}$/,
];

function cleanName(title) {
  return String(title || '')
    .replace(/\.(cbz|cbr|zip|rar|pdf)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/(\S)\.(?=\S)/g, (m, a) => (/\d/.test(a) ? m : a + ' '))   // «One.Piece.v01» -> «One Piece v01»
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')                       // [Grupo] (2020) {digital}
    .replace(/\s+/g, ' ')
    .trim();
}

function guessSeries(title) {
  const t = cleanName(title);
  for (const rx of RX) {
    const m = rx.exec(t);
    const s = m && m[1].replace(/[\s\-–—,:#.]+$/, '').trim();
    if (s && s.length >= 2 && /\D/.test(s)) return s;
  }
  return t || String(title || '').trim();
}

module.exports = { guessSeries, cleanName };
