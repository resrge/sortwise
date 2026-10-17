# SortWise

Tidy a messy folder (like Downloads) in one click. SortWise scans the folder, shows you exactly where every file will go, then moves them into a destination folder you choose — and every run can be undone.

**v0.2.0**

## Run it

```bash
npm install
npm start
```

`npm test` runs the sorting logic tests (plain Node, no window).

## Build the installer (Windows)

Needs Node.js and [Inno Setup 6 or 7](https://jrsoftware.org/isinfo.php).

```powershell
.\build-installer.ps1
```

It stamps today's date as the build, installs dependencies, runs the tests, packages the app with electron-builder, then compiles `installer\SortWise.iss`. The result is `installer\Output\SortWise-Setup-<version>-build<date>.exe`.

Flags: `-Iscc "path\to\ISCC.exe"` (if it isn't found automatically), `-KeepBuild` (keep the current buildStamp), `-Clean` (wipe old output first), `-SkipTests`.
If PowerShell blocks the script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

## How it sorts

| Mode | Result |
|---|---|
| **File type** | `Images/`, `Documents/`, `Videos/`, `Audio/`, `Archives/`, `Installers/`, `Code/`, `Fonts/`, `Disk Images/`, `Torrents/`, `Other/` |
| **Extension** | `PDF/`, `ZIP/`, `PNG/`, `EXE/`… |
| **Similar names** | Only name groups, everything else in `Misc/` |

With **Group similar names** on, matching files get their own sub-folder inside their type folder:

```
Organized/
  Documents/
    Invoice/      invoice_2024-03.pdf, Invoice 2024-04 (1).pdf, invoice-final-v2.pdf
    notes.txt
  Installers/
    AutoUnzip/    AutoUnzip-Setup-0.6.1.exe, AutoUnzip-Setup-0.7.0.exe
  Images/
    Screenshot/   Screenshot 2026-10-01 101233.png, …
```

Names are matched after ignoring dates, version numbers, `(1)` / `copy` / `final` suffixes, and long number runs. "Files needed for a group" sets the minimum family size.

## Safety

- Nothing moves until you click **Organize**; untick any group or single file first.
- Only loose files at the top level are touched — existing sub-folders are left alone.
- Files still downloading (`.crdownload`, `.part`, `.tmp`…) and `desktop.ini` / `Thumbs.db` are skipped.
- Name clashes become `name (2).ext` — nothing is overwritten.
- Moves across drives fall back to copy + delete, keeping the modified date.
- **History & undo** keeps the last 25 runs, including auto-organized batches (stored in the app's userData folder).

## Automation

- **Watch this folder**: spots new files as they arrive. While watching, closing the window keeps SortWise in the tray (right-click the tray icon to quit).
- **Auto-organize new files**: moves each new file once it has finished downloading (its size stops changing and nothing has it open), using the same sort settings. A lone `invoice_05.pdf` still lands in an existing `Documents/Invoice` folder. Each batch shows a notification (click it to open the folder) and appears in History with an *auto* tag, so it can be undone.
- **Open folder after organizing**: opens the destination in Explorer after you click Organize. There's also an **Open folder** button in the sidebar and action bar.
- **Start with Windows**: starts hidden in the tray at sign-in.

## Updates

SortWise checks for updates 8 seconds after it starts and every 6 hours after that (installed builds only). It looks at the latest release on **github.com/resrge/sortwise** first, then **https://resrge.com/sortwise/latest.json**. It downloads the new installer in the background and checks its SHA-256. Then **Restart to update** appears in the title bar. Clicking it runs the installer silently (Windows asks for admin once), and SortWise reopens when the install finishes.

### Shipping a release

1. Bump `version` in `package.json`.
2. Run `.\build-installer.ps1 -Publish -Notes "What's new"`. This needs the [GitHub CLI](https://cli.github.com) and `gh auth login`. Without `-Publish`, create release `v<version>` on GitHub yourself and attach the two files below.
3. Upload `installer\Output\SortWise-Setup-<version>-build<date>.exe` and `installer\Output\latest.json` to `resrge.com/sortwise/`.

A rebuild of the same version with a newer build date also counts as an update.

## Layout

```
main.js              Electron main process: IPC, settings, history, tray, auto-organize
preload.js           Safe bridge exposed as window.sortwise
src/organizer.js     Scan / group / plan / move / undo (pure Node)
src/watcher.js       Folder watcher that waits for downloads to finish (pure Node)
src/updater.js       GitHub + resrge.com update check, download, silent install
src/version.js       Version / build comparison
renderer/            index.html, styles.css, app.js
scripts/             Exe icon + version stamping (rcedit)
installer/           Inno Setup script
test/                Logic + watcher tests
assets/icon.png
```

## Adding a category

Edit `CATEGORIES` at the top of `src/organizer.js`, and add an icon + color in `renderer/app.js` (`ICONS`, `COLORS`) and `styles.css` (`--c-…`).
