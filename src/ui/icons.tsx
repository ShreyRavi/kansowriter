// 18px, 1.5-stroke icons from the design canvas; decorative (aria-hidden), labels live on the buttons.
const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 18 18',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  'aria-hidden': true,
};

export const MenuIcon = () => (
  <svg {...base}>
    <path d="M2 4.5h14M2 9h14M2 13.5h9" />
  </svg>
);
export const FocusIcon = () => (
  <svg {...base}>
    <circle cx="9" cy="9" r="6.5" />
    <circle cx="9" cy="9" r="2" />
  </svg>
);
export const MoonIcon = () => (
  <svg {...base} strokeLinejoin="round">
    <path d="M14.5 10.5A6 6 0 0 1 7.5 3.5a6 6 0 1 0 7 7z" />
  </svg>
);
export const SunIcon = () => (
  <svg {...base}>
    <circle cx="9" cy="9" r="3.5" />
    <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4" />
  </svg>
);
export const SearchIcon = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="5" />
    <path d="M12 12l3.5 3.5" />
  </svg>
);
export const PlusIcon = () => (
  <svg {...base}>
    <path d="M9 3v12M3 9h12" />
  </svg>
);
export const CloseIcon = () => (
  <svg {...base}>
    <path d="M4 4l10 10M14 4L4 14" />
  </svg>
);
export const MoreIcon = () => (
  <svg {...base}>
    <circle cx="4" cy="9" r="1.2" />
    <circle cx="9" cy="9" r="1.2" />
    <circle cx="14" cy="9" r="1.2" />
  </svg>
);
export const EnvelopeIcon = () => (
  <svg {...base} strokeLinejoin="round">
    <rect x="2" y="4" width="14" height="10" rx="1.5" />
    <path d="M2.5 4.8 9 10l6.5-5.2" />
  </svg>
);
