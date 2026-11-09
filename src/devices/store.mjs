import { defaultPreferences, preferencesSchema, storedPreferencesSchema, snSchema } from '../shared/devices.mjs';
// 保留旧存储键，继续读取重命名前保存的配置。
const KEY = 'dsh-asr/devices';
export class DeviceStore {
  constructor(credentials) { this.credentials = credentials; }
  async state() {
    let record = await this.credentials.readRecord(KEY);
    if (!record) record = await this.credentials.modifyRecord(KEY, current => current ?? { kind: 'grant', payload: { version: 1, devices: {} } });
    if (record?.kind !== 'grant' || record.payload?.version !== 1 || !record.payload.devices) throw new Error('设备配置无法读取');
    return structuredClone(record.payload);
  }
  async get(sn) {
    snSchema.parse(sn);
    const saved = (await this.state()).devices[sn];
    return { revision: saved?.revision ?? 0, preferences: storedPreferencesSchema.parse({ ...defaultPreferences(), ...saved?.preferences }) };
  }
  async save(sn, revision, input) {
    snSchema.parse(sn);
    const preferences = preferencesSchema.parse(input);
    preferences.linkUrl = preferences.linkUrl.trim();
    await this.state();
    await this.credentials.modifyRecord(KEY, record => {
      const state = structuredClone(record.payload);
      const saved = state.devices[sn];
      if ((saved?.revision ?? 0) !== revision) throw new Error('设备配置已变更，请刷新后重试');
      state.devices[sn] = { revision: revision + 1, preferences };
      return { kind: 'grant', payload: state };
    });
    return this.get(sn);
  }
}
