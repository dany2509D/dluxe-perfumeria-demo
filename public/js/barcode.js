// Códigos de barras para las etiquetas del mostrador: EAN-13 (el que traen los perfumes) y Code 128 (para los SKU).
// Funciones puras, sin DOM: devuelven el ancho de cada barra/espacio, y barcodeSVG() las dibuja.

// ── EAN-13 ────────────────────────────────────────────────
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Check(first12) {
  const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}
export const isEan13 = (s) => /^\d{13}$/.test(s) && Number(s[12]) === ean13Check(s.slice(0, 12));

// Cadena de 95 módulos ('1' = barra, '0' = espacio).
export function ean13Modules(code) {
  if (!isEan13(code)) throw new Error('No es un EAN-13 válido');
  const parity = PARITY[Number(code[0])];
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? L : G)[Number(code[1 + i])];
  bits += '01010';
  for (let i = 0; i < 6; i++) bits += R[Number(code[7 + i])];
  return bits + '101';
}

// ── Code 128 (juego B: letras, números y signos) ──────────
// Anchos de cada carácter: 3 barras y 3 espacios (suman 11 módulos). El de parada tiene 4 barras y 3 espacios (13 módulos).
export const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const STOP = 106;

// Valores del símbolo para un texto (juego B: caracteres ASCII 32–126) con su dígito de control.
export function code128Values(text) {
  const s = String(text);
  if (!s.length || [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126)) throw new Error('Code 128 (juego B) solo admite caracteres ASCII imprimibles');
  const vals = [START_B, ...[...s].map((ch) => ch.charCodeAt(0) - 32)];
  const check = vals.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  return [...vals, check, STOP];
}

export function code128Modules(text) {
  let bits = '';
  for (const v of code128Values(text)) {
    let bar = true;
    for (const w of C128[v]) {
      bits += (bar ? '1' : '0').repeat(Number(w));
      bar = !bar;
    }
  }
  return bits;
}

// Lee de vuelta una cadena de módulos de Code 128 (sirve para comprobar que lo dibujado se puede leer).
export function code128Decode(bits) {
  const widths = [];
  let run = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === bits[i - 1]) run++;
    else { widths.push(run); run = 1; }
  }
  widths.push(run);
  const symbols = [];
  for (let i = 0; i < widths.length; ) {
    const take = i + 7 <= widths.length && widths.slice(i, i + 7).join('') === C128[STOP] ? 7 : 6;
    const key = widths.slice(i, i + take).join('');
    const v = C128.indexOf(key);
    if (v < 0) return null;
    symbols.push(v);
    i += take;
  }
  if (symbols[0] !== START_B || symbols.at(-1) !== STOP) return null;
  const body = symbols.slice(1, -2);
  const check = symbols.at(-2);
  const sum = (START_B + body.reduce((s, v, i) => s + v * (i + 1), 0)) % 103;
  if (sum !== check) return null;
  return body.map((v) => String.fromCharCode(v + 32)).join('');
}

// Dibuja el código como SVG (barras negras sobre blanco, con la zona en blanco que pide la norma). Devuelve el texto SVG.
export function barcodeSVG(value, { height = 54, module = 2, text = true } = {}) {
  const v = String(value);
  const ean = isEan13(v);
  const bits = ean ? ean13Modules(v) : code128Modules(v);
  const quiet = ean ? 9 : 10;
  const width = (bits.length + quiet * 2) * module;
  const fontPx = 11;
  const total = height + (text ? fontPx + 6 : 0);
  let x = quiet * module;
  let bars = '';
  for (let i = 0; i < bits.length; ) {
    let j = i;
    while (j < bits.length && bits[j] === bits[i]) j++;
    if (bits[i] === '1') {
      // En EAN-13 las barras de guarda (inicio, centro y fin) llegan un poco más abajo, como en el original.
      const guard = ean && (i < 3 || (i >= 45 && i < 50) || i >= 92);
      bars += `<rect x="${x}" y="0" width="${(j - i) * module}" height="${guard && text ? height + 5 : height}"/>`;
    }
    x += (j - i) * module;
    i = j;
  }
  const label = text ? `<text x="${width / 2}" y="${height + fontPx + 3}" text-anchor="middle" font-family="monospace" font-size="${fontPx}" fill="#000">${v.replace(/[<&>]/g, '')}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${total}" width="${width}" height="${total}" role="img" aria-label="Código de barras ${v.replace(/[<&>"]/g, '')}"><rect width="${width}" height="${total}" fill="#fff"/><g fill="#000">${bars}</g>${label}</svg>`;
}
