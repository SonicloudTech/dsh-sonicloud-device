import { defaultPreferences, preferencesSchema } from '../shared/devices.mjs';

// One editor per SN survives device/page switching and serializes revision-based saves.
export class DevicePreferences {
  listeners = new Set();
  sequence = 0;
  pending = false;
  constructor(api, device, notify = () => {}) {
    this.api = api;
    this.notify = notify;
    this.sn = device.sn;
    this.confirmed = device;
    this.revision = device.revision;
    this.state = { form: device.preferences, busy: false, error: '', notice: '', invalid: false, linkDirty: false };
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  publish(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  sync(device) {
    if (device.revision < this.confirmed.revision) return;
    this.confirmed = device;
    if (!this.state.busy && !this.state.invalid && !this.state.linkDirty) {
      this.revision = device.revision;
      this.publish({ form: device.preferences });
    }
  }
  change(key, value) {
    const form = { ...this.state.form, [key]: value };
    if (key === 'mAction' && value !== 'openWebUrl' && (this.state.linkDirty || this.state.invalid)) {
      form.linkUrl = this.confirmed.preferences.linkUrl;
      return this.replace(form);
    }
    if (key === 'linkUrl' || this.state.linkDirty
      || (key === 'mAction' && value === 'openWebUrl')) {
      if (this.disposed) return;
      this.sequence++; this.pending = false;
      this.publish({ form, linkDirty: true, invalid: false, error: '', notice: '' });
      return;
    }
    return this.replace(form);
  }
  commitLink() {
    return this.replace({ ...this.state.form, linkUrl: this.state.form.linkUrl.trim() }, true);
  }
  reset() { return this.replace(defaultPreferences()); }
  replace(form, confirmLink = false) {
    if (this.disposed) return;
    this.sequence++;
    this.linkConfirmation = confirmLink ? this.sequence : undefined;
    const valid = preferencesSchema.safeParse(form);
    this.pending = valid.success;
    this.publish({ form, linkDirty: false, invalid: !valid.success, notice: '', error: valid.success ? '' : `${valid.error.issues[0].message}，当前修改尚未生效，仍使用已保存的设置。` });
    if (confirmLink && !valid.success) {
      this.linkConfirmation = undefined;
      this.notify(`${valid.error.issues[0].message}，设置未生效。`, 'error');
    }
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
        if (!this.disposed && this.linkConfirmation === sequence) {
          this.linkConfirmation = undefined;
          this.notify('链接设置成功，已生效', 'success');
        }
      }
    } catch (error) {
      this.pending = false;
      this.revision = this.confirmed.revision;
      const message = `未保存：${error.message}。请重新选择设置后重试。`;
      if (!this.disposed && this.linkConfirmation !== undefined) {
        this.linkConfirmation = undefined;
        this.notify(message, 'error');
      }
      if (this.state.linkDirty || this.state.invalid) this.publish({ error: this.state.error || message, notice: '' });
      else this.publish({ form: this.confirmed.preferences, invalid: false, error: message, notice: '' });
    } finally {
      if (!this.state.invalid && !this.pending) this.revision = this.confirmed.revision;
      this.publish({ busy: false });
    }
  }
  dispose() { this.disposed = true; this.pending = false; this.listeners.clear(); }
}
