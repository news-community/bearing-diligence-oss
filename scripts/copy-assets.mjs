// Files the gates, the download module and the page read at runtime. tsc copies no JSON, no page,
// no font and no image.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const copy = (from, to) => {
  const dest = join(root, "dist", to ?? from);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(root, from), dest);
};
for (const rel of ["src/gates/hosted-providers.json", "src/gates/plants.json", "src/download/manifest.json", "src/ui/app.html", "app/preload.cjs"]) {
  copy(rel);
}
// The page's fonts and mark sit beside it, so it reaches them by relative path and never by network:
// Fontsource's Geist and Newsreader (SIL Open Font License, each licence copied with its font), and
// the bear (MIT, Microsoft's Fluent Emoji, its notice in app/icon/).
const fonts = "node_modules/@fontsource-variable";
copy(`${fonts}/geist/files/geist-latin-wght-normal.woff2`, "src/ui/fonts/geist-latin-wght-normal.woff2");
copy(`${fonts}/geist/LICENSE`, "src/ui/fonts/LICENSE-geist.txt");
copy(`${fonts}/newsreader/files/newsreader-latin-wght-normal.woff2`, "src/ui/fonts/newsreader-latin-wght-normal.woff2");
copy(`${fonts}/newsreader/files/newsreader-latin-wght-italic.woff2`, "src/ui/fonts/newsreader-latin-wght-italic.woff2");
copy(`${fonts}/newsreader/LICENSE`, "src/ui/fonts/LICENSE-newsreader.txt");
copy("app/icon/bear.svg", "src/ui/icon/bear.svg");
copy("app/icon/LICENSE-fluent-emoji.txt", "src/ui/icon/LICENSE-fluent-emoji.txt");
copy("app/icon/bear-app-icon-1024.png", "app/icon/bear-app-icon-1024.png");
