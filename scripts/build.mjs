// Gom Server và Gateway thành hai tệp ESM đơn (dist/server.mjs, dist/gateway.mjs) chạy bằng Node 22.13+.
// `node:sqlite` có sẵn trong Node nên không đóng gói; mã nạp nó bằng createRequire nên chạy được cả khi đã gom.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
for (const name of ['server', 'gateway']) {
  await build({
    entryPoints: [`src/${name}/main.ts`],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'none',
    external: ['node:sqlite'],
    banner: { js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);" },
    define: { 'process.env.OCEAN_VERSION': JSON.stringify(version) },
  })
}
console.log(`built dist/server.mjs, dist/gateway.mjs (v${version})`)
