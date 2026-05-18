import * as faceapi from 'face-api.js'

/** 前髪・生え際・こめかみなどから算出したヘア質感スコア */
export interface SegmentMetrics {
  edgeDensity: number
  luminanceVariance: number
  relativeDarkness: number
}

export interface AnalyzeResult {
  /** ボリューム控えめに見える＝0％〜質感・ふんわり感が写り込む側＝100％（写真ベースのヒューリスティック／医学的診断ではありません） */
  fluffRate: number
  hairLikeness: number /** 0–1（内部の質感寄りスコアと同期） */
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

type Rect = { x: number; y: number; w: number; h: number }
type WeightedRoi = Rect & { weight: number }

function clampRect(iw: number, ih: number, r: Rect): Rect | null {
  const x = Math.floor(clamp(r.x, 0, iw - 8))
  const y = Math.floor(clamp(r.y, 0, ih - 8))
  const w = Math.ceil(clamp(r.x + r.w, x + 8, iw)) - x
  const h = Math.ceil(clamp(r.y + r.h, y + 8, ih)) - y
  if (w < 12 || h < 12) return null
  return { x, y, w, h }
}

/**
 * 正面撮影でも安定するよう、頭頂だけでなく
 * 前髪・生え際・こめかみ（＋写っていれば頭頂付近）を複数領域で切り出す。
 */
function hairTextureRois(
  iw: number,
  ih: number,
  faceBox: faceapi.Box,
  browMedianY: number,
): WeightedRoi[] {
  const faceH = faceBox.height
  const faceW = faceBox.width
  const left = faceBox.x
  const right = faceBox.x + faceW
  const top = faceBox.y
  const browLine = Math.floor(clamp(browMedianY - 5, 8, ih))

  const rois: WeightedRoi[] = []

  const foreheadTop = Math.max(0, Math.floor(top - faceH * 0.35))
  const forehead = clampRect(iw, ih, {
    x: left + faceW * 0.15,
    y: foreheadTop,
    w: faceW * 0.7,
    h: browLine - foreheadTop,
  })
  if (forehead && forehead.h >= 14) {
    rois.push({ ...forehead, weight: 0.45 })
  }

  const templeTop = Math.max(0, Math.floor(top - faceH * 0.18))
  const templeH = browLine - templeTop
  const leftTemple = clampRect(iw, ih, {
    x: left - faceW * 0.28,
    y: templeTop,
    w: faceW * 0.38,
    h: templeH,
  })
  if (leftTemple && leftTemple.h >= 14) {
    rois.push({ ...leftTemple, weight: 0.22 })
  }

  const rightTemple = clampRect(iw, ih, {
    x: right - faceW * 0.1,
    y: templeTop,
    w: faceW * 0.38,
    h: templeH,
  })
  if (rightTemple && rightTemple.h >= 14) {
    rois.push({ ...rightTemple, weight: 0.22 })
  }

  if (top > faceH * 0.1) {
    const crown = clampRect(iw, ih, {
      x: left + faceW * 0.2,
      y: 0,
      w: faceW * 0.6,
      h: Math.floor(top - 4),
    })
    if (crown && crown.h >= 14) {
      rois.push({ ...crown, weight: 0.18 })
    }
  }

  if (rois.length === 0) {
    const fallback = clampRect(iw, ih, {
      x: left + faceW * 0.05,
      y: 0,
      w: faceW * 0.9,
      h: browLine,
    })
    if (fallback) return [{ ...fallback, weight: 1 }]
  }

  return rois
}

function mergeWeightedMetrics(items: { metrics: SegmentMetrics; weight: number }[]): SegmentMetrics {
  const totalW = items.reduce((s, i) => s + i.weight, 0)
  if (totalW <= 0) {
    return { edgeDensity: 0, luminanceVariance: 0, relativeDarkness: 0 }
  }
  let edge = 0
  let lum = 0
  let dark = 0
  for (const { metrics, weight } of items) {
    const w = weight / totalW
    edge += metrics.edgeDensity * w
    lum += metrics.luminanceVariance * w
    dark += metrics.relativeDarkness * w
  }
  return { edgeDensity: edge, luminanceVariance: lum, relativeDarkness: dark }
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
  /** 暗いヘアほど値が高い（明るめに写ると低下） */
  const relativeDarkness = 1 - mean / 255

  return { edgeDensity, luminanceVariance: Math.sqrt(Math.max(variance, 1e-6)), relativeDarkness }
}

/** 質感の統計から「ふさふさ率」0–100（エンタメ向けヒューリスティック／医学的％ではありません） */
export function baldRateFromHairMetrics(m: SegmentMetrics): { hairLikeness: number; fluffRate: number } {
  /** 強い細かい質感／コントラスト → ヘア寄り（数値調整済みヒューリスティック） */
  const edgeN = linearNorm(m.edgeDensity, 6.5, 26)
  const varN = linearNorm(m.luminanceVariance, 3.8, 16)
  const darkN = linearNorm(m.relativeDarkness, 0.12, 0.48)

  /** 暗さは単独より補助的に（照明でブレるため） */
  const rawHair = clamp(
    edgeN * 0.48 + varN * 0.41 + darkN * 0.11,
    0,
    1,
  )
  /** ゆるい S カーブ（質感が乏しい＝0％側、ボリューム・細かい質感が写る＝100％側へ寄せる） */
  const adjusted = clamp((rawHair - 0.5) * 1.06 + 0.5, 0, 1)
  const fluffRate = Math.round(adjusted * 100)
  return { hairLikeness: adjusted, fluffRate }
}

/**
 * 画像全体を canvas に書き込んだ状態で検出。
 * 正面でも写りやすい前髪・生え際・こめかみを中心にテクスチャで推定（医療診断ではありません）。
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
    return {
      error: '顔を検出できませんでした。正面を向いて、顔と前髪・生え際が画面に入る距離で撮り直してください。',
    }
  }

  const lm = det.landmarks.positions
  const browPts = lm.slice(17, 27)
  const browMedianY = browPts.reduce((acc, p) => acc + p.y, 0) / browPts.length

  const box = det.detection.box
  const rois = hairTextureRois(iw, ih, box, browMedianY)
  if (rois.length === 0) {
    return {
      error: '髪の判定領域を切り出せませんでした。前髪・生え際が写るように、少し引きの構図でお試しください。',
    }
  }

  const merged = mergeWeightedMetrics(
    rois.map((roi) => ({
      weight: roi.weight,
      metrics: scalpMetricsSampled(roiGray(canvas, roi), roi.w, roi.h),
    })),
  )
  const { hairLikeness, fluffRate } = baldRateFromHairMetrics(merged)

  return {
    fluffRate,
    hairLikeness,
    metrics: merged,
    browTopY: browMedianY,
  }
}
