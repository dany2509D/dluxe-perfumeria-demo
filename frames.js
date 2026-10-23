// Quién puede mostrar una página dentro de un iframe (cabecera Content-Security-Policy: frame-ancestors).
// Recibe una lista de orígenes separados por coma ("https://sitio.com, https://www.sitio.com") o "*" (solo para pruebas).
// También acepta todos los subdominios de un sitio con "https://*.sitio.com" (útil para las vistas previas de un despliegue):
// el comodín solo vale como primer tramo y la dirección debe tener al menos dos tramos más (nunca "https://*.com").
// Todo lo que no sea un origen válido se descarta; la propia página siempre puede.
const ORIGIN = /^https?:\/\/[\w.-]+(:\d+)?$/;
const SUBDOMAINS = /^https?:\/\/\*\.([\w-]+\.)+[\w-]+(:\d+)?$/;

export const ancestors = (list) =>
  ["'self'", ...String(list ?? '').split(',').map((o) => o.trim()).filter((o) => o === '*' || ORIGIN.test(o) || SUBDOMAINS.test(o))].join(' ');
