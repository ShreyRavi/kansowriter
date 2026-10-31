import { useEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from 'react';
// Recorded from the real app by scripts/record-demo.ts. Imported (not in public/) so the files get
// content-hashed names (/assets/demo-*, cached as immutable in vercel.json); the service worker
// never precaches them (vite.config.ts globIgnores).
import paperPoster from './demo/demo-paper.webp';
import nightPoster from './demo/demo-night.webp';
import writePaper from './demo/demo-step-write-paper.webp';
import writeNight from './demo/demo-step-write-night.webp';
import sendPaper from './demo/demo-step-send-paper.webp';
import sendNight from './demo/demo-step-send-night.webp';
import readPaper from './demo/demo-step-read-paper.webp';
import readNight from './demo/demo-step-read-night.webp';

type Theme = 'paper' | 'night';

const MEDIA = {
  paper: { poster: paperPoster, steps: [writePaper, sendPaper, readPaper] },
  night: { poster: nightPoster, steps: [writeNight, sendNight, readNight] },
} satisfies Record<Theme, unknown>;

/** the recorded frame: 960 × 600 CSS px, encoded at 1280 × 800 */
const VIDEO_W = 1280;
const VIDEO_H = 800;
/** the step screenshots: 760 × 475 CSS px crops, saved at 1140 × 713 */
const STEP_W = 1140;
const STEP_H = 713;

/** The macOS app ships its files inside the .app: it shows the poster, not the video. */
const DESKTOP = import.meta.env.MODE === 'desktop';
type Videos = Record<Theme, { mp4: string; webm: string }>;
/** the video files' chunk (demoVideos.ts), retried once like the app's other chunks */
const loadVideos: (() => Promise<Videos>) | null = DESKTOP
  ? null
  : () => import('./demoVideos').catch(() => import('./demoVideos')).then((m) => m.VIDEOS);

const LETTER =
  'Hello, old friend, The tomatoes finally came in. I ate the first one standing in the garden, still warm from the sun. ' +
  'I keep thinking about our walk by the river last spring. Let’s do it again before the leaves turn. Write back when you can. No hurry.';

/** The theme the page shows (data-theme: the app's Light/Dark choice, or the device's setting). */
function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'night' ? 'night' : 'paper');
export const useTheme = () => useSyncExternalStore(subscribeTheme, currentTheme, () => 'paper' as Theme);

const REDUCE = '(prefers-reduced-motion: reduce)';
function subscribeMotion(cb: () => void) {
  const mq = matchMedia(REDUCE);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const useReducedMotion = () =>
  useSyncExternalStore(
    subscribeMotion,
    () => matchMedia(REDUCE).matches,
    () => false,
  );

/**
 * The silent demo loop. Nothing loads until it is near the viewport (no sources, no poster); it
 * plays muted while in view and pauses out of view. Under reduced motion it never starts on its
 * own: the poster shows with a Play button. Pause / Play is always there (WCAG 2.2.2).
 */
function DemoVideo({ theme }: { theme: Theme }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reduce = useReducedMotion();
  const [near, setNear] = useState(false);
  const [videos, setVideos] = useState<Videos | null>(null);
  const [inView, setInView] = useState(false);
  /** the visitor's own choice: null until they press Pause or Play */
  const [choice, setChoice] = useState<'play' | 'pause' | null>(null);
  const [playing, setPlaying] = useState(false);
  const wantPlay = choice === 'play' || (choice === null && !reduce);
  const media = MEDIA[theme];

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return void setNear(true);
    const loader = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { rootMargin: '400px 0px' });
    const watcher = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { threshold: 0.25 });
    loader.observe(el);
    watcher.observe(el);
    return () => {
      loader.disconnect();
      watcher.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!near || !loadVideos) return;
    let alive = true;
    loadVideos().then(
      (v) => alive && setVideos(v),
      () => {}, // offline before it was ever fetched: the frame stays empty, the steps below still read
    );
    return () => {
      alive = false;
    };
  }, [near]);

  const shouldPlay = near && wantPlay && inView;
  const shouldPlayRef = useRef(shouldPlay);
  shouldPlayRef.current = shouldPlay;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !near) return;
    v.muted = true; // React doesn't reflect `muted` reliably; autoplay needs it set
    if (shouldPlay) v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [near, shouldPlay, theme, videos]);

  /**
   * A play() made while the video is still choosing a source or fetching its first frames can be
   * dropped (WebKit does this on a fast first load, now that the demo sits in the hero): try again
   * once it can play, if it still should.
   */
  const retryPlay = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (shouldPlayRef.current && v.paused) v.play().catch(() => setPlaying(false));
  };

  const toggle = () => {
    const next = playing ? 'pause' : 'play';
    setChoice(next);
    // a press is a user gesture: start right away, even if the frame is only partly in view
    if (next === 'play') void videoRef.current?.play().catch(() => setPlaying(false));
  };

  return (
    <figure className="demo-figure">
      <div ref={frameRef} className="demo-frame">
        {DESKTOP ? (
          <img src={media.poster} width={VIDEO_W} height={VIDEO_H} alt="" aria-describedby="demo-desc" />
        ) : (
          videos && (
            <video
              key={theme}
              ref={videoRef}
              data-theme-variant={theme}
              width={VIDEO_W}
              height={VIDEO_H}
              poster={media.poster}
              muted
              loop
              playsInline
              preload="none"
              aria-label="Demo video: a letter is written, sent as a link and replayed"
              aria-describedby="demo-desc"
              onCanPlay={retryPlay}
              onLoadedData={retryPlay}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            >
              <source src={videos[theme].webm} type="video/webm; codecs=vp9" />
              <source src={videos[theme].mp4} type="video/mp4" />
            </video>
          )
        )}
      </div>
      <figcaption className="demo-bar ui">
        <span>A letter, written, sent as a link and replayed.</span>
        {!DESKTOP && (
          <button
            type="button"
            className="text-btn"
            aria-label={playing ? 'Pause the demo' : 'Play the demo'}
            onClick={toggle}
            disabled={!videos}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
        )}
      </figcaption>
      <p id="demo-desc" className="sr-only">
        A short silent recording of Kansowriter. A letter is typed into an empty page, with a pause and one word rewritten: {LETTER} Send as
        letter opens a preview and the link is copied. The link opens the letter in the reader, which replays it the way it was typed.
      </p>
    </figure>
  );
}

const STEPS = [
  {
    title: 'Write',
    text: 'Write as you always do. Your draft, and the timing of each word, stay on your device.',
    alt: 'The editor with a short letter on the page.',
  },
  {
    title: 'Send as letter',
    text: 'The envelope above the page packs the whole letter into the link itself. Nothing is uploaded or kept on a server, and anyone with the link can read it.',
    alt: 'The Send as letter panel: a preview of the letter above a Copy link button.',
  },
  {
    title: 'They watch it unfold',
    text: 'The link opens a reader that replays the letter as it was written: the pauses, and the words you changed.',
    alt: 'The reader replaying the letter, halfway through a sentence.',
  },
];

/** The demo loop in the hero, under the line (homepage only). */
export function HeroDemo() {
  const theme = useTheme();
  return (
    <div className="demo">
      <DemoVideo theme={theme} />
    </div>
  );
}

/** Below the hero: three small steps (homepage only). */
export function HowLetters() {
  const theme = useTheme();
  return (
    <section id="how" className="how" aria-labelledby="how-title">
      <h2 id="how-title">How letters work</h2>
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <img src={MEDIA[theme].steps[i]} width={STEP_W} height={STEP_H} alt={s.alt} loading="lazy" decoding="async" />
            <div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
