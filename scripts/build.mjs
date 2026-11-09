// Đóng gói Server và Gateway thành hai file JS đơn, dùng với Node 22.13+: node dist/server.mjs
import { build } from 'esbuild'
for (const name of ['server', 'gateway']) {
  await build({
    entryPoints: [`src/${name}/main.ts`], outfile: `dist/${name}.mjs`,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);" },
  })
}
console.log('built dist/server.mjs, dist/gateway.mjs')
