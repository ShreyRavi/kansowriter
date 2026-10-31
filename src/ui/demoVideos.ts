// The homepage demo videos (scripts/record-demo.ts), in their own chunk: LandingDemo loads it when
// the demo nears the viewport. The macOS build never imports it, so the .app ships no video files.
import paperMp4 from './demo/demo-paper.mp4';
import paperWebm from './demo/demo-paper.webm';
import nightMp4 from './demo/demo-night.mp4';
import nightWebm from './demo/demo-night.webm';

export const VIDEOS = {
  paper: { mp4: paperMp4, webm: paperWebm },
  night: { mp4: nightMp4, webm: nightWebm },
};
