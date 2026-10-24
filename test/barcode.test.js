// Códigos de barras de las etiquetas: las tablas de EAN-13 y Code 128 se verifican por sus propiedades (no se puede probar con un escáner aquí).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { C128, code128Modules, code128Decode, code128Values, ean13Modules, ean13Check, isEan13, barcodeSVG } from '../public/js/barcode.js';

describe('Code 128', () => {
  test('la tabla tiene 107 símbolos, todos distintos y bien formados', () => {
    assert.equal(C128.length, 107);
    assert.equal(new Set(C128).size, 107);
    for (let i = 0; i < 106; i++) {
      const w = [...C128[i]].map(Number);
      assert.equal(w.length, 6, `símbolo ${i}`);
      assert.equal(w.reduce((a, b) => a + b, 0), 11, `símbolo ${i} suma 11 módulos`);
      const bars = w[0] + w[2] + w[4];
      assert.equal(bars % 2, 0, `símbolo ${i}: las barras suman un número par (propiedad de paridad de Code 128)`);
      assert.ok(w.every((x) => x >= 1 && x <= 4));
    }
    assert.equal([...C128[106]].map(Number).reduce((a, b) => a + b, 0), 13, 'la parada suma 13');
  });
  test('lo que se codifica se lee de vuelta, con su dígito de control', () => {
    for (const text of ['DLX-00006-100', 'A', 'abc XYZ 0123456789', '~!@#$%^&*()_+', 'SET-0001']) {
      assert.equal(code128Decode(code128Modules(text)), text);
    }
  });
  test('un símbolo cambiado se detecta por el dígito de control', () => {
    const bits = code128Modules('DLX-00006-100');
    const swapped = bits.slice(0, 11 + 11) + bits.slice(11 + 11 + 11, 11 + 11 + 22) + bits.slice(11 + 11, 11 + 11 + 11) + bits.slice(11 + 11 + 22);
    assert.equal(code128Decode(swapped), null);
  });
  test('el control sigue la fórmula oficial (inicio + suma ponderada módulo 103)', () => {
    const v = code128Values('AB');
    const expected = (104 + 33 * 1 + 34 * 2) % 103;
    assert.deepEqual(v, [104, 33, 34, expected, 106]);
  });
  test('rechaza lo que el juego B no puede representar', () => {
    assert.throws(() => code128Values(''));
    assert.throws(() => code128Values('ñandú'));
    assert.throws(() => code128Values('línea\n2'));
  });
});

describe('EAN-13', () => {
  test('dígito de control y validación con códigos conocidos', () => {
    assert.equal(ean13Check('400638133393'), 1);
    assert.equal(ean13Check('590123412345'), 7);
    assert.ok(isEan13('4006381333931') && isEan13('5901234123457'));
    assert.ok(!isEan13('4006381333932') && !isEan13('123') && !isEan13('400638133393a'));
  });
  test('95 módulos: guardas de inicio, centro y fin en su lugar', () => {
    for (const code of ['4006381333931', '5901234123457', '7450000000013']) {
      const m = ean13Modules(code);
      assert.equal(m.length, 95);
      assert.equal(m.slice(0, 3), '101');
      assert.equal(m.slice(45, 50), '01010');
      assert.equal(m.slice(92), '101');
    }
  });
  test('cada mitad se decodifica a los dígitos originales', () => {
    const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
    const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
    const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
    const code = '5901234123457';
    const m = ean13Modules(code);
    const left = [...Array(6)].map((_, i) => m.slice(3 + i * 7, 10 + i * 7));
    const right = [...Array(6)].map((_, i) => m.slice(50 + i * 7, 57 + i * 7));
    // cada dígito derecho es el complemento del izquierdo en L
    right.forEach((r, i) => assert.equal(R.indexOf(r), Number(code[7 + i])));
    left.forEach((l, i) => assert.ok([L.indexOf(l), G.indexOf(l)].some((d) => d === Number(code[1 + i]))));
    assert.deepEqual(left.map((l) => (L.includes(l) ? 'L' : 'G')).join(''), 'LGGLLG', 'el primer dígito (5) fija el patrón LGGLLG');
  });
  test('un EAN con dígito de control mal puesto no se dibuja', () => {
    assert.throws(() => ean13Modules('4006381333932'));
  });
});

describe('barcodeSVG', () => {
  test('dibuja un EAN-13 o un Code 128 según el valor, con el texto legible', () => {
    const ean = barcodeSVG('4006381333931');
    assert.match(ean, /^<svg /);
    assert.ok(ean.includes('4006381333931') && ean.includes('<rect'));
    const c128 = barcodeSVG('DLX-00006-100');
    assert.ok(c128.includes('DLX-00006-100'));
    assert.ok(!barcodeSVG('DLX-1', { text: false }).includes('<text'));
  });
  test('el texto se escapa (no deja pasar etiquetas)', () => {
    const svg = barcodeSVG('A<script>x</script>B');
    assert.ok(!svg.includes('<script>'));
  });
});
