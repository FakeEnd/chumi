const video = document.querySelector('video');
const canvas = document.createElement('canvas'), thumbnail = document.createElement('canvas');
thumbnail.width = 64; thumbnail.height = 48;
const small = thumbnail.getContext('2d', { willReadFrequently: true });
let stream, previous, previousWidth, previousHeight;

async function capture(force) {
  if (!stream) {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { width: { max: 1600 }, height: { max: 1000 }, frameRate: { max: 1 } } });
    video.srcObject = stream;
    await video.play();
  }
  if (stream.getVideoTracks()[0]?.readyState !== 'live') return { error: 'window_not_found' };
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return { error: 'capture_not_ready' };
  const scale = Math.min(1, 1600 / video.videoWidth, 1000 / video.videoHeight);
  const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
  small.drawImage(video, 0, 0, 64, 48);
  const pixels = small.getImageData(0, 0, 64, 48).data;
  const grey = new Uint8Array(64 * 48);
  let sum = 0, changed = !previous || previousWidth !== width || previousHeight !== height;
  for (let i = 0; i < grey.length; i++) {
    grey[i] = Math.round(pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114);
    sum += grey[i];
    if (previous && grey[i] !== previous[i]) changed = true;
  }
  const result = { width, height, thumb: btoa(String.fromCharCode(...grey)), mean: sum / grey.length };
  if (force || changed) {
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);
    result.image = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  }
  previous = grey; previousWidth = width; previousHeight = height;
  return result;
}
window.chumiCapture = { capture };
