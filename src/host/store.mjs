import { randomUUID } from 'node:crypto';
import { BUILTIN_ASR } from '../asr/config.mjs';

export const STORE_KEY = 'dsh-asr/config';

export class ServiceStore {
  constructor(credentials) { this.credentials = credentials; }
  async state() {
    // 白名单重建旧记录，只保留调用身份；不读取旧服务或复制其中的凭据。
    const record = await this.credentials.modifyRecord(STORE_KEY, current => ({
      kind: 'grant', payload: {
        version: 2,
        userId: typeof current?.payload?.userId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(current.payload.userId)
          ? current.payload.userId : randomUUID(),
      },
    }));
    return record.payload;
  }
  async catalog() {
    await this.state();
    return { revision: 0, activeId: 'builtin', services: [{ ...BUILTIN_ASR, id: 'builtin', builtin: true, configured: true }] };
  }
  async resolve() { return { ...BUILTIN_ASR, id: 'builtin', userId: (await this.state()).userId }; }
}
