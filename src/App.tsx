import { useCallback, useEffect, useRef, useState } from 'react'
import { BaldTrendChart } from './components/BaldTrendChart'
import type { AnalyzeResult } from './lib/analyzeBaldness'
import { analyzeBaldnessFromCanvas } from './lib/analyzeBaldness'
import { ensureFaceModels } from './lib/faceModels'
import { appendHistory, clearHistory, loadHistory, type HistoryEntry } from './lib/historyStore'

type Phase = 'idle' | 'models' | 'analyzing'

function snapshotVideoToCanvas(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  canvas.width = video.videoWidth || 640
  canvas.height = video.videoHeight || 480
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
}

function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました'))
    img.onload = () => resolve(img)
    img.src = URL.createObjectURL(file)
  })
}

async function analyzeFromImageFile(blob: Blob, canvas: HTMLCanvasElement) {
  const img = await loadImageElement(blob)
  try {
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const res = await analyzeBaldnessFromCanvas(canvas)
    return res
  } finally {
    URL.revokeObjectURL(img.src)
  }
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [modelError, setModelError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string>('モデルを準備しています…')
  const [camOpen, setCamOpen] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [lastDetail, setLastDetail] = useState<AnalyzeResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory())

  const latestRate = history[0]?.baldRate ?? null

  /** 初回で face-api をロード（失敗時はリトライ用に ensure を保持） */
  useEffect(() => {
    let cancel = false
    setPhase('models')
    ;(async () => {
      try {
        await ensureFaceModels()
        if (!cancel) {
          setPhase('idle')
          setModelError(null)
          setStatusMessage('準備できました')
        }
      } catch {
        if (!cancel) {
          setModelError(
            'AIモデルの読み込みに失敗しました。インターネット接続を確認して、このページを再読み込みしてください。',
          )
          setPhase('idle')
          setStatusMessage('モデル準備エラー')
        }
      }
    })()
    return () => {
      cancel = true
    }
  }, [])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop())
    streamRef.current = null
    setCamOpen(false)
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  useEffect(() => () => stopCamera(), [stopCamera])

  const startCamera = useCallback(async () => {
    if (modelError) return
    setAnalyzeError(null)
    setStatusMessage('カメラを起動しています…')
    try {
      stopCamera()
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      streamRef.current = stream
      const vid = videoRef.current
      if (!vid) return
      vid.srcObject = stream
      await vid.play()
      setCamOpen(true)
      setStatusMessage('')
    } catch {
      setAnalyzeError(
        'カメラを使えませんでした。「写真を選ぶ」で画像アップロードするか、ブラウザの権限設定を確認してください。',
      )
      setStatusMessage('')
    }
  }, [modelError, stopCamera])

  const runAnalysisFromCanvas = useCallback(async (): Promise<boolean> => {
    const canvas = canvasRef.current
    if (!canvas) return false
    setPhase('analyzing')
    setAnalyzeError(null)
    await new Promise((r) => setTimeout(r, 120))

    try {
      const res = await analyzeBaldnessFromCanvas(canvas)

      if ('error' in res) {
        setAnalyzeError(res.error)
        setLastDetail(null)
        setPhase('idle')
        return false
      }

      const nextHist = appendHistory(res.baldRate)
      setHistory(nextHist)
      setLastDetail(res)
      setPhase('idle')
      return true
    } catch {
      setAnalyzeError('解析中に予期しないエラーが発生しました。別の写真でお試しください。')
      setLastDetail(null)
      setPhase('idle')
      return false
    }
  }, [])

  const captureFromCamera = useCallback(async () => {
    if (phase === 'models' || modelError) return
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video?.srcObject || !canvas || !camOpen) {
      setAnalyzeError('先にカメラを起動してください。または「写真を選ぶ」をご利用ください。')
      return
    }
    if (video.readyState < 2) {
      setAnalyzeError('カメラの映像がまだ準備できていません。数秒後にもう一度お試しください。')
      return
    }
    snapshotVideoToCanvas(video, canvas)
    await runAnalysisFromCanvas()
  }, [phase, modelError, camOpen, runAnalysisFromCanvas])

  const onPickFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file || phase === 'models' || modelError) return

      const canvas = canvasRef.current
      if (!canvas) return
      setAnalyzeError(null)
      setPhase('analyzing')
      try {
        const res = await analyzeFromImageFile(file, canvas)
        if ('error' in res) {
          setAnalyzeError(res.error)
          setLastDetail(null)
          setPhase('idle')
          return
        }
        const nextHist = appendHistory(res.baldRate)
        setHistory(nextHist)
        setLastDetail(res)
        setPhase('idle')
      } catch {
        setAnalyzeError('画像の処理に失敗しました。JPEG / PNG でお試しください。')
        setPhase('idle')
      }
    },
    [phase, modelError],
  )

  const retryModels = async () => {
    setModelError(null)
    setPhase('models')
    setStatusMessage('モデルを再読み込みしています…')
    try {
      await ensureFaceModels()
      setPhase('idle')
      setStatusMessage('準備できました')
    } catch {
      setModelError('モデルの読み込みに失敗しました。通信環境と VPN / 広告ブロック設定を確認してください。')
      setPhase('idle')
      setStatusMessage('')
    }
  }

  const onResetHistory = () => {
    clearHistory()
    setHistory([])
    setLastDetail(null)
  }

  const modelsBusy = phase === 'models'

  return (
    <div className="mx-auto max-w-xl px-4 pb-24 pt-8 sm:pt-14">
      <header className="mb-10 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/85 px-4 py-1.5 text-xs font-medium tracking-wide text-slate-600 shadow-sm ring-1 ring-slate-200/70 backdrop-blur">
          写真ベース／頭頂の質感読みから％換算した見ため指標（エンタメ目安）
        </div>
        <h1 className="bg-gradient-to-r from-[#1e2846] via-[#3b4fa6] to-[#287a93] bg-clip-text font-display text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
          頭頂コンディション
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-slate-600">
          <strong className="font-semibold text-slate-700">
            「どれだけ抜け感が増して見えるか」を、丁寧に言い換えた指標です。
          </strong>
          撮影データの質感だけを読み取り、その一枚で言う<strong className="font-semibold text-slate-700">ボリューム感／ツヤ感の気配</strong>
          に近い状態を％で並べられるようにしました。ログ用途で、自分の頭頂部の様子と向き合うためのひとつの目安になります。
        </p>
      </header>

      {modelError && (
        <div className="mb-6 rounded-2xl border border-rose-200/90 bg-rose-50/90 px-5 py-4 text-sm text-rose-900 shadow-sm">
          <p className="leading-relaxed">{modelError}</p>
          <button
            type="button"
            onClick={retryModels}
            disabled={phase === 'models'}
            className="mt-3 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-rose-700 disabled:opacity-55"
          >
            モデルを再試行
          </button>
        </div>
      )}

      <section className="rounded-3xl border border-white/80 bg-white/75 p-5 shadow-xl shadow-teal-soft/35 ring-1 ring-teal-soft/40 backdrop-blur-md sm:p-7">
        <div className="relative overflow-hidden rounded-2xl bg-slate-950/5 ring-1 ring-slate-200/80">
          <video
            ref={videoRef}
            className={`aspect-video w-full object-cover ${camOpen ? 'block opacity-90' : 'hidden'}`}
            playsInline
            muted
            autoPlay
          />
          {!camOpen && (
            <div className="aspect-video grid place-items-center bg-gradient-to-b from-slate-100 to-teal-soft/55">
              <div className="text-center px-6">
                <p className="text-sm font-semibold text-slate-700">カメラ待機中</p>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  「カメラを起動」を押してから判定してください。頭頂部〜前髪が十分写る構図にすると結果が安定します。
                </p>
              </div>
            </div>
          )}
        </div>

        <canvas ref={canvasRef} className="hidden" />

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            disabled={modelsBusy || !!modelError}
            onClick={startCamera}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-800 px-4 py-3.5 text-sm font-semibold text-white shadow hover:bg-slate-900 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            <span className="text-lg" aria-hidden>
              📷
            </span>
            {camOpen ? 'カメラをやり直す' : 'カメラを起動'}
          </button>

          <button
            type="button"
            disabled={modelsBusy || !!modelError || phase === 'analyzing'}
            onClick={captureFromCamera}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(115deg,#3d6bb8_12%,#2d9db0_92%)] px-4 py-3.5 text-sm font-semibold text-white shadow-[0_10px_38px_-12px_rgb(61_107_184/62%)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="text-lg" aria-hidden>
              ✂️
            </span>
            今日の見ため％を算出
          </button>

          <button
            type="button"
            disabled={modelsBusy || !!modelError || phase === 'analyzing'}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-slate-200/95 bg-white/90 px-4 py-3.5 text-sm font-semibold text-slate-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="text-lg" aria-hidden>
              🖼️
            </span>
            写真を選ぶ
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            className="hidden"
            onChange={onPickFile}
          />
        </div>

        {analyzeError && (
          <p className="mt-4 rounded-xl border border-amber-200/95 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-950">
            {analyzeError}
          </p>
        )}

        {phase === 'analyzing' && (
          <div className="mt-6 flex items-center gap-4 rounded-2xl border border-teal-soft/80 bg-teal-soft/60 px-4 py-4 text-sm font-medium text-slate-700">
            <span
              className="inline-block h-8 w-8 shrink-0 animate-spin rounded-full border-4 border-teal-soft/40 border-l-[#3d67c4] border-t-[#3496b8]"
              aria-hidden
            />
            <span>
              解析中です…眉より上までの質感統計から、％にマッピングしています。
            </span>
          </div>
        )}

        <div className="mt-8 grid gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold text-slate-800">最新の頭頂コンディション（見ため％）</h2>
            {lastDetail?.hairLikeness != null && phase !== 'analyzing' && (
              <span className="rounded-full bg-slate-900/85 px-2.5 py-0.5 text-[11px] font-medium text-teal-soft">
                質感側の読み（補助） {(lastDetail.hairLikeness * 100).toFixed(0)}
              </span>
            )}
          </div>

          <div className="flex items-end justify-between gap-3 rounded-2xl bg-[linear-gradient(115deg,#0f172af2_22%,#1d4fa4e6)] px-6 py-7 text-teal-soft shadow-inner">
            <div>
              {latestRate == null ? (
                <span className="text-6xl font-bold tabular-nums text-white opacity-95">―</span>
              ) : (
                <span className="bg-gradient-to-b from-teal-soft to-teal-soft/70 bg-clip-text text-[3.85rem] font-black leading-none tracking-tighter text-transparent sm:text-[4.75rem]">
                  {latestRate}
                </span>
              )}
            </div>
            <span className="pb-4 text-xl font-semibold text-white">%</span>
          </div>

          <details className="group mt-4 rounded-xl border border-blue-100/90 bg-blue-50/40 px-5 py-2 text-[13px] text-slate-700 backdrop-blur">
            <summary className="cursor-pointer py-3 font-semibold text-slate-900 outline-none transition group-open:pb-2">
              この％は具体的に何を示していますか？&nbsp;
              <span className="font-normal text-slate-600">▼</span>
            </summary>
            <div className="space-y-3 pb-4 text-left text-sm leading-relaxed text-slate-600 [&_strong]:font-semibold [&_strong]:text-slate-800">
              <p>
                ご自身の頭頂部がどれだけ「抜け感が増して見える状態」へ寄っているか、その<strong>見える印象を数字に寄せたざっくり指標です。</strong>{' '}
                単体の％で医学的進行や「いく％薄くなっているか」を証明することは<strong>ありません。</strong>{' '}
                複数枚を同じ環境・距離・角度ではかると自分のログとして意味が増えます。
              </p>
              <p>
                <strong>分析のしくみ：</strong>{' '}
                ブラウザ上で<strong>お顔の位置を自動検知</strong>し、<strong>眉より少し上〜頭頂が写っている帯だけ</strong>を切り出します。そのグレースケールについて、細かく変化があるか（細い毛束・影の境目などをエッジで捉えるための差分・コントラスト）と、明暗の総体傾向を足しあわせ、
                「この一枚では<strong>フラット〜なめらかな反射感</strong>が優勢だったか」「<strong>毛の質感の細やかさが優勢</strong>だったか」を内部でざっくり区別できるように％へ割り振っています。
              </p>
              <p>
                <strong>％としての読み方：</strong>{' '}
                数値が<strong>高め</strong> → 質感側でいう細かさより、<strong>一枚の写真上ではスムーズで反射がまとわりやすい見え方側</strong>にアルゴリズムが分類しました（「頭皮寄り」の見える印象）。
                数値が<strong>低め</strong> → <strong>毛の質感が細やかく写り込んだ側に分類しました</strong>（「それっぽい密度」の見える印象）。
                逆光・フラッシュ・アングルを変えると数値も大きく動くため、その度に「今日の状態の参考」までに留められます。
              </p>
            </div>
          </details>

          <details className="group mt-6 rounded-xl border border-slate-200/95 bg-teal-soft/45 px-5 py-2 text-[13px] text-slate-700">
            <summary className="cursor-pointer py-3 font-semibold text-slate-800 outline-none transition group-open:pb-2">
              より読みやすい結果を得るコツ&nbsp;
              <span className="text-slate-500">▼</span>
            </summary>
            <div className="space-y-4 pb-3 text-left text-sm leading-relaxed text-slate-600">
              <div>
                <p className="font-semibold text-slate-800">照明</p>
                <ul className="mt-2 list-disc space-y-1 pl-[1.05rem]">
                  <li>自然光または十分明るい室内灯の正面から撮る</li>
                  <li>逆光を避ける（頭が暗く質感情報が欠ける）</li>
                  <li>フラッシュオンだと質感過剰になりがち／オフでも十分明るければそれで安定</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-slate-800">撮影構図</p>
                <ul className="mt-2 list-disc space-y-1 pl-[1.05rem]">
                  <li>前髪ライン〜頭頂〜分け目付近まで写るように</li>
                  <li>できるだけ頭を傾げず<b className="font-medium text-slate-700">正面</b>構図</li>
                  <li>ズーム過多で質感情報がなくなるので、少し離れてシャープ確保</li>
                  <li>背景に白〜肌色の広い無地が頭に重なると読み込みズレがあるので避ける</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-slate-800">免責事項</p>
                <p className="mt-2">
                  <strong className="font-semibold text-slate-800">
                    薄毛進行そのものや AGA を診断できる医薬・アプリ機能ではなく、頭皮の状態を断定する製品でもありません。
                  </strong>
                  質感のみをヒューリスティックで換算しているエンタメ・セルフラグ用途であり、結果はあくまで目安です。
                  はっきりとした症状や不安がある場合は<strong className="font-semibold text-slate-800">皮膚科・専門医</strong>
                  で受診されてください。
                </p>
              </div>
            </div>
          </details>
        </div>
      </section>

      <section className="mt-10 rounded-3xl border border-white/90 bg-white/70 p-6 shadow-lg shadow-teal-soft/25 ring-1 ring-teal-soft/35 backdrop-blur">
        <h2 className="text-[15px] font-semibold text-slate-800">推移グラフ</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {history.length >= 5
            ? '生活リズムの変化の「目安」をつかめるよう、自動で過去ログを並べています（端末のみ保存）。'
            : '何度も測ってみましょう。履歴が増えるほど波形が読みやすくなります。'}
        </p>
        <div className="mt-6">
          <BaldTrendChart entries={history} />
        </div>

        <div className="mt-6 flex items-center justify-between gap-4 border-t border-slate-100/90 pt-5">
          <p className="text-xs text-slate-500">{statusMessage}</p>
          <button
            type="button"
            onClick={onResetHistory}
            disabled={!history.length}
            className="rounded-xl border border-rose-200/90 bg-white px-4 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-35"
          >
            履歴をリセット
          </button>
        </div>
      </section>

      <footer className="mx-auto mt-12 max-w-md text-center text-[11px] leading-relaxed text-slate-500">
        「頭頂コンディション」は、頭頂部画像の質感のみから算出した<strong className="font-medium text-slate-600">
          写真ベース・見ための％指標です。
        </strong>
        「薄い・濃い」そのものというより、質感側に寄った見えかたに対するカウンターに近く、結果に対する確定的な評価は行いません。オープンモデルの読み込みは jsDelivr 経由の face-api の重みを利用します。
        <br />
        <span className="mt-1 inline-block opacity-85">
          © {new Date().getFullYear()} 頭頂コンディション demo
        </span>
      </footer>
    </div>
  )
}

export default App
