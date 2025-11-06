// マイク音声取得とWeb Audio APIの使用例

let audioContext;
let analyser;
let microphone;
let dataArray;
let frequencyData;
let animationId;
let isRecording = false;
let isRecordingData = false;
let recordingStartTime = 0;
let frequencyHistory = []; // [{time: 秒, frequency: Hz}, ...]
let ambulanceHighHistory = [];
let ambulanceLowHistory = [];

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recordBtn = document.getElementById('recordBtn');
const stopRecordBtn = document.getElementById('stopRecordBtn');
const clearRecordBtn = document.getElementById('clearRecordBtn');
const statusElem = document.getElementById('status');
const recordStatus = document.getElementById('recordStatus');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

const plotCanvas = document.getElementById('plotCanvas');
const plotCtx = plotCanvas.getContext('2d');
// const dominantFreqSpan = document.getElementById('dominantFreq');
const ambulanceSpeedSpan = document.getElementById('ambulanceSpeed');
const roadDistanceSpan = document.getElementById('roadDistance');
const passTimeSpan = document.getElementById('passTime');
const fundamentalFreqSpan = document.getElementById('fundamentalFreq');

// #canvasContainer に追加し、サイズを同期
(function initCanvases() {
    const container = document.getElementById('canvasContainer');
    if (container) {
        // 既存の同ID要素があれば入れ替え
        const prevPlot = document.getElementById('plotCanvas');
        const prevVis = document.getElementById('visualizer');
        if (prevPlot && prevPlot !== plotCanvas) prevPlot.remove();
        if (prevVis && prevVis !== canvas) prevVis.remove();
        container.appendChild(plotCanvas);
        container.appendChild(canvas);
    }
    syncCanvasSize(plotCanvas, plotCtx);
    syncCanvasSize(canvas, canvasCtx);
})();

const minFreq = 700;
const maxFreq = 1000;
const maxmaxFreq = 20000;
const ambulanceHighFreq = 960;
const ambulanceLowFreq = 770;

// m/sをkm/hにするには3.6をかける
let estimation = {
    v_amb: 30.0, // km/h
    road_dist: 5.0, // m
    t0: 0.0 // s
};
let firstHightRecordTime = 0;
let firstLowRecordTime = 0;

// function syncCanvasSize(canvas, ctx) {
//     const dpr = window.devicePixelRatio || 1;
//     const cssW = Math.floor(canvas.clientWidth);
//     const cssH = Math.floor(canvas.clientHeight);
//     canvas.width = Math.max(1, cssW * dpr);
//     canvas.height = Math.max(1, cssH * dpr);
//     ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // スケールをCSSピクセル基準に
//   }
  
  // 使い方
  syncCanvasSize(canvas, canvasCtx);
  syncCanvasSize(plotCanvas, plotCtx);

// マイクの開始
async function startMicrophone() {
    try {
        // マイクへのアクセス許可を取得
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });

        // AudioContextを作成（Web Audio API）
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        microphone = audioContext.createMediaStreamSource(stream);
        
        // 分析用の設定（より高い解像度で周波数分析）
        analyser.fftSize = 4096; //FFTのサイズ、サンプル数
        const bufferLength = analyser.frequencyBinCount; //FFTの周波数ビン、fftSize/2
        dataArray = new Uint8Array(bufferLength); //getByteTimeDomainData()で取得する時間領域の波形データを格納する配列
        frequencyData = new Uint8Array(bufferLength); //getByteFrequencyData()で取得する周波数領域のスペクトルデータを格納する配列

        // マイクの音声を分析器に接続
        microphone.connect(analyser);

        isRecording = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        recordBtn.disabled = false;
        statusElem.textContent = 'マイクが有効です。音声を検出しています...';

        // 可視化を開始
        visualize();

    } catch (error) {
        console.error('マイクの取得に失敗しました:', error);
        statusElem.textContent = 'エラー: ' + error.message;
        alert('マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。');
    }
}

