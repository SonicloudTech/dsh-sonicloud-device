import { z } from 'zod';
import { preferencesSchema, storedPreferencesSchema, snSchema } from './devices.mjs';

export const PACKAGE = '@sonicloud/dsh-sonicloud-device';
const text = z.string().max(4096);
const id = z.string().max(80);
const catalog = z.object({ revision: z.number().int(), activeId: id, services: z.array(z.object({
  id, name: text, streamUrl: text, tokenUrl: text, translateUrl: text, builtin: z.boolean(), configured: z.boolean(),
}).strict()) });
const device = z.object({
  id: text, sn: z.string(), type: z.string(), name: z.string(), connection: z.enum(['usb', 'ble']),
  battery: z.number().nullable(), identityConfirmed: z.boolean(), dpiState: z.string(),
  dpiRaw: z.number().optional(), revision: z.number().optional(), preferences: storedPreferencesSchema.optional(),
});
const devices = z.object({ status: text, devices: z.array(device), recognitionLanguages: z.array(z.string()), translationReady: z.boolean() });
const session = { sessionId: z.string() };
const event = z.discriminatedUnion('type', [
  devices.extend({ type: z.literal('devices') }),
  z.object({ type: z.literal('notice'), message: text }),
  z.object({ type: z.literal('request'), ...session, sn: z.string(), action: z.enum(['voice_input', 'translate', 'speechSearch']) }),
  z.object({ type: z.literal('phase'), ...session, phase: z.enum(['recording', 'finishing', 'translating']) }),
  z.object({ type: z.literal('preview'), ...session, text: z.string().max(65536) }),
  z.object({ type: z.literal('result'), ...session, text: z.string().max(65536) }),
  z.object({ type: z.literal('finished'), ...session }),
  z.object({ type: z.literal('cancelled'), ...session }),
  z.object({ type: z.literal('failed'), ...session, message: text }),
]);
const codec = (name, schema) => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => schema });
const define = (method, params, result, extra = {}) => ({
  id: `${PACKAGE}#asr/${method}`, namespace: 'asr', service: 'sinicloudAsr', method,
  invocation: { kind: 'direct' },
  parameters: params.map(([name, schema]) => ({ name, wire: name, source: 'json', codec: codec(`${method}/${name}`, schema) })),
  result: codec(`${method}/result`, result), ...extra,
});
export const REMOTE = {
  package: PACKAGE,
  descriptors: [
    define('catalog', [], catalog),
    define('devices', [], devices),
    define('saveDevice', [['sn', snSchema], ['revision', z.number().int().nonnegative()], ['preferences', preferencesSchema]],
      z.object({ revision: z.number(), preferences: preferencesSchema, message: text })),
    define('watch', [['clientId', id]], event, { mode: 'stream', cancellation: { parameter: 'signal' } }),
    define('accept', [['clientId', id], ['sessionId', id]], z.boolean()),
    define('cancel', [['clientId', id], ['sessionId', id]], z.boolean()),
    define('watchAi', [['clientId', id]], z.object({
      requestId: id, sessionId: id, operation: z.enum(['prepare', 'insert', 'release']),
      expiresAt: z.number().optional(), text: z.string().max(65536).optional(), autoSend: z.boolean().optional(),
    }), { mode: 'stream', cancellation: { parameter: 'signal' } }),
    define('answerAi', [['clientId', id], ['requestId', id], ['ok', z.boolean()]], z.boolean()),
  ],
};
export const TYPERT = {
  package: PACKAGE, face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: REMOTE.descriptors,
};
