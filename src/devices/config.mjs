import { z } from 'zod';
const query = z.partialRecord(z.enum(['lid', 'lanid', 'role', 'language', 'accent', 'rlang']), z.union([z.string().max(128), z.number()])).refine(value => Object.keys(value).length > 0, '识别参数不能为空');
export const pluginConfigSchema = z.object({
  native: z.object({ libraryPath: z.string().min(1).max(4096).optional() }).strict().optional(),
  dpiLevels: z.partialRecord(z.enum(['800', '1200', '1600', '2400']), z.number().int().min(0).max(255)).optional(),
  recognitionLanguages: z.array(z.object({ language: z.string(), accent: z.string(), rlang: z.string(), query }).strict()).max(100).optional(),
  translation: z.object({ timeoutMs: z.number().int().min(1000).max(60000).default(15000) }).strict().optional(), tailMs: z.number().int().min(0).max(1000).default(150),
}).strict();