// マイクの停止
function stopMicrophone() {
    if (isRecording) {
        isRecording = false;
        cancelAnimationFrame(animationId);
        
        if (microphone) {
            microphone.disconnect();
        }
        if (audioContext) {
            audioContext.close();
        }

        startBtn.disabled = false;
        stopBtn.disabled = true;
        recordBtn.disabled = true;
        stopRecordBtn.disabled = true;
        isRecordingData = false;
        status.textContent = 'マイクが停止しました';

        // キャンバスをクリア
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    }
    stopRecording();
    clearRecording();
}

// 記録の開始
function startRecording() {
    if (!isRecording) return;
    isRecordingData = true;
    recordingStartTime = performance.now() / 1000; // 秒単位
    frequencyHistory = [];
    ambulanceHighHistory = [];
    ambulanceLowHistory = [];
    recordBtn.disabled = true;
    stopRecordBtn.disabled = false;
    recordStatus.textContent = '記録中...';
}

// 記録の停止
function stopRecording() {
    isRecordingData = false;
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    recordStatus.textContent = '';
    if (frequencyHistory.length > 0) {
        clearRecordBtn.disabled = false;
    }
    plotFrequencyHistory();
}

// 記録のクリア
function clearRecording() {
    frequencyHistory = [];
    ambulanceHighHistory = [];
    ambulanceLowHistory = [];
    estimation = {
        v_amb: 30.0,
        road_dist: 5.0,
        t0: 0.0
    };
    recordingStartTime = 0;
    firstHightRecordTime = 0;
    firstLowRecordTime = 0;
    recordStatus.textContent = '記録をクリアしました';
    plotCtx.clearRect(0, 0, plotCanvas.width, plotCanvas.height);
    clearRecordBtn.disabled = true;
    ambulanceSpeedSpan.textContent = '-';
    roadDistanceSpan.textContent = '-';
    passTimeSpan.textContent = '-';
}

// 救急車が自分からroad_distance離れた道路の位置xを負から正に一定速度v_sourceで移動
// freqObs = v / (v + v_source * cos(atan(v_source * (t - t0)
// 
function dopplerEffect(freq_s, t, v_source, road_distance, t0, v_sound = 340) {
    const dist = Math.sqrt(road_distance**2 + v_source**2 * (t - t0)**2);
    const cos = v_source * (t - t0) / dist;
    return v_sound / (v_sound + v_source * cos) * freq_s;
}

function axisX(x, y) {
    const x1 = x[0];
    const x2 = x[1];
    const x3 = x[2];
    const y1 = y[0];
    const y2 = y[1];
    const y3 = y[2];
    if (x1 == x2 || x2 == x3 || x1 == x3) {
        console.log('duplicate x');
        return x2;
    }
    const m1 = (y2 - y1) / (x2 - x1);
    const m2 = (y3 - y2) / (x3 - x2);
    if (Math.abs(m1 - m2) < 1e-6) {
        console.log('parallel lines');
        return x2;
    }
    const a = (m2 - m1) / (x3 - x1);
    const b = m1 - a * (x1 + x2);
    const axis_x = -b / (2 * a);
    return axis_x;
}

function nextValue(xs, errors) {
    if (errors[0] > errors[1] && errors[1] < errors[2]) {
        return axisX(xs, errors);
    } else if (errors[0] < errors[1] && errors[1] < errors[2]) {
        return xs[0];
    } else if (errors[0] > errors[1] && errors[1] > errors[2]) {
        return xs[2];
    } else if (errors[0] < errors[1] && errors[1] > errors[2]) {
        return errors[0] < errors[2] ? xs[0] : xs[2];
    }
    return axisX(xs, errors);
}

function calculateError(v_amb, road_dist, t0) {
    let errorHigh = 0.0;
    for (let obs of ambulanceHighHistory) {
        const estimationHigh = dopplerEffect(ambulanceHighFreq, obs.time, v_amb, road_dist, t0);
        errorHigh += (estimationHigh - obs.frequency)**2;
    }
    let errorLow = 0.0;
    for (let obs of ambulanceLowHistory) {
        const estimationLow = dopplerEffect(ambulanceLowFreq, obs.time, v_amb, road_dist, t0);
        errorLow += (estimationLow - obs.frequency)**2;
    }
    return (errorHigh + errorLow) / (ambulanceHighHistory.length + ambulanceLowHistory.length);
}

