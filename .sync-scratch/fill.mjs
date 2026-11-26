// Fills each locale catalog from the regenerated en.json: existing entries kept, new keys in English.
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

for (const app of ["web", "mobile", "desktop"]) {
  const dir = `apps/${app}`;
  const config = JSON.parse(fs.readFileSync(`${dir}/gt.config.json`, "utf8"));
  const file = (locale) => `${dir}/${config.files.gt.output.replace("[locale]", locale)}`;
  const en = JSON.parse(fs.readFileSync(file(config.defaultLocale), "utf8"));
  let added = 0;
  let dropped = 0;
  for (const locale of config.locales) {
    let old = {};
    try {
      old = JSON.parse(
        execFileSync("git", ["show", `HEAD:${file(locale)}`], { encoding: "utf8", maxBuffer: 1 << 28 }),
      );
    } catch {}
    const next = {};
    for (const [key, text] of Object.entries(en)) {
      if (Object.hasOwn(old, key)) next[key] = old[key];
      else {
        next[key] = text;
        added++;
      }
    }
    dropped += Object.keys(old).filter((key) => !Object.hasOwn(en, key)).length;
    fs.writeFileSync(file(locale), JSON.stringify(next, null, 2) + "\n");
  }
  console.log(`${app}: ${Object.keys(en).length} keys; filled ${added} locale entries with English; dropped ${dropped}`);
}
