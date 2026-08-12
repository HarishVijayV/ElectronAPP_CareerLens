/**
 * CareerLens desktop shell.
 *
 * This file does not contain the app. It opens a window and points it at the
 * Next.js frontend, which is still served the same way it always was
 * (`npm run dev` in ../frontend). Think of it as a browser with one bookmark
 * and no address bar.
 *
 * Because the window loads a real http://localhost origin, cookie auth keeps
 * working untouched — the httpOnly access_token/refresh_token cookies that
 * frontend/src/lib/api.ts relies on behave exactly as they do in Chrome.
 */
const { app, BrowserWindow, shell } = require("electron");

// Where the frontend is served. Override when pointing a shipped build at a
// hosted deployment: set APP_URL=https://your-site before launching.
const APP_URL = process.env.APP_URL || "http://localhost:3000";

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "CareerLens",
    // Don't show an empty white frame while the page is still loading.
    show: false,
    webPreferences: {
      // Nothing here needs Node, and the page is remote content, so keep the
      // renderer sandboxed rather than handing it filesystem access.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Next dev server takes a few seconds to boot. If Electron wins the race the
  // load fails outright, so retry instead of leaving the user on an error page.
  const load = () => {
    win.loadURL(APP_URL).catch(() => setTimeout(load, 1000));
  };
  win.webContents.on("did-fail-load", () => setTimeout(load, 1000));
  load();

  // External links (job postings, company sites) belong in the real browser,
  // not trapped inside this window with no way back.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

// macOS keeps apps alive with no windows; Windows and Linux do not.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
