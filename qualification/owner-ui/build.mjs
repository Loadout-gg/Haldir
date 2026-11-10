import { build } from 'esbuild';
await build({
  entryPoints:['qualification/owner-ui/client.mjs'],
  outfile:'target/owner-ui/client.js', bundle:true, platform:'browser', format:'esm',
  inject:['qualification/owner-ui/browser-shims.mjs'],
  drop:['console'], define:{global:'globalThis'}, minify:true, logLevel:'info',
});
