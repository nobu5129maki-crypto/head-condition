import * as faceapi from 'face-api.js'

/** 頭頂部ROIと眉位置から算出したヘア質感スコア */
export interface SegmentMetrics {
  edgeDensity: number
  luminanceVariance: number
  relativeDarkness: number
}

export interface AnalyzeResult {
  baldRate: number /** 0–100、頭頂コンディション値（高め＝質感よりスキン寄りの見た目。エンタメ目安） */
  hairLikeness: number /** 0–1 */
  metrics: SegmentMetrics
  browTopY: number
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function linearNorm(x: number, lo: number, hi: number): number {
  if (hi <= lo) return 0.5
  return clamp((x - lo) / (hi - lo), 0, 1)
}

/** 頭頂部（眉より上〜撮影された髪／頭皮）矩形 */
function scalpRoi(
  iw: number,
  ih: number,
  faceBox: faceapi.Box,
  browMedianY: number,
): { x: number; y: number; w: number; h: number } | null {
  const faceH = faceBox.height
  const xc = faceBox.x + faceBox.width / 2
  const halfW = (faceBox.width * 1.05) / 2
  const x0 = Math.floor(clamp(xc - halfW, 0, iw - 8))
  const x1 = Math.ceil(clamp(xc + halfW, x0 + 8, iw))
  const yBottom = Math.floor(clamp(browMedianY - 8, 8, ih))
  const yTop = clamp(Math.floor(faceBox.top - faceH * 0.82), 0, yBottom - 24)
  const w = x1 - x0
  const h = yBottom - yTop

  if (h < 20 || w < 24) return null
  return { x: x0, y: yTop, w, h }
}

function grayscaleFromImageData(data: Uint8ClampedArray, w: number, h: number) {
  const g = new Float32Array(w * h)
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4
      const r = data[i],
        gn = data[i + 1],
        b = data[i + 2]
      g[py * w + px] = 0.299 * r + 0.587 * gn + 0.114 * b
    }
  }
  return g
}

/** ROI だけ切り出しグレースケール（高速化） */
function roiGray(canvas: HTMLCanvasElement, roi: { x: number; y: number; w: number; h: number }) {
  const sx = roi.x
  const sy = roi.y
  const rw = roi.w
  const rh = roi.h
  const ctx = canvas.getContext('2d')!
  const full = ctx.getImageData(sx, sy, rw, rh)
  return grayscaleFromImageData(full.data, rw, rh)
}

function scalpMetricsSampled(grayRoi: Float32Array, rw: number, rh: number): SegmentMetrics {
  let sum = 0
  const nTotal = grayRoi.length
  for (let i = 0; i < nTotal; i++) sum += grayRoi[i]
  const mean = sum / nTotal

  let varSum = 0
  let edgeSum = 0
  let edgeSteps = 0
  /** ステップ間引きしてパフォーマンス確保（スマホ向け） */
  const stride = rh > 120 || rw > 120 ? 2 : 1

  for (let y = stride; y < rh - stride; y += stride) {
    for (let x = stride; x < rw - stride; x += stride) {
      const i = y * rw + x
      const px = grayRoi[i]
      const dx = px - grayRoi[i - stride]
      const dy = px - grayRoi[i - stride * rw]
      edgeSum += Math.abs(dx) + Math.abs(dy)
      edgeSteps++
      varSum += (px - mean) ** 2
    }
  }

  const variance = varSum / Math.max(edgeSteps, 1)
  const edgeDensity = edgeSum / Math.max(edgeSteps, 1)
  /** 暗いヘアほど値が高い（肌・薄毛で明るめなら低下） */
  const relativeDarkness = 1 - mean / 255

  return { edgeDensity, luminanceVariance: Math.sqrt(Math.max(variance, 1e-6)), relativeDarkness }
}

/** 質感〜頭頂コンディション指標％（経験的レンジ。エンタメ向け調整済みの粗いマッピング） */
export function baldRateFromHairMetrics(m: SegmentMetrics): { hairLikeness: number; baldRate: number } {
  /** 強い細かい質感／コントラスト → ヘア寄り（数値調整済みヒューリスティック） */
  const edgeN = linearNorm(m.edgeDensity, 6.5, 26)
  const varN = linearNorm(m.luminanceVariance, 3.8, 16)
  const darkN = linearNorm(m.relativeDarkness, 0.12, 0.48)

  /** 暗さは単独より補助的に（照明でブレるため） */
  const hairLikeness = clamp(
    edgeN * 0.48 + varN * 0.41 + darkN * 0.11,
    0,
    1,
  )
  /** ゆるい S カーブで極端な 0 / 100 を減らす */
  const adjusted = clamp((hairLikeness - 0.5) * 1.06 + 0.5, 0, 1)
  let baldRate = Math.round((1 - adjusted) * 100)
  baldRate = clamp(baldRate, 3, 97)
  return { hairLikeness: adjusted, baldRate }
}

/**
 * 画像全体を canvas に書き込んだ状態で検出。
 * 「眉より上」を頭頂部とみなしテクスチャで推定（医療診断ではありません）。
 */
export async function analyzeBaldnessFromCanvas(
  canvas: HTMLCanvasElement,
): Promise<AnalyzeResult | { error: string }> {
  const iw = canvas.width
  const ih = canvas.height
  if (iw < 80 || ih < 80) {
    return { error: '画像が小さすぎます。もう少し近く／明るく撮影してください。' }
  }

  const det = await faceapi
    .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.42, inputSize: 448 }))
    .withFaceLandmarks()

  if (!det) {
    return { error: '顔を検出できませんでした。正面を向いて、頭頂部が画面に入る距離で撮り直してください。' }
  }

  const lm = det.landmarks.positions
  /** 両眉のアーク（17〜26）。上寄りになるよう小さめインデックス中心に寄せてもよいが、平均で安定 */
  const browPts = lm.slice(17, 27)
  const browMedianY = browPts.reduce((acc, p) => acc + p.y, 0) / browPts.length

  const box = det.detection.box
  const roi = scalpRoi(iw, ih, box, browMedianY)
  if (!roi) {
    return { error: '頭頂部の判定領域を切り出せませんでした。もう少し髪まで写るようにしましょう。' }
  }

  const gray = roiGray(canvas, roi)
  const metrics = scalpMetricsSampled(gray, roi.w, roi.h)
  const { hairLikeness, baldRate } = baldRateFromHairMetrics(metrics)

  return {
    baldRate,
    hairLikeness,
    metrics,
    browTopY: browMedianY,
  }
}
