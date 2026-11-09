import { defaultPreferences, preferencesSchema } from '../shared/devices.mjs';

// One editor per SN survives device/page switching and serializes revision-based saves.
export class DevicePreferences {
  listeners = new Set();
  sequence = 0;
  pending = false;
  constructor(api, device) {
    this.api = api;
    this.sn = device.sn;
    this.confirmed = device;
    this.revision = device.revision;
    this.state = { form: device.preferences, busy: false, error: '', notice: '', invalid: false };
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  publish(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  sync(device) {
    if (device.revision < this.confirmed.revision) return;
    this.confirmed = device;
    if (!this.state.busy && !this.state.invalid) {
      this.revision = device.revision;
      this.publish({ form: device.preferences });
    }
  }
  change(key, value) { return this.replace({ ...this.state.form, [key]: value }); }
  reset() { return this.replace(defaultPreferences()); }
  replace(form) {
    if (this.disposed) return;
    this.sequence++;
    const valid = preferencesSchema.safeParse(form);
    this.pending = valid.success;
    this.publish({ form, invalid: !valid.success, notice: '', error: valid.success ? '' : `${valid.error.issues[0].message}，当前修改尚未生效。` });
    if (!this.state.busy && this.pending) return this.save();
  }
  async save() {
    this.publish({ busy: true });
    try {
      while (this.pending && !this.disposed) {
        this.pending = false;
        const sequence = this.sequence;
        const result = await this.api.saveDevice(this.sn, this.revision, this.state.form);
        if (!result.ok) throw new Error(result.error?.message || '设备设置保存失败');
        const saved = result.value;
        this.revision = saved.revision;
        if (saved.revision >= this.confirmed.revision) this.confirmed = saved;
        if (sequence === this.sequence) this.publish({ form: this.confirmed.preferences, notice: saved.message, error: '' });
      }
    } catch (error) {
      this.pending = false;
      this.revision = this.confirmed.revision;
      this.publish({ form: this.confirmed.preferences, invalid: false, error: `未保存：${error.message}。请重新选择设置后重试。`, notice: '' });
    } finally {
      if (!this.state.invalid && !this.pending) this.revision = this.confirmed.revision;
      this.publish({ busy: false });
    }
  }
  dispose() { this.disposed = true; this.pending = false; this.listeners.clear(); }
}
