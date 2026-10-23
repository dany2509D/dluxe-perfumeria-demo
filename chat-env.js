// Elige el asistente según las variables de entorno:
//   - con ANTHROPIC_API_KEY (y el SDK instalado) → asistente de IA (Claude);
//   - sin clave → asistente local de reglas: funciona igual de bien con el catálogo, sin costo y sin internet.
// CHATBOT=off lo apaga, CHATBOT=local fuerza el local aunque haya clave y CHATBOT=on fuerza la IA con credenciales
// que resuelva el SDK por su cuenta (por ejemplo `ant auth login`).
import { createChatService } from './chatbot.js';
import { createLocalChatService } from './chatbot-local.js';
import { loadBrand } from './brand.js';

let Anthropic = null;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
} catch {
  /* sin `npm install`: se usa el asistente local */
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function buildChat(db, env = process.env, brand = loadBrand(env)) {
  if (env.CHATBOT === 'off') return { enabled: false, reason: 'apagado' };

  // La identidad de la tienda (nombre, horario, contacto, WhatsApp) sale de brand.json / variables de entorno.
  const whatsapp = brand.whatsapp || null;

  const wantsAi = env.CHATBOT !== 'local' && (env.CHATBOT === 'on' || !!env.ANTHROPIC_API_KEY || !!env.ANTHROPIC_AUTH_TOKEN);
  if (wantsAi && Anthropic) {
    const effort = EFFORTS.includes(env.CHATBOT_EFFORT) ? env.CHATBOT_EFFORT : 'medium';
    const service = createChatService({
      db,
      client: new Anthropic(),
      model: env.CHATBOT_MODEL || 'claude-haiku-5-5',
      effort,
      fallback: env.CHATBOT_FALLBACK !== 'off',
      brand,
    });
    return Object.assign(service, { whatsapp: !!whatsapp });
  }
  return createLocalChatService({ db, whatsapp, brand });
}
