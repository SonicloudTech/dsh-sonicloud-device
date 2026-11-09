export const clientBuildOptions = {
  entryPoints: ['src/client/index.jsx'], bundle: true, platform: 'browser', format: 'cjs', target: 'chrome120',
  loader: { '.css': 'text', '.svg': 'text' }, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-sonicloud-device",factory(require){ const module={exports:{}}; const exports=module.exports;' },
  footer: { js: 'return module.exports; }});' },
};
