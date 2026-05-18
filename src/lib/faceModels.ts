import * as faceapi from 'face-api.js'

/** jsDelivr + GitHub から公式 weights を読み込み（初回のみネット必須） */
const MODEL_URI =
  'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights'

let loadPromise: Promise<void> | null = null

export function ensureFaceModels(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URI),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URI),
      ])
    })().catch((e) => {
      loadPromise = null
      throw e
    })
  }
  return loadPromise
}
