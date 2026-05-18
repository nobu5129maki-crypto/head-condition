import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const svg = readFileSync(join(root, 'public', 'favicon.svg'))

/** 一覧表示・ホーム追加用 */
await sharp(svg).resize(512, 512).png({ compressionLevel: 9 }).toFile(join(root, 'public', 'favicon.png'))

/** ブラウザタブ向けに控えめ解像度 */
await sharp(svg).resize(32, 32).png({ compressionLevel: 9 }).toFile(join(root, 'public', 'favicon-32.png'))

console.log('Wrote public/favicon.png (512×512) and public/favicon-32.png')
