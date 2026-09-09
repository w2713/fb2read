/**
 * Где лежат состояние и настройки.
 *
 * На unix — по XDG, как у эталонной реализации, чтобы обе читали один и тот
 * же positions.json. На Windows XDG не в ходу, поэтому берутся принятые там
 * каталоги: настройки в APPDATA, данные в LOCALAPPDATA.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const APP = "fb2read";

const isWindows = process.platform === "win32";

/** Каталог с позициями чтения и закладками. */
export function dataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg) return join(xdg, APP);
  if (isWindows) {
    const local = process.env["LOCALAPPDATA"];
    if (local) return join(local, APP);
  }
  return join(homedir(), ".local", "share", APP);
}

/** Каталог с файлом настроек. */
export function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, APP);
  if (isWindows) {
    const roaming = process.env["APPDATA"];
    if (roaming) return join(roaming, APP);
  }
  return join(homedir(), ".config", APP);
}

/** Файл с позициями чтения. */
export function stateFile(): string {
  return join(dataDir(), "positions.json");
}

/** Файл настроек. */
export function configFile(): string {
  return join(configDir(), "config.ini");
}
