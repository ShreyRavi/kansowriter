// After `tauri build`: put the macOS app at dist/mac/Kansowriter.app, replacing an older copy.
// Only dist/mac is touched, so the web build in dist/web stays as it was.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const from = 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Kansowriter.app';
const to = 'dist/mac/Kansowriter.app';

if (!existsSync(from)) {
  console.error(`No app at ${from}: run tauri build first`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
mkdirSync('dist/mac', { recursive: true });
// ditto keeps the bundle's symlinks, permissions and signature intact
execFileSync('ditto', [from, to]);
console.log(`Copied ${to}`);