function roughEstimation(n, v_amb, road_dist, t0, v_range, dist_range, t0_range) {
    const num_data = ambulanceHighHistory.length + ambulanceLowHistory.length;
    if (num_data === 0) {
        return null;
    }
    const m = 2 * n + 1
    const dv = v_range / 3.6 / n;
    const droad_dist = dist_range / n;
    const dt0 = t0_range / n;
    const v_ambs = Array.from({length: m}, (_, i) => v_amb + dv * (i - n));
    const road_dists = Array.from({length: m}, (_, i) => road_dist + droad_dist * (i - n));
    const t0s = Array.from({length: m}, (_, i) => t0 + dt0 * (i - n));
    const errors = [];
    for (let i = 0; i < m; i++) {
        const error = calculateError(v_ambs[i], road_dists[i], t0s[i]);
        if (Number.isFinite(error)) {
            errors.push({v_amb: v_ambs[i], road_dist: road_dists[i], t0: t0s[i], error: error});
        }
    }
    const sortedErrors = errors.sort((a, b) => a.error - b.error);
    const best = sortedErrors[0];
    return { v_amb: best.v_amb, road_dist: best.road_dist, t0: best.t0 };
}

function dopplerFitting(v_amb_input, road_dist_input, t0_input) {
    let v_amb = v_amb_input;
    let road_dist = road_dist_input;
    let t0 = t0_input;
    let dv = 20.0;
    let droad_dist = 5.0;
    let dt0 = 100.0;
    const rough = roughEstimation(4, v_amb, road_dist, t0, dv, droad_dist, dt0);
    if (rough) {
        v_amb = rough.v_amb;
        road_dist = rough.road_dist;
        t0 = rough.t0;
    }
    let v_ambs = [v_amb - dv, v_amb, v_amb + dv];
    let road_dists = [road_dist - droad_dist, road_dist, road_dist + droad_dist];
    let t0s = [t0 - dt0, t0, t0 + dt0];
    let errors = [];
    const denom = (ambulanceHighHistory.length + ambulanceLowHistory.length);
    if (denom === 0) {
        return null;
    }
    for (let i = 0; i < 6; i++) {
        // for (let j = 0; j < 3; j++) {
        //     const error = calculateError(v_ambs[j], road_dist, t0);
        //     if (Number.isFinite(error)) {
        //         errors.push(error);
        //     }
        // }
        // v_amb = nextValue(v_ambs, errors);
        // if (v_amb < 0) {
        //     v_amb *= -1;
        //     t0 *= -1;
        //     t0s = [t0 - dt0, t0, t0 + dt0];
        // }
        // v_ambs = [v_amb - dv, v_amb, v_amb + dv];
        
        // for (let j = 0; j < 3; j++) {
        //     const error = calculateError(v_amb, road_dists[j], t0);
        //     if (Number.isFinite(error)) {
        //         errors.push(error);
        //     }
        // }
        // road_dist = nextValue(road_dists, errors);
        // if (road_dist < 0) {
        //     road_dist *= -1;
        // }
        // road_dists = [road_dist - droad_dist, road_dist, road_dist + droad_dist];

        // for (let j = 0; j < 3; j++) {
        //     const error = calculateError(v_amb, road_dist, t0s[j]);
        //     if (Number.isFinite(error)) {
        //         errors.push(error);
        //     }
        // }
        // t0 = nextValue(t0s, errors);
        // t0s = [t0 - dt0, t0, t0 + dt0];
        const newRough = roughEstimation(4, v_amb, road_dist, t0, dv, droad_dist, dt0);
        if (newRough) {
            v_amb = newRough.v_amb;
            road_dist = newRough.road_dist;
            t0 = newRough.t0;
        }
        if (v_amb < 0) {
            v_amb *= -1;
            t0 *= -1;
        }
        if (road_dist < 0) {
            road_dist *= -1;
        }

        if (Math.abs(v_amb - v_ambs[1]) < dv) {
            // console.log(`${i} v stable: ${v_amb.toFixed(3)} ${dv.toFixed(3)}`);
            dv *= 0.6
        }
        if (Math.abs(road_dist - road_dists[1]) < droad_dist) {
            // console.log(`${i} dist stable: ${road_dist.toFixed(3)} ${droad_dist.toFixed(3)}`);
            droad_dist *= 0.6;
        }
        if (Math.abs(t0 - t0s[1]) < dt0) {
            // console.log(`${i} time stable: ${t0.toFixed(3)} ${dt0.toFixed(3)}`);
            dt0 *= 0.6;
        }
    }

    return { v_amb: v_amb, road_dist: road_dist, t0: t0 };
}

