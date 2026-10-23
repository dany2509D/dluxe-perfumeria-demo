// Quién puede mostrar una página dentro de un iframe (cabecera Content-Security-Policy: frame-ancestors).
// Recibe una lista de orígenes separados por coma ("https://sitio.com, https://www.sitio.com") o "*" (solo para pruebas).
// Todo lo que no sea un origen válido se descarta; la propia página siempre puede.
export const ancestors = (list) =>
  ["'self'", ...String(list ?? '').split(',').map((o) => o.trim()).filter((o) => o === '*' || /^https?:\/\/[\w.-]+(:\d+)?$/.test(o))].join(' ');
