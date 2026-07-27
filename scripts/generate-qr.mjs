// Regenerates the GoFundMe donation QR code committed at public/donate-qr.svg.
// Run with: npx --yes qrcode@1 >/dev/null 2>&1; node scripts/generate-qr.mjs
// (requires the `qrcode` package to be resolvable, e.g. `npm i --no-save qrcode`)
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

const DONATE_URL = 'https://www.gofundme.com/f/support-marty-lyons-foundations-mission'
const OUT = fileURLToPath(new URL('../public/donate-qr.svg', import.meta.url))

const svg = await QRCode.toString(DONATE_URL, {
  type: 'svg',
  errorCorrectionLevel: 'M',
  margin: 1,
  color: { dark: '#0a0a0f', light: '#ffffff' },
})

await writeFile(OUT, svg)
console.log(`Wrote ${OUT} for ${DONATE_URL}`)