// 周波数を計算する関数
// function calculateFrequency(frequencyData, sampleRate) {
//     // 周波数データから最大振幅のインデックスを見つける
//     let maxValue = 0;
//     let maxIndex = 0;
    
//     // 人間の可聴範囲（20Hz～20kHz）に絞る
//     const minFreqIndex = 0;
//     const maxFreqIndex = Math.min(frequencyData.length, Math.floor(maxmaxFreq * analyser.fftSize / sampleRate));
    
//     for (let i = minFreqIndex; i < maxFreqIndex; i++) {
//         if (frequencyData[i] > maxValue) {
//             maxValue = frequencyData[i];
//             maxIndex = i;
//         }
//     }
    
//     // インデックスを実際の周波数に変換
//     const frequency = (maxIndex * sampleRate) / analyser.fftSize;
    
//     return {
//         frequency: frequency,
//         amplitude: maxValue,
//         index: maxIndex
//     };
// }

// 主要周波数を計算（複数のピークから基本周波数を推定）
// 注意: これは簡易的な方法で、最大振幅の周波数を返します
// より正確な基本周波数検出には、オートコリレーション法などが必要です
function findDominantFrequency(frequencyData, sampleRate) {
    const nyquist = sampleRate / 2;
    const binSize = nyquist / frequencyData.length;
    
    // 人間の声や楽器の音域（80Hz～2000Hz）に絞る
    const minIndex = Math.floor(minFreq / binSize);
    const maxFreqIndex = Math.floor(maxFreq / binSize);
    
    let maxValue = 0;
    let dominantIndex = minIndex;
    
    for (let i = minIndex; i < maxFreqIndex && i < frequencyData.length; i++) {
        if (frequencyData[i] > maxValue) {
            maxValue = frequencyData[i];
            dominantIndex = i;
        }
    }
    
    const frequency = dominantIndex * binSize;
    return frequency;
}

// より正確な基本周波数検出（自己相関：時間領域データを使用）
// うまくいってない
function findFundamentalFrequency(timeDomainData, sampleRate, minFrequency, maxFrequency) {
	const size = timeDomainData.length;
	if (!size || !sampleRate) return 0;

	// 1) Uint8(0..255) -> Float32(-1..1)
	const buffer = new Float32Array(size);
	let sum = 0;
	for (let i = 0; i < size; i++) {
		const v = (timeDomainData[i] - 128) / 128;
		buffer[i] = v;
		sum += v;
	}

	// 2) DC除去とレベルチェック
	const mean = sum / size;
	let rms = 0; // 平均値との差の2乗の和の平方根
	for (let i = 0; i < size; i++) {
		const d = buffer[i] - mean;
		buffer[i] = d;
		rms += d * d;
	}
	rms = Math.sqrt(rms / size);
	if (rms < 0.005) return 0;

	// 3) 探索ラグ範囲（80~2000Hz）
	const minLag = Math.max(1, Math.floor(sampleRate / maxFrequency));
	const maxLag = Math.min(size - 1, Math.floor(sampleRate / minFrequency));
	if (minLag >= maxLag) return 0;

	// 4) 自己相関を計算（指定範囲）
	const acf = new Float32Array(maxLag + 1);
	for (let lag = minLag; lag <= maxLag; lag++) {
		let corr = 0;
        const effectiveSize = size - lag;
        if (effectiveSize <= 0) continue;
		for (let i = 0; i < size - lag; i++) {
			corr += buffer[i] * buffer[i + lag];
		}
		acf[lag] = corr / effectiveSize;
	}

	// 5) 最初のディップ後の局所最大 or 範囲内最大
	let peakLag = -1;
	let peakVal = -Infinity;
	let prev = acf[minLag];
	let rising = false;
	for (let lag = minLag + 1; lag <= maxLag - 1; lag++) {
		const curr = acf[lag];
		if (curr > prev) {
			rising = true;
		} else if (rising && curr < prev) {
			// prev は局所最大
			if (prev > peakVal) {
				peakVal = prev;
				peakLag = lag - 1;
			}
			rising = false;
		}
		prev = curr;
	}
	if (peakLag <= 0) {
		for (let lag = minLag; lag <= maxLag; lag++) {
			if (acf[lag] > peakVal) {
				peakVal = acf[lag];
				peakLag = lag;
			}
		}
	}
	if (peakLag <= 0) return 0;

	return sampleRate / peakLag;
}

