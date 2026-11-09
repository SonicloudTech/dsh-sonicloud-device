import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ServiceStore } from './store.mjs';
import { createTokenProvider } from '../asr/auth.mjs';
import { streamRecognition } from '../asr/stream.mjs';
import { translateText } from '../devices/translate.mjs';
import { TYPERT } from '../shared/remote.mjs';
import { DeviceManager } from '../devices/manager.mjs';
import { MouseSdk } from '../devices/native.mjs';
import { pluginConfigSchema } from '../devices/config.mjs';

export const name = 'dsh-sonicloud-device';
export const inject = ['credentials', 'typert'];
export class MouseController extends TypertRemoteService {
  constructor(ctx, config = {}, dependencies = {}) {
    super(ctx, 'sinicloudAsr', { namespace: 'asr' });
    config = pluginConfigSchema.parse(config);
    this.store = new ServiceStore(ctx.credentials);
    this.dependencies = dependencies;
    this.providers = new Map(); this.lifetime = new AbortController();
    // 即使没有设备连接，也完成遗留凭据清理；失败时禁止发起业务请求。
    this.initialized = this.store.state();
    this.initialized.catch(() => {});
    this.manager = new DeviceManager({ credentials: ctx.credentials, config,
      sdk: dependencies.sdk ?? new MouseSdk(config.native), ...dependencies,
      prepare: () => this.service(), recognize: request => this.recognize(request),
      translate: request => this.translate(request) });
    ctx.effect(() => () => {
      this.lifetime.abort(); this.providers.clear(); return this.manager.close();
    });
  }
  async service() { await this.initialized; return { ...await this.store.resolve(), ...this.dependencies.endpoints }; }
  catalog() { return this.store.catalog(); }
  devices() { return this.manager.view(); }
  saveDevice(sn, revision, preferences) { return this.manager.save(sn, revision, preferences); }
  watch(clientId, signal) { return this.manager.watch(clientId, signal); }
  accept(clientId, sessionId) { return this.manager.accept(clientId, sessionId); }
  cancel(clientId, sessionId) { this.manager.assertOwner(clientId); this.manager.cancel(sessionId); return true; }
  provider(sn, service) {
    const key = JSON.stringify([service.tokenUrl, sn]);
    if (!this.providers.has(key)) this.providers.set(key,
      createTokenProvider({ tokenUrl: service.tokenUrl, sn }, this.dependencies.fetchImpl ?? globalThis.fetch, this.lifetime.signal));
    return this.providers.get(key);
  }
  async *recognize({ sn, query, uplink, signal, service: capturedService }) {
    const connection = new AbortController();
    const timeout = this.dependencies.connectTimeout ?? 10_000;
    const timer = setTimeout(() => connection.abort(), timeout);
    const combined = AbortSignal.any([signal, this.lifetime.signal, connection.signal]);
    const deadline = Date.now() + timeout;
    try {
      const service = capturedService ?? await this.service();
      combined.throwIfAborted();
      const getToken = this.provider(sn, service);
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await getToken(combined);
        combined.throwIfAborted();
        let retry = false;
        for await (const event of streamRecognition({
          service: { ...service, recognitionQuery: query }, token, uplink, signal: combined,
          WebSocketImpl: this.dependencies.WebSocketImpl,
          connectTimeout: Math.max(1, deadline - Date.now()),
          onAuthFailure: () => getToken.invalidate(token),
        })) {
          if (event.type === 'ready') clearTimeout(timer);
          if (event.type === 'error' && event.code === '4010' && event.retryable && attempt === 0) { retry = true; break; }
          yield event;
          if (event.type === 'error') return;
        }
        combined.throwIfAborted();
        if (!retry) return;
      }
    } catch (error) {
      if (!signal.aborted && !this.lifetime.signal.aborted) yield { type: 'error',
        message: connection.signal.aborted ? 'ASR 连接超时，请稍后重试'
          : /^(Token |设备|License |ASR )/.test(error.message) ? error.message : 'ASR 服务暂不可用，请稍后重试' };
    } finally { clearTimeout(timer); }
  }
  async translate({ sn, service: capturedService, ...request }) {
    const service = capturedService ?? await this.service();
    const signal = AbortSignal.any([request.signal, this.lifetime.signal]);
    signal.throwIfAborted();
    return translateText({ ...request, signal, getToken: this.provider(sn, service), userId: service.userId,
      url: service.translateUrl, fetchImpl: this.dependencies.fetchImpl ?? globalThis.fetch });
  }
}
export async function apply(ctx, config = {}) {
  ctx.effect(() => ctx.typert.register(TYPERT));
  const controller = new MouseController(ctx, config);
  await controller.initialized;
}