function findAmbulanceFrequency(frequencyData, sampleRate) {
    const nyquist = sampleRate / 2;
    const binSize = nyquist / frequencyData.length;
    
    // 救急車の周波数範囲（400Hz～1500Hz）に絞る
    const minAmbulanceFreq = 500;
    const maxAmbulanceFreq = 1200;
    const minIndex = Math.floor(minAmbulanceFreq / binSize);
    const maxFreqIndex = Math.floor(maxAmbulanceFreq / binSize);
    
    let maxValue = 0;
    let dominantIndex = minIndex;
    
    for (let i = minIndex; i < maxFreqIndex && i < frequencyData.length; i++) {
        if (frequencyData[i] > maxValue) {
            maxValue = frequencyData[i];
            dominantIndex = i;
        }
    }
    
    const frequency = dominantIndex * binSize;
    return frequency;
}

// 音声波形と周波数スペクトルの可視化
function visualize() {
    if (!isRecording) return;

    // 時間領域データを取得（波形表示用）
    analyser.getByteTimeDomainData(dataArray);
    
    // 周波数領域データを取得（周波数分析用）
    analyser.getByteFrequencyData(frequencyData);

    const sampleRate = audioContext.sampleRate;
    
    // 周波数を計算
    // 全周波数範囲（o~20kHz）で最も強い周波数を取得
    // const peakFreqInfo = calculateFrequency(frequencyData, sampleRate);
    // 80Hz~2000Hzの範囲で最も強い周波数を取得（最大振幅の周波数）
    const dominantFreq = findDominantFrequency(frequencyData, sampleRate);
    // より正確な基本周波数を推定（時間領域データを使用）
    const fundamentalFreq = findFundamentalFrequency(dataArray, sampleRate, minFreq, maxFreq);
    // 救急車が出しそうな周波数の範囲で最も強い周波数を取得
    const ambulanceFreq = findAmbulanceFrequency(frequencyData, sampleRate);
    
    // 周波数情報を表示
    // dominantFreqSpan.textContent = dominantFreq.toFixed(2);
    fundamentalFreqSpan.textContent = fundamentalFreq.toFixed(2);
    // peakFreqSpan.textContent = peakFreqInfo.frequency.toFixed(2);
    
    // 記録中の場合、周波数を記録
    if (isRecordingData) {
        const currentTime = (performance.now() / 1000) - recordingStartTime;
        if (frequencyHistory.length < 1000) {
            frequencyHistory.push({
                time: currentTime,
                frequency: fundamentalFreq, // 基本周波数を記録
                dominantFrequency: dominantFreq, // 最大振幅の周波数を記録
                ambulanceFrequency: ambulanceFreq // 救急車の周波数を記録
            });
        } else {
            frequencyHistory.shift();
            frequencyHistory.push({
                time: currentTime,
                frequency: fundamentalFreq, // 基本周波数を記録
                dominantFrequency: dominantFreq, // 最大振幅の周波数を記録
                ambulanceFrequency: ambulanceFreq // 救急車の周波数を記録
            });
        }

        if (Math.abs(ambulanceFreq - ambulanceHighFreq) < 50) {
            if (ambulanceHighHistory.length == 0) {
                estimation.v_amb = 340 * (ambulanceHighFreq / ambulanceFreq - 1);
                estimation.t0 = currentTime + 5.0;
                firstHightRecordTime = currentTime - recordingStartTime;
            }
            ambulanceHighHistory.push({
                time: currentTime,
                frequency: ambulanceFreq
            });
        } else if (Math.abs(ambulanceFreq - ambulanceLowFreq) < 70) {
            if (ambulanceLowHistory.length == 0) {
                if (estimation.t0 == 0) {
                    estimation.v_amb = 340 * (ambulanceLowFreq / ambulanceFreq - 1);
                    estimation.t0 = currentTime + 5.0;
                }
                firstLowRecordTime = currentTime - recordingStartTime;
            }
            ambulanceLowHistory.push({
                time: currentTime,
                frequency: ambulanceFreq
            });
        }
        const minTime = currentTime - 15.0;
        ambulanceHighHistory = ambulanceHighHistory.filter(d => d.time >= minTime);
        ambulanceLowHistory = ambulanceLowHistory.filter(d => d.time >= minTime);
        if (ambulanceHighHistory.length > 0 && firstHightRecordTime > 0) {
            ambulanceHighHistory = ambulanceHighHistory.filter(d => d.time >= firstHightRecordTime + 1.0);
        }
        if (ambulanceLowHistory.length > 0 && firstLowRecordTime > 0) {
            ambulanceLowHistory = ambulanceLowHistory.filter(d => d.time >= firstLowRecordTime + 1.0);
        }
        if (ambulanceHighHistory.length + ambulanceLowHistory.length > 0 && (ambulanceHighHistory.length + ambulanceLowHistory.length) % 20 == 0) {
            estimation = dopplerFitting(estimation.v_amb, estimation.road_dist, estimation.t0);
            const vDisp = Number.isFinite(estimation.v_amb) ? (estimation.v_amb * 3.6).toFixed(3) : '-'; // m/s -> km/h
            const dDisp = Number.isFinite(estimation.road_dist) ? estimation.road_dist.toFixed(3) : '-';
            // const tDisp = Number.isFinite(estimation.t0) ? estimation.t0.toFixed(3) : '-';
            ambulanceSpeedSpan.textContent = `${vDisp} km/h`;
            roadDistanceSpan.textContent = `${dDisp} m`;
            // passTimeSpan.textContent = `${tDisp} s`;
            if (Number.isFinite(estimation.t0)) {
                if (estimation.t0 > currentTime) {
                    passTimeSpan.textContent = `${(estimation.t0 - currentTime).toFixed(3)}秒後`;
                } else {
                    passTimeSpan.textContent = `${(currentTime - estimation.t0).toFixed(3)}秒前`;
                }
            } else {
                passTimeSpan.textContent = '-';
            }
        }
        
        // リアルタイムでプロットを更新（パフォーマンスを考慮して数フレームに1回）
        if (frequencyHistory.length % 5 === 0) {
            plotFrequencyHistory();
        }
    }
    
    // キャンバスをクリア
    canvasCtx.fillStyle = 'rgb(240, 240, 240)';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 上半分：周波数スペクトル
    const spectrumHeight = canvas.height / 2;
    const barWidth = canvas.width / frequencyData.length;
    let x = 0;
    
    canvasCtx.fillStyle = 'rgb(0, 123, 255)';
    for (let i = 0; i < frequencyData.length; i++) {
        const barHeight = (frequencyData[i] / 255) * spectrumHeight;
        
        // 主要周波数付近を強調表示
        const freq = (i * sampleRate) / analyser.fftSize;
        if (Math.abs(freq - dominantFreq) < 10) {
            canvasCtx.fillStyle = 'rgb(255, 0, 0)';
        } else {
            canvasCtx.fillStyle = 'rgb(0, 123, 255)';
        }
        
        canvasCtx.fillRect(x, spectrumHeight - barHeight, barWidth, barHeight);
        x += barWidth;
    }
    
    // 主要周波数に縦線を表示
    const freqLineX = (dominantFreq / (sampleRate / 2)) * canvas.width;
    canvasCtx.strokeStyle = 'rgb(255, 0, 0)';
    canvasCtx.lineWidth = 2;
    canvasCtx.beginPath();
    canvasCtx.moveTo(freqLineX, 0);
    canvasCtx.lineTo(freqLineX, spectrumHeight);
    canvasCtx.stroke();

    const freqLineX2 = (ambulanceFreq / (sampleRate / 2)) * canvas.width;
    canvasCtx.strokeStyle = 'rgb(0, 0, 255)';
    canvasCtx.lineWidth = 2;
    canvasCtx.beginPath();
    canvasCtx.moveTo(freqLineX2, 0);
    canvasCtx.lineTo(freqLineX2, spectrumHeight);
    canvasCtx.stroke();

    const freqLineX3 = (fundamentalFreq / (sampleRate / 2)) * canvas.width;
    canvasCtx.strokeStyle = 'rgb(0, 255, 0)';
    canvasCtx.lineWidth = 2;
    canvasCtx.beginPath();
    canvasCtx.moveTo(freqLineX3, 0);
    canvasCtx.lineTo(freqLineX3, spectrumHeight);
    canvasCtx.stroke();
    
    // 下半分：時間領域の波形
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = 'rgb(0, 123, 255)';
    canvasCtx.beginPath();

    const sliceWidth = canvas.width / dataArray.length;
    x = 0;

    for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = spectrumHeight + (v * spectrumHeight / 2);

        if (i === 0) {
            canvasCtx.moveTo(x, y);
        } else {
            canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
    }

    canvasCtx.stroke();
    
    // ラベルを表示
    canvasCtx.fillStyle = 'rgb(0, 0, 0)';
    canvasCtx.font = '14px Arial';
    canvasCtx.fillText('周波数スペクトル', 10, 20);
    canvasCtx.fillText('波形', 10, spectrumHeight + 20);
    
    // 音声レベルを計算して表示
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
    const level = Math.round((average / 128) * 100);
    canvasCtx.fillText(`音声レベル: ${level}%`, 10, spectrumHeight + 40);

    animationId = requestAnimationFrame(visualize);
}

// 周波数履歴をプロットする関数
function plotFrequencyHistory() {
    if (frequencyHistory.length === 0) return;
    
    const padding = 40;
    const plotWidth = plotCanvas.width - padding * 2;
    const plotHeight = plotCanvas.height - padding * 2;
    
    // キャンバスをクリア
    plotCtx.fillStyle = 'rgb(255, 255, 255)';
    plotCtx.fillRect(0, 0, plotCanvas.width, plotCanvas.height);
    
    if (frequencyHistory.length < 2) return;
    
    // データの範囲を計算
    const times = frequencyHistory.map(d => d.time);
    const minTime = performance.now() / 1000 - recordingStartTime - 15.0;
    const maxTime = performance.now() / 1000 - recordingStartTime;
    
    // 時間範囲が0の場合の処理
    const timeRange = maxTime - minTime;
    if (timeRange === 0) return;
    
    // グリッドと軸を描画
    plotCtx.strokeStyle = 'rgb(200, 200, 200)';
    plotCtx.lineWidth = 1;
    
    // 横線（周波数）
    const numGridLines = 5;
    for (let i = 0; i <= numGridLines; i++) {
        const y = padding + (plotHeight / numGridLines) * i;
        plotCtx.beginPath();
        plotCtx.moveTo(padding, y);
        plotCtx.lineTo(padding + plotWidth, y);
        plotCtx.stroke();
        
        const freq = maxFreq - (maxFreq - minFreq) * (i / numGridLines);
        plotCtx.fillStyle = 'rgb(100, 100, 100)';
        plotCtx.font = '12px Arial';
        plotCtx.fillText(freq.toFixed(0) + ' Hz', 5, y + 4);
    }
    
    // 縦線（時間）
    const numTimeLines = 10;
    for (let i = 0; i <= numTimeLines; i++) {
        const x = padding + (plotWidth / numTimeLines) * i;
        plotCtx.beginPath();
        plotCtx.moveTo(x, padding);
        plotCtx.lineTo(x, padding + plotHeight);
        plotCtx.stroke();
        
        const time = -timeRange * ((numTimeLines - i) / numTimeLines);
        plotCtx.fillStyle = 'rgb(100, 100, 100)';
        plotCtx.font = '12px Arial';
        plotCtx.fillText(time.toFixed(1) + 's', x - 15, plotCanvas.height - 5);
    }
    
    // データをプロット
    plotCtx.lineWidth = 2;
    
    const freqRangeForPlot = maxFreq - minFreq;
    
    // データポイントを描画
    function plotDataPoint(frequency, color) {
        plotCtx.fillStyle = color;
        for (let i = 0; i < frequencyHistory.length; i++) {
            const time = frequencyHistory[i].time;
            const x = padding + ((time - minTime) / timeRange) * plotWidth;
            const y = padding + plotHeight - ((frequency[i] - minFreq) / freqRangeForPlot) * plotHeight;
            
            plotCtx.beginPath();
            plotCtx.arc(x, y, 2, 0, Math.PI * 2);
            plotCtx.fill();
        }
    }
    function plotAmbulanceFrequency(ambulanceHistory, freq_source, color) {
        plotCtx.fillStyle = color;
        for (let i = 0; i < ambulanceHistory.length; i++) {
            const time = ambulanceHistory[i].time;
            const x = padding + ((time - minTime) / timeRange) * plotWidth;
            const y = padding + plotHeight - ((ambulanceHistory[i].frequency - minFreq) / freqRangeForPlot) * plotHeight;
            plotCtx.beginPath();
            plotCtx.arc(x, y, 2, 0, Math.PI * 2);
            plotCtx.fill();
        }
        const times = ambulanceHistory.map(d => d.time);
        const t_min = Math.min(...times);
        const t_max = Math.max(...times);
        plotCtx.strokeStyle = color;
        plotCtx.lineWidth = 1;
        for (let t = t_min; t < t_max; t += 0.1) {
            const fitting = dopplerEffect(freq_source, t, estimation.v_amb, estimation.road_dist, estimation.t0);
            const x = padding + ((t - minTime) / timeRange) * plotWidth;
            const y = padding + plotHeight - ((fitting - minFreq) / freqRangeForPlot) * plotHeight;
            if (t == t_min) {
                plotCtx.moveTo(x, y);
            } else {
                plotCtx.lineTo(x, y);
            }
        }
        plotCtx.stroke();
    }

    console.log(plotCanvas.width, plotCanvas.height);
    plotAmbulanceFrequency(ambulanceHighHistory, ambulanceHighFreq, 'rgb(0, 255, 0)');
    plotAmbulanceFrequency(ambulanceLowHistory, ambulanceLowFreq, 'rgb(0, 0, 255)');

    // タイトルとラベル
    plotCtx.fillStyle = 'rgb(0, 0, 0)';
    plotCtx.font = 'bold 16px Arial';
    plotCtx.fillText('周波数時系列グラフ', padding, 20);
    plotCtx.font = '12px Arial';
    plotCtx.fillText('時間 (秒)', plotCanvas.width / 2 - 30, plotCanvas.height - 10);
    plotCtx.save();
    plotCtx.translate(15, plotCanvas.height / 2);
    plotCtx.rotate(-Math.PI / 2);
    plotCtx.fillText('周波数 (Hz)', 0, 0);
    plotCtx.restore();
}

// イベントリスナー
startBtn.addEventListener('click', startMicrophone);
stopBtn.addEventListener('click', stopMicrophone);
recordBtn.addEventListener('click', startRecording);
stopRecordBtn.addEventListener('click', stopRecording);
clearRecordBtn.addEventListener('click', clearRecording);

// ページを離れる前に停止
window.addEventListener('beforeunload', stopMicrophone);



window.addEventListener('resize', () => {
    syncCanvasSize(plotCanvas, plotCtx);
    syncCanvasSize(canvas, canvasCtx);
});

function syncCanvasSize(el, ctx) {
    const displayWidth = el.clientWidth;
    const displayHeight = el.clientHeight;
    el.width = displayWidth;
    el.height = displayHeight;
    // ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

